'use strict';

require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const TelegramBot = require('node-telegram-bot-api');
const { Bot: MaxBot } = require('@maxhub/max-bot-api');

const { createAdminHandler } = require('./admin/http');

let GramjsClient = null;
let GramjsStringSession = null;
try {
  GramjsClient = require('telegram').TelegramClient;
  GramjsStringSession = require('telegram/sessions').StringSession;
} catch {
  // gramjs not installed — MTProto large-video support disabled
}

const parseIntEnv = (name, fallback) => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer`);
  }
  return parsed;
};

const parseBooleanEnv = (name, fallback) => {
  const raw = process.env[name];
  if (!raw) return fallback;

  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;

  throw new Error(`Environment variable ${name} must be boolean-like`);
};

const requireEnv = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const trimSlash = (value) => String(value || '').replace(/\/+$/, '');
const normalizeUsername = (value) => String(value || '').replace(/^@/, '').trim().toLowerCase();

const appConfig = {
  telegramToken: requireEnv('TELEGRAM_BOT_TOKEN'),
  maxToken: requireEnv('MAX_BOT_TOKEN'),
  telegramApiBaseUrl: trimSlash(process.env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org'),
  routingConfigPath: process.env.ROUTING_CONFIG_PATH
    ? path.resolve(process.cwd(), process.env.ROUTING_CONFIG_PATH)
    : path.resolve(process.cwd(), 'config/routes.json'),
  discoveredChatsPath: path.resolve(process.cwd(), 'config/discovered-chats.json'),
  defaultRepostDelayMs: parseIntEnv('DEFAULT_REPOST_DELAY_MS', 3000),
  defaultMediaGroupCollectMs: parseIntEnv('DEFAULT_MEDIA_GROUP_COLLECT_MS', 1200),
  defaultIncludeTelegramFooter: parseBooleanEnv('DEFAULT_INCLUDE_TELEGRAM_FOOTER', true),
  apiPort: parseIntEnv('API_PORT', 3000),
  adminPassword: process.env.ADMIN_PASSWORD || '',
};

if (appConfig.defaultRepostDelayMs < 0) {
  throw new Error('DEFAULT_REPOST_DELAY_MS must be >= 0');
}
if (appConfig.defaultMediaGroupCollectMs < 0) {
  throw new Error('DEFAULT_MEDIA_GROUP_COLLECT_MS must be >= 0');
}

const log = (msg, extra = {}) => {
  const payload = Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : '';
  console.log(`[${new Date().toISOString()}] ${msg}${payload}`);
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const ensureNumber = (value, fieldName) => {
  assert(typeof value === 'number' && Number.isFinite(value), `${fieldName} must be a number`);
};

const ensureString = (value, fieldName) => {
  assert(typeof value === 'string' && value.trim().length > 0, `${fieldName} must be a non-empty string`);
};

const validateDestination = (routeId, destination, index) => {
  const prefix = `routes[${routeId}].destinations[${index}]`;
  ensureString(destination.network, `${prefix}.network`);

  if (destination.network === 'max') {
    const hasChat = typeof destination.chat_id === 'number';
    const hasUser = typeof destination.user_id === 'number';
    assert(hasChat !== hasUser, `${prefix}: set exactly one of chat_id or user_id`);
    if (hasChat) ensureNumber(destination.chat_id, `${prefix}.chat_id`);
    if (hasUser) ensureNumber(destination.user_id, `${prefix}.user_id`);
    return;
  }

  if (destination.network === 'telegram') {
    ensureNumber(destination.chat_id, `${prefix}.chat_id`);
    return;
  }

  if (destination.network === 'facebook') {
    ensureString(destination.page_id, `${prefix}.page_id`);
    const hasInline = typeof destination.access_token === 'string' && destination.access_token.length > 0;
    const hasEnv = typeof destination.access_token_env === 'string' && destination.access_token_env.length > 0;
    assert(hasInline || hasEnv, `${prefix}: set access_token (inline) or access_token_env (env var name) for facebook destination`);
    if (hasEnv) {
      assert(process.env[destination.access_token_env], `${prefix}: env var ${destination.access_token_env} is not set`);
    }
    return;
  }

  if (destination.network === 'instagram') {
    ensureString(destination.ig_user_id, `${prefix}.ig_user_id`);
    const hasInline = typeof destination.access_token === 'string' && destination.access_token.length > 0;
    const hasEnv = typeof destination.access_token_env === 'string' && destination.access_token_env.length > 0;
    assert(hasInline || hasEnv, `${prefix}: set access_token (inline) or access_token_env (env var name) for instagram destination`);
    if (hasEnv) {
      assert(process.env[destination.access_token_env], `${prefix}: env var ${destination.access_token_env} is not set`);
    }
    return;
  }

  if (destination.network === 'youtube') {
    const clientIdEnv = destination.client_id_env || 'YOUTUBE_CLIENT_ID';
    const clientSecretEnv = destination.client_secret_env || 'YOUTUBE_CLIENT_SECRET';
    const refreshTokenEnv = destination.refresh_token_env || 'YOUTUBE_REFRESH_TOKEN';
    assert(process.env[clientIdEnv], `${prefix}: env var ${clientIdEnv} is not set (YouTube client_id)`);
    assert(process.env[clientSecretEnv], `${prefix}: env var ${clientSecretEnv} is not set (YouTube client_secret)`);
    assert(process.env[refreshTokenEnv], `${prefix}: env var ${refreshTokenEnv} is not set (YouTube refresh_token)`);
    return;
  }

  if (destination.network === 'vk') {
    ensureNumber(destination.owner_id, `${prefix}.owner_id`);
    const hasInline = typeof destination.access_token === 'string' && destination.access_token.length > 0;
    const hasEnv = typeof destination.access_token_env === 'string' && destination.access_token_env.length > 0;
    assert(hasInline || hasEnv, `${prefix}: set access_token (inline) or access_token_env (env var name) for vk destination`);
    if (hasEnv) {
      assert(process.env[destination.access_token_env], `${prefix}: env var ${destination.access_token_env} is not set`);
    }
    return;
  }

  throw new Error(`${prefix}.network unsupported: ${destination.network}`);
};

const validateRoute = (route, index) => {
  const id = route.id || `index_${index}`;
  ensureString(id, `routes[${index}].id`);
  ensureString(route.source?.network, `routes[${id}].source.network`);

  if (route.source.network === 'telegram') {
    const hasId = typeof route.source.chat_id === 'number';
    const hasUsername = typeof route.source.chat_username === 'string' && route.source.chat_username.trim().length > 0;
    assert(hasId || hasUsername, `routes[${id}].source: set chat_id and/or chat_username for telegram source`);
    if (hasId) ensureNumber(route.source.chat_id, `routes[${id}].source.chat_id`);
  } else if (route.source.network === 'max') {
    ensureNumber(route.source.chat_id, `routes[${id}].source.chat_id`);
  } else if (route.source.network === 'api') {
    // Accept either an inline key (stored in routes.json) or a reference
    // to an env var. Inline is simpler for self-service CLI setup; env
    // var is the "traditional" separation-of-secrets option.
    const hasInline = typeof route.source.api_key === 'string' && route.source.api_key.length > 0;
    const hasEnv = typeof route.source.api_key_env === 'string' && route.source.api_key_env.length > 0;
    assert(hasInline || hasEnv, `routes[${id}].source: set api_key (inline) or api_key_env (env var name)`);
    if (hasInline) {
      assert(route.source.api_key.length >= 16, `routes[${id}].source.api_key must be at least 16 characters`);
    }
    if (hasEnv) {
      assert(process.env[route.source.api_key_env], `routes[${id}].source: env var ${route.source.api_key_env} is not set`);
    }
  } else {
    throw new Error(`routes[${id}].source.network unsupported: ${route.source.network}`);
  }

  assert(Array.isArray(route.destinations) && route.destinations.length > 0, `routes[${id}].destinations must be a non-empty array`);
  route.destinations.forEach((destination, destinationIndex) => {
    validateDestination(id, destination, destinationIndex);
  });

  if (route.options && route.options.repost_delay_ms !== undefined) {
    ensureNumber(route.options.repost_delay_ms, `routes[${id}].options.repost_delay_ms`);
    assert(route.options.repost_delay_ms >= 0, `routes[${id}].options.repost_delay_ms must be >= 0`);
  }

  if (route.options && route.options.media_group_collect_ms !== undefined) {
    ensureNumber(route.options.media_group_collect_ms, `routes[${id}].options.media_group_collect_ms`);
    assert(route.options.media_group_collect_ms >= 0, `routes[${id}].options.media_group_collect_ms must be >= 0`);
  }

  if (route.options && route.options.include_telegram_footer !== undefined) {
    assert(typeof route.options.include_telegram_footer === 'boolean', `routes[${id}].options.include_telegram_footer must be boolean`);
  }

  if (route.options && route.options.include_sender_name !== undefined) {
    assert(typeof route.options.include_sender_name === 'boolean', `routes[${id}].options.include_sender_name must be boolean`);
  }

  return {
    id,
    enabled: route.enabled !== false,
    source: route.source,
    destinations: route.destinations,
    options: route.options || {},
  };
};

/**
 * Allows human-readable string IDs in JSON, e.g. "chat_id": "-1002286857270".
 * Mutates the parsed tree in place before validation.
 */
const normalizeNumericIdsInRoutes = (parsed) => {
  if (!parsed || typeof parsed !== 'object') return;

  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    for (const key of Object.keys(node)) {
      if ((key === 'chat_id' || key === 'user_id') && typeof node[key] === 'string') {
        const trimmed = node[key].trim();
        if (/^-?\d+$/.test(trimmed)) {
          const n = Number(trimmed);
          if (Number.isSafeInteger(n)) node[key] = n;
        }
      } else {
        walk(node[key]);
      }
    }
  };

  walk(parsed);
};

const loadRoutingConfig = (configPath) => {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Routing config not found: ${configPath}`);
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw);
  normalizeNumericIdsInRoutes(parsed);

  assert(Array.isArray(parsed.routes), 'Routing config must include routes[]');

  const routes = parsed.routes.map((route, index) => validateRoute(route, index));
  return {
    routes,
  };
};

let routingConfig = loadRoutingConfig(appConfig.routingConfigPath);

/**
 * Re-reads routes.json from disk and replaces the in-memory routingConfig.
 * Used by the admin HTTP API after every mutation so the bot picks up changes
 * without a process restart. If the new file fails validation, the caller
 * is responsible for restoring the previous file — this function will rethrow.
 */
const reloadRoutingConfig = () => {
  routingConfig = loadRoutingConfig(appConfig.routingConfigPath);
  log('Routing config reloaded', {
    routes_total: routingConfig.routes.length,
    routes_enabled: routingConfig.routes.filter((r) => r.enabled !== false).length,
  });
};

const getRouteDelayMs = (route) => {
  if (typeof route.options.repost_delay_ms === 'number') return route.options.repost_delay_ms;
  return appConfig.defaultRepostDelayMs;
};

const getRouteMediaGroupCollectMs = (route) => {
  if (typeof route.options.media_group_collect_ms === 'number') return route.options.media_group_collect_ms;
  return appConfig.defaultMediaGroupCollectMs;
};

const getRouteIncludeFooter = (route) => {
  if (typeof route.options.include_telegram_footer === 'boolean') return route.options.include_telegram_footer;
  return appConfig.defaultIncludeTelegramFooter;
};

const telegram = new TelegramBot(appConfig.telegramToken, { polling: true });
const maxBot = new MaxBot(appConfig.maxToken);

const BOT_API_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024; // 20 MB hard limit of the public Telegram Bot API

// ---------------------------------------------------------------------------
// Temp-file overflow protection
// ---------------------------------------------------------------------------

const TEMP_MIN_FREE_MB = parseIntEnv('TEMP_MIN_FREE_MB', 1000);

/** Paths of temp files currently being downloaded/uploaded. */
const activeTempFiles = new Set();

/**
 * Throws if free space in os.tmpdir() is below TEMP_MIN_FREE_MB.
 * Silently skips on Node versions that don't support fs.statfsSync (< 19.6).
 */
const checkDiskSpace = () => {
  if (typeof fs.statfsSync !== 'function') return;
  const stats = fs.statfsSync(os.tmpdir());
  const freeMb = Math.round((stats.bfree * stats.bsize) / (1024 * 1024));
  if (freeMb < TEMP_MIN_FREE_MB) {
    throw new Error(
      `Not enough disk space in ${os.tmpdir()}: ${freeMb} MB free (need ${TEMP_MIN_FREE_MB} MB)`,
    );
  }
};

/**
 * Deletes stale tg_bridge_* files in os.tmpdir() that are older than maxAgeMs
 * AND are not currently tracked in activeTempFiles.
 */
const cleanStaleTempFiles = (maxAgeMs = 30 * 60 * 1000) => {
  const dir = os.tmpdir();
  const now = Date.now();
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith('tg_bridge_')) continue;
      const file = path.join(dir, name);
      if (activeTempFiles.has(file)) continue;
      try {
        const { mtimeMs } = fs.statSync(file);
        if (now - mtimeMs > maxAgeMs) {
          fs.unlinkSync(file);
          log('Cleaned stale temp file', { file: name });
        }
      } catch { /* ignore per-file errors */ }
    }
  } catch { /* ignore readdir errors */ }
};

const state = {
  queue: [],
  queueBusy: false,
  mediaGroupBuffer: new Map(),
  maxBotUserId: null,
  droppedSourceLogs: new Map(),
};

let mtprotoClient = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Discovered-chats registry — persisted so bridge-init --merge can find
// Telegram chats even when the main bot is already consuming getUpdates
// ---------------------------------------------------------------------------

const _discoveredChats = (() => {
  let cache = null;

  const load = () => {
    if (cache) return cache;
    try {
      if (fs.existsSync(appConfig.discoveredChatsPath)) {
        const parsed = JSON.parse(fs.readFileSync(appConfig.discoveredChatsPath, 'utf8'));
        cache = parsed && typeof parsed.chats === 'object' ? parsed : { chats: {} };
      } else {
        cache = { chats: {} };
      }
    } catch {
      cache = { chats: {} };
    }
    return cache;
  };

  return {
    persist(chat) {
      if (!chat || !chat.id) return;
      const key = String(chat.id);
      const data = load();
      if (data.chats[key]) return;
      data.chats[key] = {
        id: chat.id,
        type: chat.type,
        title: chat.title || null,
        username: chat.username || null,
      };
      try {
        fs.mkdirSync(path.dirname(appConfig.discoveredChatsPath), { recursive: true });
        fs.writeFileSync(appConfig.discoveredChatsPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      } catch (err) {
        log('Failed to persist discovered chat', { error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
})();

const escapeMarkdownText = (value) => {
  return String(value).replace(/([\\`*_{}\[\]()#+\-.!|>~+])/g, '\\$1');
};

const normalizeUrl = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).toString();
  } catch {
    return encodeURI(raw);
  }
};

const hasSupportedAttachment = (messageLike) => {
  if (!messageLike) return false;
  return Boolean(
    (messageLike.photo && messageLike.photo.length)
      || messageLike.video
      || messageLike.animation
      || messageLike.audio
      || messageLike.voice
      || messageLike.video_note
      || messageLike.document,
  );
};

const getMessageCandidates = (message) => {
  return [message, message.reply_to_message, message.external_reply].filter(Boolean);
};

const hasValidFileId = (value) => typeof value === 'string' && value.length > 0;

const resolveDocumentKind = (document) => {
  const mime = typeof document?.mime_type === 'string' ? document.mime_type.toLowerCase() : '';
  const fileName = typeof document?.file_name === 'string' ? document.file_name.toLowerCase() : '';

  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';

  if (fileName.endsWith('.mp4') || fileName.endsWith('.mov') || fileName.endsWith('.mkv') || fileName.endsWith('.webm')) {
    return 'video';
  }
  if (fileName.endsWith('.mp3') || fileName.endsWith('.m4a') || fileName.endsWith('.wav') || fileName.endsWith('.ogg')) {
    return 'audio';
  }

  return 'file';
};

const buildMediaCandidates = (messageLike, label, tgChatId, tgMessageId) => {
  const results = [];
  if (!messageLike) return results;

  const ctx = { tgChatId: tgChatId || null, tgMessageId: tgMessageId || null };

  if (Array.isArray(messageLike.photo) && messageLike.photo.length) {
    for (let i = messageLike.photo.length - 1; i >= 0; i -= 1) {
      const photo = messageLike.photo[i];
      if (!hasValidFileId(photo?.file_id)) continue;
      results.push({ label, kind: 'image', fileId: photo.file_id, fileSize: photo.file_size || 0, mime: 'image/jpeg', ...ctx });
    }
  }

  if (hasValidFileId(messageLike.video?.file_id)) {
    results.push({ label, kind: 'video', fileId: messageLike.video.file_id, fileSize: messageLike.video.file_size || 0, mime: messageLike.video.mime_type || 'video/mp4', ...ctx });
  }

  if (hasValidFileId(messageLike.animation?.file_id)) {
    results.push({ label, kind: 'video', fileId: messageLike.animation.file_id, fileSize: messageLike.animation.file_size || 0, mime: messageLike.animation.mime_type || 'video/mp4', ...ctx });
  }

  if (hasValidFileId(messageLike.audio?.file_id)) {
    results.push({ label, kind: 'audio', fileId: messageLike.audio.file_id, fileSize: messageLike.audio.file_size || 0, mime: messageLike.audio.mime_type || 'audio/mpeg', ...ctx });
  }

  if (hasValidFileId(messageLike.voice?.file_id)) {
    results.push({ label, kind: 'audio', fileId: messageLike.voice.file_id, fileSize: messageLike.voice.file_size || 0, mime: 'audio/ogg', ...ctx });
  }

  if (hasValidFileId(messageLike.video_note?.file_id)) {
    results.push({ label, kind: 'video', fileId: messageLike.video_note.file_id, fileSize: messageLike.video_note.file_size || 0, mime: 'video/mp4', ...ctx });
  }

  if (hasValidFileId(messageLike.document?.file_id)) {
    results.push({
      label,
      kind: resolveDocumentKind(messageLike.document),
      fileId: messageLike.document.file_id,
      fileSize: messageLike.document.file_size || 0,
      mime: messageLike.document.mime_type || 'application/octet-stream',
      ...ctx,
    });
  }

  return results;
};

const chooseTextSource = (message) => {
  if (hasSupportedAttachment(message)) return message;
  if (hasSupportedAttachment(message.reply_to_message)) return message.reply_to_message;
  if (hasSupportedAttachment(message.external_reply)) return message.external_reply;
  return message;
};

const extractTextAndEntities = (messageLike) => {
  if (!messageLike) return { text: '', entities: [] };

  if (typeof messageLike.text === 'string' && messageLike.text.length) {
    return {
      text: messageLike.text,
      entities: Array.isArray(messageLike.entities) ? messageLike.entities : [],
    };
  }

  if (typeof messageLike.caption === 'string' && messageLike.caption.length) {
    return {
      text: messageLike.caption,
      entities: Array.isArray(messageLike.caption_entities) ? messageLike.caption_entities : [],
    };
  }

  return { text: '', entities: [] };
};

const buildEntityTree = (textLength, entities) => {
  const root = {
    type: 'root',
    offset: 0,
    length: textLength,
    end: textLength,
    children: [],
  };

  const sorted = [...entities]
    .filter((entity) => {
      if (!entity || typeof entity.offset !== 'number' || typeof entity.length !== 'number') return false;
      if (entity.length <= 0 || entity.offset < 0) return false;
      if (entity.offset + entity.length > textLength) return false;
      return true;
    })
    .map((entity) => ({ ...entity, end: entity.offset + entity.length, children: [] }))
    .sort((a, b) => {
      if (a.offset !== b.offset) return a.offset - b.offset;
      return b.length - a.length;
    });

  const stack = [root];

  for (const entity of sorted) {
    while (stack.length && entity.offset >= stack[stack.length - 1].end) {
      stack.pop();
    }

    const parent = stack[stack.length - 1];
    if (!parent) continue;
    if (entity.offset < parent.offset || entity.end > parent.end) continue;

    parent.children.push(entity);
    stack.push(entity);
  }

  return root;
};

const wrapEntityAsMarkdown = (entity, innerText, rawText) => {
  const raw = String(rawText || '');
  switch (entity.type) {
    case 'bold':
      return `**${innerText}**`;
    case 'italic':
      return `_${innerText}_`;
    case 'underline':
      return `++${innerText}++`;
    case 'strikethrough':
      return `~~${innerText}~~`;
    case 'code':
      return `\`${raw.replace(/`/g, '\\`')}\``;
    case 'pre':
      return `\n\`\`\`\n${raw.replace(/```/g, '``\\`')}\n\`\`\`\n`;
    case 'text_link':
      if (entity.url) return `[${innerText}](${normalizeUrl(entity.url)})`;
      return innerText;
    case 'url':
      return `[${escapeMarkdownText(raw)}](${normalizeUrl(raw)})`;
    case 'text_mention':
      return innerText;
    default:
      return innerText;
  }
};

const renderNodeAsMarkdown = (node, sourceText) => {
  let cursor = node.offset;
  let markdown = '';

  const children = [...(node.children || [])].sort((a, b) => a.offset - b.offset);
  for (const child of children) {
    if (child.offset > cursor) {
      markdown += escapeMarkdownText(sourceText.slice(cursor, child.offset));
    }

    const innerMarkdown = renderNodeAsMarkdown(child, sourceText);
    const rawText = sourceText.slice(child.offset, child.end);
    markdown += wrapEntityAsMarkdown(child, innerMarkdown, rawText);
    cursor = child.end;
  }

  if (cursor < node.end) {
    markdown += escapeMarkdownText(sourceText.slice(cursor, node.end));
  }

  return markdown;
};

const formatTelegramTextAsMarkdown = (text, entities) => {
  if (!text) return '';
  if (!entities || !entities.length) return escapeMarkdownText(text);

  const root = buildEntityTree(text.length, entities);
  return renderNodeAsMarkdown(root, text);
};

const escapeHtml = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Converts MAX-style markdown (used throughout the bridge) to Telegram HTML.
 * Handles both raw markdown (API sources) and backslash-escaped markdown
 * produced by formatTelegramTextAsMarkdown.
 */
const markdownToTelegramHtml = (md) => {
  if (!md) return '';
  let text = md;

  // 1. Extract code blocks → <pre>
  const blocks = [];
  text = text.replace(/\n?```\n?([\s\S]*?)```\n?/g, (_, c) => {
    blocks.push(`<pre>${escapeHtml(c.trim())}</pre>`);
    return `\x00B${blocks.length - 1}\x00`;
  });

  // 2. Extract inline code → <code>
  const codes = [];
  text = text.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code>${escapeHtml(c)}</code>`);
    return `\x00C${codes.length - 1}\x00`;
  });

  // 3. Extract links → <a>
  const links = [];
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    links.push(`<a href="${escapeHtml(url.replace(/\\(.)/g, '$1'))}">${escapeHtml(label.replace(/\\(.)/g, '$1'))}</a>`);
    return `\x00L${links.length - 1}\x00`;
  });

  // 4. Unescape markdown backslash escapes (from escapeMarkdownText)
  text = text.replace(/\\([\\`*_{}\[\]()#+\-.!|>~])/g, '$1');

  // 5. HTML-escape remaining text (*, _, ~ etc are NOT html-special)
  text = escapeHtml(text);

  // 6. Markdown → HTML tags
  text = text.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  text = text.replace(/(?<!\w)_(.+?)_(?!\w)/g, '<i>$1</i>');
  text = text.replace(/~~(.+?)~~/g, '<s>$1</s>');
  text = text.replace(/\+\+(.+?)\+\+/g, '<u>$1</u>');

  // 7. Restore placeholders
  text = text.replace(/\x00B(\d+)\x00/g, (_, i) => blocks[Number(i)]);
  text = text.replace(/\x00C(\d+)\x00/g, (_, i) => codes[Number(i)]);
  text = text.replace(/\x00L(\d+)\x00/g, (_, i) => links[Number(i)]);

  return text;
};

const buildTelegramPostUrl = (chat, messageId) => {
  if (!chat) return '';
  if (chat.username && messageId) return `https://t.me/${chat.username}/${messageId}`;
  if (chat.username) return `https://t.me/${chat.username}`;
  if (!messageId) return '';
  if (typeof chat.id === 'number') {
    const id = String(chat.id);
    if (id.startsWith('-100')) {
      return `https://t.me/c/${id.slice(4)}/${messageId}`;
    }
  }
  return '';
};

const getTelegramLinkCandidate = (message, source) => {
  const candidates = [
    { chat: source.chat, messageId: source.message_id },
    { chat: message.external_reply?.chat, messageId: message.external_reply?.message_id },
    { chat: message.external_reply?.origin?.chat, messageId: message.external_reply?.origin?.message_id },
    { chat: message.reply_to_message?.chat, messageId: message.reply_to_message?.message_id },
    { chat: message.forward_from_chat, messageId: message.forward_from_message_id },
    { chat: message.forward_origin?.chat, messageId: message.forward_origin?.message_id },
    { chat: message.chat, messageId: message.message_id },
  ];

  for (const candidate of candidates) {
    const url = buildTelegramPostUrl(candidate.chat, candidate.messageId);
    if (!url) continue;

    const name = candidate.chat?.title || (candidate.chat?.username ? `@${candidate.chat.username}` : 'Telegram');
    return { name, url };
  }

  return null;
};

const getTelegramFooter = (message, route) => {
  if (!getRouteIncludeFooter(route)) return '';

  const source = chooseTextSource(message);
  const sourceLink = getTelegramLinkCandidate(message, source);
  if (!sourceLink) return '';

  return `tg: [${escapeMarkdownText(sourceLink.name)}](${sourceLink.url})`;
};

const getSenderName = (message) => {
  const from = message.from || message.sender_chat;
  if (!from) return '';
  if (from.first_name || from.last_name) {
    return [from.first_name, from.last_name].filter(Boolean).join(' ');
  }
  if (from.title) return from.title;
  if (from.username) return from.username;
  return '';
};

const getTelegramMessageText = (message, route, warningText = '') => {
  const own = extractTextAndEntities(message);
  const repostSource = chooseTextSource(message);
  const repost = repostSource === message ? { text: '', entities: [] } : extractTextAndEntities(repostSource);
  const footer = getTelegramFooter(message, route);

  const parts = [];

  if (route.options.include_sender_name) {
    const name = getSenderName(message);
    if (name) parts.push(`**${escapeMarkdownText(name)}:**`);
  }

  if (own.text) parts.push(formatTelegramTextAsMarkdown(own.text, own.entities));
  if (repost.text) parts.push(formatTelegramTextAsMarkdown(repost.text, repost.entities));
  if (warningText) parts.push(escapeMarkdownText(warningText));
  if (footer) parts.push(footer);

  return parts.join('\n\n');
};

const isTooBigTelegramError = (err) => {
  const text = err instanceof Error ? err.message : String(err);
  return /file is too big/i.test(text);
};

// ---------------------------------------------------------------------------
// MTProto layer — used to download video files that exceed the 20 MB Bot API cap
// ---------------------------------------------------------------------------

const initMtprotoClient = async () => {
  if (!GramjsClient || !GramjsStringSession) {
    log('gramjs not available; large video downloads via MTProto disabled');
    return;
  }

  const apiId = Number.parseInt(process.env.TELEGRAM_API_ID || '0', 10);
  const apiHash = process.env.TELEGRAM_API_HASH || '';
  if (!apiId || !apiHash) {
    log('TELEGRAM_API_ID / TELEGRAM_API_HASH not set; MTProto disabled');
    return;
  }

  const sessionFile = path.resolve(
    process.cwd(),
    process.env.TELEGRAM_MTPROTO_SESSION_FILE || '.mtproto_session',
  );
  const sessionString = fs.existsSync(sessionFile) ? fs.readFileSync(sessionFile, 'utf8').trim() : '';

  const client = new GramjsClient(
    new GramjsStringSession(sessionString),
    apiId,
    apiHash,
    { connectionRetries: 5, retryDelay: 1000 },
  );

  await client.start({ botAuthToken: appConfig.telegramToken });

  const saved = client.session.save();
  if (saved !== sessionString) {
    fs.writeFileSync(sessionFile, saved, 'utf8');
    log('MTProto session saved', { path: sessionFile });
  }

  // Bots cannot call messages.GetDialogs, so we pre-seed entity cache
  // by resolving every source channel/group from routes.json directly.
  const sources = routingConfig.routes
    .filter((r) => r.enabled !== false && r.source.network === 'telegram')
    .map((r) => r.source);

  let seeded = 0;
  for (const source of sources) {
    try {
      if (source.chat_username) {
        await client.getInputEntity(source.chat_username);
        seeded += 1;
      }
    } catch (err) {
      log('MTProto entity pre-seed skipped', {
        chat_id: source.chat_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log('MTProto client ready', { seeded_entities: seeded });

  mtprotoClient = client;
};

const makeProgressLogger = (label) => {
  let lastPct = -1;
  return (received, total) => {
    if (!total) return;
    const pct = Math.floor(Number(received) / Number(total) * 100);
    if (pct >= lastPct + 25) {
      lastPct = pct;
      log(`${label} ${pct}%`, { received_mb: Math.round(Number(received) / 1048576) });
    }
  };
};

const downloadViaMtproto = async (candidate) => {
  if (!mtprotoClient) throw new Error('MTProto client not initialized');

  let entity;
  try {
    entity = await mtprotoClient.getInputEntity(candidate.tgChatId);
  } catch (err) {
    throw new Error(`MTProto entity resolution failed for chat ${candidate.tgChatId}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const messages = await mtprotoClient.getMessages(entity, { ids: [candidate.tgMessageId] });
  if (!messages || !messages[0]) {
    throw new Error(`MTProto: message ${candidate.tgMessageId} not found in chat ${candidate.tgChatId}`);
  }

  const mimeExt = candidate.mime ? candidate.mime.split('/')[1] : 'mp4';
  const ext = `.${mimeExt.replace(/[^a-z0-9]/gi, '') || 'mp4'}`;

  checkDiskSpace();
  const tmpFile = path.join(
    os.tmpdir(),
    `tg_bridge_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`,
  );
  activeTempFiles.add(tmpFile);

  await mtprotoClient.downloadMedia(messages[0], {
    outputFile: tmpFile,
    progressCallback: makeProgressLogger('MTProto download'),
  });

  return tmpFile;
};

const uploadLargeMediaViaMtproto = async (candidate) => {
  let tmpFile = null;
  try {
    log('MTProto fallback: starting download', {
      chat_id: candidate.tgChatId,
      message_id: candidate.tgMessageId,
      file_size_mb: candidate.fileSize ? Math.round(candidate.fileSize / 1048576) : 'unknown',
    });

    tmpFile = await downloadViaMtproto(candidate);
    log('MTProto download complete, uploading to MAX', { tmp: path.basename(tmpFile) });

    let result;
    if (candidate.kind === 'video') {
      result = await maxBot.api.uploadVideo({ source: tmpFile });
    } else if (candidate.kind === 'audio') {
      result = await maxBot.api.uploadAudio({ source: tmpFile });
    } else {
      result = await maxBot.api.uploadFile({ source: tmpFile });
    }

    log('MTProto media uploaded to MAX', {
      chat_id: candidate.tgChatId,
      message_id: candidate.tgMessageId,
    });

    return result.toJson();
  } finally {
    if (tmpFile) {
      activeTempFiles.delete(tmpFile);
      try { fs.unlinkSync(tmpFile); } catch (err) {
        log('Failed to delete MTProto temp file', { file: path.basename(tmpFile), error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
};

// ---------------------------------------------------------------------------

const tgResolveFileLocation = async (fileId) => {
  const endpoint = `${appConfig.telegramApiBaseUrl}/bot${appConfig.telegramToken}/getFile`;
  const response = await fetch(`${endpoint}?file_id=${encodeURIComponent(fileId)}`);

  if (!response.ok) {
    throw new Error(`Telegram getFile HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (!payload.ok) {
    throw new Error(payload.description || 'Telegram getFile failed');
  }

  const filePath = payload.result?.file_path;
  if (!filePath) {
    throw new Error(`Telegram did not return file_path for file_id=${fileId}`);
  }

  if (filePath.startsWith('/') && fs.existsSync(filePath)) {
    return {
      type: 'source',
      value: filePath,
    };
  }

  const normalized = filePath.replace(/^\/+/, '');
  return {
    type: 'url',
    value: `${appConfig.telegramApiBaseUrl}/file/bot${appConfig.telegramToken}/${normalized}`,
  };
};

const canUseMtprotoFallback = (candidate) =>
  Boolean(mtprotoClient && candidate.tgChatId && candidate.tgMessageId);

// @maxhub/max-bot-api's uploadVideo/uploadAudio/uploadFile only accept a local
// source (file path string). Internally they use a ReadStream → chunked Content-Range
// upload to MAX, which is the only supported path for video.
// uploadImage is the only method that supports passing a URL directly.
// So for non-image media we must download to a temp file on disk first.
const downloadUrlToTempFile = async (url, mime) => {
  const mimeExt = mime ? mime.split('/')[1] : 'bin';
  const ext = `.${mimeExt.replace(/[^a-z0-9]/gi, '') || 'bin'}`;

  checkDiskSpace();
  const tmpFile = path.join(
    os.tmpdir(),
    `tg_bridge_dl_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`,
  );
  activeTempFiles.add(tmpFile);

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Telegram file download failed: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(tmpFile, buffer);
  return tmpFile;
};

const uploadMediaCandidate = async (candidate) => {
  // Pre-check: known large files bypass Bot API and go straight to MTProto
  if (
    candidate.fileSize > BOT_API_MAX_DOWNLOAD_BYTES
    && candidate.kind !== 'image'
    && canUseMtprotoFallback(candidate)
  ) {
    return uploadLargeMediaViaMtproto(candidate);
  }

  try {
    const location = await tgResolveFileLocation(candidate.fileId);

    if (candidate.kind === 'image') {
      // uploadImage supports a URL passthrough natively
      const input = location.type === 'source'
        ? { source: location.value }
        : { url: location.value };
      return (await maxBot.api.uploadImage(input)).toJson();
    }

    // For video/audio/file: must be a local file path (string) so the library uses
    // ReadStream → chunked Content-Range upload path, not the multipart Buffer path
    // which the MAX server rejects with XML instead of JSON.
    let tmpFile = null;
    try {
      const source = location.type === 'source'
        ? location.value
        : (tmpFile = await downloadUrlToTempFile(location.value, candidate.mime));

      if (candidate.kind === 'video') {
        return (await maxBot.api.uploadVideo({ source })).toJson();
      }
      if (candidate.kind === 'audio') {
        return (await maxBot.api.uploadAudio({ source })).toJson();
      }
      return (await maxBot.api.uploadFile({ source })).toJson();
    } finally {
      if (tmpFile) {
        activeTempFiles.delete(tmpFile);
        try { fs.unlinkSync(tmpFile); } catch (err) {
          log('Failed to delete download temp file', { file: path.basename(tmpFile), error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  } catch (err) {
    if (isTooBigTelegramError(err) && canUseMtprotoFallback(candidate)) {
      log('Bot API "file too big", falling back to MTProto download', {
        kind: candidate.kind,
        file_size: candidate.fileSize,
      });
      return uploadLargeMediaViaMtproto(candidate);
    }
    throw err;
  }
};

const buildAttachmentsFromTelegram = async (message) => {
  const candidates = getMessageCandidates(message);
  const mediaCandidates = [
    ...buildMediaCandidates(candidates[0], 'message', message.chat.id, message.message_id),
    ...buildMediaCandidates(candidates[1], 'reply_to_message',
      message.reply_to_message?.chat?.id || message.chat.id,
      message.reply_to_message?.message_id || null,
    ),
    ...buildMediaCandidates(candidates[2], 'external_reply', null, null),
  ];

  if (!mediaCandidates.length) {
    if (candidates.some((item) => hasSupportedAttachment(item))) {
      log('Media exists but no downloadable file_id', {
        telegram_chat_id: message.chat.id,
        telegram_message_id: message.message_id,
      });
    }
    return { attachments: [], warningText: '' };
  }

  let tooBigErrorSeen = false;
  let lastError = null;

  for (const candidate of mediaCandidates) {
    try {
      const attachment = await uploadMediaCandidate(candidate);
      return {
        attachments: [attachment],
        warningText: '',
      };
    } catch (err) {
      lastError = err;
      if (isTooBigTelegramError(err)) tooBigErrorSeen = true;

      log('Attachment candidate failed', {
        telegram_chat_id: message.chat.id,
        telegram_message_id: message.message_id,
        candidate_label: candidate.label,
        candidate_kind: candidate.kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const warningText = tooBigErrorSeen
    ? 'Вложение из Telegram не скопировано: файл слишком большой для Bot API.'
    : 'Вложение из Telegram не скопировано: файл недоступен через Bot API.';

  log('Attachment upload failed', {
    error: lastError instanceof Error ? lastError.message : String(lastError),
    telegram_chat_id: message.chat.id,
    telegram_message_id: message.message_id,
  });

  return {
    attachments: [],
    warningText,
  };
};

const matchTelegramSource = (source, message) => {
  if (source.network !== 'telegram') return false;

  let hasConstraint = false;
  let matched = true;

  if (typeof source.chat_id === 'number') {
    hasConstraint = true;
    matched = matched && source.chat_id === message.chat.id;
  }

  if (typeof source.chat_username === 'string' && source.chat_username.trim().length > 0) {
    hasConstraint = true;
    matched = matched && normalizeUsername(source.chat_username) === normalizeUsername(message.chat.username);
  }

  return hasConstraint && matched;
};

const matchMaxSource = (source, maxChatId) => {
  return source.network === 'max' && source.chat_id === maxChatId;
};

const getEnabledRoutes = () => routingConfig.routes.filter((route) => route.enabled !== false);

const findTelegramRoutes = (message) => {
  return getEnabledRoutes().filter((route) => matchTelegramSource(route.source, message));
};

const findMaxRoutes = (chatId) => {
  return getEnabledRoutes().filter((route) => matchMaxSource(route.source, chatId));
};

const findApiRoutes = (apiKey) => {
  if (!apiKey) return [];
  return getEnabledRoutes().filter((route) => {
    if (route.source.network !== 'api') return false;
    // Inline key wins if present, otherwise fall back to env var.
    const routeKey = route.source.api_key || process.env[route.source.api_key_env];
    if (!routeKey) return false;
    try {
      const a = Buffer.from(apiKey);
      const b = Buffer.from(routeKey);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  });
};

const FB_API_BASE = 'https://graph.facebook.com/v21.0';

const resolveFacebookAccessToken = (destination) => {
  if (typeof destination.access_token === 'string' && destination.access_token.length > 0) {
    return destination.access_token;
  }
  const token = process.env[destination.access_token_env];
  if (!token) throw new Error(`Facebook access token env var "${destination.access_token_env}" is not set`);
  return token;
};

const markdownToPlainText = (md) => {
  if (!md) return '';
  return md
    .replace(/\n?```[\s\S]*?```\n?/g, (m) => m.replace(/```\w*/g, '').trim())
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(?<!\w)_(.+?)_(?!\w)/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\+\+(.+?)\+\+/g, '$1')
    .replace(/\\([\\`*_{}\[\]()#+\-.!|>~])/g, '$1');
};

/**
 * Truncates text at a natural boundary.
 * Priority: sentence end (. ! ?) → newline → word boundary → hard cut.
 * Never cuts mid-word unless no boundary exists.
 */
const truncateText = (text, maxLen, ellipsis = '…') => {
  if (!text || text.length <= maxLen) return text || '';
  const limit = maxLen - ellipsis.length;
  if (limit <= 0) return ellipsis.slice(0, maxLen);

  const sentenceEnd = Math.max(
    ...['. ', '.\n', '! ', '!\n', '? ', '?\n'].map((s) => {
      const i = text.lastIndexOf(s, limit);
      return i > 0 ? i + 1 : -1;
    }),
  );
  if (sentenceEnd > limit * 0.4) return text.slice(0, sentenceEnd).trimEnd() + ellipsis;

  const nlEnd = text.lastIndexOf('\n', limit);
  if (nlEnd > limit * 0.4) return text.slice(0, nlEnd).trimEnd() + ellipsis;

  const spaceEnd = text.lastIndexOf(' ', limit);
  if (spaceEnd > limit * 0.2) return text.slice(0, spaceEnd) + ellipsis;

  return text.slice(0, limit) + ellipsis;
};

const sendToFacebook = async (destination, text, telegramMessage) => {
  const accessToken = resolveFacebookAccessToken(destination);
  const pageId = destination.page_id;
  const plainText = markdownToPlainText(text);

  // Attempt photo post if the message has a photo
  if (telegramMessage && Array.isArray(telegramMessage.photo) && telegramMessage.photo.length > 0) {
    try {
      const bestPhoto = telegramMessage.photo[telegramMessage.photo.length - 1];
      const location = await tgResolveFileLocation(bestPhoto.file_id);
      if (location.type === 'url') {
        const params = new URLSearchParams({
          url: location.value,
          caption: plainText || '',
          access_token: accessToken,
        });
        const photoResp = await fetch(`${FB_API_BASE}/${pageId}/photos`, {
          method: 'POST',
          body: params,
        });
        if (photoResp.ok) return photoResp.json();
        const errBody = await photoResp.text();
        log('Facebook photo post failed, falling back to text', { status: photoResp.status, error: errBody.slice(0, 200) });
      }
    } catch (err) {
      log('Facebook photo post error, falling back to text', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  const params = new URLSearchParams({
    message: plainText || ' ',
    access_token: accessToken,
  });
  const response = await fetch(`${FB_API_BASE}/${pageId}/feed`, {
    method: 'POST',
    body: params,
  });
  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Facebook API error ${response.status}: ${errBody.slice(0, 300)}`);
  }
  return response.json();
};

const waitForInstagramMedia = async (creationId, accessToken, maxWaitMs = 90000) => {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await sleep(4000);
    const resp = await fetch(
      `${FB_API_BASE}/${creationId}?fields=status_code&access_token=${encodeURIComponent(accessToken)}`,
    );
    if (!resp.ok) continue;
    const { status_code: statusCode } = await resp.json();
    if (statusCode === 'FINISHED') return;
    if (statusCode === 'ERROR') throw new Error('Instagram media processing failed');
  }
  throw new Error('Instagram media processing timeout (90s)');
};

const sendToInstagram = async (destination, text, telegramMessage) => {
  const accessToken = resolveFacebookAccessToken(destination);
  const igUserId = destination.ig_user_id;
  const plainText = markdownToPlainText(text);

  const hasPhoto = telegramMessage && Array.isArray(telegramMessage.photo) && telegramMessage.photo.length > 0;
  const hasVideo = telegramMessage && (telegramMessage.video || telegramMessage.animation);

  if (!hasPhoto && !hasVideo) {
    log('Instagram: skipping — feed requires media (text-only not supported)', {
      ig_user_id: igUserId,
    });
    return null;
  }

  let mediaType;
  let mediaUrl;

  if (hasPhoto) {
    const bestPhoto = telegramMessage.photo[telegramMessage.photo.length - 1];
    const location = await tgResolveFileLocation(bestPhoto.file_id);
    if (location.type !== 'url') throw new Error('Instagram: photo must be publicly accessible via URL (local file unsupported)');
    mediaType = 'IMAGE';
    mediaUrl = location.value;
  } else {
    const fileId = (telegramMessage.video || telegramMessage.animation).file_id;
    const location = await tgResolveFileLocation(fileId);
    if (location.type !== 'url') throw new Error('Instagram: video must be publicly accessible via URL (local file unsupported)');
    mediaType = 'REELS';
    mediaUrl = location.value;
  }

  const createParams = new URLSearchParams({ caption: plainText || '', access_token: accessToken });
  if (mediaType === 'IMAGE') {
    createParams.set('image_url', mediaUrl);
  } else {
    createParams.set('media_type', 'REELS');
    createParams.set('video_url', mediaUrl);
  }

  const createResp = await fetch(`${FB_API_BASE}/${igUserId}/media`, {
    method: 'POST',
    body: createParams,
  });
  if (!createResp.ok) {
    const errBody = await createResp.text();
    throw new Error(`Instagram create media error ${createResp.status}: ${errBody.slice(0, 300)}`);
  }
  const { id: creationId } = await createResp.json();

  if (mediaType === 'REELS') {
    await waitForInstagramMedia(creationId, accessToken);
  }

  const publishParams = new URLSearchParams({ creation_id: creationId, access_token: accessToken });
  const publishResp = await fetch(`${FB_API_BASE}/${igUserId}/media_publish`, {
    method: 'POST',
    body: publishParams,
  });
  if (!publishResp.ok) {
    const errBody = await publishResp.text();
    throw new Error(`Instagram publish error ${publishResp.status}: ${errBody.slice(0, 300)}`);
  }

  log('Posted to Instagram', { ig_user_id: igUserId, media_type: mediaType });
  return publishResp.json();
};

// ── YouTube destination ──────────────────────────────────────────────────────

const YOUTUBE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const YOUTUBE_UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';

const resolveYouTubeConfig = (destination) => ({
  clientId: process.env[destination.client_id_env || 'YOUTUBE_CLIENT_ID'],
  clientSecret: process.env[destination.client_secret_env || 'YOUTUBE_CLIENT_SECRET'],
  refreshToken: process.env[destination.refresh_token_env || 'YOUTUBE_REFRESH_TOKEN'],
});

const refreshYouTubeAccessToken = async ({ clientId, clientSecret, refreshToken }) => {
  const resp = await fetch(YOUTUBE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`YouTube token refresh failed ${resp.status}: ${err.slice(0, 200)}`);
  }
  const { access_token: accessToken } = await resp.json();
  return accessToken;
};

const isYouTubeShorts = (video, destination) => {
  if (!video) return false;
  const maxDuration = typeof destination.shorts_max_duration_s === 'number'
    ? destination.shorts_max_duration_s : 60;
  const isShort = typeof video.duration === 'number' && video.duration <= maxDuration;
  const isVertical = destination.shorts_for_vertical !== false
    && typeof video.width === 'number' && typeof video.height === 'number'
    && video.height > video.width;
  return isShort && isVertical;
};

const uploadToYouTube = async (accessToken, { title, description, categoryId, privacyStatus, filePath, mime }) => {
  const fileBuffer = fs.readFileSync(filePath);
  const contentType = mime || 'video/mp4';

  const initResp = await fetch(
    `${YOUTUBE_UPLOAD_URL}?uploadType=resumable&part=snippet,status`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': contentType,
        'X-Upload-Content-Length': String(fileBuffer.length),
      },
      body: JSON.stringify({
        snippet: {
          title: truncateText(title || 'Video', 100, '…'),
          description: truncateText(description || '', 5000, '…'),
          categoryId: String(categoryId || 22),
        },
        status: { privacyStatus: privacyStatus || 'public' },
      }),
    },
  );
  if (!initResp.ok) {
    const err = await initResp.text();
    throw new Error(`YouTube upload init failed ${initResp.status}: ${err.slice(0, 300)}`);
  }
  const uploadUrl = initResp.headers.get('location');
  if (!uploadUrl) throw new Error('YouTube: no Location header in upload init response');

  const uploadResp = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType, 'Content-Length': String(fileBuffer.length) },
    body: fileBuffer,
  });
  if (!uploadResp.ok && uploadResp.status !== 201) {
    const err = await uploadResp.text();
    throw new Error(`YouTube upload failed ${uploadResp.status}: ${err.slice(0, 300)}`);
  }
  return uploadResp.json();
};

const sendToYouTube = async (destination, text, telegramMessage) => {
  const video = telegramMessage?.video || telegramMessage?.animation;
  if (!video) {
    log('YouTube: skipping — message has no video', { network: 'youtube' });
    return null;
  }

  const ytConfig = resolveYouTubeConfig(destination);
  const accessToken = await refreshYouTubeAccessToken(ytConfig);
  const location = await tgResolveFileLocation(video.file_id);

  const plainText = markdownToPlainText(text);
  const shorts = isYouTubeShorts(video, destination);
  const shortsTag = shorts ? ' #Shorts' : '';
  const firstLine = plainText ? plainText.split('\n')[0] : '';
  const title = truncateText(firstLine || 'Video', 100 - shortsTag.length, '…') + shortsTag;
  const description = shorts ? `#Shorts\n\n${plainText}` : plainText;

  let tmpFile = null;
  try {
    const source = location.type === 'source'
      ? location.value
      : (tmpFile = await downloadUrlToTempFile(location.value, video.mime_type || 'video/mp4'));

    const result = await uploadToYouTube(accessToken, {
      title,
      description,
      categoryId: destination.category_id || 22,
      privacyStatus: destination.privacy_status || 'public',
      filePath: source,
      mime: video.mime_type || 'video/mp4',
    });

    log('Posted to YouTube', { video_id: result.id, is_shorts: shorts });
    return result;
  } finally {
    if (tmpFile) {
      activeTempFiles.delete(tmpFile);
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }
};

// ── VK destination ───────────────────────────────────────────────────────────

const VK_API_BASE = 'https://api.vk.com/method';
const VK_API_VERSION = '5.199';

const resolveVkAccessToken = (destination) => {
  if (typeof destination.access_token === 'string' && destination.access_token.length > 0) {
    return destination.access_token;
  }
  const token = process.env[destination.access_token_env];
  if (!token) throw new Error(`VK access token env var "${destination.access_token_env}" is not set`);
  return token;
};

const vkApiCall = async (method, params) => {
  const body = new URLSearchParams({ ...params, v: VK_API_VERSION });
  const resp = await fetch(`${VK_API_BASE}/${method}`, { method: 'POST', body });
  if (!resp.ok) throw new Error(`VK API HTTP ${resp.status} on ${method}`);
  const data = await resp.json();
  if (data.error) throw new Error(`VK API error ${data.error.error_code}: ${data.error.error_msg}`);
  return data.response;
};

const isVkClip = (video, destination) => {
  if (!video) return false;
  const maxDuration = typeof destination.clips_max_duration_s === 'number'
    ? destination.clips_max_duration_s : 60;
  const isShort = typeof video.duration === 'number' && video.duration <= maxDuration;
  const isVertical = destination.clips_for_vertical !== false
    && typeof video.width === 'number' && typeof video.height === 'number'
    && video.height > video.width;
  return isShort && isVertical;
};

const uploadVideoToVk = async (accessToken, ownerId, { filePath, mime, title, description, isClip }) => {
  const saveParams = {
    access_token: accessToken,
    owner_id: ownerId,
    name: truncateText(title || 'Video', 255, '…'),
    description: truncateText(description || '', 5000, '…'),
  };
  if (isClip) saveParams.is_reels = 1;

  const saveResp = await vkApiCall('video.save', saveParams);
  const { upload_url: uploadUrl, video_id: videoId, owner_id: videoOwnerId } = saveResp;

  const fileBuffer = fs.readFileSync(filePath);
  const formData = new FormData();
  formData.append('video_file', new Blob([fileBuffer], { type: mime || 'video/mp4' }), 'video.mp4');

  const uploadResp = await fetch(uploadUrl, { method: 'POST', body: formData });
  if (!uploadResp.ok) {
    const err = await uploadResp.text();
    throw new Error(`VK video upload failed ${uploadResp.status}: ${err.slice(0, 200)}`);
  }
  return { videoId, videoOwnerId };
};

const uploadPhotoToVkWall = async (accessToken, ownerId, filePath) => {
  const groupId = ownerId < 0 ? -ownerId : undefined;
  const serverParams = { access_token: accessToken };
  if (groupId) serverParams.group_id = groupId;

  const server = await vkApiCall('photos.getWallUploadServer', serverParams);

  const fileBuffer = fs.readFileSync(filePath);
  const formData = new FormData();
  formData.append('photo', new Blob([fileBuffer], { type: 'image/jpeg' }), 'photo.jpg');

  const uploadResp = await fetch(server.upload_url, { method: 'POST', body: formData });
  if (!uploadResp.ok) throw new Error(`VK photo upload HTTP ${uploadResp.status}`);
  const uploadData = await uploadResp.json();

  const saveParams = {
    access_token: accessToken,
    server: uploadData.server,
    photo: uploadData.photo,
    hash: uploadData.hash,
  };
  if (groupId) saveParams.group_id = groupId;

  const saved = await vkApiCall('photos.saveWallPhoto', saveParams);
  const photo = saved[0];
  return { photoId: photo.id, photoOwnerId: photo.owner_id };
};

const sendToVk = async (destination, text, telegramMessage) => {
  const accessToken = resolveVkAccessToken(destination);
  const ownerId = destination.owner_id;
  const plainText = markdownToPlainText(text);

  const video = telegramMessage?.video || telegramMessage?.animation;
  const hasPhoto = telegramMessage && Array.isArray(telegramMessage.photo) && telegramMessage.photo.length > 0;

  let attachment = '';
  let tmpFile = null;

  try {
    if (video) {
      const location = await tgResolveFileLocation(video.file_id);
      const source = location.type === 'source'
        ? location.value
        : (tmpFile = await downloadUrlToTempFile(location.value, video.mime_type || 'video/mp4'));

      const clip = isVkClip(video, destination);
      const firstLine = plainText ? plainText.split('\n')[0] : '';
      const { videoId, videoOwnerId } = await uploadVideoToVk(accessToken, ownerId, {
        filePath: source,
        mime: video.mime_type,
        title: firstLine || 'Video',
        description: plainText || '',
        isClip: clip,
      });
      attachment = `video${videoOwnerId}_${videoId}`;
      log('VK video uploaded', { owner_id: videoOwnerId, video_id: videoId, is_clip: clip });

    } else if (hasPhoto) {
      const bestPhoto = telegramMessage.photo[telegramMessage.photo.length - 1];
      const location = await tgResolveFileLocation(bestPhoto.file_id);
      const source = location.type === 'source'
        ? location.value
        : (tmpFile = await downloadUrlToTempFile(location.value, 'image/jpeg'));

      const { photoId, photoOwnerId } = await uploadPhotoToVkWall(accessToken, ownerId, source);
      attachment = `photo${photoOwnerId}_${photoId}`;
      log('VK photo uploaded', { owner_id: photoOwnerId, photo_id: photoId });
    }

    const postParams = {
      access_token: accessToken,
      owner_id: ownerId,
      message: plainText || '',
      from_group: ownerId < 0 ? 1 : 0,
    };
    if (attachment) postParams.attachments = attachment;

    const postResult = await vkApiCall('wall.post', postParams);
    log('Posted to VK', { owner_id: ownerId, post_id: postResult.post_id });
    return postResult;
  } finally {
    if (tmpFile) {
      activeTempFiles.delete(tmpFile);
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }
};

const sendToDestination = async (destination, text, attachments, meta = {}) => {
  if (destination.network === 'max') {
    const payload = { format: 'markdown' };
    if (attachments && attachments.length) payload.attachments = attachments;
    const safeText = text || ' ';

    if (typeof destination.chat_id === 'number') {
      return maxBot.api.sendMessageToChat(destination.chat_id, safeText, payload);
    }
    return maxBot.api.sendMessageToUser(destination.user_id, safeText, payload);
  }

  if (destination.network === 'telegram') {
    const safeText = markdownToTelegramHtml(text) || ' ';
    return telegram.sendMessage(destination.chat_id, safeText, { parse_mode: 'HTML' });
  }

  if (destination.network === 'facebook') {
    return sendToFacebook(destination, text, meta.telegramMessage || null);
  }

  if (destination.network === 'instagram') {
    return sendToInstagram(destination, text, meta.telegramMessage || null);
  }

  if (destination.network === 'youtube') {
    return sendToYouTube(destination, text, meta.telegramMessage || null);
  }

  if (destination.network === 'vk') {
    return sendToVk(destination, text, meta.telegramMessage || null);
  }

  throw new Error(`Unsupported destination network: ${destination.network}`);
};

const sendToRouteDestinations = async (route, text, attachments, meta = {}) => {
  for (const destination of route.destinations) {
    await sendToDestination(destination, text, attachments, meta);
  }
};

const enqueueSingle = (route, message) => {
  state.queue.push({
    kind: 'telegram_single',
    route,
    runAt: Date.now() + getRouteDelayMs(route),
    message,
  });
  void processQueue();
};

const enqueueMediaGroup = (route, messages) => {
  state.queue.push({
    kind: 'telegram_group',
    route,
    runAt: Date.now() + getRouteDelayMs(route),
    messages,
  });
  void processQueue();
};

const enqueueMaxMessage = (route, payload) => {
  state.queue.push({
    kind: 'max_single',
    route,
    runAt: Date.now() + getRouteDelayMs(route),
    payload,
  });
  void processQueue();
};

const enqueueApiMessage = (route, payload) => {
  state.queue.push({
    kind: 'api_single',
    route,
    runAt: Date.now() + getRouteDelayMs(route),
    payload,
  });
  void processQueue();
};

const collectMediaGroup = (route, message) => {
  const key = `${route.id}:${message.chat.id}:${message.media_group_id}`;
  const existing = state.mediaGroupBuffer.get(key) || {
    messages: [],
    timer: null,
  };

  if (!existing.messages.some((item) => item.message_id === message.message_id)) {
    existing.messages.push(message);
  }

  if (existing.timer) clearTimeout(existing.timer);
  existing.timer = setTimeout(() => {
    state.mediaGroupBuffer.delete(key);
    const ordered = [...existing.messages].sort((a, b) => a.message_id - b.message_id);
    enqueueMediaGroup(route, ordered);
  }, getRouteMediaGroupCollectMs(route));

  state.mediaGroupBuffer.set(key, existing);
};

const forwardTelegramSingle = async (route, message) => {
  const { attachments, warningText } = await buildAttachmentsFromTelegram(message);
  const text = getTelegramMessageText(message, route, warningText);

  await sendToRouteDestinations(route, text, attachments, { telegramMessage: message });

  log('Reposted telegram message', {
    route_id: route.id,
    telegram_chat_id: message.chat.id,
    telegram_message_id: message.message_id,
    attachments: attachments.length,
  });
};

const forwardTelegramGroup = async (route, messages) => {
  const ordered = [...messages].sort((a, b) => a.message_id - b.message_id);
  const anchor = ordered.find((item) => extractTextAndEntities(item).text) || ordered[0];

  const attachments = [];
  const warningSet = new Set();

  for (const message of ordered) {
    const built = await buildAttachmentsFromTelegram(message);
    attachments.push(...built.attachments);
    if (built.warningText) warningSet.add(built.warningText);
  }

  const warningText = warningSet.size ? Array.from(warningSet).join('\n') : '';
  const text = getTelegramMessageText(anchor, route, warningText);

  await sendToRouteDestinations(route, text, attachments, { telegramMessage: anchor });

  log('Reposted telegram media_group', {
    route_id: route.id,
    telegram_chat_id: anchor.chat.id,
    telegram_media_group_id: anchor.media_group_id,
    telegram_messages: ordered.length,
    attachments: attachments.length,
  });
};

const forwardMaxSingle = async (route, payload) => {
  const text = payload.text ? String(payload.text) : '';
  await sendToRouteDestinations(route, text, []);

  log('Reposted max message', {
    route_id: route.id,
    max_chat_id: payload.chatId,
    max_message_id: payload.mid,
  });
};

const forwardApiSingle = async (route, payload) => {
  const text = payload.text ? String(payload.text) : '';
  await sendToRouteDestinations(route, text, []);
  log('Reposted API message', { route_id: route.id });
};

const processQueue = async () => {
  if (state.queueBusy) return;
  state.queueBusy = true;

  try {
    while (state.queue.length) {
      state.queue.sort((a, b) => a.runAt - b.runAt);
      const next = state.queue[0];
      const waitMs = Math.max(0, next.runAt - Date.now());
      if (waitMs > 0) {
        await sleep(waitMs);
      }

      state.queue.shift();

      try {
        if (next.kind === 'telegram_single') {
          await forwardTelegramSingle(next.route, next.message);
        } else if (next.kind === 'telegram_group') {
          await forwardTelegramGroup(next.route, next.messages);
        } else if (next.kind === 'max_single') {
          await forwardMaxSingle(next.route, next.payload);
        } else if (next.kind === 'api_single') {
          await forwardApiSingle(next.route, next.payload);
        }
      } catch (err) {
        log('Failed to process queue item', {
          route_id: next.route?.id,
          kind: next.kind,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    state.queueBusy = false;
  }
};

const logDroppedTelegramMessage = (message) => {
  const key = `${message.chat.id}`;
  const now = Date.now();
  const last = state.droppedSourceLogs.get(key) || 0;
  if (now - last < 60_000) return;
  state.droppedSourceLogs.set(key, now);

  log('Ignored telegram message from untrusted source chat', {
    telegram_chat_id: message.chat.id,
    telegram_chat_username: message.chat.username || null,
    telegram_message_id: message.message_id,
  });
};

const onTelegramMessage = (message) => {
  if (message.chat) _discoveredChats.persist(message.chat);

  const routes = findTelegramRoutes(message);
  if (!routes.length) {
    logDroppedTelegramMessage(message);
    return;
  }

  for (const route of routes) {
    if (message.media_group_id) {
      collectMediaGroup(route, message);
    } else {
      enqueueSingle(route, message);
    }
  }
};

/** Plain text for MAX slash-commands (same rules as @maxhub/max-bot-api Composer.command). */
const maxPlainTextForSlashCommand = (maxMessage) => {
  const raw = maxMessage.body?.text;
  if (typeof raw !== 'string') return '';
  const myId = state.maxBotUserId;
  const mention = maxMessage.body.markup?.find((m) => m.type === 'user_mention');
  if (mention && mention.from === 0 && myId != null && mention.user_id === myId) {
    return raw.slice(mention.length).trim();
  }
  return raw.trim();
};

const isMaxChatIdCommand = (plain) => plain === '/chatid'
  || plain.startsWith('/chatid ')
  || plain.startsWith('/chatid@');

/** Prefer ctx.chatId; fallback to recipient (some payloads differ). */
const resolveMaxChatId = (ctx, maxMessage) => {
  const fromCtx = ctx.chatId;
  if (typeof fromCtx === 'number' && Number.isFinite(fromCtx)) return fromCtx;
  const r = maxMessage?.recipient?.chat_id;
  if (typeof r === 'number' && Number.isFinite(r)) return r;
  return undefined;
};

const sendMaxChatIdReply = (chatId, label) => {
  const reply = `Chat ID: \`${chatId}\``;
  return maxBot.api.sendMessageToChat(chatId, reply, { format: 'markdown' }).catch((err) => {
    log(`${label} reply failed`, { error: err instanceof Error ? err.message : String(err), chatId });
  });
};

/** Fires when the bot is added to a chat — gives chat_id without relying on /chatid. */
const onMaxBotAdded = (ctx) => {
  const chatId = ctx.chatId;
  if (typeof chatId !== 'number' || !Number.isFinite(chatId)) {
    log('MAX bot_added: missing chat_id on update', { update_type: ctx.updateType });
    return;
  }
  void sendMaxChatIdReply(chatId, 'MAX bot_added chat id');
};

const onMaxMessage = (ctx) => {
  const maxMessage = ctx.message;
  if (!maxMessage) return;

  if (state.maxBotUserId && maxMessage.sender?.user_id === state.maxBotUserId) {
    return;
  }

  const commandPlain = maxPlainTextForSlashCommand(maxMessage);
  if (isMaxChatIdCommand(commandPlain)) {
    const id = resolveMaxChatId(ctx, maxMessage);
    if (id === undefined) {
      log('MAX /chatid: could not resolve chat_id', {
        has_recipient: Boolean(maxMessage.recipient),
        recipient_chat_id: maxMessage.recipient?.chat_id,
        ctx_chatId: ctx.chatId,
      });
      return;
    }
    void sendMaxChatIdReply(id, 'MAX /chatid');
    return;
  }

  const maxChatId = resolveMaxChatId(ctx, maxMessage);
  if (maxChatId === undefined) return;

  const text = maxMessage.body?.text || '';
  const routes = findMaxRoutes(maxChatId);
  if (!routes.length) return;

  const payload = {
    chatId: maxChatId,
    mid: maxMessage.body?.mid,
    text,
  };

  for (const route of routes) {
    enqueueMaxMessage(route, payload);
  }
};

// ---------------------------------------------------------------------------
// API HTTP server — receives messages from external sources
// ---------------------------------------------------------------------------

const handleApiRequest = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }

  if (req.method !== 'POST' || req.url !== '/api/message') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  const authHeader = req.headers.authorization || '';
  const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!tokenMatch) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing or invalid Authorization header' }));
    return;
  }

  const apiKey = tokenMatch[1];
  const routes = findApiRoutes(apiKey);
  if (!routes.length) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid API key' }));
    return;
  }

  let body = '';
  for await (const chunk of req) body += chunk;

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    return;
  }

  if (!payload.text || typeof payload.text !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing required field: text' }));
    return;
  }

  for (const route of routes) {
    enqueueApiMessage(route, payload);
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, routes_matched: routes.length }));
  log('API message received', { routes_matched: routes.length });
};

const bootstrap = async () => {
  cleanStaleTempFiles();
  setInterval(cleanStaleTempFiles, 15 * 60 * 1000).unref();

  await initMtprotoClient().catch((err) => {
    log('MTProto init failed (non-fatal, large videos will show warning)', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  const [tgMe, maxMe] = await Promise.all([
    telegram.getMe(),
    maxBot.api.getMyInfo(),
  ]);

  state.maxBotUserId = maxMe.user_id;

  const enabledRoutes = getEnabledRoutes();
  log('Bridge started', {
    telegram_bot: tgMe.username,
    max_bot_id: maxMe.user_id,
    routes_total: routingConfig.routes.length,
    routes_enabled: enabledRoutes.length,
    routing_config_path: appConfig.routingConfigPath,
  });

  const routeSummary = enabledRoutes.map((route) => ({
    id: route.id,
    source: route.source,
    destinations: route.destinations,
  }));
  log('Enabled routes', { routes: routeSummary });

  const handleChatIdCommand = (message) => {
    if (message.text === '/chatid' || message.text?.startsWith('/chatid@')) {
      const reply = `Chat ID: \`${message.chat.id}\`\nTitle: ${message.chat.title || '—'}\nType: ${message.chat.type}`;
      telegram.sendMessage(message.chat.id, reply, { parse_mode: 'Markdown' }).catch(() => {});
      return true;
    }
    return false;
  };

  telegram.on('message', (message) => {
    handleChatIdCommand(message);
    onTelegramMessage(message);
  });
  telegram.on('channel_post', (message) => {
    handleChatIdCommand(message);
    onTelegramMessage(message);
  });
  telegram.on('polling_error', (err) => {
    log('Telegram polling error', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  maxBot.on('message_created', onMaxMessage);
  maxBot.on('bot_added', onMaxBotAdded);
  maxBot.catch((err, ctx) => {
    log('MAX polling handler error', {
      error: err instanceof Error ? err.message : String(err),
      update_type: ctx?.updateType,
    });
  });

  log(
    'MAX: using long polling. If /chatid never reacts, remove Webhook for this bot in '
    + 'MAX (business.max.ru) — Webhook and long polling cannot be used together.',
  );

  const maxAllowedUpdates = (process.env.MAX_ALLOWED_UPDATES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allowedUpdates = maxAllowedUpdates.length
    ? maxAllowedUpdates
    : ['message_created', 'message_edited', 'bot_added', 'bot_started', 'message_callback'];

  const startMaxPolling = async () => {
    const MAX_POLLING_RESTART_DELAY_MS = 3000;
    while (true) {
      try {
        await maxBot.start({ allowedUpdates });
        // start() resolved — polling loop exited (SDK bug: returns on transient errors)
        log('MAX polling loop exited unexpectedly, restarting...');
      } catch (err) {
        log('MAX polling error', { error: err instanceof Error ? err.message : String(err) });
      }
      maxBot.stop();
      await sleep(MAX_POLLING_RESTART_DELAY_MS);
    }
  };

  void startMaxPolling();

  log('MAX listener started', { allowedUpdates });

  const apiRoutes = getEnabledRoutes().filter((r) => r.source.network === 'api');
  const adminEnabled = Boolean(appConfig.adminPassword);

  const adminHandler = adminEnabled
    ? createAdminHandler({
      adminPassword: appConfig.adminPassword,
      routingConfigPath: appConfig.routingConfigPath,
      getRoutingConfig: () => routingConfig,
      reloadRoutingConfig,
      log,
    })
    : null;

  if (apiRoutes.length > 0 || adminEnabled) {
    const server = http.createServer((req, res) => {
      let pathname = '/';
      try {
        pathname = new URL(req.url || '/', 'http://localhost').pathname;
      } catch {
        pathname = req.url || '/';
      }

      if (adminHandler && pathname.startsWith('/admin')) {
        adminHandler.handle(req, res, pathname).catch((err) => {
          log('Admin handler error', { error: err instanceof Error ? err.message : String(err) });
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
          }
        });
        return;
      }

      handleApiRequest(req, res).catch((err) => {
        log('API handler error', { error: err instanceof Error ? err.message : String(err) });
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      });
    });

    server.listen(appConfig.apiPort, () => {
      log('HTTP server listening', {
        port: appConfig.apiPort,
        api_routes: apiRoutes.length,
        admin_enabled: adminEnabled,
      });
    });
  }
};

const cleanupAndExit = (signal) => {
  if (activeTempFiles.size) {
    log(`${signal}: cleaning up ${activeTempFiles.size} temp file(s)`);
    for (const file of activeTempFiles) {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
    }
  }
  process.exit(0);
};

process.on('SIGINT', () => cleanupAndExit('SIGINT'));
process.on('SIGTERM', () => cleanupAndExit('SIGTERM'));

bootstrap().catch((err) => {
  log('Fatal startup error', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
