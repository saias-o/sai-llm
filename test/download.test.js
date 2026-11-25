'use strict';

// Archive extraction for runtimes. SAIAS_HOME points at a temporary folder before anything loads.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saias-test-'));
process.env.SAIAS_HOME = home;
const { extractArchives } = require('../src/download');

const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const binary = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

// A runtime archive whose files sit in a wrapper folder, as some releases ship them.
function makeArchive(dir) {
  const src = path.join(dir, 'src', 'build-1234');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, binary), 'binary');
  fs.writeFileSync(path.join(src, 'ggml.dll'), 'library');
  const archive = path.join(dir, 'runtime.tar.gz');
  execFileSync(tar, ['-czf', archive, '-C', path.join(dir, 'src'), 'build-1234']);
  return archive;
}

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('runtime archives are extracted without their wrapper folder', () => {
  const archive = makeArchive(home);
  const dest = path.join(home, 'runtimes', 'r1');
  extractArchives([archive], dest, binary);
  assert.equal(fs.readFileSync(path.join(dest, binary), 'utf8'), 'binary');
  assert.ok(fs.existsSync(path.join(dest, 'ggml.dll')));
});

// exFAT and FAT drives cannot take the file times tar restores: extraction must still work.
// Runs when SAIAS_TEST_DRIVE names such a folder (for example D:\ on an exFAT drive).
test('extraction works on the drive in SAIAS_TEST_DRIVE', { skip: !process.env.SAIAS_TEST_DRIVE }, () => {
  const dir = fs.mkdtempSync(path.join(process.env.SAIAS_TEST_DRIVE, 'saias-test-'));
  try {
    const archive = makeArchive(dir);
    const dest = path.join(dir, 'runtime');
    extractArchives([archive], dest, binary);
    assert.ok(fs.existsSync(path.join(dest, binary)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
