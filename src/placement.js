'use strict';

// Where a profile runs on this PC: which GPUs hold the model, and where its vision encoder goes.
//
// llama.cpp sizes the layers and the context for the memory each GPU has (--fit). SAIAS chooses
// the devices. Memory alone does not say which GPU is faster: an integrated GPU can report more
// shared memory than a dedicated one that runs twice as fast. So SAIAS asks llama-fit-params how
// each arrangement fits (a few seconds, nothing is loaded), then starts llama-server with the ones
// worth trying, measures a real turn, and keeps the fastest arrangement that works.
//
//   1. Text: each GPU alone and all GPUs together, the vision encoder left out.
//   2. Vision (models with an mmproj): the best text devices, with the encoder on each GPU or on
//      the CPU. Its memory is reserved on its GPU, so the layers are fitted around it.
//
// A placement is stored per profile in state.json and reused by the hub; llama.cpp still fits
// the layers to the memory free at each start. "saias tune" measures again.

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const llama = require('./llama');
const { filler } = require('./eval/suites/context');

const MARGIN_MIB = 512;        // memory left free on each GPU for the system and other apps
const RETRY_MIB = 1024;        // more margin when an arrangement crashed: some GPUs report memory they do not have
const VISION_FACTOR = 1.4;     // vision encoder: weights plus working buffers (llama.cpp: 889 MiB for a 641 MiB file)
const MIN_SHARE = 0.5;         // an arrangement offloading less than half of the best one is not tried
const TURN = { prompt: 2048, answer: 128, images: 0.5 }; // the turn arrangements are compared on
const LOAD_TIMEOUT_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const TRIAL_PROMPT_TOKENS = 512;
const TRIAL_ANSWER_TOKENS = 64;

// "Vulkan0=AMD Radeon(TM) Graphics=4037|Vulkan1=NVIDIA GeForce MX450=2120": a placement is
// measured again when the GPUs change.
function signature(devices) {
  return devices.map(d => `${d.id}=${d.name}=${d.mib}`).join('|');
}

function fitParamsPath(serverExe) {
  const exe = path.join(path.dirname(serverExe), 'llama-fit-params' + path.extname(serverExe));
  return fs.existsSync(exe) ? exe : null;
}

// Memory the vision encoder needs on a GPU, in MiB.
function visionMiB(mmprojBytes) {
  return Math.ceil((mmprojBytes / 1024 ** 2) * VISION_FACTOR);
}

// The fit target of each device of a text arrangement: the margin (base), plus the vision
// encoder on the GPU that holds it.
function fitTarget(devices, vision, mmprojMiB, base = devices.map(() => MARGIN_MIB)) {
  return devices.map((id, i) => base[i] + (id === vision ? mmprojMiB : 0));
}

// llama-fit-params prints the fitted arguments on stdout ("-c 32768 -ngl 26 -ts 24,2") and its
// reasoning on stderr, where "n_layer=33" gives the model's layer count when it had to reduce.
function parseFit(stdout, stderr = '') {
  const ngl = stdout.match(/-ngl (-?\d+)/);
  if (!ngl) return null;
  const counts = [...stderr.matchAll(/n_layer=\s*(\d+)/g)].map(m => Number(m[1]));
  const total = counts.length ? Math.max(...counts) : null;
  const layers = Number(ngl[1]);
  const all = layers < 0 || (total !== null && layers >= total);
  return { all, layers: all ? total : layers, total, share: all ? 1 : total ? layers / total : null };
}

// Options of the variant that change how much memory the model needs.
function fitOptions(variant, files) {
  const s = variant.server;
  const options = { model: files.model };
  for (const key of ['ctx-size', 'parallel', 'batch-size', 'ubatch-size', 'flash-attn', 'cache-type-k', 'cache-type-v']) {
    if (s[key] !== undefined) options[key] = s[key];
  }
  return options;
}

function fit(fitExe, variant, files, devices, target) {
  const ctx = variant.server['ctx-size'];
  const args = llama.toArgs({
    ...fitOptions(variant, files),
    device: devices.join(','),
    'fit-target': target.join(','),
    ...(ctx ? { 'fit-ctx': ctx } : {}),
    'log-verbosity': 4, // prints the layer counts it tries (n_layer=33)
  });
  const out = spawnSync(fitExe, args, { cwd: path.dirname(fitExe), encoding: 'utf8', windowsHide: true, timeout: 120000 });
  return parseFit(out.stdout || '', out.stderr || '');
}

// Text arrangements: each GPU alone, then all of them together, the one with the most free
// memory first.
function deviceSets(gpus) {
  const sorted = [...gpus].sort((a, b) => b.free - a.free);
  const sets = sorted.map(g => [g.id]);
  if (sorted.length > 1) sets.push(sorted.map(g => g.id));
  return sets;
}

// Drops the arrangements that offload much less than the best one: on this machine they cannot
// win. Arrangements whose share is unknown are kept.
function prune(candidates) {
  const best = Math.max(0, ...candidates.map(c => c.fit.share ?? 0));
  return candidates.filter(c => c.fit.share === null || c.fit.share >= best * MIN_SHARE);
}

// Seconds for the reference turn: lower is better.
function score(m, vision) {
  return TURN.prompt / m.promptTps + TURN.answer / m.genTps + (vision ? TURN.images * m.imageSeconds : 0);
}

// A 1024 x 1024 gradient, as a PNG: about 1,000 image tokens, like a phone photo or screenshot.
function testImage(size = 1024) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    for (let x = 0; x < size; x++) {
      const i = row + 1 + x * 3;
      raw[i] = (x * 255) / size;
      raw[i + 1] = (y * 255) / size;
      raw[i + 2] = ((x + y) * 127) / size;
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bits per channel
  header[9] = 2; // RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function post(port, body) {
  const started = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ temperature: 0, cache_prompt: false, ...body }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
  return { timings: json.timings || {}, seconds: (Date.now() - started) / 1000 };
}

// Starts llama-server with a placement, measures one text turn (and one image), stops it.
// -> { promptTps, genTps, imageSeconds? } or throws with the reason it failed.
async function trial({ exe, alias, variant, files, template, placement, logFile }) {
  const port = await freePort();
  const args = llama.serverArgs({ alias, port, variant, placement, files, template });
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, 'a');
  let proc;
  try {
    fs.writeSync(fd, `
==== ${new Date().toISOString()} ${args.join(' ')}
`);
    proc = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true, stdio: ['ignore', fd, fd] });
  } finally {
    fs.closeSync(fd);
  }
  let exited = null;
  proc.on('exit', code => { exited = code ?? 1; });
  proc.on('error', () => { exited = 1; });
  const crashed = () => Object.assign(new Error(`llama-server stopped (code ${exited}); log: ${logFile}`), { crashed: true });
  try {
    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    for (;;) {
      if (exited !== null) throw crashed();
      if (Date.now() > deadline) throw new Error('took too long to load');
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })).ok) break;
      } catch { /* still loading */ }
      await delay(500);
    }
    const guard = async request => {
      try { return await request; } catch (e) {
        for (let i = 0; i < 12 && exited === null; i++) await delay(250); // a crash closes the connection first
        throw exited !== null ? crashed() : e;
      }
    };
    const text = await guard(post(port, {
      messages: [{ role: 'user', content: filler(TRIAL_PROMPT_TOKENS, 7).join('\n') + '\n\nSummarize this log.' }],
      max_tokens: TRIAL_ANSWER_TOKENS,
      ignore_eos: true,
    }));
    const result = { promptTps: text.timings.prompt_per_second, genTps: text.timings.predicted_per_second };
    if (!(result.promptTps > 0 && result.genTps > 0)) throw new Error('no timings in the reply');
    if (files.mmproj) {
      const image = await guard(post(port, {
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'What colors are in this image?' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${testImage().toString('base64')}` } },
        ] }],
        max_tokens: 1,
      }));
      result.imageSeconds = image.seconds;
    }
    return result;
  } finally {
    if (exited === null) {
      proc.kill();
      for (let i = 0; i < 40 && exited === null; i++) await delay(250);
    }
  }
}

function describe(placement, devices) {
  const name = id => devices.find(d => d.id === id)?.name || id;
  const text = placement.devices.length ? placement.devices.map(name).join(' + ') : 'the CPU';
  if (placement.vision === undefined) return text;
  return `${text}, vision on ${placement.vision === 'none' ? 'the CPU' : name(placement.vision)}`;
}

// Chooses the placement of one profile. ui: { info, ok, bad }.
// -> placement { devices, vision?, fitTarget, signature, measured?, layers? } or null when this
// runtime cannot plan (no GPU, or no llama-fit-params): llama-server then fits on its own.
async function plan({ exe, alias, variant, files, template, mmprojBytes, logDir, ui }) {
  const devices = llama.listDevices(exe).map(d => ({ ...d, free: d.free ?? d.mib }));
  const fitExe = fitParamsPath(exe);
  if (!devices.length || !fitExe) return null;
  const sig = signature(devices);
  const vision = Boolean(files.mmproj);
  const mmMiB = vision ? visionMiB(mmprojBytes) : 0;
  const logFile = path.join(logDir, `${alias}-tune.log`);
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(logFile, '');
  // Measures one arrangement; a crash is tried once more with a larger margin.
  // Text arrangements are measured without the vision encoder, which is placed afterwards.
  // -> { m, placement } (the placement that worked) or null.
  const run = async (placement, label, withVision = vision) => {
    ui.info(`  trying ${label}...`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const m = await trial({ exe, alias, variant, files: withVision ? files : { model: files.model }, template, placement, logFile });
        ui.info(`    ${m.promptTps.toFixed(0)} tokens/s prompt, ${m.genTps.toFixed(1)} tokens/s generation${m.imageSeconds !== undefined ? `, image in ${m.imageSeconds.toFixed(1)} s` : ''}`);
        return { m, placement };
      } catch (e) {
        ui.info(`    failed: ${e.message}`);
        if (!e.crashed || attempt || !placement.devices.length) return null;
        placement = { ...placement, fitTarget: placement.fitTarget.map(t => t + RETRY_MIB) };
        ui.info(`    again with ${RETRY_MIB} MiB more left free on each GPU...`);
      }
    }
    return null;
  };

  // 1. Text.
  const textCandidates = prune(deviceSets(devices).map(set => {
    const target = fitTarget(set, null, 0);
    return { devices: set, fitTarget: target, fit: fit(fitExe, variant, files, set, target) };
  }).filter(c => c.fit));
  if (!textCandidates.length) return null;
  const measured = [];
  if (textCandidates.length > 1) {
    ui.info(`${alias}: comparing ${textCandidates.length} GPU arrangements (one load each)`);
    for (const c of textCandidates) {
      const tried = await run({ devices: c.devices, fitTarget: c.fitTarget }, describe(c, devices), false);
      if (tried) measured.push({ ...c, fitTarget: tried.placement.fitTarget, m: tried.m });
    }
    measured.sort((a, b) => score(a.m, false) - score(b.m, false));
  }
  const best = measured[0] || textCandidates[0];

  // 2. Vision: on a GPU (layers refitted around it) or on the CPU.
  const finalists = [];
  if (vision) {
    for (const gpu of [...devices].sort((a, b) => b.free - a.free)) {
      const target = fitTarget(best.devices, gpu.id, mmMiB, best.fitTarget);
      if (!best.devices.includes(gpu.id) && gpu.free < MARGIN_MIB + mmMiB) continue;
      const f = fit(fitExe, variant, files, best.devices, target);
      if (f) finalists.push({ devices: best.devices, vision: gpu.id, fitTarget: target, fit: f });
    }
    finalists.push({ devices: best.devices, vision: 'none', fitTarget: best.fitTarget, fit: best.fit });
  } else {
    finalists.push(best);
  }

  // On a single GPU that keeps every layer with the encoder there too, moving the encoder cannot
  // help: that arrangement is tried alone. With several GPUs the encoder shifts the split of the
  // layers, so every option is measured.
  const dominant = vision && best.devices.length === 1
    && finalists.find(f => f.vision === best.devices[0] && f.fit.all && best.fit.all);
  const order = dominant ? [dominant, ...finalists.filter(f => f !== dominant)] : finalists;
  if (vision) ui.info(`${alias}: placing the vision encoder`);
  let chosen = null;
  for (const f of order) {
    const planned = { devices: f.devices, fitTarget: f.fitTarget, ...(vision ? { vision: f.vision } : {}) };
    const tried = (!vision && measured.length && f === best) ? { m: best.m, placement: planned } : await run(planned, describe(planned, devices));
    if (!tried) continue;
    const s = score(tried.m, vision);
    if (!chosen || s < chosen.score) chosen = { placement: tried.placement, m: tried.m, score: s, fit: f.fit };
    if (f === dominant) break;
  }
  if (!chosen) throw new Error(`${alias} could not run on any GPU arrangement; see ${logFile}`);
  const round = v => Math.round(v * 10) / 10;
  return {
    ...chosen.placement,
    summary: describe(chosen.placement, devices),
    signature: sig,
    layers: chosen.fit.all ? 'all' : chosen.fit.layers,
    measured: {
      promptTps: round(chosen.m.promptTps),
      genTps: round(chosen.m.genTps),
      ...(chosen.m.imageSeconds !== undefined ? { imageSeconds: round(chosen.m.imageSeconds) } : {}),
    },
  };
}

module.exports = { plan, describe, signature, parseFit, prune, deviceSets, fitTarget, visionMiB, score, testImage, MARGIN_MIB };
