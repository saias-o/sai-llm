'use strict';

// Console output for the CLI: sections, status lines, progress bars and prompts.

const readline = require('node:readline/promises');

const tty = process.stdout.isTTY;
const color = (code, text) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);

function size(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
  return Math.max(1, Math.round(bytes / 1e6)) + ' MB';
}

// reporter: { event({ type, text }), progress(label, total) -> bar }. While one is set, output
// goes to it instead of the console and prompts answer with their default: the graphical setup
// asks its questions before it starts.
let reporter = null;
function setReporter(r) { reporter = r; }

function emit(type, text, line) {
  if (reporter) reporter.event({ type, text });
  else console.log(line);
}

const step = text => emit('step', text, '\n' + color(36, '== ' + text));
const ok = text => emit('ok', text, color(32, '  [ok] ') + text);
const todo = text => emit('todo', text, color(33, '  [..] ') + text);
const bad = text => emit('bad', text, color(31, '  [!!] ') + text);
const info = text => emit('info', text, '  ' + text);

function progress(label, total) {
  if (reporter) return reporter.progress(label, total);
  let last = 0;
  let lastPct = -1;
  const line = done => `  -> ${label}  ${size(done)} / ${size(total)} (${Math.floor((done / total) * 100)}%)`;
  return {
    update(done) {
      const now = Date.now();
      const pct = Math.floor((done / total) * 100);
      if (tty) {
        if (now - last < 250 && done < total) return;
        last = now;
        process.stdout.write('\r' + line(done).padEnd(100));
      } else if (pct >= lastPct + 10) {
        lastPct = pct - (pct % 10);
        console.log(line(done));
      }
    },
    note(text) { if (tty) process.stdout.write('\n'); console.log(`  -> ${label}: ${text}`); },
    done() { if (tty) process.stdout.write('\r' + `  -> ${label}  ${size(total)}`.padEnd(100) + '\n'); },
    fail(text) { if (tty) process.stdout.write('\n'); bad(`${label}: ${text}`); },
  };
}

async function ask(question, fallback, assumeYes) {
  if (assumeYes || reporter || !process.stdin.isTTY) return fallback;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('  ' + question + ' ')).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}

async function confirm(question, fallback = true, assumeYes = false) {
  const answer = await ask(`${question} ${fallback ? '[Y/n]' : '[y/N]'}`, fallback ? 'y' : 'n', assumeYes);
  return /^y/i.test(answer);
}

module.exports = { size, step, ok, todo, bad, info, progress, ask, confirm, setReporter };
