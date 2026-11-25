'use strict';

// Adds the SAIAS folder to the user's PATH (Windows) so "saias" works in any terminal.

const { execFileSync } = require('node:child_process');
const paths = require('../paths');
const ui = require('../ui');

function onPath() {
  return (process.env.PATH || '').split(';').some(p => p.replace(/[\\/]+$/, '').toLowerCase() === paths.ROOT.toLowerCase());
}

async function add({ yes }) {
  if (process.platform !== 'win32' || onPath()) return;
  ui.step('Command line');
  if (!(await ui.confirm(`Add ${paths.ROOT} to your PATH so "saias" works in any new terminal?`, true, yes))) return;
  const dir = paths.ROOT.replace(/'/g, "''");
  const script = [
    "$p = [Environment]::GetEnvironmentVariable('Path', 'User')",
    `$d = '${dir}'`,
    "if (-not (($p -split ';') -contains $d)) { [Environment]::SetEnvironmentVariable('Path', (@($p, $d) | Where-Object { $_ }) -join ';', 'User') }",
  ].join('; ');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', windowsHide: true });
    ui.ok('"saias" is on your PATH for new terminals.');
  } catch (e) {
    ui.bad(`Could not update PATH: ${e.message}`);
  }
}

module.exports = { add };
