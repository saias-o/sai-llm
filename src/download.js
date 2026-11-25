'use strict';

// Resumable downloads verified by size and sha256, and archive extraction.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const paths = require('./paths');
const ui = require('./ui');

const ATTEMPTS = 6;

async function hashFile(file, onProgress) {
  const hash = crypto.createHash('sha256');
  let done = 0;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 4 << 20 })) {
    hash.update(chunk);
    done += chunk.length;
    onProgress?.(done);
  }
  return hash.digest('hex');
}

// Downloads spec.url to dest. A partial file (dest + ".part") is resumed; the final file is
// renamed into place only after its size and sha256 match the catalog.
async function downloadFile(spec, dest, label = spec.name) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest + '.part';
  const bar = ui.progress(label, spec.size);
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (have > spec.size) { fs.rmSync(part); have = 0; }
    try {
      const hash = crypto.createHash('sha256');
      if (have) {
        // Feed the bytes already on disk to the hash so the digest covers the whole file.
        bar.note('resuming');
        let read = 0;
        for await (const chunk of fs.createReadStream(part, { highWaterMark: 4 << 20 })) {
          hash.update(chunk);
          bar.update(read += chunk.length);
        }
      }
      if (have < spec.size) {
        const res = await fetch(spec.url, { headers: have ? { Range: `bytes=${have}-` } : {}, redirect: 'follow' });
        if (have && res.status === 200) {
          // The server ignored the range: start over.
          await res.body?.cancel();
          fs.rmSync(part);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        let done = have;
        const meter = new Transform({
          transform(chunk, _enc, cb) {
            hash.update(chunk);
            done += chunk.length;
            bar.update(done);
            cb(null, chunk);
          },
        });
        await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(part, { flags: 'a' }));
      }
      const size = fs.statSync(part).size;
      if (size !== spec.size) throw new Error(`size ${size}, expected ${spec.size}`);
      const digest = hash.digest('hex');
      if (digest !== spec.sha256) {
        fs.rmSync(part);
        throw new Error('sha256 mismatch, the file was discarded');
      }
      fs.renameSync(part, dest);
      bar.done();
      return dest;
    } catch (e) {
      if (attempt === ATTEMPTS) { bar.fail(e.message); throw new Error(`${label}: ${e.message}`); }
      bar.note(`${e.message}; retrying (${attempt}/${ATTEMPTS - 1})`);
      await delay(3000 * attempt);
    }
  }
  throw new Error(`${label}: download failed`);
}

// Windows' own bsdtar reads zip archives; a GNU tar earlier on PATH (Git for Windows) does not.
function tarCommand() {
  if (process.platform !== 'win32') return 'tar';
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return full;
    if (entry.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    }
  }
  return null;
}

// Extracts archives into dest. Archives may wrap their files in a folder: the folder that
// contains the binary (or, for archives without it, the top level) is what gets copied.
function extractArchives(archiveFiles, dest, binary) {
  fs.mkdirSync(paths.downloads, { recursive: true });
  const staging = fs.mkdtempSync(path.join(paths.downloads, 'extract-'));
  try {
    for (const archive of archiveFiles) {
      const tmp = fs.mkdtempSync(path.join(staging, 'a-'));
      // File times are not restored (unzip -DD, tar -m): exFAT and FAT drives reject the times
      // Windows tar tries to set, which fails the whole extraction although every file is there.
      if (/\.zip$/i.test(archive) && process.platform !== 'win32') execFileSync('unzip', ['-q', '-DD', archive, '-d', tmp]);
      else execFileSync(tarCommand(), ['-m', '-xf', archive, '-C', tmp], { windowsHide: true });
      const bin = findFile(tmp, binary);
      let root = bin ? path.dirname(bin) : tmp;
      if (!bin) {
        const entries = fs.readdirSync(root, { withFileTypes: true });
        if (entries.length === 1 && entries[0].isDirectory()) root = path.join(root, entries[0].name);
      }
      fs.cpSync(root, dest, { recursive: true, force: true });
    }
    if (!fs.existsSync(path.join(dest, binary))) throw new Error(`${binary} not found after extraction`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = { downloadFile, extractArchives, hashFile };
