'use strict';

// Windows registration of a SAIAS copy installed from its folder (Install-SAIAS.cmd):
//   - an entry in Settings > Apps > Installed apps, whose Uninstall button runs
//     Uninstall-SAIAS.cmd (HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\SAIAS);
//   - a SAIAS shortcut in the Start menu.
// Copies installed with SAIAS-Setup.exe have their own entry from Inno Setup: nothing is added.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const paths = require('../paths');
const ui = require('../ui');

const KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SAIAS';
const q = s => `'${String(s).replace(/'/g, "''")}'`;

function powershell(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

// Installed by SAIAS-Setup.exe (Inno Setup leaves its uninstaller in the app folder).
function setupInstalled() {
  return fs.existsSync(path.join(paths.ROOT, 'unins000.exe'));
}

function startMenuShortcut() {
  return path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'SAIAS.lnk');
}

function folderBytes(dir) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      total += entry.isDirectory() ? folderBytes(full) : fs.statSync(full).size;
    }
  } catch { /* unreadable */ }
  return total;
}

function register({ exe }) {
  if (process.platform !== 'win32' || setupInstalled()) return;
  ui.step('Windows');
  const version = require(path.join(paths.ROOT, 'package.json')).version;
  const cmd = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  const uninstaller = path.join(paths.ROOT, 'Uninstall-SAIAS.cmd');
  const icon = exe || path.join(paths.ROOT, 'SAIAS-LLM', 'saias-llm.ico');
  const sizeKB = Math.round(folderBytes(paths.home) / 1024);
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const values = [
    ['DisplayName', 'String', 'SAIAS'],
    ['DisplayVersion', 'String', version],
    ['Publisher', 'String', 'SAIAS'],
    ['DisplayIcon', 'String', icon],
    ['InstallLocation', 'String', paths.ROOT],
    ['InstallDate', 'String', today],
    ['URLInfoAbout', 'String', 'https://github.com/saias-o/saias-llm'],
    ['UninstallString', 'String', `"${cmd}" /d /c ""${uninstaller}""`],
    ['QuietUninstallString', 'String', `"${cmd}" /d /c ""${uninstaller}" --console --yes"`],
    ['EstimatedSize', 'DWord', String(Math.min(sizeKB, 0x7fffffff))],
    ['NoModify', 'DWord', '1'],
    ['NoRepair', 'DWord', '1'],
  ];
  const target = exe || path.join(paths.ROOT, 'Start-SAIAS.cmd');
  const script = [
    `$k = ${q(KEY)}`,
    'New-Item -Path $k -Force | Out-Null',
    ...values.map(([name, type, value]) => `New-ItemProperty -Path $k -Name ${q(name)} -PropertyType ${type} -Value ${q(value)} -Force | Out-Null`),
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${q(startMenuShortcut())})`,
    `$s.TargetPath = ${q(target)}`,
    `$s.WorkingDirectory = ${q(path.dirname(target))}`,
    `$s.IconLocation = ${q(icon)}`,
    `$s.Description = 'SAIAS: local AI models and chat'`,
    '$s.Save()',
  ].join('; ');
  try {
    powershell(script);
    ui.ok('SAIAS is listed in Settings > Apps > Installed apps, and in the Start menu');
  } catch (e) {
    ui.bad(`Could not register SAIAS with Windows: ${String(e.stderr || e.message).trim()}`);
  }
}

function registered() {
  if (process.platform !== 'win32') return false;
  try { return powershell(`Test-Path ${q(KEY)}`).trim() === 'True'; } catch { return false; }
}

function unregister() {
  if (process.platform !== 'win32') return;
  powershell(`Remove-Item -Path ${q(KEY)} -Recurse -Force -ErrorAction SilentlyContinue`);
  fs.rmSync(startMenuShortcut(), { force: true });
}

module.exports = { register, registered, unregister, startMenuShortcut, setupInstalled, folderBytes };
