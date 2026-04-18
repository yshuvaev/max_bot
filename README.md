# Telegram / API → MAX / Facebook / Instagram Bridge Bot

**[Русский](README.ru.md)** | English

A lightweight Node.js bridge that automatically reposts messages from **Telegram** channels/groups and **external API sources** to **MAX** (max.ru), **Telegram**, **Facebook Pages**, and **Instagram** business accounts, including text formatting, images, videos, audio, and file attachments.

---

## Features

- **Text** — Telegram markdown entities (bold, italic, links, code, …) converted to MAX markdown
- **Images** — forwarded via MAX upload API; also posted as photos to Facebook / Instagram
- **Video / Audio / Files** — downloaded from Telegram and uploaded to MAX; videos forwarded to Instagram as Reels
- **Large videos (> 20 MB)** — downloaded via MTProto (requires optional `TELEGRAM_API_ID` / `TELEGRAM_API_HASH`)
- **Media albums** — Telegram `media_group` arrives as a single MAX message with multiple attachments
- **Facebook destination** — post text and photos to a Facebook Page via Graph API ([setup guide](docs/facebook.md))
- **Instagram destination** — post photos and Reels to an Instagram Business/Creator account ([setup guide](docs/instagram.md))
- **YouTube destination** — upload videos to YouTube; vertical videos ≤60 s auto-published as Shorts ([setup guide](docs/youtube.md))
- **VK destination** — post text/photos/video to VK community or profile wall; vertical videos ≤60 s auto-uploaded as VK Clips ([setup guide](docs/vk.md))
- **Telegram Stories destination** — post stories to Telegram channels via userbot (MTProto); one-time phone auth, no new app registration ([setup guide](docs/telegram-stories.md))
- **TikTok destination** — publish videos to TikTok feed and stories; `post_type: "video"` or `"story"`; tokens auto-rotated in `.tiktok_tokens.json` ([setup guide](docs/tiktok.md))
- **Smart text truncation** — titles/descriptions cut at sentence → newline → word boundary (never mid-word)
- **Source footer** — optional "tg: [Channel](link)" footer on every reposted message
- **Sender name** — optional bold sender name prefix for group-to-group bridges
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
        "include_telegram_footer": true,
        "include_sender_name": true
      }
    }
  ]
}
```

### Route options

| Option | Type | Default | Description |
|---|---|---|---|
| `repost_delay_ms` | number | `3000` | Delay before reposting (rate-limit protection) |
| `media_group_collect_ms` | number | `1200` | Wait time to collect all parts of a media album |
| `include_telegram_footer` | boolean | `true` | Append "tg: [Channel](link)" footer |
| `include_sender_name` | boolean | `false` | Prepend **sender's name** (bold) to the message — useful for group-to-group bridges where you need to see who wrote the original |

### API source

To accept messages from external systems (CI/CD, monitoring, form
submissions, other bots), use `"network": "api"`. Two ways to hold the
Bearer token:

**Inline** — stored directly in `routes.json` (self-contained, no env
var needed; the CLI auto-generates a secure key for you):

```jsonc
{
  "id": "form_leads_to_tg",
  "enabled": true,
  "source": {
    "network": "api",
    "api_key": "Rv-XnHTYA46euHdNuAs-KbzMAWZfBf60HoSRF7_1QBI"  // >= 16 chars
  },
  "destinations": [
    { "network": "telegram", "chat_id": -5075596986 }
  ]
}
```

**Env var reference** — key lives in `.env`, `routes.json` only stores the
name. Useful if you want secrets separated from config or managed by a
secrets-manager that writes `.env` for you:

```jsonc
{
  "id": "alerts_to_max",
  "enabled": true,
  "source": {
    "network": "api",
    "api_key_env": "API_KEY_ALERTS"   // name of the env var in the bot's .env
  },
  "destinations": [
    { "network": "max", "chat_id": -70999000000000 },
    { "network": "telegram", "chat_id": -1001234567890 }
  ],
  "options": { "repost_delay_ms": 0 }
}
```

The HTTP server starts automatically when at least one API route is
present (or when `ADMIN_PASSWORD` is set). Send messages with:

```bash
curl -X POST http://your-server:3000/api/message \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY_ALERTS" \
  -d '{"text": "**Alert:** deploy finished"}'
```

Text supports markdown: `**bold**`, `_italic_`, `` `code` ``, `~~strike~~`, `[link](url)`, and fenced code blocks.

---

## Bridge CLI (`max-bot-bridge`)

A built-in command-line tool to manage bridging routes **live** without
editing `routes.json` by hand or redeploying. Works against any bot
instance with `ADMIN_PASSWORD` set in its `.env`.

### Enable the admin API

On the **bot server**, add to `.env`:

```dotenv
ADMIN_PASSWORD=<a-long-random-secret>   # leave empty to fully disable the admin API
# API_PORT=3000                          # default; change if :3000 is already taken
```

Restart the bot. When the admin API is enabled, `/admin/*` endpoints are
served on the same HTTP port as the API ingest endpoint (`API_PORT`,
default `3000`).

> ⚠️  **Security.** The admin API speaks plaintext HTTP. Before exposing
> it to the public internet, either put it behind TLS (Caddy, Nginx) or
> tunnel it over SSH:
> ```bash
> ssh -L 3000:localhost:3000 root@your-bot
> max-bot-bridge login localhost
> ```

### Use the CLI

```bash
# On your laptop, anywhere the repo is cloned and `npm install`ed:
npx max-bot-bridge                       # interactive TUI (recommended)
npx max-bot-bridge --help                # full command reference
npx max-bot-bridge login your-server-ip # password prompted interactively
npx max-bot-bridge list                  # list all routes
npx max-bot-bridge show my_route
npx max-bot-bridge show my_route --reveal  # show unmasked inline api_key
npx max-bot-bridge disable my_route
npx max-bot-bridge enable  my_route
npx max-bot-bridge add                   # interactive wizard (any source type)
npx max-bot-bridge add-api form_leads --telegram -5075596986
                                         # one-shot: auto-gen key + print curl
npx max-bot-bridge edit    my_route
npx max-bot-bridge remove  my_route      # prompts; --force skips confirmation
```

### One-shot API route creation

For quick integrations (forms, webhooks, CI alerts, other bots),
`add-api` creates a complete route in a single command — no editing
`routes.json`, no `.env` changes, no redeploy:

```bash
max-bot-bridge add-api form_leads --telegram -5075596986
```

Output includes the generated 32-byte Bearer key (shown **once** — save
it), a masked summary, and a ready-to-paste `curl` example pointing at
your server. Multiple destinations and env-var keys are also supported:

```bash
# Fan-out to MAX + Telegram, auto-generated key
max-bot-bridge add-api alerts \
  --max -70999607981465 \
  --telegram -1001234567890

# Use a key stored in the server's .env instead of inlining it
max-bot-bridge add-api ci-bot --env-var API_KEY_CI --telegram -1001234567890
```

Inline keys are masked in `list`/`show` output by default
(`abcd***wxyz`). Re-reveal with `max-bot-bridge show <id> --reveal`.

Running `max-bot-bridge` with **no arguments** opens an arrow-key menu:

```
╭────────────────────────────────────────╮
│      max-bot-bridge — bridge CLI       │
╰────────────────────────────────────────╯

server: http://your-server-ip:3000
routes: 9 enabled / 9 total

? Main menu
❯ 📋  List all routes
  🔧  Manage a route (edit / enable / disable / delete)
  ➕  Add a new route
  👤  Who am I / session info
  🚪  Logout
  ❌  Quit
```

### Session storage

After successful `login`, a long-lived Bearer token (~1 year) is stored
at `~/.config/max-bot-bridge/session.json` (mode `0600`). Passwords are
never written to disk. Use `logout` to revoke and wipe.

### Scripting & LLM-friendly mode

```bash
MAX_BOT_BRIDGE_PASSWORD=$PW max-bot-bridge login 10.0.0.5 \
  --password "$MAX_BOT_BRIDGE_PASSWORD"

max-bot-bridge list --json | jq '.[] | {id, enabled}'
max-bot-bridge show my_route --json
```

Exit codes: `0` success, `1` generic, `2` auth error, `3` not found.

### HTTP endpoints (for curl / custom tooling)

All endpoints expect JSON bodies. After `POST /admin/login` returns a
token, set `Authorization: Bearer <token>` on every subsequent request.

| Method | Path                              | Body                 | Notes                                 |
|--------|-----------------------------------|----------------------|---------------------------------------|
| POST   | `/admin/login`                    | `{password}`         | 5 attempts/min/IP rate limit          |
| POST   | `/admin/logout`                   | –                    | revokes the current token             |
| GET    | `/admin/info`                     | –                    | route counts + session expiry         |
| GET    | `/admin/routes`                   | –                    | all routes                            |
| GET    | `/admin/routes/:id`               | –                    | one route                             |
| POST   | `/admin/routes`                   | full route object    | create; validates before persisting   |
| PUT    | `/admin/routes/:id`               | partial route object | merge-update; writes+reloads atomic   |
| DELETE | `/admin/routes/:id`               | –                    | remove                                |
| POST   | `/admin/routes/:id/enable`        | –                    | toggle enabled=true                   |
| POST   | `/admin/routes/:id/disable`       | –                    | toggle enabled=false                  |
| GET    | `/admin/settings`                 | –                    | backup retention + mode               |
| PUT    | `/admin/settings`                 | partial settings     | validates, persists to settings.json  |
| GET    | `/admin/backups`                  | –                    | list snapshots (newest first)         |
| POST   | `/admin/backups`                  | `{reason}`           | manual snapshot                       |
| POST   | `/admin/backups/:name/restore`    | –                    | atomically restore from snapshot      |
| DELETE | `/admin/backups/:name`            | –                    | delete one snapshot                   |

Every mutation atomically rewrites `routes.json` and hot-reloads the bot
(no process restart). If the new config fails validation, the previous
file is restored and the API returns `400` with the error.

### Backups & settings

Every mutation of `routes.json` is preceded by a timestamped snapshot
stored next to the live file:

```
config/
  routes.json
  settings.json            # runtime settings (retention / mode)
  backups/
    routes-20260411-143022-add_my_route.json
    routes-20260411-143108-disable_debug_tg_to_max.json
    …
```

By default the bot keeps the **20 most recent** snapshots and creates a
new one automatically before **every** change (add / edit / enable /
disable / remove / restore). Older files are pruned after each new
snapshot.

Retention and mode are controlled by two settings:

| Setting         | Default | Range / values       | Meaning                                       |
|-----------------|---------|----------------------|-----------------------------------------------|
| `backups.keep`  | `20`    | integer `1..1000`    | how many snapshots to retain                  |
| `backups.mode`  | `auto`  | `auto` \| `manual`   | `auto` snapshots before every change;  `manual` only via `backup create` |

Change them at runtime via the CLI (stored in `config/settings.json`):

```bash
max-bot-bridge settings show
max-bot-bridge settings set backups.keep 50
max-bot-bridge settings set backups.mode manual
```

Or hard-lock them via `.env` (the env vars win over `settings.json` on
every reload):

```dotenv
BACKUPS_KEEP=20
BACKUPS_MODE=auto
```

Manage snapshots directly:

```bash
max-bot-bridge backup list                           # newest first
max-bot-bridge backup create --reason "pre-refactor" # on-demand snapshot
max-bot-bridge backup restore routes-20260411-143022-add_my_route.json
max-bot-bridge backup delete  routes-20260411-143022-add_my_route.json --force
```

Restoring a snapshot goes through the same validation pipeline as any
other mutation — if the restored file fails validation the previous
state is kept and the CLI returns a non-zero exit code.

---

## Social media destinations

The bridge supports posting to **Facebook Pages** and **Instagram** Business/Creator accounts as destinations alongside MAX and Telegram.

| Destination | Config field | Supported content | Shorts/Clips auto-detect | Setup guide |
|---|---|---|---|---|
| Facebook Page | `"network": "facebook"` | Text, photos | — | [docs/facebook.md](docs/facebook.md) |
| Instagram Business | `"network": "instagram"` | Photos, Reels (video) | — | [docs/instagram.md](docs/instagram.md) |
| YouTube Channel | `"network": "youtube"` | Video → auto Shorts | vertical + ≤60 s | [docs/youtube.md](docs/youtube.md) |
| VK Community / Profile | `"network": "vk"` | Text, photos, video → auto Clips | vertical + ≤60 s | [docs/vk.md](docs/vk.md) |
| Telegram Stories | `"network": "telegram_stories"` | Photos, videos | — | [docs/telegram-stories.md](docs/telegram-stories.md) |
| TikTok | `"network": "tiktok"` | Video (feed), photo/video (story) | — | [docs/tiktok.md](docs/tiktok.md) |

**Quick example — fan-out from Telegram to all platforms:**

```jsonc
{
  "id": "tg_to_all",
  "source": { "network": "telegram", "chat_id": -1001234567890 },
  "destinations": [
    { "network": "max", "chat_id": -70999000000000 },
    { "network": "facebook", "page_id": "123456789012345", "access_token_env": "FB_PAGE_ACCESS_TOKEN" },
    { "network": "instagram", "ig_user_id": "17841234567890123", "access_token_env": "FB_PAGE_ACCESS_TOKEN" },
    { "network": "youtube", "privacy_status": "public", "shorts_for_vertical": true },
    { "network": "vk", "owner_id": -123456789, "access_token_env": "VK_ACCESS_TOKEN" }
  ]
}
```

Facebook and Instagram share one **Page Access Token** from the Meta developer portal.
YouTube requires OAuth 2.0 (refresh token). VK uses a community or user access token.
See the respective setup guides for step-by-step instructions.

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
