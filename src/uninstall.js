'use strict';

// saias uninstall: removes what SAIAS installed on this PC.
//   - stops SAIAS (hub, model servers, the SAIAS app);
//   - takes the SAIAS entries out of Hermes, Codex and OpenCode (the tools themselves stay);
//   - removes the desktop and Start menu shortcuts, the PATH entry, the autostart entry and the
//     Windows "Installed apps" entry;
//   - deletes the models, runtimes and logs (data folder), the conversations, settings and chat
//     view cache (standard folder, unless kept), the private Node.js copy and the downloaded app.
// The SAIAS program folder itself stays: from a source checkout it holds the code (delete it by
// hand), and SAIAS-Setup.exe installs remove it with their own uninstaller.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const paths = require('./paths');
const ui = require('./ui');
const entry = require('./integrations/windows-entry');
const { HUB_URL, hubRunning } = require('./installed');
const { setTimeout: delay } = require('node:timers/promises');

const lower = p => path.resolve(p).toLowerCase();
const inside = (child, parent) => lower(child) === lower(parent) || lower(child).startsWith(lower(parent) + path.sep);

function desktopShortcut() {
  if (process.platform !== 'win32') return null;
  try {
    const desktop = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Environment]::GetFolderPath("Desktop")'],
      { encoding: 'utf8', windowsHide: true }).trim();
    return path.join(desktop, 'SAIAS.lnk');
  } catch {
    return null;
  }
}

function onUserPath() {
  if (process.platform !== 'win32') return false;
  try {
    const value = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetEnvironmentVariable('Path', 'User')"],
      { encoding: 'utf8', windowsHide: true });
    return value.split(';').some(p => p.trim() && lower(p.trim().replace(/[\\/]+$/, '')) === lower(paths.ROOT));
  } catch {
    return false;
  }
}

function autostart() {
  if (process.platform !== 'win32') return false;
  try {
    execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'SAIAS'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

// What an uninstall would remove, for the uninstall window and --check.
function plan() {
  const tools = require('./integrations').ALL.filter(t => t.configured?.()).map(t => t.name);
  const appDir = path.join(paths.ROOT, 'app');
  const separateData = !inside(paths.home, paths.standard);
  const conversations = path.join(paths.standard, 'Conversations');
  const items = [];
  const add = (id, label, detail, bytes = 0) => items.push({ id, label, detail, bytes });
  if (fs.existsSync(paths.home)) add('data', 'Models, runtimes and logs', paths.home, entry.folderBytes(paths.home));
  if (separateData && fs.existsSync(paths.standard)) {
    add('settings', 'Settings and the chat view cache', paths.standard, entry.folderBytes(paths.standard) - entry.folderBytes(conversations));
  }
  if (fs.existsSync(conversations)) {
    add('conversations', 'Conversations', conversations, entry.folderBytes(conversations));
  }
  if (fs.existsSync(appDir)) add('app', 'SAIAS app (downloaded build)', appDir, entry.folderBytes(appDir));
  if (tools.length) add('tools', `SAIAS settings in ${tools.join(', ')}`, 'The tools stay installed; a backup of each file is kept.');
  const shortcuts = [desktopShortcut(), entry.startMenuShortcut()].filter(p => p && fs.existsSync(p));
  if (shortcuts.length) add('shortcuts', 'Desktop and Start menu shortcuts', shortcuts.join('  '));
  if (onUserPath()) add('path', 'The "saias" command in new terminals', `${paths.ROOT} on your PATH`);
  if (autostart()) add('autostart', 'Start with Windows', 'Autostart entry');
  if (entry.registered()) add('entry', 'Entry in Settings > Apps > Installed apps', 'SAIAS');
  return {
    items,
    bytes: items.reduce((s, i) => s + i.bytes, 0),
    programFolder: paths.ROOT,
    keepsProgramFolder: !entry.setupInstalled(),
  };
}

// Stops the hub, its model servers and the SAIAS app, so their files can be deleted.
async function stopEverything() {
  if (await hubRunning()) {
    try {
      await fetch(`${HUB_URL}/saias/stop`, { method: 'POST', headers: { 'X-SAIAS': '1' }, signal: AbortSignal.timeout(5000) });
    } catch { /* already stopping */ }
    for (let i = 0; i < 20 && (await hubRunning()); i++) await delay(500);
  }
  if (process.platform !== 'win32') return;
  // Anything still running from SAIAS folders: model servers, the app and its WebView2 helpers.
  const roots = [paths.home, paths.standard, path.join(paths.ROOT, 'app')];
  const script = [
    `$roots = @(${roots.map(r => `'${r.replace(/'/g, "''")}\\'`).join(', ')})`,
    `Get-CimInstance Win32_Process | Where-Object { $p = $_.ExecutablePath; $p -and ($roots | Where-Object { $p.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) }) -and $_.ProcessId -ne ${process.pid} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    // msedgewebview2.exe lives in Windows, not in the SAIAS folders: the app's profile names it.
    `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like '*SAIAS\\WebView2*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
  ].join('; ');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', windowsHide: true });
  } catch { /* nothing to stop */ }
  await delay(1000);
}

function removeFolder(dir, label) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
      ui.ok(`${label} deleted`);
      return true;
    } catch (e) {
      if (attempt === 4) ui.bad(`${label}: ${e.message}`);
    }
  }
  return false;
}

// The Node.js running this uninstall cannot delete itself: a hidden command does it afterwards.
function deleteLater(dir) {
  if (process.platform !== 'win32') return;
  spawn('cmd.exe', ['/d', '/c', `ping -n 4 127.0.0.1 >nul & rmdir /s /q "${dir}"`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

async function run(opts = {}) {
  const keepConversations = Boolean(opts.keepConversations);
  ui.step('Stopping SAIAS');
  await stopEverything();
  ui.ok('SAIAS stopped');

  ui.step('Tools');
  let touched = 0;
  for (const tool of require('./integrations').ALL) {
    if (!tool.remove) continue;
    try {
      if (tool.remove()) { ui.ok(`SAIAS removed from ${tool.name} (the previous file is kept as .bak-saias-*)`); touched++; }
    } catch (e) {
      ui.bad(`${tool.name}: ${e.message}`);
    }
  }
  if (!touched) ui.info('No tool was set up for SAIAS.');

  ui.step('Windows');
  for (const shortcut of [desktopShortcut(), entry.startMenuShortcut()]) {
    if (shortcut && fs.existsSync(shortcut)) { fs.rmSync(shortcut, { force: true }); ui.ok(`Shortcut removed: ${shortcut}`); }
  }
  if (onUserPath()) {
    const dir = paths.ROOT.replace(/'/g, "''");
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `$p = [Environment]::GetEnvironmentVariable('Path', 'User'); $d = '${dir}'; ` +
        `$kept = ($p -split ';' | Where-Object { $_ -and ($_.TrimEnd('\\') -ne $d.TrimEnd('\\')) }) -join ';'; ` +
        `[Environment]::SetEnvironmentVariable('Path', $kept, 'User')`], { stdio: 'ignore', windowsHide: true });
      ui.ok('"saias" removed from your PATH');
    } catch (e) {
      ui.bad(`PATH: ${e.message}`);
    }
  }
  if (autostart()) {
    try {
      execFileSync('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'SAIAS', '/f'], { stdio: 'ignore', windowsHide: true });
      ui.ok('Autostart removed');
    } catch (e) {
      ui.bad(`Autostart: ${e.message}`);
    }
  }
  try {
    if (entry.registered()) { entry.unregister(); ui.ok('Removed from Settings > Apps > Installed apps'); }
  } catch (e) {
    ui.bad(`Installed apps entry: ${e.message}`);
  }

  ui.step('Files');
  const appDir = path.join(paths.ROOT, 'app');
  if (fs.existsSync(appDir)) removeFolder(appDir, 'SAIAS app');
  if (!inside(paths.home, paths.standard) && fs.existsSync(paths.home)) removeFolder(paths.home, `Models and runtimes (${paths.home})`);
  if (fs.existsSync(paths.standard)) {
    const node = path.join(paths.standard, 'node');
    const running = inside(process.execPath, node);
    for (const name of fs.readdirSync(paths.standard)) {
      const full = path.join(paths.standard, name);
      if (keepConversations && /^(conversations|settings\.json)$/i.test(name)) continue;
      if (running && lower(full) === lower(node)) continue;
      fs.rmSync(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
    }
    if (running) deleteLater(paths.standard);
    else if (!keepConversations) { try { fs.rmdirSync(paths.standard); } catch { /* not empty */ } }
    ui.ok(keepConversations ? `Data deleted (${paths.standard}); conversations kept` : `Data deleted (${paths.standard})`);
  }

  ui.step('Done');
  ui.ok('SAIAS is uninstalled.');
  if (!entry.setupInstalled()) ui.info(`The program folder stays: ${paths.ROOT}. Delete it yourself if you no longer need it.`);
}

module.exports = { plan, run };
