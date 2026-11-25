'use strict';

// Desktop shortcut to Start-SAIAS.cmd (Windows only).

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const paths = require('../paths');
const ui = require('../ui');

function create() {
  if (process.platform !== 'win32') return;
  ui.step('Shortcut');
  const q = s => `'${s.replace(/'/g, "''")}'`;
  const script = [
    '$d = [Environment]::GetFolderPath("Desktop")',
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d "SAIAS.lnk"))',
    `$s.TargetPath = ${q(path.join(paths.ROOT, 'Start-SAIAS.cmd'))}`,
    `$s.WorkingDirectory = ${q(paths.ROOT)}`,
    `$s.IconLocation = ${q(path.join(paths.ROOT, 'SAIAS-LLM', 'saias-llm.ico'))}`,
    '$s.Description = "Start SAIAS (local models, web search, Llama Chat)"',
    '$s.Save()',
  ].join('; ');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', windowsHide: true });
    ui.ok('SAIAS shortcut created on the desktop');
  } catch (e) {
    ui.bad(`Could not create the desktop shortcut: ${e.message}`);
  }
}

module.exports = { create };
