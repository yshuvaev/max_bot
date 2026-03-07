'use strict';

require('dotenv').config();

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TelegramBot = require('node-telegram-bot-api');
const { Bot: MaxBot } = require('@maxhub/max-bot-api');

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
  defaultRepostDelayMs: parseIntEnv('DEFAULT_REPOST_DELAY_MS', 3000),
  defaultMediaGroupCollectMs: parseIntEnv('DEFAULT_MEDIA_GROUP_COLLECT_MS', 1200),
  defaultIncludeTelegramFooter: parseBooleanEnv('DEFAULT_INCLUDE_TELEGRAM_FOOTER', true),
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

  return {
    id,
    enabled: route.enabled !== false,
    source: route.source,
    destinations: route.destinations,
    options: route.options || {},
  };
};

const loadRoutingConfig = (configPath) => {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Routing config not found: ${configPath}`);
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw);

  assert(Array.isArray(parsed.routes), 'Routing config must include routes[]');

  const routes = parsed.routes.map((route, index) => validateRoute(route, index));
  return {
    routes,
  };
};

const routingConfig = loadRoutingConfig(appConfig.routingConfigPath);

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

const state = {
  queue: [],
  queueBusy: false,
  mediaGroupBuffer: new Map(),
  maxBotUserId: null,
  droppedSourceLogs: new Map(),
};

let mtprotoClient = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const getTelegramMessageText = (message, route, warningText = '') => {
  const own = extractTextAndEntities(message);
  const repostSource = chooseTextSource(message);
  const repost = repostSource === message ? { text: '', entities: [] } : extractTextAndEntities(repostSource);
  const footer = getTelegramFooter(message, route);

  const parts = [];
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
  const tmpFile = path.join(
    os.tmpdir(),
    `tg_bridge_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`,
  );

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
      try { fs.unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
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
  const tmpFile = path.join(
    os.tmpdir(),
    `tg_bridge_dl_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`,
  );
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
        try { fs.unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
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

const sendToDestination = async (destination, text, attachments) => {
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
    const safeText = text || ' ';
    return telegram.sendMessage(destination.chat_id, safeText);
  }

  throw new Error(`Unsupported destination network: ${destination.network}`);
};

const sendToRouteDestinations = async (route, text, attachments) => {
  for (const destination of route.destinations) {
    await sendToDestination(destination, text, attachments);
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

  await sendToRouteDestinations(route, text, attachments);

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

  await sendToRouteDestinations(route, text, attachments);

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

const onMaxMessage = (ctx) => {
  const maxMessage = ctx.message;
  if (!maxMessage || !ctx.chatId) return;

  if (state.maxBotUserId && maxMessage.sender?.user_id === state.maxBotUserId) {
    return;
  }

  const routes = findMaxRoutes(ctx.chatId);
  if (!routes.length) return;

  const payload = {
    chatId: ctx.chatId,
    mid: maxMessage.body?.mid,
    text: maxMessage.body?.text || '',
  };

  for (const route of routes) {
    enqueueMaxMessage(route, payload);
  }
};

const bootstrap = async () => {
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

  telegram.on('message', onTelegramMessage);
  telegram.on('channel_post', onTelegramMessage);
  telegram.on('polling_error', (err) => {
    log('Telegram polling error', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  const hasMaxSourceRoutes = enabledRoutes.some((route) => route.source.network === 'max');
  if (hasMaxSourceRoutes) {
    maxBot.on('message_created', onMaxMessage);
    maxBot.catch((err, ctx) => {
      log('MAX polling handler error', {
        error: err instanceof Error ? err.message : String(err),
        update_type: ctx?.updateType,
      });
    });

    void maxBot.start({ allowedUpdates: ['message_created'] }).catch((err) => {
      log('MAX polling startup error', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    log('MAX source listener started');
  }
};

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

bootstrap().catch((err) => {
  log('Fatal startup error', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
