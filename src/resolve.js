'use strict';

// Picks, for each profile, the first catalog variant this machine can run.

const { maxNvidiaVram } = require('./hardware');
const { modelVersion, modelVersions, variantsFor } = require('./catalog');

function unmet(variant, runtime, hw) {
  const reasons = [];
  if (runtime.platform !== hw.platform) reasons.push(`needs ${runtime.platform}`);
  const req = variant.requires || {};
  if (req.nvidiaVramGB && maxNvidiaVram(hw) < req.nvidiaVramGB) reasons.push(`needs an NVIDIA GPU with ${req.nvidiaVramGB} GB VRAM`);
  if (req.ramGB && hw.ramGB < req.ramGB) reasons.push(`needs ${req.ramGB} GB RAM`);
  return reasons;
}

// -> { profile, variant, model, runtime } or { profile, error }
function resolveProfile(catalog, profileId, hw, version) {
  const profile = catalog.profiles[profileId];
  if (!profile) return { profile: profileId, error: `unknown profile "${profileId}"` };
  version ??= modelVersion(profile);
  const variants = variantsFor(profile, version);
  if (!variants) return { profile: profileId, error: `version ${version} is not in the catalog` };
  const rejected = [];
  for (const variant of variants) {
    const runtime = catalog.runtimes[variant.runtime];
    const reasons = unmet(variant, runtime, hw);
    if (!reasons.length) return { profile: profileId, modelVersion: version, variant, model: catalog.models[variant.model], runtime };
    // Only explain the variants built for this platform.
    if (runtime.platform === hw.platform) rejected.push(reasons.join(', '));
  }
  return { profile: profileId, error: rejected[0] || `not available on ${hw.platform} yet` };
}

function resolveSelection(catalog, id, hw, entry) {
  if (entry?.pinned) return resolveProfile(catalog, id, hw, modelVersion(entry));
  const latest = resolveProfile(catalog, id, hw);
  if (!latest.error || !catalog.profiles[id]) return latest;
  for (const version of modelVersions(catalog.profiles[id]).slice(1)) {
    const older = resolveProfile(catalog, id, hw, version);
    if (!older.error) return older;
  }
  return latest;
}

function resolveAll(catalog, hw, entries = {}) {
  return Object.keys(catalog.profiles).map(id => resolveSelection(catalog, id, hw, entries[id]));
}

// Profiles installed by default: every profile this PC can run, slow ones included. They are
// flagged as slow, and the advisor (recommend.js) still picks a fast one for everyday use.
function recommended(catalog, hw, entries) {
  return resolveAll(catalog, hw, entries).filter(r => !r.error).map(r => r.profile);
}

// Every file a resolved profile needs, runtimes first.
function filesFor(resolution) {
  const { model, runtime, variant } = resolution;
  return {
    runtime: { id: variant.runtime, ...runtime },
    models: Object.entries(model.files).map(([role, f]) => ({ role, ...f })),
  };
}

module.exports = { resolveProfile, resolveSelection, resolveAll, recommended, filesFor };
