'use strict';

// Catalog, resolver, server arguments, reasoning translation and config editing. No model is run.

const test = require('node:test');
const assert = require('node:assert/strict');

const catalogs = require('../src/catalog');
const { resolveProfile, recommended } = require('../src/resolve');
const llama = require('../src/llama');
const { withoutSaiasTables } = require('../src/integrations/codex');

const catalog = catalogs.bundled();
const hw = (extra = {}) => ({ platform: 'win32-x64', ramGB: 16, cpu: 'test', threads: 8, nvidia: [], ...extra });

test('the bundled catalog is valid', () => {
  assert.equal(catalog.schema, 1);
  assert.ok(Object.keys(catalog.profiles).length >= 3);
});

test('catalog validation rejects a runtime that cannot run the model', () => {
  const broken = structuredClone(catalog);
  broken.profiles.smart.variants[0].runtime = 'unsloth-b12631-cuda12-win-x64'; // no ptq1_0 support
  assert.throws(() => catalogs.validate(broken), /lacks "ptq1_0"/);
});

test('variants follow the hardware', () => {
  assert.equal(resolveProfile(catalog, 'smart', hw({ nvidia: [{ name: 'RTX', vramGB: 12 }] })).variant.id, 'smart-cuda');
  assert.equal(resolveProfile(catalog, 'smart', hw()).variant.id, 'smart-vulkan');
  assert.match(resolveProfile(catalog, 'pro', hw()).error, /NVIDIA/);
  assert.deepEqual(recommended(catalog, hw()), ['flash']); // smart-vulkan is marked slow
  assert.deepEqual(recommended(catalog, hw({ ramGB: 48, nvidia: [{ name: 'RTX', vramGB: 12 }] })), ['flash', 'smart', 'pro']);
  assert.match(resolveProfile(catalog, 'flash', hw({ platform: 'linux-x64' })).error, /win32-x64/);
});

test('server arguments come from the variant', () => {
  const variant = catalog.profiles.flash.variants[0];
  const args = llama.serverArgs({ alias: 'saias-flash', port: 9000, variant, device: 'none', files: { model: 'm.gguf' }, template: null });
  assert.deepEqual(args.slice(0, 8), ['--model', 'm.gguf', '--alias', 'saias-flash', '--host', '127.0.0.1', '--port', '9000']);
  assert.equal(args[args.indexOf('--device') + 1], 'none');
  assert.equal(args[args.indexOf('--n-gpu-layers') + 1], '0'); // CPU fallback
  assert.ok(args.includes('--jinja') && !args.includes('true'));
});

test('reasoning levels are translated for each API', () => {
  const pro = catalog.profiles.pro.variants[0];
  const flash = catalog.profiles.flash.variants[0];
  const smart = catalog.profiles.smart.variants[0];
  assert.deepEqual(llama.applyReasoning({ reasoning_effort: 'high' }, pro).chat_template_kwargs, { reasoning_effort: 'high' });
  assert.deepEqual(llama.applyReasoning({ reasoning: { effort: 'low' } }, pro).chat_template_kwargs, { reasoning_effort: 'low' });
  assert.deepEqual(llama.applyReasoning({ thinking: { type: 'disabled' } }, flash).chat_template_kwargs, { enable_thinking: false });
  assert.deepEqual(llama.applyReasoning({ reasoning_effort: 'xhigh' }, smart).chat_template_kwargs, { reasoning_effort: 'high' }); // nearest
  assert.deepEqual(llama.applyReasoning({ reasoning_effort: 'none', chat_template_kwargs: { x: 1 } }, pro).chat_template_kwargs, { reasoning_effort: 'none', x: 1 });
  assert.equal(llama.applyReasoning({ messages: [] }, pro).chat_template_kwargs, undefined);
  assert.equal('reasoning_effort' in llama.applyReasoning({ reasoning_effort: 'low' }, pro), false);
});

test('codex config: SAIAS tables are replaced, other settings kept', () => {
  const toml = 'model = "x"\n\n[a]\nk = 1\n\n# Added by SAIAS: note\n[model_providers.saias]\nname = "old"\n\n[profiles.saias]\nmodel = "old"\n\n[b]\nk = 2\n';
  const out = withoutSaiasTables(toml);
  assert.ok(!out.includes('saias'));
  assert.ok(out.includes('[a]') && out.includes('[b]') && out.includes('model = "x"'));
});
