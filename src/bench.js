'use strict';

// saias bench: measures how fast each installed profile really runs on this PC.
//   load time         from the hub's load request to "loaded"
//   prompt speed      tokens/s reading prompts of several sizes (what agents and long chats feel)
//   generation speed  tokens/s writing a fixed-length answer
// Results are stored in state.json, shown by "saias status" and used for advice.

const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const paths = require('./paths');
const store = require('./store');
const ui = require('./ui');
const { chat } = require('./eval/client');
const { filler, CHARS_PER_TOKEN } = require('./eval/suites/context');

const PROMPT_SIZES = [512, 4096, 16384];
const GENERATED_TOKENS = 256;
const LOAD_TIMEOUT_MS = 15 * 60 * 1000;

// Generation speed thresholds (tokens/s) for interactive use.
function rate(genTps) {
  if (genTps >= 20) return 'fast';
  if (genTps >= 8) return 'usable';
  return 'slow';
}

async function hubJson(hubUrl, pathname, body) {
  const res = await fetch(`${hubUrl}${pathname}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  return res.json();
}

async function profileStatus(hubUrl, model) {
  const s = await hubJson(hubUrl, '/saias/status');
  return s.profiles.find(p => p.id === model)?.status;
}

// Loads a profile through the hub and returns the load time in seconds (null if it was loaded).
async function load(hubUrl, model, cold) {
  if ((await profileStatus(hubUrl, model)) === 'loaded') {
    if (!cold) return null;
    await hubJson(hubUrl, '/models/unload', { model });
  }
  const started = Date.now();
  await hubJson(hubUrl, '/models/load', { model });
  while (Date.now() - started < LOAD_TIMEOUT_MS) {
    await delay(500);
    const status = await profileStatus(hubUrl, model);
    if (status === 'loaded') return (Date.now() - started) / 1000;
    if (status === 'unloaded') throw new Error(`${model} failed to load (see ${path.join(paths.logs, model + '.log')})`);
  }
  throw new Error(`${model} did not load within ${LOAD_TIMEOUT_MS / 60000} minutes`);
}

function promptOf(tokens) {
  return filler(tokens, 42).join('\n') + '\n\nReply with OK.';
}

// Tokens per second from llama-server timings, or from usage and wall time on other servers.
function speed(res, kind) {
  if (res.timings) {
    const v = kind === 'prompt' ? res.timings.prompt_per_second : res.timings.predicted_per_second;
    if (Number.isFinite(v) && v > 0) return v;
  }
  const n = kind === 'prompt' ? res.usage.prompt_tokens : res.usage.completion_tokens;
  return n && res.ms ? n / (res.ms / 1000) : null;
}

async function measure(target, contextLength) {
  const base = { reasoning_effort: 'none', temperature: 0, cache_prompt: false };
  await chat(target, { ...base, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1 }); // warm-up
  const promptTps = {};
  for (const size of PROMPT_SIZES) {
    if (size > contextLength * 0.8) continue;
    const res = await chat(target, { ...base, messages: [{ role: 'user', content: promptOf(size) }], max_tokens: 1 });
    promptTps[size] = round(speed(res, 'prompt'));
    ui.info(`  prompt ${String(size).padStart(6)} tokens: ${promptTps[size] ?? '?'} tokens/s`);
  }
  const res = await chat(target, {
    ...base,
    messages: [{ role: 'user', content: 'Write a long, detailed story about a lighthouse keeper.' }],
    max_tokens: GENERATED_TOKENS,
    ignore_eos: true, // llama-server: always generate the full length
  });
  const genTps = round(speed(res, 'generation'));
  ui.info(`  generation: ${genTps ?? '?'} tokens/s`);
  return { promptTps, genTps };
}

const round = v => (v === null || v === undefined ? null : Math.round(v * 10) / 10);

function advice(results) {
  const lines = [];
  for (const r of results) {
    if (r.error) continue;
    if (r.rating === 'slow') lines.push(`${r.model} generates ${r.genTps} tokens/s here: fine for long background tasks, slow for chat.`);
    const p4k = r.promptTps[4096];
    if (p4k && p4k < 200) lines.push(`${r.model} reads prompts at ${p4k} tokens/s: agent tools that send large contexts will wait a long time.`);
  }
  const usable = results.filter(r => !r.error && r.rating !== 'slow');
  if (usable.length) lines.push(`Best interactive choice on this PC: ${usable[0].model}.`);
  return lines;
}

async function run(opts) {
  let targets;
  let hubUrl = null;
  if (opts.endpoint) {
    if (!opts.model) throw new Error('--endpoint needs --model');
    targets = [{ endpoint: String(opts.endpoint).replace(/\/$/, ''), model: opts.model, contextLength: Number(opts.context) || 32768 }];
  } else {
    const installed = require('./installed');
    const models = installed.requireInstalled();
    const chosen = opts.profile ? [installed.pickModel(models, opts.profile)] : models;
    await require('./hub-client').ensureRunning();
    hubUrl = installed.HUB_URL;
    targets = chosen.map(m => ({ endpoint: `${hubUrl}/v1`, model: m.id, profile: m.profile, contextLength: m.context }));
  }

  ui.step('Benchmark');
  ui.info('Each profile is loaded in turn; this takes a few minutes per model.');
  const results = [];
  for (const t of targets) {
    ui.info(`${t.model}:`);
    try {
      const loadSeconds = hubUrl ? await load(hubUrl, t.model, Boolean(opts.cold)) : null;
      if (loadSeconds !== null) ui.info(`  load: ${loadSeconds.toFixed(1)} s`);
      const m = await measure(t, t.contextLength);
      results.push({ model: t.model, profile: t.profile, loadSeconds: round(loadSeconds), ...m, rating: m.genTps ? rate(m.genTps) : 'unknown' });
    } catch (e) {
      ui.bad(`  ${e.message}`);
      results.push({ model: t.model, profile: t.profile, error: e.message });
    }
  }

  const date = new Date().toISOString();
  if (hubUrl) {
    const state = store.load();
    state.benchmarks ||= {};
    for (const r of results) {
      if (r.error || !r.profile) continue;
      state.benchmarks[r.profile] = { variant: state.profiles[r.profile]?.variant, date, loadSeconds: r.loadSeconds, promptTps: r.promptTps, genTps: r.genTps, rating: r.rating };
    }
    store.save(state);
  }
  const out = path.join(paths.home, 'benchmarks', `${date.replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ schema: 1, kind: 'saias-bench', date, results }, null, 2) + '\n');

  ui.step('Results');
  for (const r of results) {
    if (r.error) { ui.bad(`${r.model}: ${r.error}`); continue; }
    ui.info(`${r.model.padEnd(12)} ${String(r.genTps ?? '?').padStart(6)} tokens/s generation, ${String(r.promptTps[4096] ?? r.promptTps[512] ?? '?').padStart(7)} tokens/s prompt, ${r.rating}`);
  }
  for (const line of advice(results)) ui.info(line);
  ui.ok(`Report: ${out}`);
  return results;
}

module.exports = { run, rate, speed, advice };
