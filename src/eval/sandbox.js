'use strict';

// Runs model-written JavaScript against tests in a separate Node.js process with the permission
// model on (no file system writes, child processes or workers) and a time limit. This limits
// accidents from generated code; it is not a security boundary against hostile code.

const { spawn } = require('node:child_process');

const [major, minor] = process.versions.node.split('.').map(Number);
const PERMISSION_FLAG = major > 23 || (major === 23 && minor >= 5) ? '--permission' : '--experimental-permission';

// Code blocks from a model answer: the last ```js / ```javascript block, else any block, else the text.
function extractCode(text) {
  const blocks = [...String(text).matchAll(/```(\w+)?\s*\n([\s\S]*?)```/g)];
  const js = blocks.filter(b => /^(js|javascript|node|mjs|cjs)?$/i.test(b[1] || ''));
  const chosen = (js.length ? js : blocks).pop();
  return chosen ? chosen[2] : String(text);
}

// tests: [{ args: [...], expected }] for a function, or a "script" string run after the code
// that must print a JSON array of booleans.
function runTests(code, { entry, tests, script }, timeoutMs = 10000) {
  const harness = script || `
const __results = [];
const __equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
for (const t of ${JSON.stringify(tests)}) {
  try { __results.push(__equal(${entry}(...t.args), t.expected)); } catch { __results.push(false); }
}
console.log(JSON.stringify(__results));`;
  const source = `${code}\n;\n${harness}`;
  return new Promise(resolve => {
    const child = spawn(process.execPath, [PERMISSION_FLAG, '--input-type=commonjs', '-'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', () => {
      clearTimeout(timer);
      const line = out.trim().split(/\r?\n/).pop() || '';
      try {
        const results = JSON.parse(line);
        if (!Array.isArray(results)) throw new Error('no results');
        resolve({ passed: results.filter(Boolean).length, total: results.length, error: null });
      } catch {
        const total = tests ? tests.length : 1;
        resolve({ passed: 0, total, error: (err || out || 'no output').trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 200) });
      }
    });
    child.stdin.end(source);
  });
}

module.exports = { extractCode, runTests };
