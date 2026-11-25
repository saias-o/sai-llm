'use strict';

// Instruction following: exact output formats that agents and scripts depend on.

const { contentOf } = require('../client');

function parseJson(text) {
  const t = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try { return JSON.parse(t); } catch { return undefined; }
}

module.exports = [
  {
    id: 'instruct.json-only',
    title: 'Replies with valid JSON matching a shape',
    request: () => ({
      messages: [{
        role: 'user',
        content: 'Extract the data from this sentence and reply with JSON only, no prose: {"name": string, "age": number, "languages": string[]}.\n\nSentence: Lea Martin is 34 and speaks French, German and Korean.',
      }],
    }),
    score(res) {
      const text = contentOf(res.message);
      const j = parseJson(text);
      const checks = [
        j !== undefined,
        j?.name === 'Lea Martin',
        j?.age === 34,
        Array.isArray(j?.languages) && ['french', 'german', 'korean'].every(l => j.languages.some(x => String(x).toLowerCase() === l)),
      ];
      return { score: checks.filter(Boolean).length / checks.length, detail: text.slice(0, 100) };
    },
    reference: () => ({ role: 'assistant', content: '{"name":"Lea Martin","age":34,"languages":["French","German","Korean"]}' }),
  },
  {
    id: 'instruct.exact-bullets',
    title: 'Follows a strict list format',
    request: () => ({
      messages: [{
        role: 'user',
        content: 'Give exactly three tips for writing clear commit messages. Format: three lines, each starting with "- ", nothing before or after, each line under 80 characters.',
      }],
    }),
    score(res) {
      const lines = contentOf(res.message).split(/\r?\n/).filter(l => l.trim());
      const checks = [lines.length === 3, lines.every(l => l.startsWith('- ')), lines.every(l => l.length < 80)];
      return { score: checks.filter(Boolean).length / checks.length, detail: `${lines.length} line(s)` };
    },
    reference: () => ({ role: 'assistant', content: '- Use the imperative mood in the subject.\n- Keep the subject under 50 characters.\n- Explain why in the body, not how.' }),
  },
  {
    id: 'instruct.system-rule',
    title: 'Keeps a system prompt rule',
    request: () => ({
      messages: [
        { role: 'system', content: 'You are a support assistant for Atlas. Always answer in French, whatever the language of the question.' },
        { role: 'user', content: 'How do I reset my password?' },
      ],
    }),
    score(res) {
      const text = contentOf(res.message).toLowerCase();
      const french = (text.match(/\b(le|la|les|votre|vous|pour|mot de passe|de|et|un|une)\b/g) || []).length;
      const english = (text.match(/\b(the|your|you|to|and|password|click)\b/g) || []).length;
      return { score: french > english ? 1 : 0, detail: text.slice(0, 80) };
    },
    reference: () => ({ role: 'assistant', content: 'Pour réinitialiser votre mot de passe, ouvrez la page de connexion et cliquez sur « Mot de passe oublié ».' }),
  },
];
