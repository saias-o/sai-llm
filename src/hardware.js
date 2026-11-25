'use strict';

const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 });
  } catch {
    return '';
  }
}

function nvidiaGpus() {
  const out = run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
  return out.split(/\r?\n/).filter(Boolean).map(line => {
    const [name, mib] = line.split(/,\s*/);
    return { name: name.trim(), vramGB: Math.round(Number(mib) / 1024) };
  }).filter(g => g.vramGB > 0);
}

function freeBytes(dir) {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

function detect() {
  return {
    platform: `${process.platform}-${process.arch}`,
    ramGB: Math.round(os.totalmem() / 1024 ** 3),
    cpu: os.cpus()[0]?.model?.trim() || 'unknown CPU',
    threads: os.availableParallelism(),
    nvidia: nvidiaGpus(),
  };
}

function maxNvidiaVram(hw) {
  return Math.max(0, ...hw.nvidia.map(g => g.vramGB));
}

module.exports = { detect, maxNvidiaVram, freeBytes };
