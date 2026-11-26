'use strict';

// Installation state: which files and runtimes are on disk, and which catalog variant each
// installed profile uses. Model files are keyed by sha256, so a file shared by two catalog
// versions is downloaded once.

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');

const SCHEMA = 1;

function empty() {
  return { schema: SCHEMA, catalogVersion: null, files: {}, runtimes: {}, profiles: {}, previous: null };
}

function load() {
  try {
    const state = JSON.parse(fs.readFileSync(paths.state, 'utf8'));
    return state.schema === SCHEMA ? { ...empty(), ...state } : empty();
  } catch {
    return empty();
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function save(state) { writeJson(paths.state, state); }

// Serialize catalog and state changes across the CLI and the graphical setup.
async function withLock(operation) {
  const root = process.env.SAIAS_HOME ? paths.home : paths.standard;
  const file = path.join(root, 'installation.lock');
  fs.mkdirSync(root, { recursive: true });
  let fd;
  try { fd = fs.openSync(file, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner;
    try { owner = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const pid = Number(owner);
    let abandoned = owner === undefined;
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); } catch (e) { abandoned = e.code === 'ESRCH'; }
    } else if (owner !== undefined) {
      try { abandoned = Date.now() - fs.statSync(file).mtimeMs > 60_000; }
      catch (e) { if (e.code !== 'ENOENT') throw e; abandoned = true; }
    }
    if (abandoned) {
      try { if (owner !== undefined && fs.readFileSync(file, 'utf8') === owner) fs.unlinkSync(file); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      try { fd = fs.openSync(file, 'wx'); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    if (fd === undefined) throw new Error('Another SAIAS installation operation is in progress. Try again when it finishes.');
  }
  try {
    fs.writeFileSync(fd, `${process.pid}\n`);
    return await operation();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(file, { force: true });
  }
}

function sizeOf(file) {
  try { return fs.statSync(file).size; } catch { return -1; }
}

// Path of a catalog file if it is on disk with the expected size, else null.
function filePath(state, spec) {
  const known = state.files[spec.sha256];
  if (known && sizeOf(known.path) === spec.size) return known.path;
  const versioned = downloadPath(spec);
  if (sizeOf(versioned) === spec.size) return versioned;
  const standard = path.join(paths.models, spec.name);
  if (sizeOf(standard) === spec.size && !Object.entries(state.files).some(([sha, file]) =>
    sha !== spec.sha256 && typeof file.path === 'string'
    && (process.platform === 'win32' ? path.resolve(file.path).toLowerCase() === standard.toLowerCase() : path.resolve(file.path) === standard))) return standard;
  return null;
}

function downloadPath(spec) { return path.join(paths.models, spec.sha256, spec.name); }

function recordFile(state, spec, file, { verified, adopted = false }) {
  state.files[spec.sha256] = { name: spec.name, path: file, size: spec.size, verified, adopted };
}

function binaryPath(dir, runtime) {
  return path.join(dir, runtime.binary);
}

// Directory of an installed runtime, else null.
function runtimeDir(state, id, runtime) {
  const candidates = [state.runtimes[id]?.dir, path.join(paths.runtimes, id)].filter(Boolean);
  return candidates.find(dir => fs.existsSync(binaryPath(dir, runtime))) || null;
}

function recordRuntime(state, id, dir, { adopted = false } = {}) {
  state.runtimes[id] = { dir, adopted };
}

module.exports = { load, save, writeJson, withLock, filePath, downloadPath, recordFile, runtimeDir, recordRuntime, binaryPath, sizeOf };
