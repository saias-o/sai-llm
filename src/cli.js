#!/usr/bin/env node
'use strict';

// saias: install, update and run the SAIAS local models. Node.js 22+, no dependencies.

const ui = require('./ui');

const HELP = `SAIAS - Self-updating Artificial Intelligence Agent System

Usage: saias <command> [options]

Commands
  install            Detect the hardware, install the recommended profiles, set up Hermes
                     --profiles flash,smart,pro   choose profiles
                     --yes                        accept the defaults and licenses
                     --check                      report only, change nothing
                     --no-hermes --no-shortcut    skip those integrations
  start              Start the hub: Llama Chat and the OpenAI-compatible API on port 8090
                     --open                       open Llama Chat in the browser
  update             Install newer models from the latest catalog (--check, --yes)
  rollback           Return to the models installed before the last update
  adopt <folder>     Reuse runtimes and model files already on disk (--move, --verify)
  status             Show the installation and the hub state (--json)
  clean              Delete files no profile uses any more (--yes)

Environment
  SAIAS_HOME         data folder (default: %LOCALAPPDATA%\\SAIAS on Windows)
  SAIAS_HUB_PORT     hub port (default: 8090)
  SAIAS_CATALOG_URL  catalog used by "saias update"`;

// Accepts --flag, --key value, --key=value and PowerShell-style -Key value.
function parse(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--?([A-Za-z][\w-]*)(?:=(.*))?$/);
    if (!m) { opts._.push(argv[i]); continue; }
    const key = m[1].toLowerCase().replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (m[2] !== undefined) opts[key] = m[2];
    else if (key === 'profiles' && argv[i + 1] && !argv[i + 1].startsWith('-')) opts[key] = argv[++i];
    else opts[key] = true;
  }
  return opts;
}

async function main() {
  const [command = 'help', ...rest] = process.argv.slice(2);
  const opts = parse(rest);
  const manage = require('./install');
  switch (command.toLowerCase()) {
    case 'install': {
      await manage.install(opts);
      if (opts.check) return;
      if (!opts.noHermes) {
        const { configure } = require('./integrations/hermes');
        const { models, defaultModel } = installedModels();
        await configure({ models, defaultModel, yes: opts.yes });
      }
      if (!opts.noShortcut) require('./integrations/shortcut').create();
      ui.step('Done');
      ui.info('Start SAIAS: Start-SAIAS.cmd, the SAIAS desktop shortcut, or "saias start --open".');
      ui.info('Llama Chat: http://127.0.0.1:8090/   API for Hermes and other tools: http://127.0.0.1:8090/v1');
      return;
    }
    case 'start': return require('./hub').start({ open: Boolean(opts.open) });
    case 'update': return manage.update(opts);
    case 'rollback': return manage.rollback();
    case 'adopt': return manage.adopt(opts._[0], opts);
    case 'status': return manage.status(opts);
    case 'clean': return manage.clean(opts);
    case 'help': case '--help': case '-h': console.log(HELP); return;
    default: throw new Error(`Unknown command "${command}". Run "saias help".`);
  }
}

// Installed profiles as Hermes models, the most capable last (catalog order).
function installedModels() {
  const catalog = require('./catalog').installed();
  const state = require('./store').load();
  const models = [];
  for (const [id, entry] of Object.entries(state.profiles)) {
    const variant = catalog.profiles[id].variants.find(v => v.id === entry.variant);
    const model = catalog.models[variant.model];
    models.push({ id: 'saias-' + id, context: variant.server['ctx-size'] || model.context, vision: Boolean(model.vision) });
  }
  const preferred = ['saias-smart', 'saias-pro', 'saias-flash'].find(id => models.some(m => m.id === id));
  return { models, defaultModel: preferred || models[0]?.id || null };
}

main().catch(e => {
  ui.bad(e.message);
  process.exitCode = 1;
});
