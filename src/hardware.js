'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

// Installed RAM in GB. The OS reports a little less than what is installed (firmware and
// integrated graphics reserve some), so an "8 GB" laptop shows 7.4 GB: read the memory modules
// on Windows, and round up elsewhere.
function installedRamGB() {
  const visible = os.totalmem() / 1024 ** 3;
  if (process.platform === 'win32') {
    const out = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-CimInstance Win32_PhysicalMemory | Measure-Object -Property Capacity -Sum).Sum']);
    const bytes = Number(out.trim());
    if (bytes > 0) return Math.round(bytes / 1024 ** 3);
  }
  return Math.ceil(visible - 0.25);
}

// Free bytes on the drive that holds dir (or its nearest existing parent).
function freeBytes(dir) {
  while (dir && !fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
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
    ramGB: installedRamGB(),
    cpu: os.cpus()[0]?.model?.trim() || 'unknown CPU',
    threads: os.availableParallelism(),
    nvidia: nvidiaGpus(),
  };
}

function maxNvidiaVram(hw) {
  return Math.max(0, ...hw.nvidia.map(g => g.vramGB));
}

module.exports = { detect, maxNvidiaVram, freeBytes };
