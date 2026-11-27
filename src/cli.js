#!/usr/bin/env node
'use strict';

// saias: install, update and run the SAIAS local models. Node.js 22+, no dependencies.

const ui = require('./ui');

const HELP = `SAIAS - Self-updating Artificial Intelligence Agent System

Usage: saias <command> [options]

Setup
  setup              Graphical installer: the advisor preselects the profiles this PC can run
                     (--console runs "install" in the terminal instead; same options)
  install            Detect the hardware, install the recommended profiles, connect your tools
                     --profiles flash,smart,pro   choose profiles
                     --yes                        accept the defaults and licenses
                     --check                      report only, change nothing
                     --no-tools --no-path --no-shortcut --no-bench   skip those steps
  connect [tool...]  Point tools at SAIAS: hermes, opencode, codex, claude (default: detected ones)
  update             Install newer models from the latest catalog (--check, --yes)
  rollback           Return to the models installed before the last update
  versions [profile] List available model versions and the active version (--json)
  use <profile> <version|latest>
                     Pin one profile to a version such as 1.0 or follow updates (--check, --yes)
  adopt <folder>     Reuse runtimes and model files already on disk (--move, --verify)
  install-image [dir] Install the local SAIAS Chat image generator (Windows x64, --yes)
  move <folder>      Move the models and the rest of the data folder, for example to another drive
  app                Download or update the native SAIAS app for Windows (--open starts it)
  clean              Delete files no profile uses any more (--yes)
  uninstall          Remove SAIAS from this PC in a window: models, data, shortcuts, tool settings
                     (--console in the terminal, with --check --yes --keep-conversations)

Run
  start              Start the hub: Llama Chat and the local API on port 8090 (--open)
  stop               Stop the hub and its model servers
  status             Show the installation and the hub state (--json)
  recommend          Show which profile suits this PC best (--json)
  claude [options]   Run Claude Code on a SAIAS model (--profile smart|pro|flash)
  omni                Run the Omni voice client (defaults to saias-omni; --profile NAME, --open)

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
      await manage.finish(opts);
      return;
    }
    case 'setup': return require('./setup').run(opts);
    case 'uninstall': return require('./setup').run({ ...opts, uninstall: true });
    case 'connect': return require('./integrations').connect(opts._, { yes: opts.yes });
    case 'claude': return require('./integrations/claude').launch(rest);
    case 'omni': return require('./integrations/omni').launch(rest);
    case 'start': return require('./hub').start({ open: Boolean(opts.open) });
    case 'stop': return stop();
    case 'bench': return require('./bench').run(opts);
    case 'eval': return require('./eval').run(opts);
    case 'update': return manage.update(opts);
    case 'rollback': return manage.rollback();
    case 'versions': return manage.versions(opts._[0], opts);
    case 'use': return manage.use(opts._[0], opts._[1], opts);
    case 'adopt': return manage.adopt(opts._[0], opts);
    case 'install-image': return require('./image').install(opts._[0], opts);
    case 'move': return manage.move(opts._[0]);
    case 'app': {
      const exe = await require('./app').ensure();
      if (exe && opts.open) require('node:child_process').spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
      return;
    }
    case 'status': return manage.status(opts);
    case 'recommend': return require('./recommend').run(opts);
    case 'clean': return manage.clean(opts);
    case 'help': case '--help': case '-h': console.log(HELP); return;
    default: throw new Error(`Unknown command "${command}". Run "saias help".`);
  }
}

main().catch(e => {
  ui.bad(e.message);
  process.exitCode = 1;
});
