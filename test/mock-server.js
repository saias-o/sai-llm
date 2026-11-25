'use strict';

// A fake OpenAI-compatible server for tests: no model is loaded. In "reference" mode it answers
// each evaluation task with that task's ideal answer; in "wrong" mode it answers badly. It also
// returns llama-server style timings so the benchmark can be tested.

const http = require('node:http');
const { SUITES } = require('../src/eval');

function firstUser(messages) {
  return messages.find(m => m.role === 'user')?.content;
}

function startMock({ mode = 'reference', promptTps = 812.5, genTps = 23.4 } = {}) {
  const byPrompt = new Map();
  for (const suite of Object.values(SUITES)) {
    for (const task of suite) {
      const prompt = task.request ? firstUser(task.request().messages) : null;
      if (prompt) byPrompt.set(prompt, task);
    }
  }
  const multiStep = SUITES.tools.find(t => t.id === 'tools.multi-step');
  const requests = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      requests.push({ url: req.url, body: json });
      if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end('{}'); return; }
      const prompt = firstUser(json.messages || []);
      const task = byPrompt.get(prompt) || (/Atlas app listen/.test(prompt || '') ? multiStep : null);
      let message;
      if (mode === 'reference' && task) message = task.reference(json);
      else message = { role: 'assistant', content: 'I do not know.' };
      const promptTokens = Math.ceil(JSON.stringify(json.messages || []).length / 4);
      const completionTokens = json.max_tokens || 8;
      const out = {
        id: 'mock', object: 'chat.completion', model: json.model,
        choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
        timings: { prompt_n: promptTokens, prompt_per_second: promptTps, predicted_n: completionTokens, predicted_per_second: genTps },
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({ endpoint: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise(r => server.close(r)) });
  }));
}

module.exports = { startMock };
