'use strict';

// saias eval: agent-focused evaluation of a SAIAS profile or any OpenAI-compatible endpoint.
// Suites: tools (tool calling and multi-step use), code (JavaScript with hidden tests),
// context (retrieval in long inputs), instruct (strict formats and system rules).
// Reports are saved as JSON so candidate models can be compared before they enter the catalog.

const fs = require('node:fs');
const path = require('node:path');
const paths = require('../paths');
const ui = require('../ui');
const { chat } = require('./client');

const SUITES = {
  tools: require('./suites/tools'),
  code: require('./suites/code'),
  context: require('./suites/context'),
  instruct: require('./suites/instruct'),
};

function selectTasks(opts) {
  const names = opts.suite ? String(opts.suite).split(/[,\s]+/).filter(Boolean) : Object.keys(SUITES);
  for (const n of names) if (!SUITES[n]) throw new Error(`Unknown suite "${n}". Suites: ${Object.keys(SUITES).join(', ')}`);
  const only = opts.task ? String(opts.task).split(',') : null;
  return names.flatMap(n => SUITES[n].map(t => ({ ...t, suite: n }))).filter(t => !only || only.some(o => t.id.includes(o)));
}

// Target: a SAIAS profile through the hub, or --endpoint/--model for a candidate on any server.
async function resolveTarget(opts) {
  if (opts.endpoint) {
    if (!opts.model) throw new Error('--endpoint needs --model');
    return { endpoint: String(opts.endpoint).replace(/\/$/, ''), model: opts.model, contextLength: Number(opts.context) || 32768, label: opts.model };
  }
  const installed = require('../installed');
  const model = installed.pickModel(installed.requireInstalled(), opts.profile);
  await require('../hub-client').ensureRunning();
  const catalog = require('../catalog').installed();
  return {
    endpoint: `${installed.HUB_URL}/v1`, model: model.id, contextLength: Number(opts.context) || model.context,
    label: model.id, modelName: model.name, catalogVersion: catalog?.version,
  };
}

function requestDefaults(opts) {
  const d = {};
  if (opts.reasoning) d.reasoning_effort = opts.reasoning;
  if (opts.temperature !== undefined) d.temperature = Number(opts.temperature);
  if (opts.maxTokens) d.max_tokens = Number(opts.maxTokens);
  return d;
}

async function runTask(task, target, defaults) {
  if (task.tokens && task.tokens > target.contextLength * 0.9) return { skipped: `needs ${task.tokens} tokens of context` };
  const ask = body => chat(target, { ...defaults, ...body });
  const started = Date.now();
  try {
    const result = task.run ? await task.run(ask) : await task.score(await ask(task.request()));
    return { ...result, ms: Date.now() - started };
  } catch (e) {
    return { score: 0, detail: `error: ${e.message}`, ms: Date.now() - started };
  }
}

function summarize(results) {
  const scored = results.filter(r => !r.skipped);
  const mean = list => (list.length ? list.reduce((s, r) => s + r.score, 0) / list.length : null);
  const suites = {};
  for (const r of scored) (suites[r.suite] ||= []).push(r);
  return {
    overall: mean(scored),
    suites: Object.fromEntries(Object.entries(suites).map(([n, list]) => [n, { score: mean(list), tasks: list.length }])),
  };
}

const pct = v => (v === null ? '  n/a' : `${Math.round(v * 100)}%`.padStart(5));

async function run(opts) {
  const tasks = selectTasks(opts);
  if (opts.list) { for (const t of tasks) ui.info(`${t.id.padEnd(28)} ${t.title}`); return null; }
  const target = await resolveTarget(opts);
  const defaults = requestDefaults(opts);
  const repeat = Math.max(1, Number(opts.repeat) || 1);
  ui.step(`Evaluating ${target.label}${target.modelName ? ` (${target.modelName})` : ''}: ${tasks.length} tasks${repeat > 1 ? ` x ${repeat}` : ''}`);
  const started = Date.now();
  const results = [];
  for (const task of tasks) {
    const runs = [];
    for (let i = 0; i < repeat; i++) runs.push(await runTask(task, target, defaults));
    const done = runs.filter(r => !r.skipped);
    const result = done.length
      ? { id: task.id, suite: task.suite, title: task.title, score: done.reduce((s, r) => s + r.score, 0) / done.length, detail: done[done.length - 1].detail, ms: Math.round(done.reduce((s, r) => s + r.ms, 0) / done.length) }
      : { id: task.id, suite: task.suite, title: task.title, skipped: runs[0].skipped };
    results.push(result);
    if (result.skipped) ui.info(`skip  ${task.id.padEnd(28)} ${result.skipped}`);
    else ui.info(`${pct(result.score)} ${task.id.padEnd(28)} ${(result.ms / 1000).toFixed(1).padStart(6)} s  ${String(result.detail || '').replace(/\s+/g, ' ').slice(0, 70)}`);
  }
  const summary = summarize(results);
  const report = {
    schema: 1, kind: 'saias-eval', date: new Date().toISOString(),
    target: { model: target.model, modelName: target.modelName, endpoint: target.endpoint, contextLength: target.contextLength, catalogVersion: target.catalogVersion },
    settings: { ...defaults, repeat },
    durationMs: Date.now() - started,
    ...summary,
    results,
  };
  ui.step('Summary');
  for (const [n, s] of Object.entries(summary.suites)) ui.info(`${n.padEnd(10)} ${pct(s.score)}  (${s.tasks} tasks)`);
  ui.info(`${'overall'.padEnd(10)} ${pct(summary.overall)}`);
  const out = opts.out ? path.resolve(opts.out) : path.join(paths.home, 'evals', `${report.date.replace(/[:.]/g, '-')}-${target.label.replace(/[^\w.-]+/g, '_')}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  ui.ok(`Report: ${out}`);
  return report;
}

module.exports = { run, SUITES, selectTasks, runTask, summarize };
