'use strict';

// Tool calling: the core skill of an agent. Each task checks the tool calls (names, argument
// JSON and types) or the final answer after tool results. "reference" returns an ideal
// assistant message for a request; the self-tests use it to validate the scoring.

const { contentOf, toolCallsOf } = require('../client');

const fn = (name, description, properties, required = Object.keys(properties)) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});

const WEATHER = fn('get_weather', 'Current weather for a city', { city: { type: 'string', description: 'City name' } });
const CALCULATOR = fn('calculator', 'Evaluate an arithmetic expression exactly', { expression: { type: 'string' } });
const SEARCH = fn('search_web', 'Search the web', { query: { type: 'string' } });
const EMAIL = fn('send_email', 'Send an email', { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } });
const EVENT = fn('create_event', 'Create a calendar event', {
  title: { type: 'string' },
  date: { type: 'string', description: 'Date as YYYY-MM-DD' },
  attendees: { type: 'array', items: { type: 'string' }, description: 'Email addresses' },
});
const THERMOSTAT = fn('set_thermostat', 'Control the thermostat', {
  mode: { type: 'string', enum: ['heat', 'cool', 'off'] },
  temperature: { type: 'number', description: 'Target temperature in Celsius' },
});
const LIST_FILES = fn('list_files', 'List the files in a folder of the project', { path: { type: 'string' } });
const READ_FILE = fn('read_file', 'Read a text file of the project', { path: { type: 'string' } });

const call = (name, args, id = `call_${name}_${Math.abs(JSON.stringify(args).length)}`) =>
  ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const toolMessage = calls => ({ role: 'assistant', content: '', tool_calls: calls });
const textMessage = content => ({ role: 'assistant', content });
const user = content => [{ role: 'user', content }];

// Virtual project for the multi-step task.
const FILES = {
  '.': ['README.md', 'config', 'src'],
  config: ['app.env', 'db.env'],
  'config/app.env': 'NAME=atlas\nPORT=8443\nLOG_LEVEL=info\n',
  'config/db.env': 'DB_HOST=localhost\nDB_PORT=5432\n',
  src: ['main.js'],
  'src/main.js': 'require("dotenv").config({ path: "config/app.env" });\n',
  'README.md': '# Atlas\nSettings live in the config folder.\n',
};
function runVirtualTool(c) {
  const p = String(c.args?.path || '.').replace(/^\.\/?/, '').replace(/\/$/, '') || '.';
  if (c.name === 'list_files') return Array.isArray(FILES[p]) ? FILES[p].join('\n') : `Not a folder: ${p}`;
  if (c.name === 'read_file') return typeof FILES[p] === 'string' ? FILES[p] : `No such file: ${p}`;
  return `Unknown tool ${c.name}`;
}

module.exports = [
  {
    id: 'tools.single-call',
    title: 'Calls the right tool with the right argument',
    request: () => ({ messages: user('What is the weather like in Paris right now?'), tools: [WEATHER, SEARCH] }),
    score(res) {
      const calls = toolCallsOf(res.message);
      const ok = calls.length >= 1 && calls[0].name === 'get_weather' && /paris/i.test(calls[0].args?.city || '');
      return { score: ok ? 1 : 0, detail: calls.map(c => `${c.name}(${c.raw})`).join(', ') || contentOf(res.message).slice(0, 120) };
    },
    reference: () => toolMessage([call('get_weather', { city: 'Paris' })]),
  },
  {
    id: 'tools.no-call',
    title: 'Answers directly when no tool is needed',
    request: () => ({ messages: user('How many days are there in a leap year? Answer with the number only.'), tools: [WEATHER, SEARCH, CALCULATOR] }),
    score(res) {
      const calls = toolCallsOf(res.message);
      const ok = calls.length === 0 && /\b366\b/.test(contentOf(res.message));
      return { score: ok ? 1 : 0, detail: calls.length ? `called ${calls.map(c => c.name).join(', ')}` : contentOf(res.message).slice(0, 80) };
    },
    reference: () => textMessage('366'),
  },
  {
    id: 'tools.choose-tool',
    title: 'Picks the calculator among several tools',
    request: () => ({ messages: user('Use the calculator to compute 48271 * 9137 exactly.'), tools: [SEARCH, EMAIL, CALCULATOR] }),
    score(res) {
      const c = toolCallsOf(res.message)[0];
      const expr = String(c?.args?.expression || '');
      const ok = c?.name === 'calculator' && /48271/.test(expr) && /9137/.test(expr);
      return { score: ok ? 1 : 0, detail: c ? `${c.name}(${c.raw})` : contentOf(res.message).slice(0, 80) };
    },
    reference: () => toolMessage([call('calculator', { expression: '48271 * 9137' })]),
  },
  {
    id: 'tools.parallel-calls',
    title: 'Makes one call per city in a single turn',
    request: () => ({ messages: user('Compare the current weather in Tokyo and in Lima.'), tools: [WEATHER] }),
    score(res) {
      const cities = toolCallsOf(res.message).filter(c => c.name === 'get_weather').map(c => String(c.args?.city || ''));
      const found = ['tokyo', 'lima'].filter(city => cities.some(c => c.toLowerCase().includes(city))).length;
      return { score: found / 2, detail: cities.join(', ') || contentOf(res.message).slice(0, 80) };
    },
    reference: () => toolMessage([call('get_weather', { city: 'Tokyo' }, 'call_1'), call('get_weather', { city: 'Lima' }, 'call_2')]),
  },
  {
    id: 'tools.typed-arguments',
    title: 'Produces valid typed arguments (string, date, array)',
    request: () => ({
      messages: user('Create a calendar event titled "Design review" on 2027-03-14 with ana@example.com and li@example.com.'),
      tools: [EVENT, EMAIL],
    }),
    score(res) {
      const c = toolCallsOf(res.message)[0];
      const a = c?.args || {};
      const checks = [
        c?.name === 'create_event',
        typeof a.title === 'string' && /design review/i.test(a.title),
        a.date === '2027-03-14',
        Array.isArray(a.attendees) && a.attendees.length === 2 && a.attendees.every(x => /@example\.com$/.test(x)),
      ];
      return { score: checks.filter(Boolean).length / checks.length, detail: c ? `${c.name}(${c.raw})` : 'no call' };
    },
    reference: () => toolMessage([call('create_event', { title: 'Design review', date: '2027-03-14', attendees: ['ana@example.com', 'li@example.com'] })]),
  },
  {
    id: 'tools.enum-and-number',
    title: 'Respects enums and numeric types',
    request: () => ({ messages: user('Switch the air conditioning on and cool the room to 21 degrees.'), tools: [THERMOSTAT] }),
    score(res) {
      const c = toolCallsOf(res.message)[0];
      const ok = c?.name === 'set_thermostat' && c.args?.mode === 'cool' && c.args?.temperature === 21;
      return { score: ok ? 1 : 0, detail: c ? `${c.name}(${c.raw})` : 'no call' };
    },
    reference: () => toolMessage([call('set_thermostat', { mode: 'cool', temperature: 21 })]),
  },
  {
    id: 'tools.use-result',
    title: 'Uses a tool result in its answer',
    request: () => ({
      messages: [
        { role: 'user', content: 'Should I take an umbrella in Oslo today?' },
        toolMessage([call('get_weather', { city: 'Oslo' }, 'call_oslo')]),
        { role: 'tool', tool_call_id: 'call_oslo', content: '{"city":"Oslo","condition":"heavy rain","temperature_c":7}' },
      ],
      tools: [WEATHER],
    }),
    score(res) {
      const text = contentOf(res.message);
      const ok = toolCallsOf(res.message).length === 0 && /\byes\b|umbrella/i.test(text) && /rain/i.test(text);
      return { score: ok ? 1 : 0, detail: text.slice(0, 120) };
    },
    reference: () => textMessage('Yes, take an umbrella: heavy rain is expected in Oslo (7 °C).'),
  },
  {
    id: 'tools.multi-step',
    title: 'Explores files over several steps to find an answer',
    // Runs its own agent loop: list, read, answer.
    async run(ask) {
      const messages = user('Which port does the Atlas app listen on? Use the tools to look in the project, then answer with the port number.');
      const trace = [];
      for (let step = 0; step < 8; step++) {
        const res = await ask({ messages, tools: [LIST_FILES, READ_FILE] });
        const calls = toolCallsOf(res.message);
        if (!calls.length) {
          const text = contentOf(res.message);
          const ok = /\b8443\b/.test(text);
          return { score: ok ? 1 : 0, detail: `${step} tool step(s): ${trace.join(' > ')}; answer: ${text.slice(0, 80)}` };
        }
        messages.push({ role: 'assistant', content: res.message.content || '', tool_calls: res.message.tool_calls });
        for (const c of calls) {
          trace.push(`${c.name}(${c.args?.path ?? ''})`);
          messages.push({ role: 'tool', tool_call_id: c.id, content: runVirtualTool(c) });
        }
      }
      return { score: 0, detail: `no answer after 8 steps: ${trace.join(' > ')}` };
    },
    reference(body) {
      const toolResults = body.messages.filter(m => m.role === 'tool').map(m => m.content);
      if (!toolResults.length) return toolMessage([call('list_files', { path: '.' }, 'c1')]);
      if (toolResults.length === 1) return toolMessage([call('list_files', { path: 'config' }, 'c2')]);
      if (toolResults.length === 2) return toolMessage([call('read_file', { path: 'config/app.env' }, 'c3')]);
      return textMessage('The Atlas app listens on port 8443.');
    },
  },
];
