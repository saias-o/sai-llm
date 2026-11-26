'use strict';

// What this PC should use: every profile as resolved from the catalog, the most capable one and
// the everyday one. Measured speeds (saias bench) win over the catalog's expectations.
// Shown by "saias recommend" and read by the SAIAS app (--json).

const catalogs = require('./catalog');
const hardware = require('./hardware');
const store = require('./store');
const ui = require('./ui');
const { resolveAll } = require('./resolve');

function recommendations(catalog = catalogs.installed() || catalogs.bundled(), hw = hardware.detect(), state = store.load()) {
  const profiles = resolveAll(catalog, hw, state.profiles).map(r => {
    const profile = catalog.profiles[r.profile];
    const entry = { id: 'saias-' + r.profile, profile: r.profile, summary: profile.summary, rank: profile.rank, interactive: Boolean(profile.interactive) };
    if (r.error) return { ...entry, available: false, error: r.error };
    const installed = state.profiles[r.profile];
    const bench = state.benchmarks?.[r.profile];
    return {
      ...entry,
      available: true,
      installed: Boolean(installed),
      model: r.model.name,
      modelVersion: r.modelVersion,
      pinned: Boolean(installed?.pinned),
      runtime: r.runtime.name,
      variant: r.variant.id,
      slow: Boolean(r.variant.slow),
      cpuOnly: r.variant.server?.device === 'none',
      note: r.variant.note || null,
      context: r.variant.server['ctx-size'] || r.model.context,
      vision: Boolean(r.model.vision),
      benchmark: bench && bench.variant === r.variant.id && catalogs.modelVersion(bench) === r.modelVersion
        ? { genTps: bench.genTps, rating: bench.rating, date: bench.date } : null,
    };
  }).sort((a, b) => b.rank - a.rank);

  const available = profiles.filter(p => p.available);
  const top = available[0];
  const mostCapable = top ? {
    id: top.id,
    reason: `${top.model} on ${top.cpuOnly ? 'the CPU' : top.runtime}${top.slow ? '; it runs slowly on this PC' : ''}.`,
  } : null;

  const measured = available.find(p => p.benchmark && p.benchmark.rating !== 'slow');
  const expected = available.find(p => p.interactive && !p.slow);
  const pick = measured || expected || available[available.length - 1];
  const everyday = pick ? {
    id: pick.id,
    measured: Boolean(pick.benchmark),
    genTps: pick.benchmark?.genTps ?? null,
    reason: pick.benchmark
      ? `Measured at ${pick.benchmark.genTps} tokens/s on this PC.`
      : 'Expected to answer quickly on this PC. Run "saias bench" to measure it.',
  } : null;

  return { catalogVersion: catalog.version, hardware: hw, profiles, mostCapable, everyday };
}

function run(opts) {
  const r = recommendations();
  if (opts.json) { console.log(JSON.stringify(r)); return; }
  ui.step(`Profiles for this PC (catalog ${r.catalogVersion})`);
  for (const p of r.profiles) {
    if (!p.available) { ui.info(`${p.id.padEnd(12)} not available: ${p.error}`); continue; }
    const speed = p.benchmark ? `${p.benchmark.genTps} tokens/s (${p.benchmark.rating})` : 'not measured';
    ui.info(`${p.id.padEnd(12)} ${p.modelVersion} ${p.model}, ${p.context.toLocaleString('en-US')} tokens, ${speed}${p.installed ? '' : ', not installed'}`);
  }
  if (r.mostCapable) ui.ok(`Most capable: ${r.mostCapable.id}. ${r.mostCapable.reason}`);
  if (r.everyday) ui.ok(`Everyday pick: ${r.everyday.id}. ${r.everyday.reason}`);
}

module.exports = { recommendations, run };
