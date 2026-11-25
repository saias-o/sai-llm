'use strict';

// Where SAIAS keeps its data. Everything lives under one folder:
//   runtimes/<runtime id>/   extracted llama.cpp builds
//   models/                  model files
//   downloads/               partial downloads (resumable)
//   logs/                    server logs
//   state.json               what is installed and which variant each profile uses
//   catalog.json             the catalog the current installation was resolved from

const os = require('node:os');
const path = require('node:path');

const ROOT = path.dirname(__dirname);

function dataDir() {
  if (process.env.SAIAS_HOME) return path.resolve(process.env.SAIAS_HOME);
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'SAIAS');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'SAIAS');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'saias');
}

const home = dataDir();

module.exports = {
  ROOT,
  home,
  runtimes: path.join(home, 'runtimes'),
  models: path.join(home, 'models'),
  downloads: path.join(home, 'downloads'),
  logs: path.join(home, 'logs'),
  state: path.join(home, 'state.json'),
  installedCatalog: path.join(home, 'catalog.json'),
  repoCatalog: path.join(ROOT, 'catalog', 'catalog.json'),
  webMcp: path.join(ROOT, 'mcp', 'saias-web.js'),
};
