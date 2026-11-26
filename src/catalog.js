'use strict';

// The catalog maps stable profile names (flash, smart, pro) to concrete models and
// llama.cpp runtimes. Clients only ever see "saias-<profile>"; a new catalog version can
// swap the model behind a profile without any client change.

const fs = require('node:fs');
const { isDeepStrictEqual } = require('node:util');
const paths = require('./paths');

const SCHEMA = 1;
const DEFAULT_URL = 'https://raw.githubusercontent.com/saias-o/saias-llm/main/catalog/catalog.json';
const REASONING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

const FIRST_MODEL_VERSION = '1.0';
const MODEL_VERSION = /^[1-9]\d*\.(0|[1-9]\d*)$/;

function modelVersion(entry) { return entry?.modelVersion ?? FIRST_MODEL_VERSION; }

function variantsFor(profile, version = modelVersion(profile)) {
  if (!profile) return undefined;
  return version === modelVersion(profile) ? profile.variants : profile.previousVersions?.[version];
}

function installedVariant(catalog, id, entry) {
  return variantsFor(catalog.profiles[id], modelVersion(entry))?.find(v => v.id === entry?.variant);
}

function modelVersions(profile) {
  return [modelVersion(profile), ...Object.keys(profile.previousVersions || {})].sort((a, b) => compareVersions(b, a));
}

function validate(catalog) {
  const problems = [];
  if (catalog.schema !== SCHEMA) problems.push(`unsupported catalog schema ${catalog.schema} (expected ${SCHEMA})`);
  Object.values(catalog.profiles || {}).forEach((profile, index) => {
    // Capability order, higher is more capable. Catalogs written before "rank" existed list
    // their profiles from the least to the most capable.
    if (!Number.isFinite(profile.rank)) profile.rank = index + 1;
  });
  for (const [pid, profile] of Object.entries(catalog.profiles || {})) {
    if (!/^[a-z][a-z0-9-]*$/.test(pid)) problems.push(`profile "${pid}": invalid name`);
    const version = profile.modelVersion === undefined ? FIRST_MODEL_VERSION : profile.modelVersion;
    const history = Object.keys(profile.previousVersions || {});
    if (typeof version !== 'string' || !MODEL_VERSION.test(version)
      || (version !== FIRST_MODEL_VERSION && !history.includes(FIRST_MODEL_VERSION))
      || history.some(key => !MODEL_VERSION.test(key) || compareVersions(key, version) >= 0)) {
      problems.push(`profile "${pid}": invalid model version history (use versions such as 1.0, 1.1 and 2.0)`);
    }
    for (const [number, variants] of [[version, profile.variants], ...Object.entries(profile.previousVersions || {})]) {
      if (!Array.isArray(variants) || !variants.length) { problems.push(`profile "${pid}" ${number}: no variants`); continue; }
      if (new Set(variants.map(v => v.id)).size !== variants.length) problems.push(`profile "${pid}" ${number}: duplicate variants`);
      validateVariants(variants, catalog, problems);
    }
  }
  for (const [id, m] of Object.entries(catalog.models || {})) {
    for (const [role, f] of Object.entries(m.files || {})) {
      if (typeof f.name !== 'string' || !f.name || /^[.]{1,2}$|[/\\:]/.test(f.name)) problems.push(`${id}.${role}: invalid file name`);
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

function validateVariants(variants, catalog, problems) {
  for (const v of variants) {
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

function verifyHistory(before, next) {
  if (!before) return;
  for (const [id, profile] of Object.entries(before.profiles)) {
    if (!profile.modelVersion) continue; // Catalogs shipped before model versioning.
    for (const version of modelVersions(profile)) {
      const current = next.profiles[id];
      const retained = variantsFor(current, version);
      if (!retained) throw new Error(`The new catalog removed saias-${id} ${version}.`);
      for (const variant of variantsFor(profile, version)) {
        const replacement = retained.find(v => v.id === variant.id);
        const archived = version !== modelVersion(current);
        const original = before.models[variant.model];
        const candidate = next.models[replacement?.model];
        const weights = model => Object.fromEntries(Object.entries(model?.files || {}).map(([role, file]) => [role, file.sha256]));
        if (!replacement || !candidate || !isDeepStrictEqual(weights(original), weights(candidate))
          || (archived && (!isDeepStrictEqual(variant, replacement) || original.template !== candidate.template))) {
          throw new Error(`The new catalog changed saias-${id} ${version} (${variant.id}). Keep its original artifacts and publish new weights under a new model version.`);
        }
        const archives = runtime => runtime?.archives?.map(a => a.sha256);
        const runtime = next.runtimes[variant.runtime];
        if (runtime && !isDeepStrictEqual(archives(before.runtimes[variant.runtime]), archives(runtime))) {
          throw new Error(`The new catalog changed runtime ${variant.runtime}. Publish it under a new runtime ID.`);
        }
      }
    }
  }
}

function save(catalog) {
  require('./store').writeJson(paths.installedCatalog, catalog);
}

module.exports = { REASONING_LEVELS, FIRST_MODEL_VERSION, MODEL_VERSION, modelVersion, variantsFor, installedVariant, modelVersions, validate, verifyHistory, bundled, installed, remote, newest, compareVersions, save };
