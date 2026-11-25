'use strict';

// Adds a "saias" provider to OpenCode's global config (~/.config/opencode/opencode.json).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ui = require('../ui');
const { HUB_URL } = require('../installed');
const { which, backup } = require('./util');

const CONFIG = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode', 'opencode.json');

function detect() {
  return Boolean(which('opencode')) || fs.existsSync(CONFIG);
}

async function configure({ models, yes }) {
  ui.step('OpenCode');
  let config = {};
  if (fs.existsSync(CONFIG)) {
    try {
      config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    } catch (e) {
      ui.bad(`${CONFIG} is not plain JSON (${e.message}); add the provider by hand (see README).`);
      return;
    }
  }
  config.$schema ||= 'https://opencode.ai/config.json';
  config.provider ||= {};
  config.provider.saias = {
    npm: '@ai-sdk/openai-compatible',
    name: 'SAIAS (local)',
    options: { baseURL: `${HUB_URL}/v1` },
    models: Object.fromEntries(models.map(m => [m.id, {
      name: m.id,
      tool_call: true,
      reasoning: m.reasoning,
      attachment: m.vision,
      modalities: { input: m.vision ? ['text', 'image'] : ['text'], output: ['text'] },
      limit: { context: m.context, output: 32768 },
    }])),
  };
  const best = models[0];
  const askDefault = `Make ${best.id} the default OpenCode model${config.model ? ` (instead of ${config.model})` : ''}?`;
  if (await ui.confirm(askDefault, !config.model, yes)) config.model = `saias/${best.id}`;
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  const saved = backup(CONFIG);
  fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2) + '\n');
  ui.ok(`SAIAS provider added to ${CONFIG}${saved ? ' (backup: .bak-saias-*)' : ''}`);
  ui.info(`In OpenCode, pick a model with /models, for example saias/${best.id}.`);
}

module.exports = { id: 'opencode', name: 'OpenCode', detect, configure };
