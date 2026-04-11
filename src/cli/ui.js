'use strict';

/**
 * Minimal terminal UI helpers: colors, tables, formatting.
 * Uses raw ANSI escapes so we don't need chalk as a dependency.
 */

const useColor = process.stdout.isTTY && process.env.NO_COLOR !== '1';

const wrap = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : String(text));

const colors = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  cyan: wrap('36'),
  gray: wrap('90'),
};

const symbols = {
  enabled: useColor ? colors.green('●') : '[on] ',
  disabled: useColor ? colors.gray('○') : '[off]',
  arrow: useColor ? colors.dim('→') : '->',
};

const icons = {
  telegram: '✈',
  max: '★',
  api: '⚡',
};

const formatEndpoint = (node) => {
  if (!node) return '?';
  const net = node.network || '?';
  const icon = icons[net] || '?';
  if (net === 'api') return `${icon} api:${node.api_key_env || '?'}`;

  const label = node.title
    || (node.chat_username ? `@${node.chat_username}` : null)
    || (typeof node.chat_id === 'number' ? String(node.chat_id) : null)
    || (typeof node.user_id === 'number' ? `user:${node.user_id}` : null)
    || '?';
  return `${icon} ${net}:${label}`;
};

const formatRoute = (route) => {
  const status = route.enabled === false ? symbols.disabled : symbols.enabled;
  const src = formatEndpoint(route.source);
  const dsts = (route.destinations || []).map(formatEndpoint).join(', ');
  const id = colors.bold(route.id);
  return `${status}  ${id}\n    ${src}  ${symbols.arrow}  ${dsts}`;
};

const renderRoutesList = (routes) => {
  if (!routes.length) return colors.dim('(no routes configured)');
  return routes.map(formatRoute).join('\n');
};

const renderRouteFull = (route) => {
  const lines = [];
  const status = route.enabled === false ? colors.yellow('disabled') : colors.green('enabled');
  lines.push(`${colors.bold('id:')}           ${route.id}`);
  lines.push(`${colors.bold('status:')}       ${status}`);
  lines.push(`${colors.bold('source:')}       ${formatEndpoint(route.source)}`);
  lines.push(`${colors.bold('destinations:')}`);
  for (const d of route.destinations || []) {
    lines.push(`  - ${formatEndpoint(d)}`);
  }
  if (route.options && Object.keys(route.options).length) {
    lines.push(`${colors.bold('options:')}      ${JSON.stringify(route.options)}`);
  }
  lines.push('');
  lines.push(colors.dim('raw:'));
  lines.push(colors.dim(JSON.stringify(route, null, 2)));
  return lines.join('\n');
};

const success = (msg) => console.log(`${colors.green('✔')} ${msg}`);
const info = (msg) => console.log(`${colors.cyan('ℹ')} ${msg}`);
const warn = (msg) => console.error(`${colors.yellow('!')} ${msg}`);
const error = (msg) => console.error(`${colors.red('✗')} ${msg}`);

const title = (text) => console.log(`\n${colors.bold(colors.cyan(text))}\n${colors.dim('─'.repeat(Math.min(60, text.length + 4)))}`);

module.exports = {
  colors,
  symbols,
  icons,
  useColor,
  formatEndpoint,
  formatRoute,
  renderRoutesList,
  renderRouteFull,
  success,
  info,
  warn,
  error,
  title,
};
