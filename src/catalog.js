'use strict';

// The catalog maps stable profile names (flash, smart, pro) to concrete models and
// llama.cpp runtimes. Clients only ever see "saias-<profile>"; a new catalog version can
// swap the model behind a profile without any client change.

const fs = require('node:fs');
const paths = require('./paths');

const SCHEMA = 1;
const DEFAULT_URL = 'https://raw.githubusercontent.com/saias-o/saias-llm/main/catalog/catalog.json';
const REASONING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

function validate(catalog) {
  const problems = [];
  if (catalog.schema !== SCHEMA) problems.push(`unsupported catalog schema ${catalog.schema} (expected ${SCHEMA})`);
  for (const [pid, profile] of Object.entries(catalog.profiles || {})) {
    if (!/^[a-z][a-z0-9-]*$/.test(pid)) problems.push(`profile "${pid}": invalid name`);
    if (!profile.variants?.length) problems.push(`profile "${pid}": no variants`);
    for (const v of profile.variants || []) {
      const model = catalog.models?.[v.model];
      const runtime = catalog.runtimes?.[v.runtime];
      if (!model) problems.push(`${v.id}: unknown model "${v.model}"`);
      if (!runtime) problems.push(`${v.id}: unknown runtime "${v.runtime}"`);
      if (model && runtime) {
        for (const need of model.needs || []) {
          if (!runtime.supports?.includes(need)) problems.push(`${v.id}: runtime ${v.runtime} lacks "${need}" needed by ${v.model}`);
        }
      }
      for (const level of Object.keys(v.reasoning?.levels || {})) {
        if (!REASONING_LEVELS.includes(level)) problems.push(`${v.id}: unknown reasoning level "${level}"`);
      }
    }
  }
  for (const [id, m] of Object.entries(catalog.models || {})) {
    for (const [role, f] of Object.entries(m.files || {})) {
      if (!f.url || !f.size || !/^[0-9a-f]{64}$/.test(f.sha256 || '')) problems.push(`${id}.${role}: url, size and sha256 are required`);
    }
  }
  for (const [id, r] of Object.entries(catalog.runtimes || {})) {
    for (const a of r.archives || []) {
      if (!a.url || !a.size || !/^[0-9a-f]{64}$/.test(a.sha256 || '')) problems.push(`runtime ${id}: url, size and sha256 are required`);
    }
  }
  if (problems.length) throw new Error('Invalid catalog:\n  ' + problems.join('\n  '));
  return catalog;
}

function readFile(file) {
  return validate(JSON.parse(fs.readFileSync(file, 'utf8')));
}

// The catalog shipped with this copy of SAIAS.
function bundled() {
  return readFile(paths.repoCatalog);
}

// The catalog the current installation was resolved from, if any.
function installed() {
  try { return readFile(paths.installedCatalog); } catch { return null; }
}

async function remote(url = process.env.SAIAS_CATALOG_URL || DEFAULT_URL) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'Cache-Control': 'no-cache' } });
  if (!res.ok) throw new Error(`Could not fetch the catalog (${res.status}) from ${url}`);
  return validate(await res.json());
}

// Versions are dates (YYYY.MM.DD[.N]); compare them numerically part by part.
function compareVersions(a = '0', b = '0') {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

function newest(...catalogs) {
  return catalogs.filter(Boolean).sort((x, y) => compareVersions(y.version, x.version))[0] || null;
}

function save(catalog) {
  fs.mkdirSync(paths.home, { recursive: true });
  fs.writeFileSync(paths.installedCatalog, JSON.stringify(catalog, null, 2) + '\n');
}

module.exports = { REASONING_LEVELS, validate, bundled, installed, remote, newest, compareVersions, save };
