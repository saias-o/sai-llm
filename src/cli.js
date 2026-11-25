#!/usr/bin/env node
'use strict';

// saias: install, update and run the SAIAS local models. Node.js 22+, no dependencies.

const ui = require('./ui');

const HELP = `SAIAS - Self-updating Artificial Intelligence Agent System

Usage: saias <command> [options]

Setup
  install            Detect the hardware, install the recommended profiles, connect your tools
                     --profiles flash,smart,pro   choose profiles
                     --yes                        accept the defaults and licenses
                     --check                      report only, change nothing
                     --no-tools --no-path --no-shortcut --no-bench   skip those steps
  connect [tool...]  Point tools at SAIAS: hermes, opencode, codex, claude (default: detected ones)
  update             Install newer models from the latest catalog (--check, --yes)
  rollback           Return to the models installed before the last update
  adopt <folder>     Reuse runtimes and model files already on disk (--move, --verify)
  clean              Delete files no profile uses any more (--yes)

Run
  start              Start the hub: Llama Chat and the local API on port 8090 (--open)
  stop               Stop the hub and its model servers
  status             Show the installation and the hub state (--json)
  claude [options]   Run Claude Code on a SAIAS model (--profile smart|pro|flash)

Measure
  bench              Measure load time, prompt and generation speed of each profile
                     --profile pro   one profile only     --cold   reload loaded models
  eval               Agent evaluation: tool calling, coding, long context, instructions
                     --profile pro   --suite tools,code   --task needle   --repeat 3
                     --reasoning medium   --list   --out report.json
                     --endpoint URL --model NAME [--context N]   evaluate any OpenAI-compatible server

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

async function stop() {
  const { HUB_URL, hubRunning } = require('./installed');
  if (!(await hubRunning())) { ui.info('SAIAS is not running.'); return; }
  await fetch(`${HUB_URL}/saias/stop`, { method: 'POST', headers: { 'X-SAIAS': '1' } });
  ui.ok('SAIAS stopped.');
}

async function main() {
  const [command = 'help', ...rest] = process.argv.slice(2);
  const opts = parse(rest);
  const manage = require('./install');
  switch (command.toLowerCase()) {
    case 'install': {
      await manage.install(opts);
      if (opts.check) return;
      // --no-hermes is kept from the first installer: it skips only Hermes.
      if (!opts.noTools) {
        const tools = require('./integrations');
        const ids = tools.ALL.filter(t => t.detect() && !(opts.noHermes && t.id === 'hermes')).map(t => t.id);
        await tools.connect(ids, { yes: opts.yes });
      }
      if (!opts.noPath) await require('./integrations/path').add({ yes: opts.yes });
      if (!opts.noShortcut) require('./integrations/shortcut').create();
      if (!opts.noBench && (await ui.confirm('Measure how fast each model runs on this PC now? It loads each model in turn (a few minutes).', true, opts.yes))) {
        await require('./bench').run({});
      }
      ui.step('Done');
      ui.info('Start SAIAS: Start-SAIAS.cmd, the SAIAS desktop shortcut, or "saias start --open".');
      ui.info('Llama Chat: http://127.0.0.1:8090/   API for Hermes and other tools: http://127.0.0.1:8090/v1');
      return;
    }
    case 'connect': return require('./integrations').connect(opts._, { yes: opts.yes });
    case 'claude': return require('./integrations/claude').launch(rest);
    case 'start': return require('./hub').start({ open: Boolean(opts.open) });
    case 'stop': return stop();
    case 'bench': return require('./bench').run(opts);
    case 'eval': return require('./eval').run(opts);
    case 'update': return manage.update(opts);
    case 'rollback': return manage.rollback();
    case 'adopt': return manage.adopt(opts._[0], opts);
    case 'status': return manage.status(opts);
    case 'clean': return manage.clean(opts);
    case 'help': case '--help': case '-h': console.log(HELP); return;
    default: throw new Error(`Unknown command "${command}". Run "saias help".`);
  }
}

main().catch(e => {
  ui.bad(e.message);
  process.exitCode = 1;
});
