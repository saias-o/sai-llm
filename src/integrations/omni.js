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

  const model = pickModel(requireInstalled(), values.profile);
  await ensureRunning();
  ui.info(`Omni on ${model.id} (${model.name}) through ${HUB_URL}`);
  const child = spawn(process.execPath, values.open ? [entry, '--open'] : [entry], {
    cwd,
    env: { ...environment(model), OMNI_MODEL: model.id, OMNI_BRAIN: 'claude', VITE_BACKEND: 'bridge' },
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
