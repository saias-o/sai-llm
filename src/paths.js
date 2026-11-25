'use strict';

// Where SAIAS keeps its data. Everything lives under one folder:
//   runtimes/<runtime id>/   extracted llama.cpp builds
//   models/                  model files
//   downloads/               partial downloads (resumable)
//   logs/                    server logs
//   state.json               what is installed and which variant each profile uses
//   catalog.json             the catalog the current installation was resolved from
//
// The folder is SAIAS_HOME when set, else the standard folder below. The setup can move it to
// another drive: the standard folder then holds data-folder.txt with the chosen path.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.dirname(__dirname);

function standardDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'SAIAS');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'SAIAS');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'saias');
}

const standard = standardDir();
const pointer = path.join(standard, 'data-folder.txt');

function dataDir() {
  if (process.env.SAIAS_HOME) return path.resolve(process.env.SAIAS_HOME);
  try {
    const chosen = fs.readFileSync(pointer, 'utf8').trim();
    if (chosen && path.isAbsolute(chosen)) return chosen;
  } catch { /* no other folder chosen */ }
  return standard;
}

function locate(home) {
  Object.assign(module.exports, {
    home,
    runtimes: path.join(home, 'runtimes'),
    models: path.join(home, 'models'),
    downloads: path.join(home, 'downloads'),
    logs: path.join(home, 'logs'),
    state: path.join(home, 'state.json'),
    installedCatalog: path.join(home, 'catalog.json'),
  });
}

// Moves the data folder for this process and the next ones (not the files already in it).
function setHome(dir) {
  const home = path.resolve(dir);
  if (process.env.SAIAS_HOME) throw new Error('SAIAS_HOME is set: change it instead.');
  fs.mkdirSync(home, { recursive: true });
  if (home.toLowerCase() === standard.toLowerCase()) fs.rmSync(pointer, { force: true });
  else {
    fs.mkdirSync(standard, { recursive: true });
    fs.writeFileSync(pointer, home + '\n');
  }
  locate(home);
}

module.exports = {
  ROOT,
  standard,
  repoCatalog: path.join(ROOT, 'catalog', 'catalog.json'),
  webMcp: path.join(ROOT, 'mcp', 'saias-web.js'),
  setHome,
};
locate(dataDir());
