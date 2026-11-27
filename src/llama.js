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

// The reasoning level a request asks for, in any of the APIs the hub serves:
//   Chat Completions  reasoning_effort: "high"
//   Responses (Codex) reasoning: { effort: "high" }
//   Messages (Claude) thinking: { type: "enabled", budget_tokens: 8000 } or { type: "disabled" }
function requestedLevel(body) {
  if (body.reasoning_effort !== undefined) return String(body.reasoning_effort).toLowerCase();
  if (body.reasoning?.effort) return String(body.reasoning.effort).toLowerCase();
  if (body.thinking?.type === 'disabled') return 'none';
  if (body.thinking?.type === 'enabled') {
    const budget = Number(body.thinking.budget_tokens) || 0;
    return budget >= 24000 ? 'xhigh' : budget >= 12000 ? 'high' : budget >= 4000 ? 'medium' : 'low';
  }
  return null;
}

// Maps the requested reasoning level onto the chat template arguments the model behind the
// profile understands. Unsupported levels fall back to the nearest supported one. Explicit
// chat_template_kwargs from the client win. Returns the request body to send.
function applyReasoning(body, variant, defaultLevel) {
  const spec = variant.reasoning;
  const wanted = requestedLevel(body) ?? defaultLevel;
  if (!spec || !wanted) return body;
  const out = { ...body };
  delete out.reasoning_effort;
  const supported = Object.keys(spec.levels);
  let level = supported.includes(wanted) ? wanted : null;
  if (!level) {
    const rank = REASONING_LEVELS.indexOf(wanted === 'max' ? 'xhigh' : wanted);
    if (rank < 0) return out;
    level = supported.map(l => [l, Math.abs(REASONING_LEVELS.indexOf(l) - rank)]).sort((a, b) => a[1] - b[1])[0][0];
  }
  out.chat_template_kwargs = { ...spec.levels[level], ...(body.chat_template_kwargs || {}) };
  return out;
}

// Claude Code can put system reminders between messages. Qwen's template
// accepts system text only at the beginning, so retain it in the Messages API's
// top-level system field without changing the order of the user and tool turns.
function mergeSystemMessages(body) {
  if (!Array.isArray(body.messages) || !body.messages.some(message => message?.role === 'system')) return body;
  const blocks = content => typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  return {
    ...body,
    system: [...blocks(body.system), ...body.messages.filter(message => message?.role === 'system').flatMap(message => blocks(message.content))],
    messages: body.messages.filter(message => message?.role !== 'system'),
  };
}

function templatePath(root, model) {
  return model.template ? path.join(root, model.template) : null;
}

module.exports = { version, listDevices, backendOf, pickDevice, serverArgs, applyReasoning, requestedLevel, mergeSystemMessages, templatePath, toArgs };
