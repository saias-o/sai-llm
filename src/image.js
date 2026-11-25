'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const paths = require('./paths');
const ui = require('./ui');
const { downloadFile, extractArchives, hashFile } = require('./download');
const spec = require('../catalog/image.json');

const executable = 'sd-cli.exe';
const supported = process.platform === 'win32' && process.arch === 'x64';
const pointer = path.join(paths.standard, 'image-folder.txt');
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const runFile = promisify(execFile);
let active;

function folder() {
  try {
    const chosen = fs.readFileSync(pointer, 'utf8').trim();
    if (path.isAbsolute(chosen)) return chosen;
  } catch { /* use the default data folder */ }
  return path.join(paths.home, 'image');
}

function binary(dir, backend) {
  return path.join(dir, spec.runtimes[backend].sha256.slice(0, 12), executable);
}

function modelPresent(dir) {
  try { return fs.statSync(path.join(dir, spec.model.name)).size === spec.model.size; }
  catch { return false; }
}

function status() {
  const dir = folder();
  return { supported, ready: supported && modelPresent(dir) && fs.existsSync(binary(dir, 'cpu')) };
}

async function ensureDownload(file, dest) {
  if (fs.existsSync(dest) && await hashFile(dest) === file.sha256) return;
  await downloadFile(file, dest);
}

async function install(destination, opts = {}) {
  if (!supported) throw new Error('saias-image currently supports Windows x64.');
  const dir = destination ? path.resolve(destination) : folder();
  ui.info(`${spec.name} (CreativeML OpenRAIL-M)  ${spec.license}`);
  if (!(await ui.confirm('Accept the model license?', true, opts.yes))) return;
  if (await alreadyInstalled(dir)) { register(dir); return; }
  const downloads = path.join(dir, 'downloads');
  await ensureDownload(spec.model, path.join(dir, spec.model.name));
  for (const [backend, runtime] of Object.entries(spec.runtimes)) {
    const exe = binary(dir, backend);
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
  register(dir);
}

async function alreadyInstalled(dir) {
  return modelPresent(dir) && Object.keys(spec.runtimes).every(backend => fs.existsSync(binary(dir, backend)))
    && await hashFile(path.join(dir, spec.model.name)) === spec.model.sha256;
}

function register(dir) {
  fs.mkdirSync(paths.standard, { recursive: true });
  const tmp = `${pointer}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, dir + '\n');
  fs.renameSync(tmp, pointer);
  ui.ok(`${spec.id} installed in ${dir}`);
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

async function render(promptFile, output, signal) {
  const dir = folder();
  const gpu = binary(dir, 'vulkan');
  const device = await vulkanDevice(gpu, signal);
  const threads = Math.max(1, Math.min(8, Math.floor(os.availableParallelism() / 2)));
  const args = ['-m', path.join(dir, spec.model.name), '--prompt-file', promptFile, '-o', output, '-W', '512', '-H', '512',
    '--sampling-method', 'lcm', '--scheduler', 'lcm', '--steps', '4', '--cfg-scale', '1', '--seed', '-1',
    '--vae-tiling', '--vae-tile-size', '40x40', '--vae-tile-overlap', '0.25', '--mmap', '-t', String(threads)];
  if (device) {
    try {
      await run(gpu, [...args, '--backend', `diffusion=${device},te=cpu,vae=cpu`,
        '--params-backend', 'diffusion=disk,te=cpu,vae=cpu', '--max-vram', '-0.5', '--disable-prefetch',
        '--diffusion-fa', '--diffusion-conv-direct'], signal);
      validatePng(output);
      return 'vulkan';
    } catch (error) {
      signal.throwIfAborted();
      console.warn('saias-image: Vulkan failed, retrying on CPU:', error.message);
      fs.rmSync(output, { force: true });
    }
  }
  await run(binary(dir, 'cpu'), [...args, '--backend', 'cpu', '--params-backend', 'cpu', '--diffusion-fa'], signal);
  validatePng(output);
  return 'cpu';
}

function validatePng(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(24);
    if (fs.readSync(fd, header) !== header.length || !header.subarray(0, 8).equals(pngSignature)
      || header.readUInt32BE(16) !== 512 || header.readUInt32BE(20) !== 512) {
      throw new Error('The image engine did not produce a 512 × 512 PNG.');
    }
  } finally { fs.closeSync(fd); }
}

function generate(prompt, dir, { signal, prepare } = {}) {
  if (active) throw Object.assign(new Error('An image is already being generated.'), { status: 409 });
  if (!status().ready) throw Object.assign(new Error('Install saias-image with "saias install-image" first.'), { status: 503 });
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
      const backend = await render(promptFile, tmp, jobSignal);
      jobSignal.throwIfAborted();
      fs.renameSync(tmp, path.join(dir, `${id}.png`));
      return { id, backend, model: spec.id };
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

module.exports = { install, status, generate, wait, busy, stop };
