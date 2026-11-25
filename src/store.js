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

function save(state) {
  fs.mkdirSync(paths.home, { recursive: true });
  const tmp = paths.state + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, paths.state);
}

function sizeOf(file) {
  try { return fs.statSync(file).size; } catch { return -1; }
}

// Path of a catalog file if it is on disk with the expected size, else null.
function filePath(state, spec) {
  const known = state.files[spec.sha256];
  if (known && sizeOf(known.path) === spec.size) return known.path;
  const standard = path.join(paths.models, spec.name);
  if (sizeOf(standard) === spec.size) return standard;
  return null;
}

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

module.exports = { load, save, filePath, recordFile, runtimeDir, recordRuntime, binaryPath, sizeOf };
