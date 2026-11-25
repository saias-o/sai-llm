'use strict';

// The native SAIAS app (Windows). The installer from Build-Installer.ps1 ships SAIAS.exe next to
// saias.cmd. A source checkout has none: it downloads the build that GitHub Actions publishes on
// the "app" release (.github/workflows/app.yml) into <SAIAS folder>\app. SAIAS.exe finds
// saias.cmd by looking in its parent folders, so it works from there.

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const ui = require('./ui');
const { downloadFile, extractArchives } = require('./download');

const RELEASE = process.env.SAIAS_APP_URL || 'https://github.com/saias-o/saias-llm/releases/download/app';
const APP_DIR = path.join(paths.ROOT, 'app');
const BUNDLED = path.join(paths.ROOT, 'SAIAS.exe');
const DOWNLOADED = path.join(APP_DIR, 'SAIAS.exe');
const INFO = path.join(APP_DIR, 'app.json');

// The app to launch, or null when there is none yet.
function exe() {
  if (process.platform !== 'win32') return null;
  if (fs.existsSync(BUNDLED)) return BUNDLED;
  return fs.existsSync(DOWNLOADED) ? DOWNLOADED : null;
}

function readJson(text) {
  return JSON.parse(String(text).replace(/^﻿/, ''));
}

function installedInfo() {
  try { return readJson(fs.readFileSync(INFO, 'utf8')); } catch { return null; }
}

async function latestInfo() {
  const res = await fetch(`${RELEASE}/app.json`, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`no published SAIAS app (HTTP ${res.status})`);
  const info = readJson(await res.text());
  if (!info.file || !info.size || !/^[0-9a-f]{64}$/.test(info.sha256 || '')) throw new Error('the published app.json is incomplete');
  return info;
}

// Downloads or updates the app when this copy of SAIAS has no SAIAS.exe of its own.
// Never fatal: without the app, the shortcut opens Llama Chat instead.
async function ensure() {
  if (process.platform !== 'win32' || fs.existsSync(BUNDLED)) return exe();
  ui.step('SAIAS app');
  let latest;
  try {
    latest = await latestInfo();
  } catch (e) {
    if (exe()) { ui.ok(`SAIAS app (could not check for a newer build: ${e.message})`); return exe(); }
    ui.bad(`SAIAS app not installed: ${e.message}. The shortcut opens Llama Chat instead.`);
    return null;
  }
  const current = installedInfo();
  if (exe() && current?.sha256 === latest.sha256) { ui.ok(`SAIAS app (build ${latest.commit.slice(0, 7)})`); return exe(); }

  const zip = path.join(paths.downloads, latest.file);
  try {
    await downloadFile({ url: `${RELEASE}/${latest.file}`, size: latest.size, sha256: latest.sha256, name: latest.file }, zip, 'SAIAS app');
    fs.rmSync(APP_DIR, { recursive: true, force: true });
    extractArchives([zip], APP_DIR, 'SAIAS.exe');
    fs.writeFileSync(INFO, JSON.stringify(latest, null, 2) + '\n');
    ui.ok(`SAIAS app installed (build ${latest.commit.slice(0, 7)})`);
  } catch (e) {
    ui.bad(`SAIAS app not installed: ${e.message}`);
  } finally {
    fs.rmSync(zip, { force: true });
  }
  return exe();
}

module.exports = { exe, ensure, APP_DIR };
