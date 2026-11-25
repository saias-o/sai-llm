'use strict';

// Starts the hub in the background for tools launched through saias (saias claude, ...).

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const paths = require('./paths');
const ui = require('./ui');
const { hubRunning } = require('./installed');

async function ensureRunning() {
  if (await hubRunning()) return;
  fs.mkdirSync(paths.logs, { recursive: true });
  const logFile = path.join(paths.logs, 'hub.log');
  const fd = fs.openSync(logFile, 'w');
  const child = spawn(process.execPath, [path.join(__dirname, 'cli.js'), 'start'], {
    detached: true, windowsHide: true, stdio: ['ignore', fd, fd],
  });
  fs.closeSync(fd);
  child.unref();
  ui.info(`Starting SAIAS in the background (log: ${logFile}); stop it with "saias stop".`);
  for (let i = 0; i < 120; i++) {
    if (await hubRunning()) return;
    if (child.exitCode !== null) break;
    await delay(500);
  }
  throw new Error(`SAIAS did not start. Log: ${logFile}`);
}

module.exports = { ensureRunning };
