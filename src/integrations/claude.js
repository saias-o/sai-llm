'use strict';

// Runs Claude Code on a SAIAS model: "saias claude [--profile smart] [claude options]".
// The hub serves the Anthropic Messages API, so Claude Code only needs its base URL and model
// names in the environment of that one session. The user's Claude Code settings are not changed.

const { spawn } = require('node:child_process');
const ui = require('../ui');
const { HUB_URL, requireInstalled, pickModel } = require('../installed');
const { which, quoteForCmd } = require('./util');
const hubClient = require('../hub-client');

function detect() {
  return Boolean(which('claude'));
}

async function configure({ models }) {
  ui.step('Claude Code');
  ui.ok('Nothing to change in your Claude Code settings.');
  ui.info(`Run "saias claude" to start Claude Code on ${models[0].id}, or "saias claude --profile smart".`);
}

function environment(model) {
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: HUB_URL,
    ANTHROPIC_AUTH_TOKEN: 'saias-local',
    ANTHROPIC_MODEL: model.id,
    // Every model slot uses the same profile: the hub keeps one model in memory, and switching
    // to a smaller model for background tasks would reload weights on every request.
    ANTHROPIC_DEFAULT_OPUS_MODEL: model.id,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model.id,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model.id,
    ANTHROPIC_SMALL_FAST_MODEL: model.id,
    CLAUDE_CODE_SUBAGENT_MODEL: model.id,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  delete env.ANTHROPIC_API_KEY;
  return env;
}

async function launch(argv) {
  let profile = null;
  const args = [...argv];
  const at = args.findIndex(a => a === '--profile' || a.startsWith('--profile='));
  if (at >= 0) {
    profile = args[at].includes('=') ? args[at].split('=')[1] : args[at + 1];
    args.splice(at, args[at].includes('=') ? 1 : 2);
  }
  const model = pickModel(requireInstalled(), profile);
  const claude = which('claude');
  if (!claude) throw new Error('Claude Code is not installed. See https://docs.claude.com/en/docs/claude-code/setup');
  await hubClient.ensureRunning();
  ui.info(`Claude Code on ${model.id} (${model.name}) through ${HUB_URL}`);
  const env = environment(model);
  const child = /\.(cmd|bat)$/i.test(claude)
    ? spawn('cmd.exe', ['/d', '/s', '/c', [quoteForCmd(claude), ...args.map(quoteForCmd)].join(' ')], { stdio: 'inherit', env, windowsVerbatimArguments: true })
    : spawn(claude, args, { stdio: 'inherit', env });
  return new Promise(resolve => child.on('exit', code => { process.exitCode = code ?? 0; resolve(); }));
}

module.exports = { id: 'claude', name: 'Claude Code', detect, configure, launch, environment };
