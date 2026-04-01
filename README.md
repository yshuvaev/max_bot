# Telegram / API → MAX Bridge Bot

**[Русский](README.ru.md)** | English

A lightweight Node.js bridge that automatically reposts messages from **Telegram** channels/groups and **external API sources** to **MAX** (max.ru) and **Telegram** channels, including text formatting, images, videos, audio, and file attachments.

---

## Features

- **Text** — Telegram markdown entities (bold, italic, links, code, …) converted to MAX markdown
- **Images** — forwarded via MAX upload API
- **Video / Audio / Files** — downloaded from Telegram and uploaded to MAX
- **Large videos (> 20 MB)** — downloaded via MTProto (requires optional `TELEGRAM_API_ID` / `TELEGRAM_API_HASH`)
- **Media albums** — Telegram `media_group` arrives as a single MAX message with multiple attachments
- **Source footer** — optional "tg: [Channel](link)" footer on every reposted message
- **Multiple routes** — fan-out from one source to many destinations, or many independent routes
- **API ingest** — accept messages from external sources via authenticated HTTP endpoint (`POST /api/message`)
- **Queue with delay** — configurable per-route repost delay to avoid rate limits
- **Groups & supergroups** — works with Telegram channels, groups, and supergroups as sources

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js ≥ 18.18 | |
| A **Telegram Bot** | [@BotFather](https://t.me/BotFather) — must be added as **admin** to each source channel/group |
| A **MAX Bot** | [MAX developer portal](https://dev.max.ru) — must be added as **admin** to each destination channel |
| A Linux server | For production (the deploy script uses SSH + PM2) |
| `sshpass` on your local machine | Only if deploying with password auth — `brew install sshpass` / `apt install sshpass` |

---

## Quick start

### 1. Clone and install

```bash
git clone https://github.com/your-org/max_bot.git
cd max_bot
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

### 3. Add bots to chats

- Add your **Telegram bot** as **admin** to every Telegram source channel/group.
- Add your **MAX bot** as **admin** to every MAX destination channel.

### 4. Deploy

```bash
./scripts/deploy.sh
```

If `config/routes.json` does not exist yet, the script calls `./bridge.sh` automatically to discover channels and generate routes.

---

## Environment variables

```dotenv
# ── Required ────────────────────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN=1234567890:AAXXXXXX
MAX_BOT_TOKEN=your_max_token_here

# ── Deployment (required for deploy.sh) ─────────────────────────────────────
REMOTE_HOST=1.2.3.4
REMOTE_USER=root
REMOTE_PASSWORD=secret          # leave empty to use SSH key auth

# ── Optional – MTProto (for large video > 20 MB) ─────────────────────────────
TELEGRAM_API_ID=
TELEGRAM_API_HASH=

# ── Optional – API ingest endpoint ───────────────────────────────────────────
# API_PORT=3000                          # HTTP server port (started automatically)
# API_KEY_MY_ROUTE=<random-secret>       # Bearer token for a route with api_key_env="API_KEY_MY_ROUTE"

# ── Optional – advanced ──────────────────────────────────────────────────────
# TELEGRAM_API_BASE_URL=https://api.telegram.org
# ROUTING_CONFIG_PATH=config/routes.json
# DEFAULT_REPOST_DELAY_MS=3000
# DEFAULT_MEDIA_GROUP_COLLECT_MS=1200
# DEFAULT_INCLUDE_TELEGRAM_FOOTER=true

# ── Optional – temp-file overflow protection ─────────────────────────────────
# TEMP_MIN_FREE_MB=1000
```

---

## Routing config

Routes live in `config/routes.json` (gitignored — generated per deployment).

```jsonc
{
  "routes": [
    {
      "id": "my_route",
      "enabled": true,
      "source": {
        "network": "telegram",
        "chat_id": -1001234567890,
        "chat_username": "mychannel"     // optional fallback
      },
      "destinations": [
        { "network": "max", "chat_id": -70999000000000 }
      ],
      "options": {
        "repost_delay_ms": 3000,
        "media_group_collect_ms": 1200,
        "include_telegram_footer": true
      }
    }
  ]
}
```

### API source

To accept messages from external systems (CI/CD, monitoring, other bots), use `"network": "api"`:

```jsonc
{
  "id": "alerts_to_max",
  "enabled": true,
  "source": {
    "network": "api",
    "api_key_env": "API_KEY_ALERTS"   // name of the env var holding the Bearer token
  },
  "destinations": [
    { "network": "max", "chat_id": -70999000000000 },
    { "network": "telegram", "chat_id": -1001234567890 }
  ],
  "options": { "repost_delay_ms": 0 }
}
```

The HTTP server starts automatically when at least one API route is present. Send messages with:

```bash
curl -X POST http://your-server:3000/api/message \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY_ALERTS" \
  -d '{"text": "**Alert:** deploy finished"}'
```

Text supports markdown: `**bold**`, `_italic_`, `` `code` ``, `~~strike~~`, `[link](url)`, and fenced code blocks.

---

## Managing bridges

### `/chatid` command

Send `/chatid` in any Telegram chat or MAX channel where the bot is present — it replies with the numeric chat ID, title, and type. Useful for manual pairing.

### Add a new bridge automatically

1. Send any message in the new Telegram group/channel — the bot records it in `config/discovered-chats.json`.
2. Run:

```bash
npm run bridge:discover
./scripts/deploy.sh
```

`bridge:discover` reads the known-chats registry, queries MAX API for channel list, and appends only **new unpaired** combinations to `routes.json`. Existing routes are untouched.

### Add a new bridge manually by ID

```bash
npm run bridge:pair -- --tg-chat-id=-1001234567890 --max-chat-id=-70999000000000
./scripts/deploy.sh
```

### Regenerate all routes from scratch

```bash
./bridge.sh --force
./scripts/deploy.sh
```

> **Note:** while the main bot is running it consumes `getUpdates`, so `bridge:discover` falls back to the local registry. Use `bridge:pair` if you already know both chat IDs.

---

## npm scripts

| Script | Description |
|---|---|
| `npm start` | Start the bridge locally |
| `npm run bridge` | Generate `routes.json` from scratch (skips if file exists) |
| `npm run bridge:discover` | Add routes for new unpaired TG+MAX chats (non-destructive) |
| `npm run bridge:pair -- --tg-chat-id=X --max-chat-id=Y` | Manually add a single bridge pair by ID |

---

## Deployment

`scripts/deploy.sh` uploads files via SCP and restarts PM2 on the remote server:

```bash
./scripts/deploy.sh
```

Monitor logs:

```bash
source .env
sshpass -p "$REMOTE_PASSWORD" ssh "$REMOTE_USER@$REMOTE_HOST" "pm2 logs max-repost-bot --lines 50"
```

---

## Large video support (MTProto)

The public Telegram Bot API limits downloads to **20 MB**. To bridge larger videos:

1. Go to [https://my.telegram.org/apps](https://my.telegram.org/apps) and create an app.
2. Add `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` to `.env`.
3. Deploy — the bridge saves a session to `.mtproto_session` on first run (gitignored).

Without MTProto, videos over 20 MB arrive as a text post with:
> *Вложение из Telegram не скопировано: файл слишком большой для Bot API.*

---

## Temp-file overflow protection

When bridging media the bot downloads files to `os.tmpdir()` before uploading to MAX. Three mechanisms prevent disk exhaustion:

| Mechanism | Behaviour |
|---|---|
| **Pre-flight disk check** | Before every download the bridge checks free space in `os.tmpdir()`. If less than `TEMP_MIN_FREE_MB` (default 1000 MB) is available, the download is rejected with an error. Requires Node.js ≥ 19.6; silently skipped on older versions. |
| **Active-file registry** | Every temp file is registered in an in-memory Set the moment its path is created and removed immediately after the upload completes (in a `finally` block). Both the cron sweeper and the shutdown hook use this Set to avoid touching files that are currently in use. |
| **Cron sweeper** | On startup and every 15 minutes the bridge scans `os.tmpdir()` for `tg_bridge_*` files older than 30 minutes that are **not** in the active registry and deletes them. This recovers space from files left behind by a previous unclean shutdown. |
| **SIGTERM / SIGINT cleanup** | When the process receives a shutdown signal it deletes every file still in the active registry (in-flight transfers are aborted anyway) before exiting. |

Tune the threshold in `.env`:

```dotenv
TEMP_MIN_FREE_MB=1000   # default; set higher on space-constrained servers
```

---

## Security

- Messages are only reposted from sources **explicitly listed** in `routes.json`.
- Messages from unlisted chats are silently ignored.

---

## Project structure

```
├── src/
│   └── index.js              # Main bridge runtime
├── scripts/
│   ├── bridge-init.js        # Discovery, config generator, manual pair tool
│   └── deploy.sh             # SSH deploy script
├── config/
│   ├── routes.json           # Routing config (gitignored)
│   └── discovered-chats.json # Registry of seen TG chats (gitignored)
├── ecosystem.config.js       # PM2 config
├── bridge.sh                 # Runs bridge-init.js
└── .env                      # Secrets (gitignored)
```

---

## License

MIT
