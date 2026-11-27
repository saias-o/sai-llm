'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { ROOT } = require('../paths');
const { HUB_URL, pickModel, requireInstalled } = require('../installed');
const { ensureRunning } = require('../hub-client');
const { environment } = require('./claude');
const ui = require('../ui');

async function launch(args) {
  const { values } = parseArgs({
    args,
    options: {
      profile: { type: 'string' },
      open: { type: 'boolean' },
    },
  });
  const cwd = path.join(ROOT, 'plugins', 'omni');
  const entry = path.join(cwd, 'scripts', 'start.mjs');
  if (!fs.existsSync(entry)) {
    throw new Error('Omni is not initialized. From a SAIAS Git checkout, run "git submodule update --init plugins/omni".');
  }
  if (!fs.existsSync(path.join(cwd, 'node_modules', 'vite', 'bin', 'vite.js'))) {
    throw new Error('Install Omni dependencies first with "npm ci --prefix plugins/omni".');
  }

  requireInstalled();
  await ensureRunning();
  const response = await fetch(`${HUB_URL}/v1/models`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Could not list SAIAS models (HTTP ${response.status}).`);
  const { data } = await response.json();
  const models = data.filter(({ id, saias }) => id.startsWith('saias-') && saias).map(({ id, saias }) => ({
    id, profile: saias.profile, name: saias.model, vision: saias.vision,
  }));
  const model = values.profile ? pickModel(models, values.profile) : { id: 'saias-omni' };
  ui.info(`Omni defaults to ${model.id} through ${HUB_URL}`);
  const child = spawn(process.execPath, values.open ? [entry, '--open'] : [entry], {
    cwd,
    env: {
      ...environment(model),
      OMNI_MODEL: model.id,
      OMNI_SAIAS_MODELS: JSON.stringify(models),
      OMNI_BRAIN: 'claude',
      OMNI_EFFORT: process.env.OMNI_EFFORT ?? 'low',
      MAX_THINKING_TOKENS: process.env.MAX_THINKING_TOKENS ?? '0',
      VITE_BACKEND: 'bridge',
    },
    stdio: 'inherit',
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      process.exitCode = code ?? 1;
      resolve();
    });
  });
}

module.exports = { launch };
