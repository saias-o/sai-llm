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
  assert.deepEqual(recommended(catalog, hw()), ['omni', 'flash', 'smart']); // compatible, even if slow
  // 8 GB of RAM and a small NVIDIA GPU: flash, and smart on the CPU from memory-mapped weights.
  const laptop = hw({ ramGB: 8, nvidia: [{ name: 'MX450', vramGB: 2 }] });
  assert.equal(resolveProfile(catalog, 'smart', laptop).variant.id, 'smart-cpu-lowmem');
  assert.deepEqual(recommended(catalog, laptop), ['omni', 'flash', 'smart']);
  assert.deepEqual(recommended(catalog, hw({ ramGB: 4 })), ['flash']);
  const lowmem = llama.serverArgs({ alias: 'saias-smart', port: 1, variant: resolveProfile(catalog, 'smart', laptop).variant, files: { model: 'm.gguf' } }).join(' ');
  assert.match(lowmem, /--device none/);
  assert.match(lowmem, /--n-gpu-layers 0/);
  assert.deepEqual(recommended(catalog, hw({ ramGB: 48, nvidia: [{ name: 'RTX', vramGB: 12 }] })), ['omni', 'flash', 'smart', 'pro']);
  const omni = resolveProfile(catalog, 'omni', laptop);
  assert.equal(omni.model.vision, true);
  assert.ok(omni.model.files.mmproj);
  assert.equal(resolveProfile(catalog, 'flash', hw({ platform: 'linux-x64' })).variant.id, 'flash-vulkan-linux');
  assert.equal(resolveProfile(catalog, 'smart', hw({ platform: 'darwin-arm64' })).variant.id, 'smart-metal');
  assert.match(resolveProfile(catalog, 'pro', hw({ platform: 'darwin-arm64' })).error, /48 GB RAM/);
  assert.match(resolveProfile(catalog, 'flash', hw({ platform: 'freebsd-x64' })).error, /not available on freebsd-x64/);
});

test('server arguments come from the variant', () => {
  const variant = catalog.profiles.flash.variants[0];
  const args = llama.serverArgs({ alias: 'saias-flash', port: 9000, variant, device: 'none', files: { model: 'm.gguf' }, template: null });
  assert.deepEqual(args.slice(0, 8), ['--model', 'm.gguf', '--alias', 'saias-flash', '--host', '127.0.0.1', '--port', '9000']);
  assert.equal(args[args.indexOf('--device') + 1], 'none');
  assert.equal(args[args.indexOf('--n-gpu-layers') + 1], '0'); // CPU fallback
  assert.ok(args.includes('--jinja') && !args.includes('true'));
  for (const flash of catalog.profiles.flash.variants) {
    const flags = llama.serverArgs({ alias: 'saias-flash', port: 9000, variant: flash, files: { model: 'm.gguf' } });
    assert.equal(flags[flags.indexOf('--reasoning-budget') + 1], '512');
    assert.deepEqual(JSON.parse(flags[flags.indexOf('--chat-template-kwargs') + 1]), { enable_thinking: false });
  }
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
  const omni = catalog.profiles.omni.variants[0];
  assert.deepEqual(llama.applyReasoning({}, omni, omni.reasoning.default).chat_template_kwargs, { enable_thinking: true });
  assert.deepEqual(llama.applyReasoning({ thinking: { type: 'disabled' } }, omni, omni.reasoning.default).chat_template_kwargs, { enable_thinking: false });
});

test('Flash limits explicit Anthropic budgets while preserving the requested reasoning mode', () => {
  const flash = catalog.profiles.flash.variants[0];
  assert.equal(flash.reasoning.enforceBudget, true);
  const budget = flash.server['reasoning-budget'];
  const high = { thinking: { type: 'enabled', budget_tokens: 16000 } };
  const translated = llama.applyReasoning(high, flash);
  const limited = llama.limitThinkingBudget(translated, budget);
  assert.deepEqual(limited.thinking, { type: 'enabled', budget_tokens: 512 });
  assert.deepEqual(limited.chat_template_kwargs, { enable_thinking: true });
  assert.equal(high.thinking.budget_tokens, 16000);
  const small = { thinking: { type: 'enabled', budget_tokens: 128 } };
  assert.equal(llama.limitThinkingBudget(small, budget), small);
  assert.equal(llama.limitThinkingBudget(high, undefined), high);
});

test('system reminders move ahead of the conversation for Qwen', () => {
  const user = { role: 'user', content: [{ type: 'text', text: 'Describe this.' }, { type: 'image', source: {} }] };
  const assistant = { role: 'assistant', content: 'I can help.' };
  const reminder = { type: 'text', text: 'Keep replies short.' };
  const body = { system: 'You are Omni.', messages: [user, { role: 'system', content: [reminder] }, assistant] };
  assert.deepEqual(llama.mergeSystemMessages(body), {
    system: [{ type: 'text', text: 'You are Omni.' }, reminder],
    messages: [user, assistant],
  });
  assert.equal(body.messages.length, 3);
});
test('codex config: SAIAS tables are replaced, other settings kept', () => {
  const toml = 'model = "x"\n\n[a]\nk = 1\n\n# Added by SAIAS: note\n[model_providers.saias]\nname = "old"\n\n[profiles.saias]\nmodel = "old"\n\n[b]\nk = 2\n';
  const out = withoutSaiasTables(toml);
  assert.ok(!out.includes('saias'));
  assert.ok(out.includes('[a]') && out.includes('[b]') && out.includes('model = "x"'));
});
