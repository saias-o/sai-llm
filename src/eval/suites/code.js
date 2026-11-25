'use strict';

// Coding: write or fix a JavaScript function; the answer is run against hidden tests.

const { contentOf } = require('../client');
const { extractCode, runTests } = require('../sandbox');

const ask = (task) => `Write a JavaScript function \`${task.entry}\`. ${task.spec}
Reply with the complete function in one \`\`\`javascript code block, with no example usage.`;

const TASKS = [
  {
    id: 'code.parse-duration',
    entry: 'parseDuration',
    spec: 'It takes a duration string made of numbers followed by h, m or s, in any order and possibly with spaces, such as "1h30m", "45s" or "2h 5s", and returns the total number of seconds. It returns null for an invalid string such as "", "abc" or "10x".',
    tests: [
      { args: ['1h30m'], expected: 5400 }, { args: ['45s'], expected: 45 }, { args: ['2h 5s'], expected: 7205 },
      { args: ['10m1h'], expected: 4200 }, { args: [''], expected: null }, { args: ['10x'], expected: null }, { args: ['abc'], expected: null },
    ],
    solution: `function parseDuration(s) {
  const t = String(s).replace(/\\s+/g, '');
  if (!/^(\\d+[hms])+$/.test(t)) return null;
  const k = { h: 3600, m: 60, s: 1 };
  let total = 0;
  for (const [, n, u] of t.matchAll(/(\\d+)([hms])/g)) total += Number(n) * k[u];
  return total;
}`,
  },
  {
    id: 'code.balanced-brackets',
    entry: 'isBalanced',
    spec: 'It returns true when every (, [ and { in a string is closed by the matching bracket in the right order, ignoring all other characters, and false otherwise.',
    tests: [
      { args: ['(a[b]{c})'], expected: true }, { args: [''], expected: true }, { args: ['([)]'], expected: false },
      { args: ['(('], expected: false }, { args: ['}{'], expected: false }, { args: ['f(x) = [1, {2}]'], expected: true },
    ],
    solution: `function isBalanced(s) {
  const pairs = { ')': '(', ']': '[', '}': '{' }, stack = [];
  for (const c of s) {
    if ('([{'.includes(c)) stack.push(c);
    else if (pairs[c] && stack.pop() !== pairs[c]) return false;
  }
  return stack.length === 0;
}`,
  },
  {
    id: 'code.merge-intervals',
    entry: 'mergeIntervals',
    spec: 'It takes an array of [start, end] number pairs in any order and returns the merged intervals sorted by start. Intervals that overlap or touch (end equals the next start) are merged. It must not modify its input.',
    tests: [
      { args: [[[1, 3], [2, 6], [8, 10], [15, 18]]], expected: [[1, 6], [8, 10], [15, 18]] },
      { args: [[[5, 7], [1, 5]]], expected: [[1, 7]] },
      { args: [[]], expected: [] },
      { args: [[[1, 10], [2, 3], [4, 5]]], expected: [[1, 10]] },
    ],
    solution: `function mergeIntervals(list) {
  const sorted = list.map(p => [...p]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e); else out.push([s, e]);
  }
  return out;
}`,
  },
  {
    id: 'code.top-k-words',
    entry: 'topWords',
    spec: 'Given a text and a number k, it returns the k most frequent words as an array of lowercase strings. Words are runs of letters a-z (case-insensitive); ties are ordered alphabetically.',
    tests: [
      { args: ['the cat and the hat and the bat', 2], expected: ['the', 'and'] },
      { args: ['B a b A c', 3], expected: ['a', 'b', 'c'] },
      { args: ['One, two! TWO? three three THREE.', 1], expected: ['three'] },
    ],
    solution: `function topWords(text, k) {
  const counts = new Map();
  for (const w of text.toLowerCase().match(/[a-z]+/g) || []) counts.set(w, (counts.get(w) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, k).map(([w]) => w);
}`,
  },
  {
    id: 'code.lru-cache',
    entry: 'LRUCache',
    spec: 'It is a class: new LRUCache(capacity) with get(key), which returns the value or -1 and marks the key as recently used, and put(key, value), which inserts or updates the key and evicts the least recently used key when the capacity is exceeded.',
    script: `
const c = new LRUCache(2);
const r = [];
c.put(1, 1); c.put(2, 2); r.push(c.get(1) === 1);
c.put(3, 3); r.push(c.get(2) === -1);
c.put(4, 4); r.push(c.get(1) === -1, c.get(3) === 3, c.get(4) === 4);
c.put(3, 30); c.put(5, 5); r.push(c.get(3) === 30, c.get(4) === -1);
console.log(JSON.stringify(r));`,
    solution: `class LRUCache {
  constructor(capacity) { this.capacity = capacity; this.map = new Map(); }
  get(key) {
    if (!this.map.has(key)) return -1;
    const v = this.map.get(key); this.map.delete(key); this.map.set(key, v); return v;
  }
  put(key, value) {
    this.map.delete(key); this.map.set(key, value);
    if (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value);
  }
}`,
  },
  {
    id: 'code.fix-binary-search',
    entry: 'binarySearch',
    spec: `It returns the index of target in a sorted array, or -1. Fix this buggy version:
\`\`\`javascript
function binarySearch(arr, target) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) / 2;
    if (arr[mid] === target) return mid;
    if (arr[mid] < target) lo = mid;
    else hi = mid - 1;
  }
  return -1;
}
\`\`\``,
    tests: [
      { args: [[1, 3, 5, 7, 9], 7], expected: 3 }, { args: [[1, 3, 5, 7, 9], 1], expected: 0 },
      { args: [[1, 3, 5, 7, 9], 9], expected: 4 }, { args: [[1, 3, 5, 7, 9], 4], expected: -1 },
      { args: [[], 1], expected: -1 }, { args: [[2], 2], expected: 0 },
    ],
    solution: `function binarySearch(arr, target) {
  let lo = 0, hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] === target) return mid;
    if (arr[mid] < target) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}`,
  },
];

module.exports = TASKS.map(task => ({
  id: task.id,
  title: `Writes ${task.entry}`,
  request: () => ({ messages: [{ role: 'user', content: ask(task) }] }),
  async score(res) {
    const code = extractCode(contentOf(res.message));
    const r = await runTests(code, task);
    return { score: r.total ? r.passed / r.total : 0, detail: r.error ? `error: ${r.error}` : `${r.passed}/${r.total} tests` };
  },
  reference: () => ({ role: 'assistant', content: '```javascript\n' + task.solution + '\n```' }),
}));
