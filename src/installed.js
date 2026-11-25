'use strict';

// The installed profiles as clients see them, and helpers shared by the client integrations.

const catalogs = require('./catalog');
const store = require('./store');

const HUB_PORT = Number(process.env.SAIAS_HUB_PORT || 8090);
const HUB_URL = `http://127.0.0.1:${HUB_PORT}`;
// Most capable first: the default for agent and coding tools.
const PREFERENCE = ['pro', 'smart', 'flash'];

// [{ id: "saias-pro", profile: "pro", name, context, vision, reasoning }], most capable first.
function installedModels() {
  const catalog = catalogs.installed();
  const state = store.load();
  if (!catalog) return [];
  const models = [];
  for (const [id, entry] of Object.entries(state.profiles)) {
    const variant = catalog.profiles[id]?.variants.find(v => v.id === entry.variant);
    if (!variant) continue;
    const model = catalog.models[variant.model];
    const levels = Object.keys(variant.reasoning?.levels || {});
    models.push({
      id: 'saias-' + id,
      profile: id,
      name: model.name,
      context: variant.server['ctx-size'] || model.context,
      vision: Boolean(model.vision),
      reasoning: levels.some(l => l !== 'none'),
    });
  }
  const rank = m => { const i = PREFERENCE.indexOf(m.profile); return i < 0 ? PREFERENCE.length : i; };
  return models.sort((a, b) => rank(a) - rank(b));
}

function requireInstalled() {
  const models = installedModels();
  if (!models.length) throw new Error('SAIAS is not installed. Run Install-SAIAS.cmd (or "saias install") first.');
  return models;
}

// The model for a tool: the requested profile if installed, else the most capable one.
function pickModel(models, profile) {
  if (profile) {
    const wanted = models.find(m => m.profile === profile || m.id === profile);
    if (!wanted) throw new Error(`Profile "${profile}" is not installed. Installed: ${models.map(m => m.profile).join(', ')}`);
    return wanted;
  }
  return models[0];
}

async function hubRunning() {
  try {
    const r = await fetch(`${HUB_URL}/saias/status`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

module.exports = { HUB_PORT, HUB_URL, installedModels, requireInstalled, pickModel, hubRunning };
