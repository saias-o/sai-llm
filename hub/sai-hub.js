// SAI hub: one llama.cpp Llama Chat UI for the three SAI profiles.
//
// No single llama-server build can host every profile: sai-smart needs the
// PrismML fork (ptq1_0 weights) and sai-pro needs the Unsloth build (inkling
// architecture). The hub therefore fronts the sai-flash router on port 8082,
// which serves Llama Chat, and speaks the llama-server router API for the two
// other profiles so they appear in the same model selector:
//   GET  /v1/models, /models   router list + sai-smart + sai-pro
//   POST /models/load|unload   starts or stops Launch-Inkling.cmd smart|pro
//   GET  /models/sse           router events + sai-smart/sai-pro status events
//   requests naming a model    routed to 8080 (smart), 8081 (pro) or the router
//
// Run: node hub\sai-hub.js [--open]   (Node.js 22, no dependencies)

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile, execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const ROOT = path.dirname(__dirname);
const HOST = '127.0.0.1';
const PORT = Number(process.env.SAI_HUB_PORT || 8090);
const ROUTER_PORT = 8082;
// One model in memory at a time, like the router's --models-max 1. Set SAI_HUB_EXCLUSIVE=0 to allow several.
const EXCLUSIVE = process.env.SAI_HUB_EXCLUSIVE !== '0';
const LOG_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'SAI-LLM', 'BackendLogs');
const STARTUP_TIMEOUT_MS = 15 * 60 * 1000;
const CREATED = Math.floor(Date.now() / 1000);

// Profiles served by their own llama-server, outside the router.
const EXTERNAL = {
  'sai-smart': { port: 8080, launchArgs: ['smart'], aliases: ['bonsai-2-27b'], ctx: 200000 },
  'sai-pro': { port: 8081, launchArgs: ['pro'], aliases: [], ctx: 500000 },
};
for (const m of Object.values(EXTERNAL)) Object.assign(m, { status: 'unloaded', failed: null, proc: null, loading: null });

const spawned = new Set();
const sseClients = new Set();

// ---------- helpers ----------

function log(...args) { console.log(new Date().toLocaleTimeString(), ...args); }

function externalName(model) {
  if (typeof model !== 'string') return null;
  for (const [name, m] of Object.entries(EXTERNAL)) if (model === name || m.aliases.includes(model)) return name;
  return null;
}

function sendError(res, code, message) {
  const body = JSON.stringify({ error: { code, message, type: code >= 500 ? 'server_error' : 'invalid_request_error' } });
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendJson(res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function probe(port) {
  try {
    const r = await fetch(`http://${HOST}:${port}/health`, { signal: AbortSignal.timeout(1500) });
    await r.body?.cancel();
    return r.ok ? 'ready' : r.status === 503 ? 'loading' : 'unavailable';
  } catch (e) {
    return e.cause?.code === 'ECONNREFUSED' ? 'offline' : 'unavailable';
  }
}

async function routerJson(method, pathname, body) {
  const r = await fetch(`http://${HOST}:${ROUTER_PORT}${pathname}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  return r.json();
}

// ---------- processes ----------

function launch(label, launchArgs) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logFile = path.join(LOG_DIR, label + '.log');
  const fd = fs.openSync(logFile, 'w');
  let proc;
  try {
    const cmd = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
    proc = spawn(cmd, ['/d', '/c', path.join(ROOT, 'Launch-Inkling.cmd'), ...launchArgs], { cwd: ROOT, windowsHide: true, stdio: ['ignore', fd, fd] });
  } finally {
    fs.closeSync(fd);
  }
  proc.logFile = logFile;
  proc.exitCode_ = null;
  spawned.add(proc);
  proc.on('exit', code => { proc.exitCode_ = code ?? 1; spawned.delete(proc); });
  proc.on('error', () => { proc.exitCode_ = 1; spawned.delete(proc); });
  log(`started ${label} (log: ${logFile})`);
  return proc;
}

function killTree(pid) {
  return new Promise(resolve => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
}

// PID of a llama-server already listening on a port we did not start ourselves.
function listeningLlamaPid(port) {
  return new Promise(resolve => {
    execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true }, (err, out) => {
      const line = !err && out.split(/\r?\n/).find(l => /LISTENING/.test(l) && new RegExp(`:${port}\\s`).test(l));
      const pid = line && line.trim().split(/\s+/).pop();
      if (!pid) return resolve(null);
      execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (e2, list) => {
        resolve(!e2 && /llama-server/i.test(list) ? Number(pid) : null);
      });
    });
  });
}

// ---------- external model state ----------

function broadcast(event) {
  const line = 'data: ' + JSON.stringify(event) + '\n\n';
  for (const res of sseClients) res.write(line);
}

function setStatus(name, status, extra = {}) {
  const m = EXTERNAL[name];
  const changed = m.status !== status;
  m.status = status;
  m.failed = extra.failed ? extra : null;
  if (changed || extra.failed) {
    log(`${name}: ${status}${extra.failed ? ' (failed)' : ''}`);
    broadcast({ model: name, event: 'status_change', data: { status, ...extra } });
  }
}

async function waitReady(name, proc) {
  const m = EXTERNAL[name];
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await probe(m.port)) === 'ready') return;
    if (proc && proc.exitCode_ !== null) throw new Error(`${name} exited during startup (code ${proc.exitCode_}). Log: ${proc.logFile}`);
    await delay(1000);
  }
  throw new Error(`${name} took too long to start.`);
}

async function loadExternal(name) {
  const m = EXTERNAL[name];
  if (m.status === 'loaded' && (await probe(m.port)) === 'ready') return;
  if (m.loading) return m.loading;
  m.loading = (async () => {
    setStatus(name, 'loading');
    await makeRoom(name);
    const state = await probe(m.port);
    if (state === 'offline') m.proc = launch(name, m.launchArgs);
    try {
      await waitReady(name, m.proc);
      setStatus(name, 'loaded');
    } catch (e) {
      const code = m.proc?.exitCode_ ?? 1;
      if (m.proc) await killTree(m.proc.pid);
      m.proc = null;
      setStatus(name, 'unloaded', { failed: true, exit_code: code });
      throw e;
    }
  })().finally(() => { m.loading = null; });
  return m.loading;
}

async function unloadExternal(name) {
  const m = EXTERNAL[name];
  const pid = m.proc?.pid ?? (await listeningLlamaPid(m.port));
  if (pid) await killTree(pid);
  m.proc = null;
  for (let i = 0; i < 30 && (await probe(m.port)) !== 'offline'; i++) await delay(500);
  setStatus(name, 'unloaded');
}

// Free memory before a load: unload every other model, external or in the router.
async function makeRoom(keep) {
  if (!EXCLUSIVE) return;
  for (const [name, m] of Object.entries(EXTERNAL)) {
    if (name !== keep && (m.status === 'loaded' || m.status === 'loading')) await unloadExternal(name);
  }
  try {
    const { data } = await routerJson('GET', '/v1/models');
    for (const r of data || []) {
      if (r.id !== keep && ['loaded', 'loading'].includes(r.status?.value)) await routerJson('POST', '/models/unload', { model: r.id });
    }
  } catch { /* router offline: nothing to unload */ }
}

// Pick up servers started or stopped outside the hub (Launch-Inkling.cmd by hand, crash, Stop-Bonsai.ps1).
async function refreshExternal() {
  await Promise.all(Object.entries(EXTERNAL).map(async ([name, m]) => {
    if (m.loading) return;
    const state = await probe(m.port);
    if (state === 'ready' && m.status !== 'loaded') setStatus(name, 'loaded');
    else if (state === 'loading' && m.status === 'unloaded') setStatus(name, 'loading');
    else if (state === 'offline' && m.status !== 'unloaded') { m.proc = null; setStatus(name, 'unloaded'); }
  }));
}

function externalEntry(name) {
  const m = EXTERNAL[name];
  const status = { value: m.status };
  if (m.failed) Object.assign(status, m.failed);
  return {
    // Aliases still route (externalName) but stay out of the list: Llama Chat would show them instead of the SAI name.
    id: name, aliases: [], tags: [], object: 'model', owned_by: 'sai-llm', created: CREATED,
    status, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
    source: 'preset', can_remove: false, context_length: m.ctx,
  };
}

// ---------- proxy ----------

function forward(req, res, port, body) {
  const headers = { ...req.headers, host: `${HOST}:${port}` };
  // The browser sees one origin (the hub); present it to the backend as its own origin so --cors-origins accepts it.
  if (headers.origin) headers.origin = `http://${HOST}:${port}`;
  if (body) { headers['content-length'] = body.length; delete headers['transfer-encoding']; }
  const up = http.request({ host: HOST, port, method: req.method, path: req.url, headers }, ur => {
    res.writeHead(ur.statusCode, ur.headers);
    ur.pipe(res);
  });
  up.on('error', err => {
    if (!res.headersSent) sendError(res, 502, `SAI backend on port ${port} is unavailable: ${err.message}`);
    else res.destroy();
  });
  res.on('close', () => { if (!res.writableFinished) up.destroy(); });
  if (body) up.end(body); else req.pipe(up);
}

async function listModels(req, res) {
  await refreshExternal();
  let list = { data: [], object: 'list' };
  try { list = await routerJson('GET', '/v1/models'); } catch { /* router still starting */ }
  list.data = (list.data || []).filter(m => !externalName(m.id)).concat(Object.keys(EXTERNAL).map(externalEntry));
  sendJson(res, list);
}

function modelEvents(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  sseClients.add(res);
  // Relay router events record by record so hub events never land inside a partial upstream record.
  let pending = '';
  const up = http.get({ host: HOST, port: ROUTER_PORT, path: '/models/sse', headers: { accept: 'text/event-stream' } }, ur => {
    ur.setEncoding('utf8');
    ur.on('data', chunk => {
      pending += chunk;
      const cut = pending.lastIndexOf('\n\n');
      if (cut >= 0) { res.write(pending.slice(0, cut + 2)); pending = pending.slice(cut + 2); }
    });
    ur.on('end', () => res.end());
  });
  up.on('error', () => res.end());
  res.on('close', () => { sseClients.delete(res); up.destroy(); });
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}`);
  const p = url.pathname;

  if (req.method === 'GET' && (p === '/v1/models' || p === '/models')) return listModels(req, res);
  if (req.method === 'GET' && p === '/models/sse') return modelEvents(req, res);

  const body = req.method === 'POST' && /json/i.test(req.headers['content-type'] || '') ? await readBody(req) : null;
  let model = url.searchParams.get('model');
  if (body && !model) { try { model = JSON.parse(body.toString('utf8')).model; } catch { /* not JSON */ } }
  const name = externalName(model);

  if (p === '/models/load' || p === '/models/unload') {
    if (!name) {
      if (p === '/models/load' && model) await makeRoom(model);
      return forward(req, res, ROUTER_PORT, body);
    }
    if (p === '/models/unload') {
      if (EXTERNAL[name].status === 'unloaded') return sendError(res, 400, 'model is not running');
      await unloadExternal(name);
    } else {
      loadExternal(name).catch(e => log(e.message)); // the UI follows progress via /models/sse
    }
    return sendJson(res, { success: true });
  }

  if (name) {
    const m = EXTERNAL[name];
    if (m.status !== 'loaded' || (await probe(m.port)) !== 'ready') {
      if (url.searchParams.get('autoload') === 'false') return sendError(res, 400, 'model is not loaded');
      try { await loadExternal(name); } catch (e) { return sendError(res, 503, e.message); }
    }
    return forward(req, res, m.port, body);
  }

  if (model && body) {
    // Router model requested while an external one holds the memory: free it before the router autoloads.
    const busy = Object.values(EXTERNAL).some(m => m.status !== 'unloaded');
    if (busy && EXCLUSIVE) await makeRoom(model);
  }
  return forward(req, res, ROUTER_PORT, body);
}

// ---------- startup ----------

async function ensureRouter() {
  let state = await probe(ROUTER_PORT);
  if (state === 'offline') {
    const proc = launch('router', []);
    const deadline = Date.now() + 60000;
    while ((state = await probe(ROUTER_PORT)) !== 'ready') {
      if (proc.exitCode_ !== null) throw new Error(`The sai-flash router exited (code ${proc.exitCode_}). Log: ${proc.logFile}`);
      if (Date.now() > deadline) throw new Error('The sai-flash router did not start within 60 s.');
      await delay(500);
    }
  } else {
    log(`reusing the server already on port ${ROUTER_PORT}`);
  }
}

function shutdown(code = 0) {
  for (const proc of spawned) {
    try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* already gone */ }
  }
  process.exit(code);
}

async function main() {
  process.on('SIGINT', () => shutdown());
  process.on('SIGTERM', () => shutdown());
  process.on('SIGHUP', () => shutdown());
  await ensureRouter();
  await refreshExternal();
  setInterval(() => refreshExternal().catch(() => {}), 5000).unref();

  const server = http.createServer((req, res) => {
    handle(req, res).catch(e => { if (!res.headersSent) sendError(res, 500, e.message); else res.destroy(); });
  });
  server.requestTimeout = 0;
  server.listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}/`;
    log(`SAI hub ready - ${url}  (sai-flash, sai-smart, sai-pro)`);
    log('OpenAI-compatible endpoint for Hermes: ' + url + 'v1. Press Ctrl+C to stop SAI and its models.');
    if (process.argv.includes('--open')) spawn('cmd.exe', ['/d', '/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  });
}

main().catch(e => { console.error(e.message); shutdown(1); });
