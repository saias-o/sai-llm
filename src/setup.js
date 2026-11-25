'use strict';

// saias setup: the graphical installer. A small server on 127.0.0.1 serves setup.html and runs the
// same code as "saias install". The advisor (recommend.js) preselects every profile this PC can
// run, so only the useful models are downloaded. The page opens in an app window (Edge or Chrome
// without browser chrome), or in the default browser when neither is found.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const paths = require('./paths');
const hardware = require('./hardware');
const store = require('./store');
const ui = require('./ui');
const manage = require('./install');
const { resolveAll, recommended, filesFor } = require('./resolve');
const { recommendations } = require('./recommend');

const PAGE = path.join(__dirname, 'setup.html');
const UNINSTALL_PAGE = path.join(__dirname, 'uninstall.html');
const IDLE_EXIT_MS = 2 * 60 * 1000;
const KEEP_FREE_BYTES = 5e9;      // room left on the drive after the downloads
const WINDOW = { width: 960, height: 780 };
const UNINSTALL_WINDOW = { width: 720, height: 640 };

// ---------------------------------------------------------------- what the page shows

function toolList() {
  const tools = require('./integrations');
  const { which } = require('./integrations/util');
  return tools.ALL.map(t => {
    // Hermes is always offered: the installer can install it.
    const present = t.id === 'hermes' ? Boolean(which('hermes')) : t.detect();
    return { id: t.id, name: t.name, present, offered: present || t.id === 'hermes' };
  }).filter(t => t.offered);
}

// Data folder candidates: the current folder and SAIAS on every other drive (Windows).
function folderChoices() {
  const choices = [{ path: paths.home, free: hardware.freeBytes(paths.home), current: true }];
  if (process.platform !== 'win32') return choices;
  const currentDrive = paths.home.slice(0, 2).toUpperCase();
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (`${letter}:` === currentDrive) continue;
    try {
      const s = fs.statfsSync(`${letter}:\\`);
      choices.push({ path: `${letter}:\\SAIAS`, free: s.bavail * s.bsize });
    } catch { /* no such drive */ }
  }
  return choices;
}

function uniqueMissingBytes(profiles) {
  const seen = new Map();
  for (const p of profiles) for (const f of p.files || []) if (f.missing) seen.set(f.key, f.size);
  return [...seen.values()].reduce((s, n) => s + n, 0);
}

// Native folder dialog (Windows). Resolves to the chosen folder or null.
function pickFolder(start) {
  return new Promise(resolve => {
    if (process.platform !== 'win32') { resolve(null); return; }
    const q = s => `'${String(s).replace(/'/g, "''")}'`;
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$d.Description = "Choose where SAIAS keeps its models (a SAIAS folder is created inside)"',
      '$d.ShowNewFolderButton = $true',
      `$d.SelectedPath = ${q(start)}`,
      'if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }',
    ].join('; ');
    const { execFile } = require('node:child_process');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], { windowsHide: true, encoding: 'utf8' },
      (err, out) => resolve(err ? null : (out || '').trim() || null));
  });
}

// A picked folder becomes <folder>\SAIAS unless it already is a SAIAS folder.
function dataFolderFor(picked) {
  const full = path.resolve(picked);
  return /^saias$/i.test(path.basename(full)) ? full : path.join(full, 'SAIAS');
}

function onPath() {
  return (process.env.PATH || '').split(path.delimiter).some(p => p.replace(/[\\/]+$/, '').toLowerCase() === paths.ROOT.toLowerCase());
}

function plan(opts) {
  const hw = hardware.detect();
  const catalog = manage.currentCatalog();
  const state = store.load();
  const advice = recommendations(catalog, hw, state);
  const preselect = opts.profiles
    ? String(opts.profiles).toLowerCase().split(/[\s,;]+/).filter(Boolean)
    : recommended(catalog, hw);

  const profiles = resolveAll(catalog, hw).map(r => {
    const p = catalog.profiles[r.profile];
    const base = { profile: r.profile, id: manage.profileName(r.profile), summary: p.summary, rank: p.rank, required: Boolean(p.always) };
    if (r.error) return { ...base, available: false, reason: r.error };
    const { runtime, models } = filesFor(r);
    const files = [
      { key: 'runtime:' + runtime.id, name: runtime.name, size: runtime.archives.reduce((s, a) => s + a.size, 0), missing: !store.runtimeDir(state, runtime.id, runtime) },
      ...models.map(f => ({ key: f.sha256, name: f.name, size: f.size, missing: !store.filePath(state, f) })),
    ];
    return {
      ...base,
      available: true,
      selected: preselect.includes(r.profile) || Boolean(p.always),
      installed: Boolean(state.profiles[r.profile]) && files.every(f => !f.missing),
      model: r.model.name,
      publisher: r.model.publisher || null,
      runtime: r.runtime.name,
      variant: r.variant.id,
      slow: Boolean(r.variant.slow),
      cpuOnly: r.variant.server?.device === 'none',
      note: r.variant.note || null,
      context: r.variant.server?.['ctx-size'] || r.model.context,
      vision: Boolean(r.model.vision),
      license: r.model.license,
      files,
    };
  });

  // The advisor also checks the disk: when the data folder's drive is too small for the
  // preselected models and nothing is installed yet, it suggests the drive with the most room.
  const folders = folderChoices();
  const need = uniqueMissingBytes(profiles.filter(p => p.selected));
  const fresh = !Object.keys(state.profiles).length;
  let suggested = null;
  // "Fits" keeps KEEP_FREE_BYTES free afterwards: filling the Windows drive breaks the PC.
  // When no drive has that much room, the roomiest one that still fits (1 GB left) is next best.
  const fits = (f, keep) => f.free === null || f.free >= need * 1.1 + keep;
  if (fresh && !process.env.SAIAS_HOME && !fits(folders[0], KEEP_FREE_BYTES)) {
    const others = folders.slice(1).sort((a, b) => b.free - a.free);
    const roomy = others.find(f => fits(f, KEEP_FREE_BYTES))
      || (others[0] && fits(others[0], 1e9) && others[0].free > (folders[0].free || 0) ? others[0] : null);
    if (roomy) suggested = roomy.path;
  }

  return {
    catalogVersion: catalog.version,
    hardware: hw,
    advice: { mostCapable: advice.mostCapable, everyday: advice.everyday },
    profiles,
    folders,
    suggestedFolder: suggested,
    keepFreeBytes: KEEP_FREE_BYTES,
    folderLocked: Boolean(process.env.SAIAS_HOME),
    installedSomething: !fresh,
    tools: opts.noTools ? [] : toolList(),
    options: {
      path: process.platform === 'win32' && !onPath() && !opts.noPath,
      shortcut: process.platform === 'win32' && !opts.noShortcut,
      bench: !opts.noBench,
    },
    home: paths.home,
    freeBytes: hardware.freeBytes(paths.home),
  };
}

// ---------------------------------------------------------------- progress events

// Every event goes to the open pages (server-sent events) and to the console. A page that
// reconnects gets the history again; progress bars keep only their latest state.
function createChannel() {
  const history = [];
  const progressAt = new Map();
  const clients = new Set();
  let nextBar = 0;

  function send(ev, { quiet = false } = {}) {
    if (ev.type === 'progress') {
      if (progressAt.has(ev.id)) history[progressAt.get(ev.id)] = ev;
      else { progressAt.set(ev.id, history.length); history.push(ev); }
    } else {
      history.push(ev);
    }
    const data = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of clients) res.write(data);
    if (quiet) return;
    if (ev.type === 'step') console.log(`\n== ${ev.text}`);
    else if (ev.type === 'progress') console.log(`  -> ${ev.label}${ev.state === 'fail' ? `: ${ev.note}` : ev.note ? `: ${ev.note}` : ''}`);
    else if (ev.text) console.log(`  ${ev.type === 'ok' ? '[ok] ' : ev.type === 'bad' || ev.type === 'error' ? '[!!] ' : ''}${ev.text}`);
  }

  const reporter = {
    event: ev => send(ev),
    progress(label, total) {
      const id = ++nextBar;
      let last = 0;
      let done = 0;
      send({ type: 'progress', id, label, done: 0, total, state: 'run' }, { quiet: true });
      return {
        update(value) {
          done = value;
          const now = Date.now();
          if (now - last < 200 && value < total) return;
          last = now;
          send({ type: 'progress', id, label, done, total, state: 'run' }, { quiet: true });
        },
        note(text) { send({ type: 'progress', id, label, done, total, state: 'run', note: text }); },
        done() { send({ type: 'progress', id, label, done: total, total, state: 'done' }); },
        fail(text) { send({ type: 'progress', id, label, done, total, state: 'fail', note: text }); },
      };
    },
  };

  function attach(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    for (const ev of history) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
  }

  return { send, reporter, attach, clients, reset() { history.length = 0; progressAt.clear(); } };
}

// ---------------------------------------------------------------- the window

function firstExisting(list) {
  return list.find(p => p && fs.existsSync(p)) || null;
}

// A Chromium browser that can open a page as an app window.
function appBrowser() {
  if (process.platform === 'win32') {
    const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
    return firstExisting([
      ...roots.map(r => path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
      ...roots.map(r => path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    ]);
  }
  if (process.platform === 'darwin') {
    return firstExisting([
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]);
  }
  const { which } = require('./integrations/util');
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'].map(which).find(Boolean) || null;
}

function openDefaultBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd.exe', ['/d', '/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
}

// The primary screen's work area (without the taskbar) in Windows scaled pixels, the unit
// Chromium uses for --window-size: 1536x816 on a 1080p screen at 125%. Null elsewhere.
function workArea() {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; $a = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; "$($a.X) $($a.Y) $($a.Width) $($a.Height)"'],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    const [x, y, width, height] = out.trim().split(/\s+/).map(Number);
    return width > 0 && height > 0 ? { x, y, width, height } : null;
  } catch {
    return null;
  }
}

// Window size and position: the preferred size, shrunk to fit the screen, centered.
function windowBounds(area = workArea(), size = WINDOW) {
  if (!area) return [`--window-size=${size.width},${size.height}`];
  const width = Math.min(size.width, area.width - 40);
  const height = Math.min(size.height, area.height - 40);
  const x = area.x + Math.round((area.width - width) / 2);
  const y = area.y + Math.round((area.height - height) / 2);
  return [`--window-size=${width},${height}`, `--window-position=${x},${y}`];
}

// Opens the page in its own window and calls onClose when that window is closed. A private
// browser profile makes the window its own process, so closing it ends that process.
function openWindow(url, onClose, size = WINDOW) {
  const exe = appBrowser();
  if (!exe) { openDefaultBrowser(url); return null; }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'saias-setup-'));
  const proc = spawn(exe, [
    `--app=${url}`, `--user-data-dir=${profile}`, ...windowBounds(workArea(), size),
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-features=Translate,msEdgeSidebarV2',
  ], { stdio: 'ignore' });
  proc.on('error', () => openDefaultBrowser(url));
  proc.on('exit', () => {
    setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* still locked */ } }, 1000);
    onClose();
  });
  return proc;
}

function closeWindow(proc) {
  if (!proc || proc.exitCode !== null) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else proc.kill();
  } catch { /* already closed */ }
}

// Opens the SAIAS app; without it, starts SAIAS in its own console like Start-SAIAS.cmd.
function startSaias() {
  const app = require('./app').exe();
  if (app) {
    spawn(app, [], { cwd: path.dirname(app), detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/d', '/c', 'start', '"SAIAS"', path.join(paths.ROOT, 'Start-SAIAS.cmd')], { cwd: paths.ROOT, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else {
    spawn(process.execPath, [path.join(paths.ROOT, 'src', 'cli.js'), 'start', '--open'], { cwd: paths.ROOT, detached: true, stdio: 'ignore' }).unref();
  }
}

// ---------------------------------------------------------------- server

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function run(opts) {
  const headless = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  if (opts.console || headless) {
    if (headless && !opts.console) ui.info(`No display found: running the ${opts.uninstall ? 'uninstaller' : 'installer'} in the terminal.`);
    if (opts.uninstall) return consoleUninstall(opts);
    await manage.install(opts);
    if (!opts.check) await manage.finish(opts);
    return;
  }

  const token = crypto.randomBytes(16).toString('hex');
  const channel = createChannel();
  let installing = false;
  let finished = false;
  let failed = false;
  let windowProc = null;
  let server = null;
  let exitResolve;
  const exited = new Promise(resolve => { exitResolve = resolve; });

  function quit() {
    closeWindow(windowProc);
    server?.close();
    for (const res of channel.clients) res.end();
    if (failed && !finished) process.exitCode = 1;
    exitResolve();
  }

  async function install(choice) {
    installing = true;
    channel.reset();
    ui.setReporter(channel.reporter);
    try {
      const profiles = (choice.profiles || []).filter(id => /^[a-z][a-z0-9-]*$/.test(id));
      if (!profiles.length) throw new Error('Choose at least one model.');
      if (choice.home && path.resolve(choice.home).toLowerCase() !== paths.home.toLowerCase()) {
        if (!path.isAbsolute(choice.home)) throw new Error(`Not a full path: ${choice.home}`);
        paths.setHome(choice.home);
        ui.ok(`Data folder: ${paths.home}`);
      }
      await manage.install({ profiles: profiles.join(','), yes: true });
      const tools = (choice.tools || []).filter(id => /^[a-z]+$/.test(id));
      await manage.finish({
        yes: true,
        tools,
        noTools: !tools.length,
        noPath: !choice.path,
        noShortcut: !choice.shortcut,
        noBench: !choice.bench,
      });
      finished = true;
      failed = false;
      channel.send({ type: 'done' });
    } catch (e) {
      failed = true;
      channel.send({ type: 'error', text: e.message });
    } finally {
      ui.setReporter(null);
      installing = false;
      if (!windowProc || windowProc.exitCode !== null) {
        if (!channel.clients.size) quit();
      }
    }
  }

  // The same window and progress channel remove SAIAS.
  async function uninstall(choice) {
    installing = true;
    channel.reset();
    ui.setReporter(channel.reporter);
    try {
      await require('./uninstall').run({ keepConversations: Boolean(choice.keepConversations) });
      finished = true;
      failed = false;
      channel.send({ type: 'done' });
    } catch (e) {
      failed = true;
      channel.send({ type: 'error', text: e.message });
    } finally {
      ui.setReporter(null);
      installing = false;
      if (!windowProc || windowProc.exitCode !== null) {
        if (!channel.clients.size) quit();
      }
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' });
      res.end(fs.readFileSync(opts.uninstall ? UNINSTALL_PAGE : PAGE));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/icon') {
      res.writeHead(200, { 'Content-Type': 'image/x-icon', 'Cache-Control': 'max-age=3600' });
      res.end(fs.readFileSync(path.join(paths.ROOT, 'SAIAS-LLM', 'saias-llm.ico')));
      return;
    }
    // Everything else needs the token from the URL the window was opened with, so other
    // pages in the browser cannot start an installation.
    const given = req.headers['x-saias-setup'] || url.searchParams.get('t');
    if (given !== token) { sendJson(res, 403, { error: 'forbidden' }); return; }

    if (req.method === 'GET' && url.pathname === '/api/plan') { sendJson(res, 200, plan(opts)); return; }
    if (req.method === 'GET' && url.pathname === '/api/uninstall-plan') { sendJson(res, 200, require('./uninstall').plan()); return; }
    if (req.method === 'POST' && url.pathname === '/api/uninstall') {
      if (installing) { sendJson(res, 409, { error: 'Already running.' }); return; }
      const choice = await readJson(req);
      sendJson(res, 202, { started: true });
      uninstall(choice);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/events') { channel.attach(req, res); return; }
    if (req.method === 'POST' && url.pathname === '/api/install') {
      if (installing) { sendJson(res, 409, { error: 'An installation is already running.' }); return; }
      const choice = await readJson(req);
      sendJson(res, 202, { started: true });
      install(choice);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/pick-folder') {
      const body = await readJson(req);
      const picked = await pickFolder(body.start || paths.home);
      if (!picked) { sendJson(res, 200, { folder: null }); return; }
      const folder = dataFolderFor(picked);
      sendJson(res, 200, { folder, free: hardware.freeBytes(folder) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/start') {
      sendJson(res, 200, { ok: true });
      startSaias();
      setTimeout(quit, 300);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/close') {
      sendJson(res, 200, { ok: true });
      if (!installing) setTimeout(quit, 300);
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  }

  server = http.createServer((req, res) => {
    handle(req, res).catch(e => { if (!res.headersSent) sendJson(res, 500, { error: e.message }); else res.destroy(); });
  });
  server.requestTimeout = 0;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const pageUrl = `http://127.0.0.1:${server.address().port}/?t=${token}`;

  ui.step(opts.uninstall ? 'SAIAS uninstall' : 'SAIAS setup');
  ui.info(`The ${opts.uninstall ? 'uninstall' : 'setup'} window is open. Keep this console open until it finishes.`);
  ui.info(`If no window appeared, open ${pageUrl}`);

  windowProc = opts.noWindow ? null : openWindow(pageUrl, () => {
    if (installing) ui.info('The window was closed; the work continues here.');
    else quit();
  }, opts.uninstall ? UNINSTALL_WINDOW : WINDOW);
  if (!windowProc && !opts.noWindow) openDefaultBrowser(pageUrl);

  // Without an app window, stop once no page has been connected for a while.
  if (!windowProc) {
    let idleSince = Date.now();
    const timer = setInterval(() => {
      if (channel.clients.size || installing) { idleSince = Date.now(); return; }
      if (Date.now() - idleSince > IDLE_EXIT_MS) { clearInterval(timer); quit(); }
    }, 5000);
    timer.unref();
    exited.then(() => clearInterval(timer));
  }

  await exited;
  if (finished) ui.ok('SAIAS is installed.');
}

// saias uninstall --console [--check] [--yes] [--keep-conversations]
async function consoleUninstall(opts) {
  const removal = require('./uninstall');
  const p = removal.plan();
  ui.step('SAIAS uninstall');
  if (!p.items.length) { ui.ok('Nothing of SAIAS is installed on this PC.'); return; }
  for (const item of p.items) ui.info(`${item.label}${item.bytes ? ` (${ui.size(item.bytes)})` : ''}: ${item.detail}`);
  if (opts.check) return;
  if (!(await ui.confirm('Remove all of this?', false, opts.yes))) { ui.info('Nothing was removed.'); return; }
  await removal.run({ keepConversations: Boolean(opts.keepConversations) });
}

module.exports = { run, plan, windowBounds };
