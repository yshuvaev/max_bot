'use strict';

/**
 * Bridge CLI entry.
 *
 * Two usage modes:
 *   1. Subcommand: `max-bot-bridge <command> [...]`
 *   2. Interactive TUI: `max-bot-bridge` (no arguments) — arrow-key menu.
 *
 * The `-h / --help` flag is extra-verbose so both humans and LLM agents can
 * understand every command without reading the README.
 */

const { Command, Option } = require('commander');

const commands = require('./commands');
const tui = require('./tui');

const VERSION = require('../../package.json').version || '1.0.0';

const AGENT_NOTE = `
Agent-friendly usage
--------------------
  - Every non-interactive flag is also available as an env var with the
    MAX_BOT_BRIDGE_ prefix (e.g. --password → MAX_BOT_BRIDGE_PASSWORD).
  - Pass --json to list / show to get machine-readable output.
  - Exit codes:
      0  success
      1  generic error (network, validation, server)
      2  auth error (not logged in / wrong password / expired session)
      3  resource not found (unknown route id)
  - To script a fresh install:
      max-bot-bridge login <host> --password=$PW
      max-bot-bridge add --json-file=./route.json       # (not in v1 yet)
      max-bot-bridge list --json | jq '.[].id'
  - Interactive prompts (add/edit) require a TTY and @inquirer/prompts.
    For unattended scripts use explicit flags when available.
`.trim();

const LONG_DESCRIPTION = `
max-bot-bridge — control panel for the Telegram/API → MAX bridge bot.

Authenticates against the bot's admin HTTP endpoint (enabled when
ADMIN_PASSWORD is set in the bot's .env) and lets you list, add, edit,
remove, enable or disable bridging routes without touching routes.json
by hand or redeploying.

Quick start:
  1) On the bot server:  add ADMIN_PASSWORD=<secret> to .env and restart.
  2) On your machine:    max-bot-bridge login <ip>
  3) Enjoy:              max-bot-bridge          (opens interactive TUI)

Security:
  The admin API speaks plain HTTP over the port set by API_PORT (default
  3000). Before exposing it to the internet, put it behind TLS (Caddy,
  Nginx) or tunnel it over SSH:
      ssh -L 3000:localhost:3000 root@your-bot
      max-bot-bridge login localhost
`.trim();

const run = async (argv) => {
  const program = new Command();

  program
    .name('max-bot-bridge')
    .version(VERSION, '-v, --version', 'print CLI version')
    .description(LONG_DESCRIPTION)
    .addHelpText('after', `\n${AGENT_NOTE}\n`);

  // ── login ────────────────────────────────────────────────────────────
  program
    .command('login [host]')
    .description('Authenticate against a running bot and save a long-lived session')
    .addOption(new Option('-p, --port <port>', 'admin API port').default('3000'))
    .addOption(new Option('-s, --scheme <scheme>', 'http or https').default('http').choices(['http', 'https']))
    .addOption(new Option('--password <password>', 'admin password (prefer stdin/env for security)').env('MAX_BOT_BRIDGE_PASSWORD'))
    .addHelpText('after', `
Examples:
  $ max-bot-bridge login 157.180.120.151
  $ max-bot-bridge login example.com --port 8080 --scheme https
  $ MAX_BOT_BRIDGE_PASSWORD=secret max-bot-bridge login 10.0.0.5 --password $MAX_BOT_BRIDGE_PASSWORD
`)
    .action((host, opts) => commands.cmdLogin(host, opts));

  program
    .command('logout')
    .description('Revoke the current server session and wipe it from disk')
    .action(() => commands.cmdLogout());

  program
    .command('whoami')
    .description('Show the active session and server summary')
    .action(() => commands.cmdWhoami());

  // ── list / ls ─────────────────────────────────────────────────────────
  program
    .command('list')
    .alias('ls')
    .description('List all bridging routes with source → destinations')
    .option('--json', 'print the raw JSON array from /admin/routes')
    .action((opts) => commands.cmdList(opts));

  // ── show ──────────────────────────────────────────────────────────────
  program
    .command('show <id>')
    .description('Show one route in detail (source, destinations, options, raw JSON)')
    .option('--json', 'print raw JSON only')
    .action((id, opts) => commands.cmdShow(id, opts));

  // ── enable / disable ─────────────────────────────────────────────────
  program
    .command('enable <id>')
    .description('Enable a route (bridge will start processing it on next message)')
    .action((id) => commands.cmdEnable(id));

  program
    .command('disable <id>')
    .description('Disable a route (keeps the config entry but stops processing)')
    .action((id) => commands.cmdDisable(id));

  // ── add ──────────────────────────────────────────────────────────────
  program
    .command('add')
    .description('Add a new route via an interactive wizard (id, source, destinations, options)')
    .addHelpText('after', `
This command requires a TTY. For scripted setups, write to routes.json
via the admin API directly, or use the TUI (max-bot-bridge).
`)
    .action(() => commands.cmdAdd());

  // ── edit ─────────────────────────────────────────────────────────────
  program
    .command('edit <id>')
    .description('Edit an existing route: toggle enabled, change source/destinations/options')
    .action((id) => commands.cmdEdit(id));

  // ── remove ───────────────────────────────────────────────────────────
  program
    .command('remove <id>')
    .alias('rm')
    .description('Delete a route (prompts for confirmation unless --force)')
    .option('-f, --force', 'skip the confirmation prompt')
    .action((id, opts) => commands.cmdRemove(id, opts));

  // ── tui ──────────────────────────────────────────────────────────────
  program
    .command('tui')
    .description('Open the interactive arrow-key menu (default when invoked without arguments)')
    .action(() => tui.mainMenu());

  // Hand argv to commander. If no subcommand was given, drop into the TUI.
  if (argv.length <= 2) {
    return tui.mainMenu();
  }

  await program.parseAsync(argv);
};

module.exports = { run };
