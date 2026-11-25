'use strict';

// The SAIAS hub: one local endpoint (default http://127.0.0.1:8090) for every installed profile.
//
// Each profile (saias-flash, saias-smart, ...) runs in its own llama-server, started on demand
// on a free port with the runtime and arguments the catalog chose for this machine. A
// llama-server in router mode without models serves Llama Chat (the llama.cpp web UI) and the
// web search MCP tools. The hub speaks the router API so Llama Chat lists every profile:
//   GET  /v1/models, /models      installed profiles with their load status
//   POST /models/load|unload      start or stop a profile server
//   GET  /models/sse              status events
//   GET  /saias/status            hub status for the CLI and the native app
//   POST /saias/stop              stop the hub and its servers (header X-SAIAS: 1)
//   anything naming a model       routed to that profile's server (started if needed)
//   anything else                 Llama Chat and MCP tools on the UI server
// OpenAI "reasoning_effort" values are translated into each model's own chat template
// arguments, so clients never need to know which model is behind a profile.

const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile, execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const paths = require('./paths');
const catalogs = require('./catalog');
const store = require('./store');
const llama = require('./llama');

// Backends always listen on the loopback address. The hub does too, unless SAIAS_HUB_HOST opens
// it to the network, which requires SAIAS_API_KEY.
const HOST = '127.0.0.1';
const BIND = process.env.SAIAS_HUB_HOST || HOST;
const API_KEY = process.env.SAIAS_API_KEY || '';
const PORT = Number(process.env.SAIAS_HUB_PORT || 8090);
// One model in memory at a time. Set SAIAS_HUB_EXCLUSIVE=0 to allow several.
const EXCLUSIVE = process.env.SAIAS_HUB_EXCLUSIVE !== '0';
const STARTUP_TIMEOUT_MS = 15 * 60 * 1000;
const CREATED = Math.floor(Date.now() / 1000);

const profiles = new Map(); // "saias-<id>" -> profile record
const children = new Set();
const sseClients = new Set();
let ui = null; // { port, proc }

function log(...args) { console.log(new Date().toLocaleTimeString(), ...args); }

// ---------------------------------------------------------------- setup from the installation

function loadProfiles() {
  const catalog = catalogs.installed();
  const state = store.load();
  if (!catalog || !Object.keys(state.profiles).length) throw new Error('SAIAS is not installed. Run Install-SAIAS.cmd (or "saias install") first.');
  for (const [id, entry] of Object.entries(state.profiles)) {
    const variant = catalog.profiles[id]?.variants.find(v => v.id === entry.variant);
    if (!variant) { log(`saias-${id}: variant ${entry.variant} not in the catalog, skipped`); continue; }
    const model = catalog.models[variant.model];
    const runtime = catalog.runtimes[variant.runtime];
    const dir = store.runtimeDir(state, variant.runtime, runtime);
    const files = Object.fromEntries(Object.entries(model.files).map(([role, f]) => [role, store.filePath(state, f)]));
    const missing = [!dir && runtime.name, ...Object.entries(files).filter(([, p]) => !p).map(([role]) => `${model.name} ${role}`)].filter(Boolean);
    if (missing.length) { log(`saias-${id}: missing ${missing.join(', ')}; run "saias install"`); continue; }
    const name = 'saias-' + id;
    profiles.set(name, {
      id, name, variant, model, runtime, device: entry.device,
      exe: store.binaryPath(dir, runtime), files, template: llama.templatePath(paths.ROOT, model),
      status: 'unloaded', failed: null, port: null, proc: null, loading: null,
    });
  }
  if (!profiles.size) throw new Error('No installed profile can start. Run "saias install".');
  const uiRuntimeId = (catalog.hub?.uiRuntimes || []).find(rid => catalog.runtimes[rid] && store.runtimeDir(state, rid, catalog.runtimes[rid]));
  if (!uiRuntimeId) throw new Error('No installed runtime can serve Llama Chat. Run "saias install".');
  const uiRuntime = catalog.runtimes[uiRuntimeId];
  return { uiExe: store.binaryPath(store.runtimeDir(state, uiRuntimeId, uiRuntime), uiRuntime) };
}

function profileFor(model) {
  if (typeof model !== 'string') return null;
  return profiles.get(model) || profiles.get('saias-' + model) || null;
}

// ---------------------------------------------------------------- processes

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, HOST, () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function launch(label, exe, args) {
  fs.mkdirSync(paths.logs, { recursive: true });
  const logFile = path.join(paths.logs, label + '.log');
  const fd = fs.openSync(logFile, 'w');
  let proc;
  try {
    // On Linux and macOS each server leads its own process group, so stopping it also stops the
    // MCP tools it started.
    proc = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', fd, fd] });
  } finally {
    fs.closeSync(fd);
  }
  proc.logFile = logFile;
  proc.exited = null;
  children.add(proc);
  proc.on('exit', code => { proc.exited = code ?? 1; children.delete(proc); });
  proc.on('error', () => { proc.exited = 1; children.delete(proc); });
  log(`started ${label} (log: ${logFile})`);
  return proc;
}

// Stops a process we started and its children (the UI server runs the MCP tools as children).
function stop(proc) {
  if (!proc || proc.exited !== null) return Promise.resolve();
  return new Promise(resolve => {
    proc.once('exit', () => resolve());
    killTree(proc);
  });
}

function killTree(proc) {
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
    return;
  }
  try { process.kill(-proc.pid, 'SIGTERM'); } catch { try { proc.kill('SIGTERM'); } catch { /* already gone */ } }
}

async function probe(port) {
  try {
    const r = await fetch(`http://${HOST}:${port}/health`, { signal: AbortSignal.timeout(1500) });
    await r.body?.cancel();
    return r.ok ? 'ready' : r.status === 503 ? 'loading' : 'unavailable';
  } catch {
    return 'offline';
  }
}

async function waitReady(label, port, proc, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await probe(port)) === 'ready') return;
    if (proc.exited !== null) throw new Error(`${label} exited during startup (code ${proc.exited}). Log: ${proc.logFile}`);
    await delay(500);
  }
  throw new Error(`${label} took too long to start. Log: ${proc.logFile}`);
}

// ---------------------------------------------------------------- profile state

function broadcast(event) {
  const line = 'data: ' + JSON.stringify(event) + '\n\n';
  for (const res of sseClients) res.write(line);
}

function setStatus(p, status, failure = null) {
  const changed = p.status !== status;
  p.status = status;
  p.failed = failure;
  if (changed || failure) {
    log(`${p.name}: ${status}${failure ? ' (failed)' : ''}`);
    broadcast({ model: p.name, event: 'status_change', data: { status, ...(failure || {}) } });
  }
}

async function load(p) {
  if (p.status === 'loaded' && p.proc?.exited === null) return;
  if (p.loading) return p.loading;
  p.loading = (async () => {
    setStatus(p, 'loading');
    if (EXCLUSIVE) for (const other of profiles.values()) if (other !== p && other.status !== 'unloaded') await unload(other);
    p.port = await freePort();
    const args = llama.serverArgs({ alias: p.name, port: p.port, variant: p.variant, device: p.device, files: p.files, template: p.template });
    p.proc = launch(p.name, p.exe, args);
    try {
      await waitReady(p.name, p.port, p.proc, STARTUP_TIMEOUT_MS);
      setStatus(p, 'loaded');
      p.proc.once('exit', code => { if (p.status !== 'unloaded') setStatus(p, 'unloaded', { failed: true, exit_code: code ?? 1 }); });
    } catch (e) {
      const code = p.proc.exited ?? 1;
      await stop(p.proc);
      p.proc = null;
      setStatus(p, 'unloaded', { failed: true, exit_code: code });
      throw e;
    }
  })().finally(() => { p.loading = null; });
  return p.loading;
}

async function unload(p) {
  setStatus(p, 'unloaded');
  await stop(p.proc);
  p.proc = null;
}

function modelEntry(p) {
  const status = { value: p.status, ...(p.failed || {}) };
  return {
    id: p.name, aliases: [], tags: [], object: 'model', owned_by: 'saias', created: CREATED,
    status, source: 'preset', can_remove: false, context_length: p.variant.server['ctx-size'] || p.model.context,
    architecture: { input_modalities: p.model.vision ? ['text', 'image'] : ['text'], output_modalities: ['text'] },
    saias: {
      profile: p.id, model: p.model.name, variant: p.variant.id, vision: Boolean(p.model.vision),
      reasoning: p.variant.reasoning ? { default: p.variant.reasoning.default, levels: Object.keys(p.variant.reasoning.levels) } : null,
    },
  };
}

// ---------------------------------------------------------------- HTTP

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res, code, message, type = code >= 500 ? 'server_error' : 'invalid_request_error') {
  send(res, code, { error: { code, message, type } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function forward(req, res, port, body) {
  const headers = { ...req.headers, host: `${HOST}:${port}` };
  // The browser only sees the hub; present the request as same-origin so --cors-origins accepts it.
  if (headers.origin) headers.origin = `http://${HOST}:${port}`;
  if (body) { headers['content-length'] = body.length; delete headers['transfer-encoding']; }
  const up = http.request({ host: HOST, port, method: req.method, path: req.url, headers }, ur => {
    res.writeHead(ur.statusCode, ur.headers);
    ur.pipe(res);
  });
  up.on('error', err => {
    if (!res.headersSent) sendError(res, 502, `SAIAS backend on port ${port} is unavailable: ${err.message}`);
    else res.destroy();
  });
  res.on('close', () => { if (!res.writableFinished) up.destroy(); });
  if (body) up.end(body); else req.pipe(up);
}

function modelEvents(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  sseClients.add(res);
  // Relay the UI server's stream record by record so hub events never split an upstream record.
  let pending = '';
  const up = http.get({ host: HOST, port: ui.port, path: '/models/sse', headers: { accept: 'text/event-stream' } }, ur => {
    ur.setEncoding('utf8');
    ur.on('data', chunk => {
      pending += chunk;
      const cut = pending.lastIndexOf('\n\n');
      if (cut >= 0) { res.write(pending.slice(0, cut + 2)); pending = pending.slice(cut + 2); }
    });
  });
  up.on('error', () => {});
  res.on('close', () => { sseClients.delete(res); up.destroy(); });
}

function isLoopback(address = '') {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

// Requests that reach a model or a tool need the key when one is set; the Llama Chat page itself
// does not (enter the key in its settings). Requests from this computer are always allowed.
function authorized(req, pathname) {
  if (!API_KEY || isLoopback(req.socket.remoteAddress)) return true;
  const guarded = req.method !== 'GET' || /^\/(v1|models|props|tools|saias|slots|metrics|mcp)(\/|$)/.test(pathname);
  if (!guarded) return true;
  const header = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] || '';
  const given = Buffer.from(String(header));
  const expected = Buffer.from(API_KEY);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}`);
  const p = url.pathname;
  if (!authorized(req, p)) return sendError(res, 401, 'Missing or invalid API key', 'authentication_error');

  if (req.method === 'GET' && (p === '/v1/models' || p === '/models')) {
    return send(res, 200, { object: 'list', data: [...profiles.values()].map(modelEntry) });
  }
  if (req.method === 'GET' && p === '/models/sse') return modelEvents(req, res);
  if (req.method === 'POST' && p === '/saias/stop') {
    // A custom header cannot be sent cross-origin without a CORS preflight, which the hub never
    // grants: web pages cannot stop SAIAS.
    if (req.headers['x-saias'] !== '1') return sendError(res, 403, 'Missing X-SAIAS header');
    send(res, 200, { stopping: true });
    log('Stop requested.');
    return setTimeout(() => shutdown(0), 100);
  }
  if (req.method === 'GET' && p === '/saias/status') {
    return send(res, 200, { port: PORT, exclusive: EXCLUSIVE, profiles: [...profiles.values()].map(x => ({ id: x.name, status: x.status, model: x.model.name, variant: x.variant.id })) });
  }

  let body = req.method === 'POST' && /json/i.test(req.headers['content-type'] || '') ? await readBody(req) : null;
  let json = null;
  if (body?.length) { try { json = JSON.parse(body.toString('utf8')); } catch { /* not JSON */ } }
  const requested = url.searchParams.get('model') || json?.model;
  const target = profileFor(requested);

  if (p === '/models/load' || p === '/models/unload') {
    if (!target) return sendError(res, 404, `Unknown model: ${requested}`);
    if (p === '/models/unload') {
      if (target.status === 'unloaded') return sendError(res, 400, 'model is not running');
      await unload(target);
    } else {
      load(target).catch(e => log(e.message)); // Llama Chat follows progress through /models/sse
    }
    return send(res, 200, { success: true });
  }

  if (!target) {
    if (requested && json) return sendError(res, 404, `Unknown model "${requested}". Available: ${[...profiles.keys()].join(', ')}`);
    return forward(req, res, ui.port, body);
  }

  if (target.status !== 'loaded') {
    if (url.searchParams.get('autoload') === 'false') return sendError(res, 400, 'model is not loaded');
    if (req.method === 'GET' && p === '/props') {
      // Readiness probe: start loading and answer like llama-server does while a model loads.
      load(target).catch(e => log(e.message));
      return sendError(res, 503, 'Loading model', 'unavailable_error');
    }
    try { await load(target); } catch (e) { return sendError(res, 503, e.message); }
  }

  if (json && llama.requestedLevel(json)) {
    json = llama.applyReasoning(json, target.variant);
    body = Buffer.from(JSON.stringify(json));
  }
  return forward(req, res, target.port, body);
}

// ---------------------------------------------------------------- lifecycle

function shutdown(code = 0) {
  for (const proc of children) {
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else process.kill(-proc.pid, 'SIGTERM');
    } catch { /* already gone */ }
  }
  process.exit(code);
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd.exe', ['/d', '/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
}

async function alreadyRunning() {
  try {
    const r = await fetch(`http://${HOST}:${PORT}/saias/status`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

async function start({ open = false } = {}) {
  if (!isLoopback(BIND) && BIND !== 'localhost' && !API_KEY) {
    throw new Error('SAIAS_HUB_HOST opens SAIAS to the network: set SAIAS_API_KEY as well.');
  }
  const url = `http://${BIND === '0.0.0.0' || BIND === '::' ? HOST : BIND}:${PORT}/`;
  if (await alreadyRunning()) {
    log(`SAIAS is already running at ${url}`);
    if (open) openBrowser(url);
    return;
  }
  const { uiExe } = loadProfiles();
  process.on('SIGINT', () => shutdown());
  process.on('SIGTERM', () => shutdown());
  process.on('SIGHUP', () => shutdown());

  // Llama Chat and the web tools: a router-mode llama-server with an empty model list.
  fs.mkdirSync(paths.home, { recursive: true });
  const presets = path.join(paths.home, 'ui-presets.ini');
  fs.writeFileSync(presets, 'version = 1\n');
  const mcp = { mcpServers: { web: { command: process.execPath, args: [paths.webMcp], timeout_ms: 120000 } } };
  const uiPort = await freePort();
  const uiProc = launch('ui', uiExe, ['--host', HOST, '--port', String(uiPort), '--cors-origins', 'localhost',
    '--models-preset', presets, '--models-max', '1', '--mcp-servers-json', JSON.stringify(mcp)]);
  await waitReady('Llama Chat server', uiPort, uiProc, 60000);
  ui = { port: uiPort, proc: uiProc };
  uiProc.once('exit', code => { log(`The Llama Chat server stopped (code ${code}). Log: ${uiProc.logFile}`); shutdown(1); });

  const server = http.createServer((req, res) => {
    handle(req, res).catch(e => { if (!res.headersSent) sendError(res, 500, e.message); else res.destroy(); });
  });
  server.requestTimeout = 0;
  server.on('error', e => { log(`Cannot listen on ${url}: ${e.message}`); shutdown(1); });
  server.listen(PORT, BIND, () => {
    log(`SAIAS hub ready - ${url}  (${[...profiles.keys()].join(', ')})`);
    log(`OpenAI-compatible endpoint: ${url}v1. Press Ctrl+C to stop SAIAS and its models.`);
    if (open) openBrowser(url);
  });
}

module.exports = { start };
