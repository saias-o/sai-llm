// SAI-LLM web front-end controller.
// Node.js, no external dependencies. Serves the static UI on http://127.0.0.1:9000
// and proxies /v1/chat/completions to the right llama-server backend, mirroring
// the port-resolution + per-model reasoning-body logic of the native client (chat.cpp).
//
// Backend map from Launch-Inkling.cmd.
//   sai-smart (Bonsai 2 27B) -> 8080, sai-max -> 8081, sai-flash -> 8082
//
// Run:  node web/server.js
// Open: http://127.0.0.1:9000

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const child_process = require('child_process');

// ---------- paths ----------
const WEB_DIR = __dirname;
const APP_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'SAI-LLM');
const CONV_DIR = path.join(APP_DIR, 'Conversations');
const SETTINGS_FILE = path.join(APP_DIR, 'settings.json');
const TEMPLATES_DIR = path.resolve(WEB_DIR, '..', 'templates');
const PORT = Number(process.env.PORT || 9000);

const MODELS = {
  'sai-smart': { port: 8080, aliases: ['sai-smart', 'bonsai-2-27b'] },
  'sai-max': { port: 8081, aliases: ['sai-max'] },
  'sai-flash': { port: 8082, aliases: ['sai-flash'] },
};

// ---------- helpers ----------
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
ensureDir(CONV_DIR); ensureDir(APP_DIR);

function sendJson(res, code, obj, headers) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, headers || {}));
  res.end(body);
}

function reasoningFields(model, level) {
  if (model === 'sai-flash') {
    return { chat_template_kwargs: { enable_thinking: level === 'on' }, reasoning_format: 'deepseek' };
  }
  if (model === 'sai-smart') {
    if (level === 'none' || level === 'off') return { chat_template_kwargs: { enable_thinking: false } };
    if (level === 'medium' || level === 'xhigh') return { chat_template_kwargs: { reasoning_effort: level } };
    return {};
  }
  const effort = { none: 0, off: 0, low: 0.2, medium: 0.7, high: 0.9, xhigh: 0.99 }[level];
  return typeof effort === 'number' ? { chat_template_kwargs: { reasoning_effort: effort } } : {};
}

async function backendAlias({ port, aliases }) {
  try {
    const response = await fetch('http://127.0.0.1:' + port + '/v1/models', { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return null;
    const { data } = await response.json();
    return aliases.find(alias => data?.some(model => model.id === alias || model.aliases?.includes(alias))) || null;
  } catch {
    return null;
  }
}

function messageContent(message, model) {
  const parts = [message.content || ''];
  const images = [];
  for (const attachment of message.attachments || []) {
    if (attachment.image_url && model !== 'sai-flash') {
      images.push({ type: 'image_url', image_url: { url: attachment.image_url } });
    } else if (attachment.image_url) {
      parts.push('[Earlier image attachment: ' + attachment.name + ']');
    } else {
      parts.push('[PDF attachment: ' + attachment.name + ']\n' + attachment.text + '\n[End PDF attachment]');
    }
  }
  const content = parts.filter(Boolean).join('\n\n');
  if (!images.length) return content;
  if (content) images.unshift({ type: 'text', text: content });
  return images;
}

// ---------- SSE proxy ----------
function streamProxy(res, port, payload) {
  const clientReq = http.request({
    host: '127.0.0.1', port,
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'Content-Length': Buffer.byteLength(payload),
    },
  }, (clientResp) => {
    res.writeHead(clientResp.statusCode, {
      'Content-Type': clientResp.headers['content-type'] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    clientResp.on('error', () => res.destroy());
    clientResp.pipe(res);
  });
  clientReq.setTimeout(300000, () => clientReq.destroy(new Error('backend timeout')));
  clientReq.on('error', (err) => {
    if (res.destroyed) return;
    if (res.headersSent) res.destroy();
    else sendJson(res, 502, { error: err.message });
  });
  res.on('close', () => clientReq.destroy());
  clientReq.end(payload);
}

// ---------- conversation store ----------
const GUID = /^(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{4}(?:-[0-9a-f]{4}){7})$/i;

function validId(id) {
  return GUID.test(id.startsWith('{') && id.endsWith('}') ? id.slice(1, -1) : id);
}

function readConversation(file, id) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { ...data, id, model: data.model === 'sai-big' ? 'sai-smart' : data.model };
}

function writeJson(file, data) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(data, null, 2));
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function loadSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return { memory: data.memory || '', system_prompt: data.system_prompt ?? data.systemPrompt ?? '' };
  } catch {
    return {};
  }
}

// ---------- run cmd helper ----------
function runCmd(cmd, args, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let out = '', err = '';
    let p;
    try { p = child_process.exec(cmd + args.join(' '), { maxBuffer: 1024 * 1024, timeout: timeoutMs, encoding: 'utf8' }); }
    catch (e) { return resolve({ out: '', err: String(e.message) }); }
    p.on('close', (code) => { const done = () => resolve({ code, out, err }); p.on('error', (e) => { err += '\n' + String(e.message); done(); }); if (done) {} const c = p.on('close', (c2) => {}); return; });
    p.on('error', (e) => resolve({ out: '', err: String(e.message) }));
    p.on('stdout', (c) => { out += c; });
    p.on('stderr', (c) => { err += c; });
    setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, timeoutMs);
  });
}
function runCmdSimple(cmd, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const p = child_process.exec(cmd, { maxBuffer: 1024 * 1024, encoding: 'utf8' });
    let out = '', err = '';
    p.on('close', () => resolve({ code: p.exitCode, out, err }));
    p.on('stdout', (c) => { out += c; });
    p.on('stderr', (c) => { err += c; });
    p.on('error', () => resolve({ code: -1, out: '', err: 'spawn error' }));
    setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, timeoutMs);
  });
}

async function detectGpu() {
  // nvidia-smi async pipes return empty output on this Windows setup (console
  // app + async read). Use execSync for synchronous capture. Correct modifier
  // is 'noheader' ('noserverheader' is invalid). Output line: name, totalMiB.
  let nvidia = { code: 1, out: '' };
  try {
    nvidia.out = child_process.execSync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader', { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    nvidia.code = 0;
  } catch (e) {
    nvidia.code = e.code || 1;
  }
  let gpu = { present: false, name: 'CPU', vramGB: null, gpuClass: 'cpu' };
  if (nvidia.code === 0 && nvidia.out.trim()) {
    const line = nvidia.out.split(/\r?\n/).map(l => l.trim()).filter(l => l).slice(0, 1);
    const parts = line[0].split(',').map(s => s.trim());
    gpu.present = true;
    gpu.name = parts[0] || 'NVIDIA GPU';
    // parts[1] is like "12282 MiB" -> parseInt drops the unit, MiB -> GB
    gpu.vramGB = Math.round(parseInt(parts[1], 10) / 1024);
    gpu.gpuClass = 'gpu';
  } else {
    // WMI name
    const wmi = await runCmdSimple('powershell -NoProfile -Command "(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }).join(\x27 ; \x27)"');
    if (wmi.out && wmi.out.trim()) {
      gpu.present = true;
      gpu.name = wmi.out.trim();
      gpu.gpuClass = /nvidia|amd|intel/i.test(gpu.name) ? 'gpu' : 'cpu';
    }
  }
  return gpu;
}

function advisorRecommendation(hardware) {
  const cpu = hardware.cpu || {}, ram = hardware.ram || {}, gpu = hardware.gpu || {};
  const vram = gpu.vramGB || 0;
  // Heuristic mirroring the native advisor profiles:
  //   sai-max  needs a real dGPU with enough VRAM (>= 12 GB comfortable for 500k ctx)
  //   sai-smart: Bonsai CUDA at 64K context
  //   sai-flash fallback (262k ctx) targeting ~20 t/s
  let capable = 'sai-flash', everyday = 'sai-flash';
  if (gpu.present && /nvidia/i.test(gpu.name)) {
    if (vram >= 10 && ram.totalGB >= 32) capable = 'sai-max';
    if (vram >= 12 && ram.totalGB >= 16) {
      if (capable !== 'sai-max') capable = 'sai-smart';
      everyday = 'sai-smart';
    }
  }
  return { capable, everyday, reason: buildAdvisorReason(capable, everyday, hardware) };
}
function buildAdvisorReason(capable, everyday, hw) {
  const parts = [];
  parts.push('Based on ' + (hw.gpu.name || 'CPU'));
  if (hw.gpu.present && hw.gpu.vramGB) parts.push(hw.gpu.vramGB + ' GB VRAM');
  parts.push('CPU: ' + (hw.cpu.cores || '?') + ' cores');
  parts.push(hw.ram.totalGB + ' GB RAM');
  return parts.join(', ');
}

function hardwareInventory() {
  const cpus = os.cpus();
  let cpuModel = cpus[0] && cpus[0].model ? cpus[0].model : 'unknown';
  return {
    cpu: { cores: cpus.length, model: cpuModel, frequencyGHz: cpus[0] && cpus[0].frequency ? (cpus[0].frequency / 1e6) : null },
    ram: { totalGB: Math.round((os.totalmem() / 1024 / 1024 / 1024) * 10) / 10 },
    os: { platform: os.platform(), release: os.release(), arch: os.arch() },
    gpu: null, // filled async by caller
  };
}

// ---------- static serving ----------
const STATIC_EXT = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res) {
  let q = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (q === '/') q = '/index.html';
  let fp = path.join(WEB_DIR, q.replace(/^\/+/, ''));
  if (path.resolve(fp) !== path.resolve(WEB_DIR) && !fp.startsWith(path.resolve(WEB_DIR) + path.sep)) return sendJson(res, 404, { error: 'not found' });
  if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) return sendJson(res, 404, { error: 'not found' });
  const ext = path.extname(fp).toLowerCase();
  res.writeHead(200, { 'Content-Type': STATIC_EXT[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache, no-store' });
  fs.createReadStream(fp).pipe(res);
}

// ---------- router ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/health') return sendJson(res, 200, { ok: true, port: PORT });
  if (p === '/api/models') {
    (async () => {
      const entries = await Promise.all(Object.entries(MODELS).map(async ([id, backend]) => {
        return [id, { port: backend.port, online: Boolean(await backendAlias(backend)) }];
      }));
      sendJson(res, 200, { models: Object.fromEntries(entries) });
    })();
    return;
  }

  if (p === '/api/chat') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
    (async () => {
      try {
        const body = await readJsonBody(req);
        if (body.error) return sendJson(res, 400, body);
        const model = body.model || 'sai-smart';
        if (!Object.hasOwn(MODELS, model)) return sendJson(res, 400, { error: 'unknown model' });
        if (!Array.isArray(body.messages) || !body.messages.length) {
          return sendJson(res, 400, { error: 'messages must be a non-empty array' });
        }
        const backend = MODELS[model];
        const alias = await backendAlias(backend);
        if (!alias) return sendJson(res, 503, { error: 'backend offline', model, port: backend.port });
        if (res.destroyed) return;
        const messages = body.messages.map(message => ({ role: message.role, content: messageContent(message, model) }));
        const openai = {
          model: alias,
          messages,
          stream: true,
          ...reasoningFields(model, body.reasoning),
        };
        if (typeof body.temperature === 'number') openai.temperature = body.temperature;
        if (typeof body.top_p === 'number') openai.top_p = body.top_p;
        if (typeof body.max_tokens === 'number') openai.max_tokens = body.max_tokens;
        streamProxy(res, backend.port, JSON.stringify(openai));
      } catch (e) {
        if (res.headersSent) try { res.end(); } catch {}
        else sendJson(res, 500, { error: String(e.message) });
      }
    })();
    return;
  }

  if (p === '/api/settings') {
    if (req.method === 'GET') return sendJson(res, 200, loadSettings());
    if (req.method === 'POST') {
      (async () => {
        try {
          const b = await readJsonBody(req);
          if (b.error) return sendJson(res, 400, b);
          const settings = { memory: b.memory || '', system_prompt: b.system_prompt || '' };
          writeJson(SETTINGS_FILE, settings);
          sendJson(res, 200, settings);
        } catch (e) { sendJson(res, 500, { error: e.message }); }
      })();
      return;
    }
    sendJson(res, 405, { error: 'GET/POST only' });
    return;
  }

  if (p === '/api/templates' || p.startsWith('/api/templates/')) {
    if (p === '/api/templates') {
      let names = [];
      if (fs.existsSync(TEMPLATES_DIR)) {
        for (const f of fs.readdirSync(TEMPLATES_DIR)) {
          if (!f.startsWith('.') && fs.statSync(path.join(TEMPLATES_DIR, f)).isFile()) names.push(f);
        }
      }
      return sendJson(res, 200, { templates: names });
    }
    const name = p.split('/').pop();
    const fp = path.join(TEMPLATES_DIR, name);
    if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      const c = fs.readFileSync(fp, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(c);
    } else sendJson(res, 404, { error: 'template not found' });
    return;
  }

  if (p === '/api/material') {
    (async () => { const hw = hardwareInventory(); hw.gpu = await detectGpu(); sendJson(res, 200, hw); })();
    return;
  }

  if (p === '/api/advisor') {
    (async () => {
      const hw = hardwareInventory();
      hw.gpu = await detectGpu();
      const rec = advisorRecommendation(hw);
      rec.hardware = hw;
      sendJson(res, 200, rec);
    })();
    return;
  }

  if (p === '/api/conversations' || p === '/api/conversations/') {
    if (req.method === 'GET') {
      const items = [];
      for (const f of fs.readdirSync(CONV_DIR)) {
        const id = path.basename(f, '.json');
        if (!f.endsWith('.json') || !validId(id)) continue;
        try {
          const full = path.join(CONV_DIR, f);
          const st = fs.statSync(full);
          const o = readConversation(full, id);
          const messages = o.messages || [];
          if (!messages.length) continue;
          const first = messages.find(m => m.role === 'user' && typeof m.content === 'string' && m.content);
          items.push({ id, model: o.model, reasoning: o.reasoning, createdAt: st.mtime.toISOString(),
            preview: first?.content.slice(0, 80).replace(/\s+/g, ' ') || '', turnCount: messages.length });
        } catch {}
      }
      items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return sendJson(res, 200, items);
    }
    if (req.method === 'POST') {
      (async () => {
        const b = await readJsonBody(req);
        if (b.error) return sendJson(res, 400, b);
        sendJson(res, 201, { id: '{' + crypto.randomUUID().toUpperCase() + '}', model: b.model || 'sai-smart',
          reasoning: b.reasoning || 'default', messages: [] });
      })();
      return;
    }
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  if (p.startsWith('/api/conversations/')) {
    let id;
    try { id = decodeURIComponent(p.slice('/api/conversations/'.length)); } catch {}
    if (!id || !validId(id)) return sendJson(res, 404, { error: 'not found' });
    const full = path.join(CONV_DIR, id + '.json');
    if (req.method === 'GET') {
      if (!fs.existsSync(full)) return sendJson(res, 404, { error: 'not found' });
      try { return sendJson(res, 200, readConversation(full, id)); }
      catch { return sendJson(res, 400, { error: 'bad json' }); }
    }
    if (req.method === 'PUT') {
      (async () => { try {
        const b = await readJsonBody(req);
        if (b.error) return sendJson(res, 400, b);
        if (!Array.isArray(b.messages)) return sendJson(res, 400, { error: 'invalid messages' });
        const conversation = { model: b.model || 'sai-smart', reasoning: b.reasoning || 'default', messages: b.messages };
        writeJson(full, conversation);
        sendJson(res, 200, { id, ...conversation });
      } catch (e) { sendJson(res, 500, { error: String(e.message) }); } })();
      return;
    }
    if (req.method === 'DELETE') { if (fs.existsSync(full)) fs.unlinkSync(full); return sendJson(res, 204, {}); }
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  serveStatic(req, res);
});

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let len = 0;
    req.on('data', chunk => {
      len += chunk.length;
      if (len <= 32 * 1024 * 1024) chunks.push(chunk);
      else resolve({ error: 'body too large' });
    });
    req.on('end', () => {
      try {
        const body = len ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        resolve(body && typeof body === 'object' && !Array.isArray(body) ? body : { error: 'bad json' });
      } catch { resolve({ error: 'bad json' }); }
    });
    req.on('error', (e) => resolve({ error: String(e.message) }));
  });
}

server.on('error', (e) => { console.error('server error', e.message); process.exit(1); });

// graceful shutdown
process.on('SIGINT', () => { console.log('\nStopping SAI-LLM web server.'); process.exit(0); });

server.listen(PORT, '127.0.0.1', () => {
  console.log('[SAI-LLM] web interface -> http://127.0.0.1:' + PORT);
  console.log('[SAI-LLM] sai-smart (Bonsai 2 27B) -> 8080; sai-max -> 8081; sai-flash -> 8082');
});
