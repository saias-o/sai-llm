'use strict';

// "saias move": the data folder moves and state.json follows. The standard folder is redirected
// to a temporary one (LOCALAPPDATA, XDG_DATA_HOME, HOME) before anything loads.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saias-move-'));
delete process.env.SAIAS_HOME;
process.env.LOCALAPPDATA = root;
process.env.XDG_DATA_HOME = root;
process.env.HOME = root;
process.env.SAIAS_HUB_PORT = '1'; // nothing listens there: the hub counts as stopped

const paths = require('../src/paths');
const store = require('../src/store');
const ui = require('../src/ui');
const { move } = require('../src/install');

ui.setReporter({ event() {}, progress: () => ({ update() {}, note() {}, done() {}, fail() {} }) });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('move carries the files, rebases state.json and redirects the next runs', async () => {
  const from = paths.home;
  fs.mkdirSync(path.join(from, 'models'), { recursive: true });
  fs.mkdirSync(path.join(from, 'runtimes', 'r1'), { recursive: true });
  fs.mkdirSync(path.join(from, 'node'), { recursive: true });
  fs.mkdirSync(path.join(from, 'Conversations'), { recursive: true });
  fs.writeFileSync(path.join(from, 'settings.json'), '{}');
  const model = path.join(from, 'models', 'm.gguf');
  fs.writeFileSync(model, 'weights');
  const state = store.load();
  state.files.abc = { name: 'm.gguf', path: model, size: 7 };
  state.files.out = { name: 'x.gguf', path: path.join(root, 'elsewhere', 'x.gguf'), size: 1, adopted: true };
  state.runtimes.r1 = { dir: path.join(from, 'runtimes', 'r1') };
  store.save(state);

  const to = path.join(root, 'other-drive', 'SAIAS');
  await move(to);

  assert.equal(paths.home, to);
  assert.equal(fs.readFileSync(path.join(to, 'models', 'm.gguf'), 'utf8'), 'weights');
  assert.ok(!fs.existsSync(model));
  assert.ok(fs.existsSync(path.join(from, 'node')), 'the private Node.js copy stays');
  assert.ok(fs.existsSync(path.join(from, 'Conversations')), "the app's conversations stay");
  assert.ok(fs.existsSync(path.join(from, 'settings.json')), "the app's chat settings stay");
  assert.equal(fs.readFileSync(path.join(from, 'data-folder.txt'), 'utf8').trim(), to);
  const moved = store.load();
  assert.equal(moved.files.abc.path, path.join(to, 'models', 'm.gguf'));
  assert.equal(moved.files.out.path, path.join(root, 'elsewhere', 'x.gguf'), 'files outside stay');
  assert.equal(moved.runtimes.r1.dir, path.join(to, 'runtimes', 'r1'));

  await assert.rejects(move(path.join(to, 'inner')), /cannot contain/);
});
