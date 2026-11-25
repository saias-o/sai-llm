'use strict';

// Long context: facts hidden at different depths of a long, plausible text must be retrieved
// and combined. Sizes above the model's context window are skipped.

const { contentOf } = require('../client');

const CHARS_PER_TOKEN = 4;

// Deterministic pseudo-random filler (logbook entries), so every run sends the same prompt.
function filler(tokens, seed) {
  let x = seed >>> 0;
  const rand = n => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x % n; };
  const places = ['the north dock', 'the archive', 'the east tower', 'the greenhouse', 'the lower market', 'the signal room'];
  const actions = ['inspected the pumps', 'logged two arrivals', 'repaired a lantern', 'sorted the mail', 'counted the crates', 'cleaned the filters'];
  const people = ['Mira', 'Tomas', 'Ines', 'Karl', 'Yuki', 'Bram', 'Odile'];
  const notes = ['Nothing unusual was reported.', 'The wind was steady from the west.', 'Supplies remain sufficient.', 'Visitors were few.', 'The shift ended on time.'];
  const out = [];
  let size = 0;
  for (let day = 1; size < tokens * CHARS_PER_TOKEN; day++) {
    const line = `Day ${day}: ${people[rand(people.length)]} ${actions[rand(actions.length)]} at ${places[rand(places.length)]}. ${notes[rand(notes.length)]}`;
    out.push(line);
    size += line.length + 1;
  }
  return out;
}

function haystack(tokens, needles, seed) {
  const lines = filler(tokens, seed);
  for (const { depth, text } of needles) lines.splice(Math.floor(lines.length * depth), 0, text);
  return lines.join('\n');
}

const SIZES = [4000, 16000, 64000, 128000];

function tasks() {
  const list = [];
  for (const tokens of SIZES) {
    const label = tokens >= 1000 ? `${tokens / 1000}k` : String(tokens);
    list.push({
      id: `context.needle-${label}`,
      title: `Finds a fact in ${label} tokens`,
      tokens,
      request: () => ({
        messages: [{
          role: 'user',
          content: `${haystack(tokens, [{ depth: 0.37, text: 'Note: the access code for the copper vault is 7391-KX.' }], tokens)}\n\nWhat is the access code for the copper vault? Answer with the code only.`,
        }],
      }),
      score(res) {
        const text = contentOf(res.message);
        return { score: /7391-KX/i.test(text) ? 1 : 0, detail: text.slice(0, 60) };
      },
      reference: () => ({ role: 'assistant', content: '7391-KX' }),
    });
    list.push({
      id: `context.combine-${label}`,
      title: `Combines two facts in ${label} tokens`,
      tokens,
      request: () => ({
        messages: [{
          role: 'user',
          content: `${haystack(tokens, [
            { depth: 0.15, text: 'Note: the ferry to Varn leaves at 14:20.' },
            { depth: 0.82, text: 'Note: the ferry to Varn is delayed by 35 minutes today.' },
          ], tokens + 7)}\n\nAt what time will the ferry to Varn actually leave today? Answer with the time only (HH:MM).`,
        }],
      }),
      score(res) {
        const text = contentOf(res.message);
        return { score: /14:55/.test(text) ? 1 : 0, detail: text.slice(0, 60) };
      },
      reference: () => ({ role: 'assistant', content: '14:55' }),
    });
  }
  return list;
}

module.exports = tasks();
module.exports.CHARS_PER_TOKEN = CHARS_PER_TOKEN;
module.exports.filler = filler;
