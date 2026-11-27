'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saias-versions-'));
process.env.SAIAS_HOME = root;
process.env.LOCALAPPDATA = root;
process.env.XDG_DATA_HOME = root;
const catalogs = require('../src/catalog');
const hardware = require('../src/hardware');
const paths = require('../src/paths');
const store = require('../src/store');
const manage = require('../src/install');
const { resolveSelection } = require('../src/resolve');
const { installedModels } = require('../src/installed');
const ui = require('../src/ui');

const hw = { platform: 'win32-x64', ramGB: 32, cpu: 'test', threads: 8, nvidia: [] };
ui.setReporter({ event() {}, progress: () => ({ update() {}, note() {}, done() {}, fail() {} }) });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function profile(id, latest, releases) {
  const variants = key => [{ id: `${id}-vulkan`, model: key, runtime: 'test', server: {} }];
  return { modelVersion: latest, variants: variants(releases[latest]), previousVersions: Object.fromEntries(
    Object.entries(releases).filter(([version]) => version !== latest).map(([version, key]) => [version, variants(key)]),
  ) };
}

test('model versions stay independent across updates, cached downgrades and re-downloads', async t => {
  const [year, month, day, revision = 0] = catalogs.bundled().version.split('.').map(Number);
  const catalogVersion = offset => [year, month, day, revision + offset].join('.');
  const bodies = { flash1: 'flash one', flash2: 'flash two', flash3: 'flash tre', smart1: 'bonsai 02', smart2: 'bonsai 03' };
  const server = http.createServer((req, res) => {
    const body = bodies[req.url.slice(1)];
    res.writeHead(body ? 200 : 404);
    res.end(body);
  });
  server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');

  const models = Object.fromEntries(Object.entries(bodies).map(([id, body]) => [id, {
    name: id, license: { name: 'Test' }, context: 1024,
    files: { model: { name: id.startsWith('smart') ? 'bonsai.gguf' : `${id}.gguf`, size: Buffer.byteLength(body),
      sha256: createHash('sha256').update(body).digest('hex'), url: `http://127.0.0.1:${server.address().port}/${id}` } },
  }]));
  const runtime = { binary: 'test-server', name: 'Test runtime', platform: hw.platform, archives: [] };
  const first = catalogs.validate({ schema: 1, version: catalogVersion(1), models, runtimes: { test: runtime }, profiles: {
    flash: profile('flash', '1.0', { '1.0': 'flash1' }), smart: profile('smart', '1.0', { '1.0': 'smart1' }),
  } });
  const next = structuredClone(first);
  next.version = catalogVersion(2);
  next.profiles.flash = profile('flash', '1.1', { '1.0': 'flash1', '1.1': 'flash2' });
  next.profiles.smart = profile('smart', '2.0', { '1.0': 'smart1', '2.0': 'smart2' });
  const later = structuredClone(next);
  later.version = catalogVersion(3);
  later.profiles.flash = profile('flash', '2.0', { '1.0': 'flash1', '1.1': 'flash2', '2.0': 'flash3' });
  let latest = next;
  t.mock.method(catalogs, 'remote', async () => catalogs.validate(latest));
  t.mock.method(hardware, 'detect', () => hw);

  catalogs.save(first);
  const initial = store.load();
  initial.profiles = { flash: { variant: 'flash-vulkan' }, smart: { variant: 'smart-vulkan' } };
  initial.catalogVersion = first.version;
  const runtimeDir = path.join(paths.runtimes, 'test');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, runtime.binary), 'existing runtime');
  for (const id of ['flash1', 'smart1']) {
    const spec = models[id].files.model;
    const old = path.join(paths.models, spec.name);
    fs.mkdirSync(paths.models, { recursive: true });
    fs.writeFileSync(old, bodies[id]);
    store.recordFile(initial, spec, old, { verified: true });
  }
  store.save(initial);
  const installed = id => installedModels().find(model => model.profile === id);
  assert.equal(installed('smart').modelVersion, '1.0', 'legacy state is version 1.0');

  await manage.update({ yes: true });
  assert.equal(installed('flash').modelVersion, '1.1');
  assert.equal(installed('smart').modelVersion, '2.0');
  assert.equal(fs.readFileSync(store.filePath(store.load(), models.smart2.files.model), 'utf8'), bodies.smart2);
  const unchanged = structuredClone(store.load().profiles.flash);

  await manage.use('saias-smart', '1.0', { yes: true });
  assert.deepEqual(store.load().profiles.flash, unchanged);
  assert.equal(installed('smart').name, 'smart1');
  assert.equal(installed('smart').pinned, true);
  latest = later;
  await manage.update({ yes: true });
  assert.equal(installed('smart').modelVersion, '1.0');
  assert.equal(installed('flash').modelVersion, '2.0');

  await manage.use('smart', 'latest', { yes: true });
  assert.equal(installed('smart').pinned, false);
  assert.equal(installed('smart').modelVersion, '2.0');
  fs.unlinkSync(store.filePath(store.load(), models.smart1.files.model));
  await manage.use('smart', '1.0', { yes: true });
  assert.equal(fs.readFileSync(store.filePath(store.load(), models.smart1.files.model), 'utf8'), bodies.smart1);
  assert.equal(fs.readFileSync(store.filePath(store.load(), models.smart2.files.model), 'utf8'), bodies.smart2);
  assert.equal(installed('flash').modelVersion, '2.0');
  await assert.rejects(manage.use('smart', '1.1', { yes: true }), /not in the catalog/);
  assert.equal(installed('smart').modelVersion, '1.0');

  const withoutSmart = store.load();
  delete withoutSmart.profiles.smart;
  store.save(withoutSmart);
  await manage.use('smart', '1.0', { yes: true });
  assert.equal(installed('smart').modelVersion, '1.0');
  assert.deepEqual(store.load().profiles.flash, withoutSmart.profiles.flash);

  const incompatible = structuredClone(next);
  incompatible.profiles.smart.variants[0].requires = { ramGB: 128 };
  assert.equal(resolveSelection(incompatible, 'smart', hw, initial.profiles.smart).modelVersion, '1.0');
  const missingHistory = structuredClone(later);
  delete missingHistory.profiles.flash.previousVersions['1.1'];
  assert.throws(() => catalogs.verifyHistory(next, missingHistory), /removed saias-flash 1\.1/);
  await store.withLock(() => assert.rejects(manage.use('smart', 'latest', { yes: true }), /in progress/));
});

test('the bundled model catalogs label the existing models 1.0', () => {
  for (const p of Object.values(catalogs.bundled().profiles)) assert.deepEqual(catalogs.modelVersions(p), ['1.0']);
  const [image] = require('../src/image').versions();
  assert.equal(image.version, '1.0');
  assert.equal(image.profile, 'saias-image');
});

test('image versions reuse cached files and keep a pin when the image installer runs', {
  skip: process.platform !== 'win32' || process.arch !== 'x64',
}, async t => {
  const manifest = require('../catalog/image.json');
  const original = structuredClone(manifest);
  t.after(() => {
    delete manifest.previousVersions;
    Object.assign(manifest, original);
  });
  const image = require('../src/image');
  const imageDir = path.join(paths.home, 'image');
  const weights = (version, content) => {
    const name = 'image.gguf';
    const dir = version === '1.0' ? imageDir : path.join(imageDir, 'versions', version);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
    return { ...original.model, name, size: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') };
  };
  const before = { ...original, model: weights('1.0', 'old image') };
  Object.assign(manifest, { modelVersion: '1.1', name: 'Updated image model', model: weights('1.1', 'new image'), previousVersions: { '1.0': before } });
  for (const runtime of Object.values(manifest.runtimes)) {
    const dir = path.join(imageDir, runtime.sha256.slice(0, 12));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sd-cli.exe'), 'existing runtime');
  }

  const textModels = structuredClone(store.load().profiles);
  await manage.use('saias-image', '1.0', { yes: true });
  await image.install(undefined, { yes: true });
  assert.equal(image.status().modelVersion, '1.0');
  assert.equal(image.status().pinned, true);
  await manage.use('saias-image', 'latest', { yes: true });
  assert.equal(image.status().modelVersion, '1.1');
  assert.equal(image.status().pinned, false);
  assert.deepEqual(store.load().profiles, textModels);
});
