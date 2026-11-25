'use strict';

// Everything that knows about llama-server: probing a build, listing its devices, turning a
// catalog variant into command-line arguments, and translating reasoning levels.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REASONING_LEVELS } = require('./catalog');

// llama-server prints --version and --list-devices on stderr: return both streams.
function runBinary(exe, args) {
  const out = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  return `${out.stdout || ''}${out.stderr || ''}`;
}

// "version: 1.0.0-dev (build 12631, commit 59f66204f)" -> { build: 12631, commit: '59f66204f' }
function version(exe) {
  const m = runBinary(exe, ['--version']).match(/build (\d+), commit ([\w.-]+)/);
  return m ? { build: Number(m[1]), commit: m[2] } : null;
}

// "  Vulkan0: NVIDIA GeForce RTX 4070 (12010 MiB, 11242 MiB free)"
function listDevices(exe) {
  return runBinary(exe, ['--list-devices']).split(/\r?\n/).map(line => line.match(/^\s+(\w+\d+):\s*(.+?)\s*\((\d+) MiB/))
    .filter(Boolean).map(([, id, name, mib]) => ({ id, name, mib: Number(mib) }));
}

// The GPU backend a runtime folder was built for, from its ggml backend libraries.
function backendOf(dir) {
  const names = fs.readdirSync(dir).map(n => n.toLowerCase());
  if (names.some(n => n.startsWith('ggml-cuda'))) return 'cuda';
  if (names.some(n => n.startsWith('ggml-vulkan'))) return 'vulkan';
  if (names.some(n => n.startsWith('ggml-hip'))) return 'rocm';
  if (names.some(n => n.startsWith('ggml-metal'))) return 'metal';
  return 'cpu';
}

// Device choice for variants with "device": "auto": the GPU with the most memory, else CPU.
function pickDevice(devices) {
  const best = [...devices].sort((a, b) => b.mib - a.mib)[0];
  return best ? best.id : 'none';
}

function toArgs(options) {
  const args = [];
  for (const [key, value] of Object.entries(options)) {
    if (value === false || value === null || value === undefined) continue;
    args.push('--' + key);
    if (value === true) continue;
    args.push(typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  return args;
}

// Full llama-server command line for one profile.
// files: { model, mmproj? } absolute paths; template: absolute path or null.
function serverArgs({ alias, port, variant, device, files, template }) {
  const options = {
    model: files.model,
    mmproj: files.mmproj,
    'chat-template-file': template,
    alias,
    host: '127.0.0.1',
    port,
    ...variant.server,
  };
  if (variant.device === 'auto') {
    options.device = device || 'none';
    if (options.device === 'none') options['n-gpu-layers'] = 0;
  }
  return toArgs(options);
}

// Maps an OpenAI-style reasoning_effort onto the chat template arguments a model understands.
// Unsupported levels fall back to the nearest supported one. Returns the request body to send.
function applyReasoning(body, variant) {
  const spec = variant.reasoning;
  if (!spec || body.reasoning_effort === undefined) return body;
  const wanted = String(body.reasoning_effort).toLowerCase();
  const out = { ...body };
  delete out.reasoning_effort;
  const supported = Object.keys(spec.levels);
  let level = supported.includes(wanted) ? wanted : null;
  if (!level) {
    const rank = REASONING_LEVELS.indexOf(wanted === 'max' ? 'xhigh' : wanted);
    if (rank < 0) return out;
    level = supported.map(l => [l, Math.abs(REASONING_LEVELS.indexOf(l) - rank)]).sort((a, b) => a[1] - b[1])[0][0];
  }
  // Explicit chat_template_kwargs from the client win over the mapped ones.
  out.chat_template_kwargs = { ...spec.levels[level], ...(body.chat_template_kwargs || {}) };
  return out;
}

function templatePath(root, model) {
  return model.template ? path.join(root, model.template) : null;
}

module.exports = { version, listDevices, backendOf, pickDevice, serverArgs, applyReasoning, templatePath, toArgs };
