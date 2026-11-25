'use strict';

// install, update, rollback, adopt, status and clean: everything that changes what is on disk.

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const catalogs = require('./catalog');
const hardware = require('./hardware');
const llama = require('./llama');
const store = require('./store');
const ui = require('./ui');
const { downloadFile, extractArchives, hashFile } = require('./download');
const { resolveProfile, resolveAll, recommended, filesFor } = require('./resolve');
const { hubRunning } = require('./installed');

const PREVIOUS_CATALOG = path.join(paths.home, 'catalog.previous.json');

// ---------------------------------------------------------------- helpers

function profileName(id) { return 'saias-' + id; }

function currentCatalog() {
  return catalogs.newest(catalogs.bundled(), catalogs.installed());
}

function missingBytes(state, resolution) {
  const { runtime, models } = filesFor(resolution);
  let bytes = 0;
  if (!store.runtimeDir(state, runtime.id, runtime)) bytes += runtime.archives.reduce((s, a) => s + a.size, 0);
  for (const f of models) if (!store.filePath(state, f)) bytes += f.size;
  return bytes;
}

function printHardware(hw) {
  ui.step('Hardware');
  ui.info(`${hw.platform}, ${hw.cpu}, ${hw.threads} threads, ${hw.ramGB} GB RAM`);
  if (hw.nvidia.length) for (const g of hw.nvidia) ui.info(`NVIDIA ${g.name}, ${g.vramGB} GB VRAM`);
  else ui.info('No NVIDIA GPU detected (other GPUs are used through Vulkan)');
}

function describe(r) {
  return `${r.model.name} (${r.variant.id}${r.variant.slow ? ', slow on this PC' : ''})`;
}

async function ensureRuntime(state, id, runtime) {
  const existing = store.runtimeDir(state, id, runtime);
  if (existing) { ui.ok(`${runtime.name}`); return existing; }
  const dir = path.join(paths.runtimes, id);
  const archives = [];
  for (const archive of runtime.archives) {
    const file = path.join(paths.downloads, path.basename(new URL(archive.url).pathname));
    await downloadFile({ ...archive, name: path.basename(file) }, file, path.basename(file));
    archives.push(file);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  extractArchives(archives, dir, runtime.binary);
  for (const file of archives) fs.rmSync(file, { force: true });
  store.recordRuntime(state, id, dir);
  store.save(state);
  ui.ok(runtime.name);
  return dir;
}

async function ensureFile(state, spec) {
  const existing = store.filePath(state, spec);
  if (existing) {
    if (!state.files[spec.sha256]) store.recordFile(state, spec, existing, { verified: false });
    ui.ok(spec.name);
    return existing;
  }
  const dest = path.join(paths.models, spec.name);
  await downloadFile(spec, dest);
  store.recordFile(state, spec, dest, { verified: true });
  store.save(state);
  ui.ok(spec.name);
  return dest;
}

// Downloads what a resolved profile needs and returns its installed state entry.
async function installResolution(state, r) {
  const { runtime, models } = filesFor(r);
  const dir = await ensureRuntime(state, runtime.id, runtime);
  for (const f of models) await ensureFile(state, f);
  const entry = { variant: r.variant.id };
  if (r.variant.device === 'auto') {
    const devices = llama.listDevices(store.binaryPath(dir, runtime));
    entry.device = llama.pickDevice(devices);
    const chosen = devices.find(d => d.id === entry.device);
    ui.ok(`${profileName(r.profile)} runs on ${chosen ? `${chosen.id}, ${chosen.name} (${chosen.mib} MiB)` : 'the CPU'}`);
  }
  return entry;
}

function snapshotPrevious(state) {
  if (!Object.keys(state.profiles).length) return;
  state.previous = { catalogVersion: state.catalogVersion, profiles: structuredClone(state.profiles) };
  if (fs.existsSync(paths.installedCatalog)) fs.copyFileSync(paths.installedCatalog, PREVIOUS_CATALOG);
}

function sameSelection(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function parseProfiles(value, catalog) {
  const ids = String(value || '').toLowerCase().split(/[\s,;]+/).filter(Boolean);
  const unknown = ids.filter(id => !catalog.profiles[id]);
  if (unknown.length) throw new Error(`Unknown profile: ${unknown.join(', ')}. Available: ${Object.keys(catalog.profiles).join(', ')}`);
  return ids;
}

// ---------------------------------------------------------------- install

async function install(opts) {
  const catalog = currentCatalog();
  const state = store.load();
  const hw = hardware.detect();
  printHardware(hw);

  ui.step(`Profiles (catalog ${catalog.version})`);
  const resolutions = resolveAll(catalog, hw);
  const rec = recommended(catalog, hw);
  for (const r of resolutions) {
    const name = profileName(r.profile).padEnd(12);
    if (r.error) { ui.info(`${name} not available: ${r.error}`); continue; }
    const missing = missingBytes(state, r);
    const status = missing ? `${ui.size(missing)} to download` : 'installed';
    ui.info(`${name} ${catalog.profiles[r.profile].summary}. ${describe(r)}: ${status}${rec.includes(r.profile) ? ' (recommended)' : ''}`);
  }

  const installed = Object.keys(state.profiles).filter(id => catalog.profiles[id]);
  const defaults = [...new Set([...rec, ...installed])];
  let chosen = opts.profiles ? parseProfiles(opts.profiles, catalog)
    : parseProfiles(await ui.ask(`Profiles to install, comma-separated (Enter = ${defaults.join(',')}):`, defaults.join(','), opts.yes || opts.check), catalog);
  for (const [id, p] of Object.entries(catalog.profiles)) if (p.always && !chosen.includes(id)) chosen.unshift(id);
  const plan = [];
  for (const id of chosen) {
    const r = resolveProfile(catalog, id, hw);
    if (r.error) ui.bad(`Skipping ${profileName(id)}: ${r.error}`);
    else plan.push(r);
  }
  ui.info(`Selected: ${plan.map(r => profileName(r.profile)).join(', ')}`);

  const need = plan.reduce((s, r) => s + missingBytes(state, r), 0);
  if (opts.check) {
    ui.step('Check');
    ui.info(need ? `${ui.size(need)} would be downloaded.` : 'Everything selected is installed.');
    return;
  }

  ui.step('Licenses');
  for (const r of plan) {
    ui.info(`${r.model.name}: ${r.model.license.name}  ${r.model.license.url}`);
    if (r.model.license.note) ui.info(`  ${r.model.license.note}`);
  }
  if (!(await ui.confirm('Accept these model licenses?', true, opts.yes))) throw new Error('Licenses not accepted; nothing was installed.');

  if (need) {
    fs.mkdirSync(paths.home, { recursive: true });
    const free = hardware.freeBytes(paths.home);
    ui.info(`Total download: ${ui.size(need)} into ${paths.home}`);
    if (free !== null && free < need * 1.1) throw new Error(`Not enough disk space: ${ui.size(free)} free, ${ui.size(need)} needed. Free some space or set SAIAS_HOME to another drive.`);
  }

  ui.step('Runtimes and models');
  const selection = {};
  for (const r of plan) selection[r.profile] = await installResolution(state, r);

  if (!sameSelection(state.profiles, selection)) snapshotPrevious(state);
  state.profiles = selection;
  state.catalogVersion = catalog.version;
  catalogs.save(catalog);
  store.save(state);
  ui.ok(`Installed ${Object.keys(selection).map(profileName).join(', ')}`);
}

// ---------------------------------------------------------------- update and rollback

async function update(opts) {
  const state = store.load();
  if (!Object.keys(state.profiles).length) throw new Error('SAIAS is not installed yet. Run: saias install');
  const current = catalogs.installed() || catalogs.bundled();
  ui.step('Catalog');
  let latest;
  try {
    latest = await catalogs.remote();
  } catch (e) {
    ui.bad(`${e.message}. Using the catalog shipped with this copy of SAIAS.`);
    latest = catalogs.bundled();
  }
  ui.info(`Installed: ${current.version}. Latest: ${latest.version}.`);
  if (catalogs.compareVersions(latest.version, current.version) <= 0) { ui.ok('SAIAS models are up to date.'); return; }

  const hw = hardware.detect();
  const changes = [];
  const plan = [];
  for (const id of Object.keys(state.profiles)) {
    const r = resolveProfile(latest, id, hw);
    if (r.error) { ui.bad(`${profileName(id)}: ${r.error} in the new catalog; keeping the current version.`); continue; }
    plan.push(r);
    const before = current.profiles[id]?.variants.find(v => v.id === state.profiles[id].variant);
    if (!before || before.model !== r.variant.model || before.runtime !== r.variant.runtime || JSON.stringify(before.server) !== JSON.stringify(r.variant.server)) {
      changes.push(`${profileName(id)}: ${before ? current.models[before.model].name : 'new'} -> ${r.model.name}`);
    }
  }
  ui.step('Changes');
  if (!changes.length) ui.info('No profile changes; only catalog metadata changed.');
  for (const c of changes) ui.info(c);
  const need = plan.reduce((s, r) => s + missingBytes(state, r), 0);
  if (need) ui.info(`Download: ${ui.size(need)}`);
  if (opts.check) return;
  if (!(await ui.confirm('Apply this update?', true, opts.yes))) return;

  ui.step('Licenses');
  for (const r of plan) ui.info(`${r.model.name}: ${r.model.license.name}  ${r.model.license.url}`);
  if (!(await ui.confirm('Accept these model licenses?', true, opts.yes))) return;

  ui.step('Downloads');
  const selection = { ...state.profiles };
  for (const r of plan) selection[r.profile] = await installResolution(state, r);
  snapshotPrevious(state);
  state.profiles = selection;
  state.catalogVersion = latest.version;
  catalogs.save(latest);
  store.save(state);
  ui.ok(`Updated to catalog ${latest.version}. Restart SAIAS to use the new models. "saias rollback" returns to ${current.version}.`);
}

function rollback() {
  const state = store.load();
  if (!state.previous || !fs.existsSync(PREVIOUS_CATALOG)) throw new Error('There is no previous installation to return to.');
  const current = { catalogVersion: state.catalogVersion, profiles: state.profiles };
  const currentCatalogFile = fs.readFileSync(paths.installedCatalog);
  fs.copyFileSync(PREVIOUS_CATALOG, paths.installedCatalog);
  fs.writeFileSync(PREVIOUS_CATALOG, currentCatalogFile);
  state.profiles = state.previous.profiles;
  state.catalogVersion = state.previous.catalogVersion;
  state.previous = current;
  store.save(state);
  ui.ok(`Returned to catalog ${state.catalogVersion}. Restart SAIAS to apply it. Run "saias rollback" again to undo.`);
}

// ---------------------------------------------------------------- adopt

// Breadth first, so the shallowest copy of a runtime wins over backups in subfolders.
function* walk(root, maxDepth = 5) {
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    yield { dir, entries };
    if (depth < maxDepth) for (const e of entries) if (e.isDirectory()) queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
  }
}

// Registers runtimes and model files that already exist elsewhere on disk, so they are not
// downloaded again. Files stay where they are unless --move is given (same drive only).
async function adopt(folder, opts) {
  if (!folder || !fs.existsSync(folder)) throw new Error('Usage: saias adopt <folder> [--move] [--verify]');
  const known = [catalogs.bundled(), catalogs.installed()].filter(Boolean);
  const files = new Map();
  const runtimes = [];
  for (const c of known) {
    for (const m of Object.values(c.models)) for (const f of Object.values(m.files)) files.set(`${f.size}`, f);
    for (const [id, r] of Object.entries(c.runtimes)) runtimes.push({ id, ...r });
  }
  const state = store.load();
  const hw = hardware.detect();
  ui.step(`Adopting from ${path.resolve(folder)}`);
  let count = 0;
  for (const { dir, entries } of walk(path.resolve(folder))) {
    for (const e of entries.filter(x => x.isFile())) {
      const full = path.join(dir, e.name);
      const spec = files.get(String(store.sizeOf(full)));
      if (!spec || store.filePath(state, spec)) continue;
      if (opts.verify) {
        const digest = await hashFile(full);
        if (digest !== spec.sha256) { ui.bad(`${full}: same size as ${spec.name} but a different sha256, skipped`); continue; }
      }
      let target = full;
      if (opts.move) {
        target = path.join(paths.models, spec.name);
        fs.mkdirSync(paths.models, { recursive: true });
        try { fs.renameSync(full, target); } catch { target = full; ui.bad(`${spec.name}: cannot move across drives, kept in place`); }
      }
      store.recordFile(state, spec, target, { verified: Boolean(opts.verify), adopted: target === full });
      ui.ok(`${spec.name} -> ${target}`);
      count++;
    }
    const binary = entries.find(x => x.isFile() && /^llama-server(\.exe)?$/i.test(x.name));
    if (binary) {
      const v = llama.version(path.join(dir, binary.name));
      const backend = llama.backendOf(dir);
      const match = v && runtimes.find(r => r.build === v.build && r.backend === backend && r.platform === hw.platform);
      if (match && !store.runtimeDir(state, match.id, match)) {
        store.recordRuntime(state, match.id, dir, { adopted: true });
        ui.ok(`${match.name} -> ${dir}${v.commit ? ` (commit ${v.commit})` : ''}`);
        count++;
      } else if (!match) {
        ui.info(`${dir}: llama-server ${v ? `build ${v.build}` : 'of unknown version'} (${backend}) matches no catalog runtime`);
      }
    }
  }
  store.save(state);
  ui.info(count ? `Adopted ${count} item(s). Run "saias install" to finish the setup.` : 'Nothing to adopt.');
}

// ---------------------------------------------------------------- status and clean

async function status(opts) {
  const state = store.load();
  const catalog = catalogs.installed();
  const hub = await hubRunning();
  if (opts.json) {
    console.log(JSON.stringify({ home: paths.home, catalogVersion: state.catalogVersion, profiles: state.profiles, hub }, null, 2));
    return;
  }
  printHardware(hardware.detect());
  ui.step('Installation');
  ui.info(`Data folder: ${paths.home}`);
  if (!catalog || !Object.keys(state.profiles).length) { ui.todo('SAIAS is not installed. Run: saias install'); return; }
  ui.info(`Catalog: ${state.catalogVersion}`);
  for (const [id, entry] of Object.entries(state.profiles)) {
    const variant = catalog.profiles[id]?.variants.find(v => v.id === entry.variant);
    if (!variant) { ui.bad(`${profileName(id)}: variant ${entry.variant} is missing from the catalog`); continue; }
    const model = catalog.models[variant.model];
    const runtime = catalog.runtimes[variant.runtime];
    const filesOk = Object.values(model.files).every(f => store.filePath(state, f));
    const runtimeOk = store.runtimeDir(state, variant.runtime, runtime);
    const line = `${profileName(id).padEnd(12)} ${model.name}, ${runtime.name}${entry.device ? `, device ${entry.device}` : ''}`;
    if (filesOk && runtimeOk) ui.ok(line); else ui.bad(`${line}: files missing, run "saias install"`);
  }
  ui.step('Hub');
  if (hub) for (const p of hub.profiles) ui.info(`${p.id.padEnd(12)} ${p.status}`);
  else ui.info('Not running. Start it with Start-SAIAS.cmd or "saias start".');
}

function referenced(state) {
  const keep = { files: new Set(), runtimes: new Set() };
  const add = (catalog, profiles) => {
    if (!catalog) return;
    for (const [id, entry] of Object.entries(profiles || {})) {
      const v = catalog.profiles[id]?.variants.find(x => x.id === entry.variant);
      if (!v) continue;
      keep.runtimes.add(v.runtime);
      for (const f of Object.values(catalog.models[v.model].files)) keep.files.add(f.sha256);
    }
  };
  add(catalogs.installed(), state.profiles);
  try { add(catalogs.validate(JSON.parse(fs.readFileSync(PREVIOUS_CATALOG, 'utf8'))), state.previous?.profiles); } catch { /* no previous */ }
  return keep;
}

// Deletes downloaded files no profile uses any more (current or previous installation).
// Adopted files outside the SAIAS folder are only forgotten, never deleted.
async function clean(opts) {
  const state = store.load();
  const keep = referenced(state);
  const doomed = [];
  for (const [sha, f] of Object.entries(state.files)) if (!keep.files.has(sha)) doomed.push({ kind: 'file', key: sha, path: f.path, adopted: f.adopted });
  for (const [id, r] of Object.entries(state.runtimes)) if (!keep.runtimes.has(id)) doomed.push({ kind: 'runtime', key: id, path: r.dir, adopted: r.adopted });
  ui.step('Clean');
  if (!doomed.length) { ui.ok('Nothing to clean.'); return; }
  for (const d of doomed) ui.info(`${d.adopted ? 'forget' : 'delete'} ${d.path}`);
  if (!(await ui.confirm('Proceed?', false, opts.yes))) return;
  for (const d of doomed) {
    if (!d.adopted && d.path.startsWith(paths.home)) fs.rmSync(d.path, { recursive: true, force: true });
    if (d.kind === 'file') delete state.files[d.key]; else delete state.runtimes[d.key];
  }
  store.save(state);
  ui.ok('Done.');
}

module.exports = { install, update, rollback, adopt, status, clean, profileName };
