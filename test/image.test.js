'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const test = require('node:test');

test('SAIAS Chat generates, retrieves and deletes an image with its conversation', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saias-image-test-'));
  const paths = require('../src/paths');
  paths.standard = dir;
  const image = require('../src/image');
  const chat = require('../src/chat-ui');
  const conversation = '{01234567-89AB-CDEF-0123-456789ABCDEF}';
  const id = '12121212-3434-5656-7878-909090909090';
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const prepare = t.mock.fn();
  const generate = t.mock.method(image, 'generate', async (prompt, output, options) => {
    assert.equal(prompt, 'A coastal lighthouse');
    assert.equal(output, path.join(dir, 'Conversations', 'images', conversation));
    assert.equal(options.signal.aborted, false);
    await options.prepare();
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, `${id}.png`), png);
    return { id, model: 'saias-image', backend: 'cpu' };
  });
  const server = http.createServer((req, res) => chat.handle(req, res, new URL(req.url, 'http://localhost').pathname, prepare));
  server.listen(0, '127.0.0.1');
  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await once(server, 'listening');
  const api = `http://127.0.0.1:${server.address().port}/saias/chat/api`;
  const post = (body, headers = { 'X-SAIAS': '1' }) => fetch(`${api}/images`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });

  assert.equal((await post({ conversation, prompt: 'A coastal lighthouse' }, {})).status, 403);
  assert.equal((await post({ conversation: '../elsewhere', prompt: 'A coastal lighthouse' })).status, 400);
  assert.equal((await post({ conversation, prompt: '<lora:other:1>' })).status, 400);
  const response = await post({ conversation, prompt: ' A coastal lighthouse ' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id, model: 'saias-image', backend: 'cpu' });
  assert.equal(generate.mock.callCount(), 1);
  assert.equal(prepare.mock.callCount(), 1);

  const url = `${api}/images/${encodeURIComponent(conversation)}/${id}.png`;
  const download = await fetch(url);
  assert.equal(download.headers.get('Content-Type'), 'image/png');
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), png);
  assert.equal((await fetch(`${api}/conversations/${encodeURIComponent(conversation)}`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(url)).status, 404);
});
