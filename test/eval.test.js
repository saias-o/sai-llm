'use strict';

// Validates the evaluation suites and the benchmark against a fake server: no model is run.
// Run: node --test

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.SAIAS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'saias-test-'));

const { startMock } = require('./mock-server');
const evaluation = require('../src/eval');
const bench = require('../src/bench');
const { runTests } = require('../src/eval/sandbox');

const quiet = fn => async (...args) => {
  const log = console.log;
  console.log = () => {};
  try { return await fn(...args); } finally { console.log = log; }
};

test('every task scores 100% with its reference answer', async () => {
  const mock = await startMock({ mode: 'reference' });
  try {
    const report = await quiet(evaluation.run)({ endpoint: mock.endpoint, model: 'mock', context: 200000, out: path.join(process.env.SAIAS_HOME, 'ref.json') });
    const failed = report.results.filter(r => !r.skipped && r.score !== 1).map(r => `${r.id}: ${r.detail}`);
    assert.deepEqual(failed, []);
    assert.equal(report.overall, 1);
    assert.equal(report.results.filter(r => r.skipped).length, 0);
  } finally { await mock.close(); }
});

test('wrong answers never score 100%', async () => {
  const mock = await startMock({ mode: 'wrong' });
  try {
    const report = await quiet(evaluation.run)({ endpoint: mock.endpoint, model: 'mock', context: 200000, out: path.join(process.env.SAIAS_HOME, 'wrong.json') });
    const perfect = report.results.filter(r => r.score === 1).map(r => r.id);
    assert.deepEqual(perfect, []);
    assert.ok(report.overall < 0.2, `overall ${report.overall}`);
  } finally { await mock.close(); }
});

test('context tasks larger than the model context are skipped', async () => {
  const mock = await startMock({ mode: 'reference' });
  try {
    const report = await quiet(evaluation.run)({ endpoint: mock.endpoint, model: 'mock', context: 20000, suite: 'context', out: path.join(process.env.SAIAS_HOME, 'ctx.json') });
    const skipped = report.results.filter(r => r.skipped).map(r => r.id);
    assert.deepEqual(skipped, ['context.needle-64k', 'context.combine-64k', 'context.needle-128k', 'context.combine-128k']);
  } finally { await mock.close(); }
});

test('the code sandbox blocks file writes and stops endless loops', async () => {
  const write = await runTests(`function f() { require('fs').writeFileSync('saias-sandbox-test.txt', 'x'); return 1; }`, { entry: 'f', tests: [{ args: [], expected: 1 }] });
  assert.equal(write.passed, 0);
  assert.equal(fs.existsSync('saias-sandbox-test.txt'), false);
  const loop = await runTests('function g() { for (;;) {} }', { entry: 'g', tests: [{ args: [], expected: 1 }] }, 2000);
  assert.equal(loop.passed, 0);
});

test('the benchmark reads llama-server timings', async () => {
  const mock = await startMock({ promptTps: 812.5, genTps: 6.2 });
  try {
    const [r] = await quiet(bench.run)({ endpoint: mock.endpoint, model: 'mock', context: 32768 });
    assert.equal(r.genTps, 6.2);
    assert.deepEqual(r.promptTps, { 512: 812.5, 4096: 812.5, 16384: 812.5 });
    assert.equal(r.rating, 'slow');
    const gen = mock.requests.find(q => q.body.ignore_eos);
    assert.equal(gen.body.max_tokens, 256);
    assert.equal(gen.body.cache_prompt, false);
  } finally { await mock.close(); }
});

test('ratings and advice', () => {
  assert.equal(bench.rate(25), 'fast');
  assert.equal(bench.rate(10), 'usable');
  assert.equal(bench.rate(3), 'slow');
  const lines = bench.advice([
    { model: 'saias-pro', rating: 'slow', genTps: 4, promptTps: { 4096: 150 } },
    { model: 'saias-smart', rating: 'fast', genTps: 30, promptTps: { 4096: 900 } },
  ]);
  assert.ok(lines.some(l => l.includes('Best interactive choice on this PC: saias-smart')));
  assert.ok(lines.some(l => l.includes('reads prompts at 150')));
});
