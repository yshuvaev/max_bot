'use strict';

/**
 * Non-interactive CLI command implementations.
 * Each command is an async function that throws on failure — errors are
 * caught and formatted by bin/max-bot-bridge.js.
 *
 * Interactive prompts used for login/add/edit/remove come from @inquirer/prompts.
 * They are required lazily so commands that don't prompt (like `list`) work
 * even if the package somehow fails to load.
 */

const client = require('./client');
const session = require('./session');
const ui = require('./ui');

const loadInquirer = () => require('@inquirer/prompts');

// ── login ────────────────────────────────────────────────────────────────

const cmdLogin = async (hostArg, opts = {}) => {
  const inquirer = loadInquirer();

  const host = hostArg || (await inquirer.input({
    message: 'Server host or IP:',
    validate: (v) => (v && v.trim()) ? true : 'Host is required',
  }));

  const port = opts.port ? Number(opts.port) : (await inquirer.input({
    message: 'Port:',
    default: '3000',
  }).then((v) => Number(v)));

  const scheme = opts.scheme || 'http';

  const password = opts.password || (await inquirer.password({
    message: 'Admin password:',
    mask: '•',
  }));

  try {
    const sess = await client.login({ host, port, password, scheme });
    session.saveSession(sess);
    const expires = sess.expires_at ? new Date(sess.expires_at).toISOString() : 'unknown';
    ui.success(`Logged in to ${scheme}://${host}:${port}`);
    ui.info(`Session stored at ${session.sessionPath()}`);
    ui.info(`Token expires: ${expires}`);
  } catch (err) {
    if (err instanceof client.ApiError) {
      if (err.status === 401) throw Object.assign(new Error('Invalid password'), { exitCode: 2 });
      throw err;
    }
    throw err;
  }
};

// ── logout ───────────────────────────────────────────────────────────────

const cmdLogout = async () => {
  const sess = session.loadSession();
  if (!sess) {
    ui.info('Not logged in — nothing to do.');
    return;
  }
  try {
    await client.logout(sess);
  } catch (err) {
    // Even if the server is unreachable, we still wipe the local session.
    ui.warn(`Server logout failed (${err.message}) — wiping local session anyway.`);
  }
  session.clearSession();
  ui.success('Logged out.');
};

// ── whoami ───────────────────────────────────────────────────────────────

const cmdWhoami = async () => {
  const sess = session.requireSession();
  const port = sess.port || 3000;
  const scheme = sess.scheme || 'http';
  ui.title('Current session');
  console.log(`host:     ${scheme}://${sess.host}:${port}`);
  console.log(`expires:  ${sess.expires_at ? new Date(sess.expires_at).toISOString() : 'unknown'}`);
  console.log(`storage:  ${session.sessionPath()}`);

  try {
    const res = await client.info(sess);
    console.log(`\nRoutes:   ${res.routes_enabled} enabled / ${res.routes_total} total`);
  } catch (err) {
    ui.warn(`Could not fetch /admin/info: ${err.message}`);
  }
};

// ── list / ls ────────────────────────────────────────────────────────────

const cmdList = async (opts = {}) => {
  const sess = session.requireSession();
  const routes = await client.listRoutes(sess);
  if (opts.json) {
    console.log(JSON.stringify(routes, null, 2));
    return;
  }
  ui.title(`Routes (${routes.length})`);
  console.log(ui.renderRoutesList(routes));
};

// ── show <id> ────────────────────────────────────────────────────────────

const cmdShow = async (routeId, opts = {}) => {
  const sess = session.requireSession();
  const route = await client.getRoute(sess, routeId);
  if (opts.json) {
    console.log(JSON.stringify(route, null, 2));
    return;
  }
  ui.title(`Route: ${route.id}`);
  console.log(ui.renderRouteFull(route));
};

// ── enable <id> / disable <id> ───────────────────────────────────────────

const cmdEnable = async (routeId) => {
  const sess = session.requireSession();
  const result = await client.enableRoute(sess, routeId);
  ui.success(`Enabled "${routeId}"`);
  if (result && result.route) console.log(ui.formatRoute(result.route));
};

const cmdDisable = async (routeId) => {
  const sess = session.requireSession();
  const result = await client.disableRoute(sess, routeId);
  ui.success(`Disabled "${routeId}"`);
  if (result && result.route) console.log(ui.formatRoute(result.route));
};

// ── remove <id> ──────────────────────────────────────────────────────────

const cmdRemove = async (routeId, opts = {}) => {
  const sess = session.requireSession();

  if (!opts.force) {
    const inquirer = loadInquirer();
    const ok = await inquirer.confirm({
      message: `Really delete route "${routeId}"? This cannot be undone.`,
      default: false,
    });
    if (!ok) {
      ui.info('Aborted.');
      return;
    }
  }

  await client.deleteRoute(sess, routeId);
  ui.success(`Removed "${routeId}"`);
};

// ── add ──────────────────────────────────────────────────────────────────

// Shared interactive wizard used by both `add` and the TUI.
// Returns a complete route object ready for POST /admin/routes.
const wizardCollectRoute = async ({ prefill = {}, fromTui = false } = {}) => {
  const inquirer = loadInquirer();

  const id = await inquirer.input({
    message: 'Route id (unique slug, e.g. "debug_tg_to_max"):',
    default: prefill.id,
    validate: (v) => (v && /^[a-zA-Z0-9_\-.:]+$/.test(v)) ? true : 'Use letters, digits, _ - . :',
  });

  const enabled = prefill.enabled === undefined
    ? await inquirer.confirm({ message: 'Enabled from the start?', default: true })
    : prefill.enabled;

  const source = await wizardCollectSource(prefill.source);
  const destinations = await wizardCollectDestinations(prefill.destinations || []);

  const includeOptions = await inquirer.confirm({
    message: 'Add per-route options (delay, media group collect, footer)?',
    default: Boolean(prefill.options && Object.keys(prefill.options).length),
  });

  const options = includeOptions ? await wizardCollectOptions(prefill.options || {}) : {};

  const route = { id, enabled, source, destinations };
  if (Object.keys(options).length) route.options = options;
  return route;
};

const wizardCollectSource = async (prefill = {}) => {
  const inquirer = loadInquirer();
  const network = await inquirer.select({
    message: 'Source network:',
    default: prefill.network || 'telegram',
    choices: [
      { name: 'Telegram channel/group', value: 'telegram' },
      { name: 'MAX chat', value: 'max' },
      { name: 'External API (HTTP ingest)', value: 'api' },
    ],
  });

  if (network === 'telegram') {
    const chatIdRaw = await inquirer.input({
      message: 'Telegram chat_id (numeric, e.g. -1001234567890, empty to skip):',
      default: prefill.chat_id ? String(prefill.chat_id) : '',
    });
    const chat_username = await inquirer.input({
      message: 'Telegram chat_username (optional, without @):',
      default: prefill.chat_username || '',
    });
    const out = { network: 'telegram' };
    if (chatIdRaw.trim()) out.chat_id = Number(chatIdRaw.trim());
    if (chat_username.trim()) out.chat_username = chat_username.trim();
    if (!out.chat_id && !out.chat_username) {
      throw new Error('At least one of chat_id / chat_username is required for a Telegram source.');
    }
    return out;
  }

  if (network === 'max') {
    const chat_id = Number(await inquirer.input({
      message: 'MAX chat_id (numeric):',
      default: prefill.chat_id ? String(prefill.chat_id) : '',
      validate: (v) => Number.isFinite(Number(v)) ? true : 'Must be a number',
    }));
    return { network: 'max', chat_id };
  }

  // api
  const api_key_env = await inquirer.input({
    message: 'Env var holding the Bearer token (e.g. API_KEY_ALERTS):',
    default: prefill.api_key_env || '',
    validate: (v) => /^[A-Z][A-Z0-9_]*$/.test(v) ? true : 'Use UPPER_SNAKE_CASE',
  });
  return { network: 'api', api_key_env };
};

const wizardCollectSingleDestination = async (prefill = {}) => {
  const inquirer = loadInquirer();
  const network = await inquirer.select({
    message: 'Destination network:',
    default: prefill.network || 'max',
    choices: [
      { name: 'MAX chat', value: 'max' },
      { name: 'MAX user (DM)', value: 'max-user' },
      { name: 'Telegram chat', value: 'telegram' },
    ],
  });

  if (network === 'max') {
    const chat_id = Number(await inquirer.input({
      message: 'MAX chat_id (numeric):',
      default: prefill.chat_id ? String(prefill.chat_id) : '',
      validate: (v) => Number.isFinite(Number(v)) ? true : 'Must be a number',
    }));
    return { network: 'max', chat_id };
  }

  if (network === 'max-user') {
    const user_id = Number(await inquirer.input({
      message: 'MAX user_id (numeric):',
      default: prefill.user_id ? String(prefill.user_id) : '',
      validate: (v) => Number.isFinite(Number(v)) ? true : 'Must be a number',
    }));
    return { network: 'max', user_id };
  }

  const chat_id = Number(await inquirer.input({
    message: 'Telegram chat_id (numeric):',
    default: prefill.chat_id ? String(prefill.chat_id) : '',
    validate: (v) => Number.isFinite(Number(v)) ? true : 'Must be a number',
  }));
  return { network: 'telegram', chat_id };
};

const wizardCollectDestinations = async (prefillList = []) => {
  const inquirer = loadInquirer();
  const results = [];
  let index = 0;
  do {
    const label = index === 0 ? 'Add first destination?' : 'Add another destination?';
    if (index > 0) {
      const more = await inquirer.confirm({ message: label, default: false });
      if (!more) break;
    }
    results.push(await wizardCollectSingleDestination(prefillList[index]));
    index += 1;
  } while (true);
  if (!results.length) {
    // force at least one
    results.push(await wizardCollectSingleDestination({}));
  }
  return results;
};

const wizardCollectOptions = async (prefill = {}) => {
  const inquirer = loadInquirer();
  const options = {};
  const delay = await inquirer.input({
    message: 'repost_delay_ms (ms, empty = default):',
    default: prefill.repost_delay_ms !== undefined ? String(prefill.repost_delay_ms) : '',
  });
  if (delay.trim()) options.repost_delay_ms = Number(delay.trim());

  const collect = await inquirer.input({
    message: 'media_group_collect_ms (ms, empty = default):',
    default: prefill.media_group_collect_ms !== undefined ? String(prefill.media_group_collect_ms) : '',
  });
  if (collect.trim()) options.media_group_collect_ms = Number(collect.trim());

  const footerChoice = await inquirer.select({
    message: 'include_telegram_footer:',
    default: prefill.include_telegram_footer === undefined ? 'default' : String(prefill.include_telegram_footer),
    choices: [
      { name: 'Use bot default', value: 'default' },
      { name: 'Yes', value: 'true' },
      { name: 'No', value: 'false' },
    ],
  });
  if (footerChoice !== 'default') options.include_telegram_footer = footerChoice === 'true';

  return options;
};

const cmdAdd = async () => {
  const sess = session.requireSession();
  const route = await wizardCollectRoute();
  console.log('\n' + ui.colors.dim('Creating route:'));
  console.log(ui.renderRouteFull(route));

  const inquirer = loadInquirer();
  const confirm = await inquirer.confirm({ message: 'Create this route?', default: true });
  if (!confirm) {
    ui.info('Aborted.');
    return;
  }

  const created = await client.createRoute(sess, route);
  ui.success(`Created route "${created.id}"`);
};

// ── edit <id> ────────────────────────────────────────────────────────────

const cmdEdit = async (routeId) => {
  const sess = session.requireSession();
  const current = await client.getRoute(sess, routeId);
  ui.title(`Editing route: ${current.id}`);
  console.log(ui.formatRoute(current));
  console.log('');

  const inquirer = loadInquirer();
  const action = await inquirer.select({
    message: 'What do you want to change?',
    choices: [
      { name: 'Toggle enabled/disabled', value: 'toggle' },
      { name: 'Edit source', value: 'source' },
      { name: 'Edit destinations', value: 'destinations' },
      { name: 'Edit options', value: 'options' },
      { name: 'Full re-wizard (id preserved)', value: 'full' },
      { name: 'Cancel', value: 'cancel' },
    ],
  });

  if (action === 'cancel') { ui.info('Aborted.'); return; }

  let patch = {};
  if (action === 'toggle') {
    patch = { enabled: current.enabled === false };
  } else if (action === 'source') {
    patch = { source: await wizardCollectSource(current.source) };
  } else if (action === 'destinations') {
    patch = { destinations: await wizardCollectDestinations(current.destinations) };
  } else if (action === 'options') {
    patch = { options: await wizardCollectOptions(current.options || {}) };
  } else if (action === 'full') {
    const full = await wizardCollectRoute({ prefill: current });
    patch = { ...full, id: current.id };
  }

  const updated = await client.updateRoute(sess, routeId, patch);
  ui.success(`Updated "${updated.id}"`);
  console.log(ui.formatRoute(updated));
};

module.exports = {
  cmdLogin,
  cmdLogout,
  cmdWhoami,
  cmdList,
  cmdShow,
  cmdEnable,
  cmdDisable,
  cmdRemove,
  cmdAdd,
  cmdEdit,
  wizardCollectRoute,
  wizardCollectSource,
  wizardCollectDestinations,
  wizardCollectSingleDestination,
  wizardCollectOptions,
};
