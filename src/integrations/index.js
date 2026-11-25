'use strict';

// Client integrations: each one points a tool at the SAIAS hub.
// Interface: { id, name, detect() -> boolean, configure({ models, yes }) }.

const ui = require('../ui');
const { requireInstalled } = require('../installed');

const ALL = [
  require('./hermes'),
  require('./opencode'),
  require('./codex'),
  require('./claude'),
];

function find(id) {
  const tool = ALL.find(t => t.id === id.toLowerCase());
  if (!tool) throw new Error(`Unknown tool "${id}". Available: ${ALL.map(t => t.id).join(', ')}`);
  return tool;
}

// Configures the given tools, or every detected one (asking first unless --yes).
async function connect(ids, { yes = false } = {}) {
  const models = requireInstalled();
  const explicit = ids.length > 0;
  const tools = explicit ? ids.map(find) : ALL.filter(t => t.detect());
  if (!tools.length) { ui.info('No supported tool found (Hermes, OpenCode, Codex, Claude Code).'); return; }
  for (const tool of tools) {
    if (!explicit && tool.id !== 'hermes' && !(await ui.confirm(`Connect ${tool.name} to SAIAS?`, true, yes))) continue;
    try {
      await tool.configure({ models, yes });
    } catch (e) {
      ui.bad(`${tool.name}: ${e.message}`);
    }
  }
}

module.exports = { ALL, find, connect };
