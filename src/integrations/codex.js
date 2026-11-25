'use strict';

// Adds a "saias" model provider and profile to the Codex config (~/.codex/config.toml).
// The default Codex model is left alone: run "codex --profile saias" to use SAIAS.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ui = require('../ui');
const { HUB_URL } = require('../installed');
const { which, backup } = require('./util');

const HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CONFIG = path.join(HOME, 'config.toml');
const TABLES = ['model_providers.saias', 'profiles.saias'];

function detect() {
  return Boolean(which('codex')) || fs.existsSync(HOME);
}

// Removes the [model_providers.saias] and [profiles.saias] tables written by an earlier run.
function withoutSaiasTables(toml) {
  const out = [];
  let skipping = false;
  for (const line of toml.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) skipping = TABLES.includes(header[1].trim());
    if (!skipping && !line.startsWith('# Added by SAIAS:')) out.push(line);
  }
  return out.join('\n').replace(/\n+$/, '');
}

async function configure({ models }) {
  ui.step('Codex');
  const best = models[0];
  const original = fs.existsSync(CONFIG) ? fs.readFileSync(CONFIG, 'utf8') : '';
  const block = [
    '',
    '# Added by SAIAS: run "codex --profile saias" to use the local models.',
    '[model_providers.saias]',
    'name = "SAIAS (local)"',
    `base_url = "${HUB_URL}/v1"`,
    'wire_api = "responses"',
    '',
    '[profiles.saias]',
    'model_provider = "saias"',
    `model = "${best.id}"`,
    'model_reasoning_effort = "high"',
    '',
  ].join('\n');
  const cleaned = withoutSaiasTables(original).replace(/\n# Added by SAIAS:[^\n]*$/, '');
  fs.mkdirSync(HOME, { recursive: true });
  const saved = backup(CONFIG);
  fs.writeFileSync(CONFIG, cleaned + '\n' + block);
  ui.ok(`SAIAS provider and profile added to ${CONFIG}${saved ? ' (backup: .bak-saias-*)' : ''}`);
  ui.info(`Use it with: codex --profile saias   (model ${best.id}; change it with -m saias-smart)`);
}

// Uninstall: takes the SAIAS tables out again. True when something was removed.
function remove() {
  if (!fs.existsSync(CONFIG)) return false;
  const original = fs.readFileSync(CONFIG, 'utf8');
  if (!/^\s*\[(model_providers|profiles)\.saias\]\s*$/m.test(original)) return false;
  backup(CONFIG);
  fs.writeFileSync(CONFIG, withoutSaiasTables(original) + '\n');
  return true;
}

function configured() {
  try { return /^\s*\[(model_providers|profiles)\.saias\]\s*$/m.test(fs.readFileSync(CONFIG, 'utf8')); } catch { return false; }
}

module.exports = { id: 'codex', name: 'Codex', detect, configure, remove, configured, withoutSaiasTables };
