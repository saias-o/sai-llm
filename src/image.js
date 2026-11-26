'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const paths = require('./paths');
const ui = require('./ui');
const store = require('./store');
const { FIRST_MODEL_VERSION, modelVersion, modelVersions } = require('./catalog');
const { downloadFile, extractArchives, hashFile } = require('./download');
const catalog = require('../catalog/image.json');

const executable = 'sd-cli.exe';
const supported = process.platform === 'win32' && process.arch === 'x64';
const pointer = path.join(paths.standard, 'image-folder.txt');
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const runFile = promisify(execFile);
let active;

function registeredFolder() {
  try {
    const chosen = fs.readFileSync(pointer, 'utf8').trim();
    if (path.isAbsolute(chosen)) return chosen;
  } catch { /* use the default data folder */ }
}

function folder() { return registeredFolder() || path.join(paths.home, 'image'); }

function versionFile(dir) { return path.join(dir, 'model-version.json'); }

function installedSelection(dir) {
  try { return JSON.parse(fs.readFileSync(versionFile(dir), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return { modelVersion: FIRST_MODEL_VERSION }; }
}

function releaseFor(version) {
  return version === modelVersion(catalog) ? catalog : catalog.previousVersions?.[version];
}

function binary(dir, runtime) { return path.join(dir, runtime.sha256.slice(0, 12), executable); }

function modelPath(dir, release, version) {
  // Keep the original on-disk location for existing 1.0 installations.
  const weights = version === FIRST_MODEL_VERSION ? dir : path.join(dir, 'versions', version);
  return path.join(weights, release.model.name);
}

function installation(dir = folder()) {
  let selection;
  try { selection = installedSelection(dir); }
  catch (error) { return { dir, ready: false, error: error.message }; }
  const version = modelVersion(selection);
  const release = releaseFor(version);
  const ready = Boolean(supported && release && store.sizeOf(modelPath(dir, release, version)) === release.model.size
    && fs.existsSync(binary(dir, release.runtimes.cpu)));
  return { dir, ready, release, version, pinned: Boolean(selection.pinned) };
}

function status() {
  const { ready, release, version, pinned, error } = installation();
  return { supported, ready, model: release?.name, modelVersion: version, pinned, error };
}

function versions() {
  const current = installation();
  return modelVersions(catalog).map(version => ({ profile: catalog.id, version, model: releaseFor(version).name,
    active: current.ready && version === current.version, pinned: current.ready && current.pinned && version === current.version,
    latest: version === modelVersion(catalog), available: supported, error: supported ? undefined : 'requires Windows x64' }));
}

async function ensureDownload(file, dest) {
  if (fs.existsSync(dest) && await hashFile(dest) === file.sha256) return;
  await downloadFile(file, dest);
}

async function install(destination, opts = {}) {
  const current = installedSelection(folder());
  const pinned = Boolean(current.pinned);
  return installVersion(destination ? path.resolve(destination) : folder(), pinned ? modelVersion(current) : modelVersion(catalog), pinned, opts);
}

function use(version, opts) {
  return installVersion(folder(), version ?? modelVersion(catalog), version !== null, opts);
}

async function installVersion(dir, version, pinned, opts) {
  if (!supported) throw new Error('saias-image currently supports Windows x64.');
  const release = releaseFor(version);
  if (!release) throw new Error(`${catalog.id} ${version} is not in the catalog.`);
  ui.info(`${catalog.id} ${version} — ${release.name}${pinned ? ' (pinned)' : ''}`);
  if (opts.check) return;
  const current = installation(dir);
  if (current.ready && current.version === version && Object.values(release.runtimes).every(runtime => fs.existsSync(binary(dir, runtime)))
    && await hashFile(modelPath(dir, release, version)) === release.model.sha256) {
    register(dir, version, pinned);
    return;
  }
  ui.info(`${release.licenseName}  ${release.license}`);
  if (!(await ui.confirm('Accept the model license?', true, opts.yes))) return;
  const downloads = path.join(dir, 'downloads');
  await ensureDownload(release.model, modelPath(dir, release, version));
  for (const runtime of Object.values(release.runtimes)) {
    const exe = binary(dir, runtime);
    if (fs.existsSync(exe)) continue;
    const archive = path.join(downloads, runtime.name);
    await ensureDownload(runtime, archive);
    const staging = fs.mkdtempSync(path.join(downloads, 'runtime-'));
    try {
      extractArchives([archive], staging, executable, downloads);
      fs.renameSync(staging, path.dirname(exe));
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
    fs.rmSync(archive);
  }
  register(dir, version, pinned);
}

function register(dir, version, pinned) {
  store.writeJson(versionFile(dir), { modelVersion: version, pinned });
  writeFolder(dir);
  ui.ok(`${catalog.id} ${version} selected in ${dir}`);
}

function writeFolder(dir) {
  fs.mkdirSync(paths.standard, { recursive: true });
  const tmp = `${pointer}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, dir + '\n');
  fs.renameSync(tmp, pointer);
}

function rebaseFolder(rebase) {
  const before = registeredFolder();
  const after = rebase(before);
  if (after && after !== before) writeFolder(after);
}

async function vulkanDevice(exe, signal) {
  if (!fs.existsSync(exe)) return null;
  try {
    const { stdout } = await runFile(exe, ['--list-devices'], { cwd: path.dirname(exe), windowsHide: true, signal, timeout: 5000 });
    const devices = [...stdout.matchAll(/^(vulkan\d+)\t([^\r\n]+)/gim)];
    return (devices.find(row => /NVIDIA/i.test(row[2])) || devices[0])?.[1] || null;
  } catch {
    signal.throwIfAborted();
    return null;
  }
}

function run(exe, args, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const proc = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    let spawnError;
    const capture = chunk => { tail = (tail + chunk).slice(-6000); };
    const abort = () => proc.kill();
    proc.stdout.on('data', capture);
    proc.stderr.on('data', capture);
    proc.on('error', error => { spawnError = error; });
    signal.addEventListener('abort', abort, { once: true });
    proc.on('close', code => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason);
      else if (spawnError) reject(spawnError);
      else if (code !== 0) reject(new Error(`stable-diffusion.cpp exited with code ${code}. ${tail.trim()}`));
      else resolve();
    });
  });
}

async function render({ dir, release, version }, promptFile, output, signal) {
  const { width, height, args: generationArgs } = release.generation;
  const gpu = binary(dir, release.runtimes.vulkan);
  const device = await vulkanDevice(gpu, signal);
  const threads = Math.max(1, Math.min(8, Math.floor(os.availableParallelism() / 2)));
  const args = ['-m', modelPath(dir, release, version), '--prompt-file', promptFile, '-o', output,
    '-W', String(width), '-H', String(height), ...generationArgs, '-t', String(threads)];
  if (device) {
    try {
      await run(gpu, [...args, '--backend', `diffusion=${device},te=cpu,vae=cpu`,
        '--params-backend', 'diffusion=disk,te=cpu,vae=cpu', '--max-vram', '-0.5', '--disable-prefetch',
        '--diffusion-fa', '--diffusion-conv-direct'], signal);
      validatePng(output, width, height);
      return 'vulkan';
    } catch (error) {
      signal.throwIfAborted();
      console.warn('saias-image: Vulkan failed, retrying on CPU:', error.message);
      fs.rmSync(output, { force: true });
    }
  }
  await run(binary(dir, release.runtimes.cpu), [...args, '--backend', 'cpu', '--params-backend', 'cpu', '--diffusion-fa'], signal);
  validatePng(output, width, height);
  return 'cpu';
}

function validatePng(file, width, height) {
  const fd = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(24);
    if (fs.readSync(fd, header) !== header.length || !header.subarray(0, 8).equals(pngSignature)
      || header.readUInt32BE(16) !== width || header.readUInt32BE(20) !== height) {
      throw new Error(`The image engine did not produce a ${width} × ${height} PNG.`);
    }
  } finally { fs.closeSync(fd); }
}

function generate(prompt, dir, { signal, prepare } = {}) {
  if (active) throw Object.assign(new Error('An image is already being generated.'), { status: 409 });
  const selected = installation();
  if (!selected.ready) throw Object.assign(new Error('Install saias-image with "saias install-image" first.'), { status: 503 });
  const controller = new AbortController();
  const jobSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60 * 1000), ...(signal ? [signal] : [])]);
  const id = randomUUID();
  const tmp = path.join(dir, `${id}.part.png`);
  const promptFile = path.join(dir, `${id}.part.txt`);
  const done = Promise.resolve().then(async () => {
    await prepare?.();
    jobSignal.throwIfAborted();
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(promptFile, prompt, { flag: 'wx' });
      const backend = await render(selected, promptFile, tmp, jobSignal);
      jobSignal.throwIfAborted();
      fs.renameSync(tmp, path.join(dir, `${id}.png`));
      return { id, backend, model: catalog.id, modelVersion: selected.version };
    } finally {
      fs.rmSync(tmp, { force: true });
      fs.rmSync(promptFile, { force: true });
    }
  }).finally(() => { active = null; });
  active = { controller, done, dir };
  return done;
}

function wait() { return active?.done.catch(() => {}); }
function busy(dir) { return active?.dir.toLowerCase() === dir.toLowerCase(); }
function stop() { active?.controller.abort(); }

module.exports = { install: (...args) => store.withLock(() => install(...args)), use, versions, status, generate, wait, busy, stop, rebaseFolder };
