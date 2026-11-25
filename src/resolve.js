'use strict';

// Picks, for each profile, the first catalog variant this machine can run.

const { maxNvidiaVram } = require('./hardware');

function unmet(variant, runtime, hw) {
  const reasons = [];
  if (runtime.platform !== hw.platform) reasons.push(`needs ${runtime.platform}`);
  const req = variant.requires || {};
  if (req.nvidiaVramGB && maxNvidiaVram(hw) < req.nvidiaVramGB) reasons.push(`needs an NVIDIA GPU with ${req.nvidiaVramGB} GB VRAM`);
  if (req.ramGB && hw.ramGB < req.ramGB) reasons.push(`needs ${req.ramGB} GB RAM`);
  return reasons;
}

// -> { profile, variant, model, runtime } or { profile, error }
function resolveProfile(catalog, profileId, hw) {
  const profile = catalog.profiles[profileId];
  if (!profile) return { profile: profileId, error: `unknown profile "${profileId}"` };
  const rejected = [];
  for (const variant of profile.variants) {
    const runtime = catalog.runtimes[variant.runtime];
    const reasons = unmet(variant, runtime, hw);
    if (!reasons.length) return { profile: profileId, variant, model: catalog.models[variant.model], runtime };
    // Only explain the variants built for this platform.
    if (runtime.platform === hw.platform) rejected.push(reasons.join(', '));
  }
  return { profile: profileId, error: rejected[0] || `not available on ${hw.platform} yet` };
}

function resolveAll(catalog, hw) {
  return Object.keys(catalog.profiles).map(id => resolveProfile(catalog, id, hw));
}

// Profiles worth installing by default: everything that runs at full speed here.
function recommended(catalog, hw) {
  return resolveAll(catalog, hw).filter(r => !r.error && !r.variant.slow).map(r => r.profile);
}

// Every file a resolved profile needs, runtimes first.
function filesFor(resolution) {
  const { model, runtime, variant } = resolution;
  return {
    runtime: { id: variant.runtime, ...runtime },
    models: Object.entries(model.files).map(([role, f]) => ({ role, ...f })),
  };
}

module.exports = { resolveProfile, resolveAll, recommended, filesFor };
