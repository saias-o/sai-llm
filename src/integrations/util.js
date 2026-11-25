'use strict';

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

// Full path of a command on PATH, or null. On Windows, npm installs an extensionless shell
// script next to the .cmd shim: only executables and command scripts are returned.
function which(cmd) {
  const out = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8', windowsHide: true });
  if (out.status !== 0) return null;
  const found = out.stdout.split(/\r?\n/).filter(Boolean);
  if (process.platform !== 'win32') return found[0] || null;
  return found.find(p => /\.(exe|cmd|bat)$/i.test(p)) || null;
}

// Copies a config file to <file>.bak-saias-<timestamp> before SAIAS edits it.
function backup(file) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const copy = `${file}.bak-saias-${stamp}`;
  fs.copyFileSync(file, copy);
  return copy;
}

// Quotes an argument for cmd.exe when running a .cmd shim.
function quoteForCmd(arg) {
  return /^[\w\-./:=@\\]+$/.test(arg) ? arg : `"${String(arg).replace(/"/g, '""')}"`;
}

module.exports = { which, backup, quoteForCmd };
