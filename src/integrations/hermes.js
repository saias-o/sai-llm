'use strict';

// Adds the SAIAS provider and the web search MCP server to Hermes Agent's config.yaml.
// Hermes ships its own Python with PyYAML, which edits the file without losing other settings.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const paths = require('../paths');
const ui = require('../ui');
const { HUB_URL } = require('../installed');
const { which } = require('./util');

const HUB = `${HUB_URL}/v1`;

const MERGE = String.raw`
import datetime, json, os, shutil, sys
import yaml

path = sys.argv[1]
spec = json.loads(sys.argv[2])
cfg = {}
if os.path.exists(path):
    with open(path, encoding="utf-8") as f:
        cfg = yaml.safe_load(f) or {}
    shutil.copy2(path, path + ".bak-saias-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S"))
providers = cfg.get("providers") or {}
providers["saias"] = spec["provider"]
cfg["providers"] = providers
servers = cfg.get("mcp_servers") or {}
servers["saias-web"] = spec["mcp"]
cfg["mcp_servers"] = servers
if spec.get("default"):
    cfg["model"] = {"provider": "custom:saias", "default": spec["default"]}
with open(path, "w", encoding="utf-8") as f:
    yaml.safe_dump(cfg, f, sort_keys=True, allow_unicode=True, default_flow_style=False)
`;

function hermesPython(hermes) {
  const venv = process.platform === 'win32' ? ['hermes-agent', 'venv', 'Scripts', 'python.exe'] : ['hermes-agent', 'venv', 'bin', 'python'];
  const candidates = [path.join(path.dirname(path.dirname(hermes)), ...venv), which('python3'), which('python')];
  return candidates.find(p => p && fs.existsSync(p)) || null;
}

function installHermes() {
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      'irm https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1 | iex'], { stdio: 'inherit' });
  } else {
    execFileSync('sh', ['-c', 'curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash'], { stdio: 'inherit' });
  }
}

function detect() {
  return true; // Offered on every install: the installer can set Hermes up from scratch.
}

// models: installed models, most capable first (see installed.js).
async function configure({ models, yes }) {
  ui.step('Hermes');
  // saias-smart answers fastest among the capable profiles: the everyday default for an agent.
  const defaultModel = (models.find(m => m.profile === 'smart') || models[0]).id;
  let hermes = which('hermes');
  if (!hermes && (await ui.confirm('Hermes Agent is not installed. Install it with the official Nous Research installer?', true, yes))) {
    installHermes();
    hermes = which('hermes');
  }
  if (!hermes) { ui.todo('Hermes not found; run the installer again after installing Hermes.'); return; }
  const configPath = execFileSync(hermes, ['config', 'path'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/).pop();
  const python = hermesPython(hermes);
  if (!configPath || !python) { ui.bad('Hermes configuration not found; add the provider by hand (see README).'); return; }

  const setDefault = defaultModel && (await ui.confirm(`Make ${defaultModel} the default Hermes model?`, true, yes));
  const spec = {
    provider: {
      name: 'SAIAS (local)', api: HUB, transport: 'chat_completions', discover_models: false,
      default_model: defaultModel || models[0].id,
      models: Object.fromEntries(models.map(m => [m.id, { context_length: m.context, ...(m.vision ? { supports_vision: true } : {}) }])),
    },
    mcp: { command: process.execPath, args: [paths.webMcp.replace(/\\/g, '/')], timeout: 120 },
    default: setDefault ? defaultModel : null,
  };
  const script = path.join(paths.home, 'hermes-merge.py');
  fs.mkdirSync(paths.home, { recursive: true });
  fs.writeFileSync(script, MERGE);
  try {
    execFileSync(python, [script, configPath, JSON.stringify(spec)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    ui.bad(`Hermes configuration failed: ${String(e.stderr || e.message).trim()}`);
    return;
  }
  ui.ok(`SAIAS provider (${HUB}) and web search added to ${configPath} (backup: .bak-saias-*)`);
  if (setDefault) ui.ok(`Default Hermes model: custom:saias / ${defaultModel}`);
}

module.exports = { id: 'hermes', name: 'Hermes Agent', detect, configure };
