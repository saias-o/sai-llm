'use strict';

// Desktop shortcut (Windows only): the SAIAS app when there is one (shipped by the installer or
// downloaded by app.js), else Start-SAIAS.cmd, which opens Llama Chat.

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const paths = require('../paths');
const ui = require('../ui');
const app = require('../app');

function create() {
  if (process.platform !== 'win32') return;
  ui.step('Shortcut');
  const exe = app.exe();
  const q = s => `'${s.replace(/'/g, "''")}'`;
  const script = [
    '$d = [Environment]::GetFolderPath("Desktop")',
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d "SAIAS.lnk"))',
    `$s.TargetPath = ${q(exe || path.join(paths.ROOT, 'Start-SAIAS.cmd'))}`,
    `$s.WorkingDirectory = ${q(exe ? path.dirname(exe) : paths.ROOT)}`,
    `$s.IconLocation = ${q(exe || path.join(paths.ROOT, 'SAIAS-LLM', 'saias-llm.ico'))}`,
    `$s.Description = ${q(exe ? 'SAIAS: models, advisor and chat' : 'Start SAIAS (local models, web search, Llama Chat)')}`,
    '$s.Save()',
  ].join('; ');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', windowsHide: true });
    ui.ok(exe ? 'SAIAS shortcut created on the desktop (opens the SAIAS app)' : 'SAIAS shortcut created on the desktop (opens Llama Chat)');
  } catch (e) {
    ui.bad(`Could not create the desktop shortcut: ${e.message}`);
  }
}

module.exports = { create };
