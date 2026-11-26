'use strict';

// SAIAS Chat: the chat page (ui/chat) and its storage, served by the hub.
//   GET    /saias/chat/                    the page (also shown inside the SAIAS app)
//   GET    /saias/chat/api/conversations   summaries, newest first
//   GET    /saias/chat/api/conversations/<id>
//   PUT    /saias/chat/api/conversations/<id>
//   DELETE /saias/chat/api/conversations/<id>
//   GET    /saias/chat/api/settings        memory, system prompt, enabled tools
//   PUT    /saias/chat/api/settings
//   POST   /saias/chat/api/extract         PDF bytes in, text out (attachments)
//   GET    /saias/chat/api/images          local image generator availability
//   POST   /saias/chat/api/images          generate an image
//   GET    /saias/chat/api/images/<conversation>/<image>.png
// Conversations are the same JSON files the SAIAS app's native chat uses, in
// <standard SAIAS folder>/Conversations, so both show the same history.
// Models, tools and chat completions come from the hub's usual endpoints (/v1/models, /tools,
// /v1/chat/completions): the page is same-origin with them.

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const image = require('./image');

const PAGE_DIR = path.join(paths.ROOT, 'ui', 'chat');
const DATA_DIR = path.join(paths.standard, 'Conversations');
const IMAGE_DIR = path.join(DATA_DIR, 'images');
const SETTINGS = path.join(paths.standard, 'settings.json');
const LIMIT = 32 * 1024 * 1024;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
// The native app names conversations with a GUID in braces.
const ID = /^[{}A-Za-z0-9-]{1,64}$/;
const PNG = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.png$/;

function send(res, code, value, type = 'application/json; charset=utf-8') {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

function fail(res, code, message) {
  send(res, code, { error: { code, message } });
}

function readBody(req, limit = LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Atomic write, like the native app.
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function title(conversation) {
  const first = (conversation.messages || []).find(m => m.role === 'user');
  if (!first) return 'New conversation';
  const text = String(first.content || first.attachments?.[0]?.name || '').split(/\r?\n/)[0].trim();
  return text.length > 60 ? text.slice(0, 60) + '…' : text || 'New conversation';
}

function listConversations() {
  let names;
  try { names = fs.readdirSync(DATA_DIR); } catch { return []; }
  const result = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(DATA_DIR, name);
    try {
      const stat = fs.statSync(file);
      if (stat.size > LIMIT) continue;
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(data.messages) || !data.messages.length) continue;
      result.push({ id: name.slice(0, -5), title: data.title || title(data), model: data.model, updated: stat.mtimeMs });
    } catch { /* unreadable file: skip */ }
  }
  return result.sort((a, b) => b.updated - a.updated);
}

// The page and the API are for this computer only: a page from another site could otherwise
// reach them through DNS rebinding.
function localHost(req) {
  const host = String(req.headers.host || '').toLowerCase();
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
}

let pdfToText = null;
function extractPdf(buf) {
  pdfToText ||= require(paths.webMcp).pdfToText;
  return pdfToText(buf);
}

// Returns true when the request was for SAIAS Chat.
async function handle(req, res, pathname, prepareImage) {
  if (pathname !== '/saias/chat' && !pathname.startsWith('/saias/chat/')) return false;
  if (!localHost(req)) { fail(res, 403, 'SAIAS Chat is only available on this computer.'); return true; }
  if (pathname === '/saias/chat') {
    res.writeHead(302, { Location: '/saias/chat/' });
    res.end();
    return true;
  }
  const rest = pathname.slice('/saias/chat/'.length);
  try {
    if (rest.startsWith('api/')) {
      await api(req, res, rest.slice(4), prepareImage);
    } else {
      page(req, res, rest || 'index.html');
    }
  } catch (e) {
    if (!res.headersSent) fail(res, 500, e.message);
  }
  return true;
}

function page(req, res, name) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Method not allowed');
  const file = path.resolve(PAGE_DIR, decodeURIComponent(name));
  if (!file.startsWith(PAGE_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return fail(res, 404, 'Not found');
  send(res, 200, fs.readFileSync(file), TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
}

async function api(req, res, route, prepareImage) {
  if (route === 'images' || route.startsWith('images/')) return images(req, res, route, prepareImage);
  if (route === 'conversations' && req.method === 'GET') return send(res, 200, listConversations());

  const match = route.match(/^conversations\/([^/]+)$/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    if (!ID.test(id)) return fail(res, 400, 'Invalid conversation id');
    const file = path.join(DATA_DIR, `${id}.json`);
    if (req.method === 'GET') {
      if (!fs.existsSync(file)) return fail(res, 404, 'No such conversation');
      return send(res, 200, fs.readFileSync(file));
    }
    if (req.method === 'PUT') {
      const data = JSON.parse((await readBody(req)).toString('utf8'));
      if (!Array.isArray(data.messages)) return fail(res, 400, 'messages must be a list');
      writeJson(file, data);
      return send(res, 200, { saved: true });
    }
    if (req.method === 'DELETE') {
      const dir = path.join(IMAGE_DIR, id);
      if (image.busy(dir)) return fail(res, 409, 'Stop image generation before deleting this conversation.');
      fs.rmSync(file, { force: true });
      fs.rmSync(dir, { recursive: true, force: true });
      return send(res, 200, { deleted: true });
    }
  }

  if (route === 'settings') {
    if (req.method === 'GET') {
      let data = {};
      try { data = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { /* defaults */ }
      return send(res, 200, data);
    }
    if (req.method === 'PUT') {
      const data = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8'));
      const clean = {
        memory: String(data.memory || ''),
        system_prompt: String(data.system_prompt || ''),
        image_tool: data.image_tool !== false,
        tools: Array.isArray(data.tools) ? data.tools.map(String) : ['web_search', 'web_fetch', 'web_research'],
      };
      writeJson(SETTINGS, clean);
      return send(res, 200, clean);
    }
  }

  if (route === 'extract' && req.method === 'POST') {
    const buf = await readBody(req);
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') return fail(res, 400, 'Not a PDF file');
    const pdf = extractPdf(buf);
    if (!pdf?.text) return fail(res, 422, 'This PDF has no text layer that SAIAS can read (scanned pages need OCR).');
    return send(res, 200, { text: pdf.text, pages: pdf.pages });
  }

  return fail(res, 404, 'Not found');
}

async function images(req, res, route, prepare) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
    return fail(res, 403, 'Image generation is only available on this computer.');
  }
  if (route === 'images' && req.method === 'GET') return send(res, 200, image.status());
  if (route === 'images' && req.method === 'POST') {
    if (req.headers['x-saias'] !== '1') return fail(res, 403, 'Missing X-SAIAS header');
    const body = await readBody(req, 16 * 1024);
    let data;
    try { data = JSON.parse(body); } catch { return fail(res, 400, 'Invalid JSON'); }
    if (typeof data?.conversation !== 'string' || !ID.test(data.conversation)) return fail(res, 400, 'Invalid conversation id');
    const prompt = typeof data.prompt === 'string' ? data.prompt.trim() : '';
    if (!prompt || prompt.length > 2000 || prompt.includes('\0')) return fail(res, 400, 'Enter a prompt of 1–2,000 characters.');
    if (/<lora:/i.test(prompt)) return fail(res, 400, 'LoRA tags are not supported by saias-image.');

    const controller = new AbortController();
    const disconnect = () => controller.abort();
    res.once('close', disconnect);
    try {
      const result = await image.generate(prompt, path.join(IMAGE_DIR, data.conversation), { signal: controller.signal, prepare });
      return send(res, 200, result);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (!error.status) console.error('saias-image:', error.message);
      const message = error.name === 'TimeoutError' ? 'Image generation timed out.' : 'Image generation failed. See the SAIAS hub log.';
      return fail(res, error.status || 500, error.status ? error.message : message);
    } finally { res.off('close', disconnect); }
  }
  const [prefix, conversation, name, extra] = route.split('/');
  if (req.method === 'GET' && prefix === 'images' && !extra && conversation && name) {
    let id;
    try { id = decodeURIComponent(conversation); } catch { return fail(res, 400, 'Invalid conversation id'); }
    if (ID.test(id) && PNG.test(name)) {
      try { return send(res, 200, fs.readFileSync(path.join(IMAGE_DIR, id, name)), 'image/png'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return fail(res, 404, 'Image not found');
}

module.exports = { handle, DATA_DIR };
