#!/usr/bin/env bash
# Remote healthcheck for max-repost-bot.
# Reads SSH creds from .env (same vars as deploy.sh).
#
# Exit codes:
#   0 — pm2 online AND Telegram + MAX reachable from server
#   1 — config / ssh error
#   2 — pm2 process missing or not "online"
#   3 — pm2 online, but upstream API unreachable (TG or MAX)
#
# Usage:
#   ./scripts/healthcheck.sh            # human-readable report
#   ./scripts/healthcheck.sh --quiet    # only summary line + exit code

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
QUIET=0
[[ "${1:-}" == "--quiet" ]] && QUIET=1

log() { [[ $QUIET -eq 0 ]] && echo "$@" || true; }
section() { [[ $QUIET -eq 0 ]] && { echo; echo "=== $* ==="; } || true; }

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

: "${REMOTE_HOST:?REMOTE_HOST is required in .env}"
: "${REMOTE_USER:?REMOTE_USER is required in .env}"
: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN is required in .env}"

APP_NAME="${PM2_APP_NAME:-max-repost-bot}"
SSH_ARGS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 -o BatchMode=no)

if [[ -n "${REMOTE_PASSWORD:-}" ]]; then
  if ! command -v sshpass >/dev/null 2>&1; then
    echo "REMOTE_PASSWORD is set but sshpass is not installed" >&2
    exit 1
  fi
  SSH_PASS_ARGS=(-o PubkeyAuthentication=no -o PreferredAuthentications=password -o IdentitiesOnly=yes)
  SSH_CMD=(sshpass -p "${REMOTE_PASSWORD}" ssh "${SSH_ARGS[@]}" "${SSH_PASS_ARGS[@]}" "${REMOTE_USER}@${REMOTE_HOST}")
else
  SSH_CMD=(ssh "${SSH_ARGS[@]}" "${REMOTE_USER}@${REMOTE_HOST}")
fi

# Run everything in one SSH round-trip and emit a tagged report we can parse.
REMOTE_SCRIPT=$(cat <<REMOTE
set +e
APP="${APP_NAME}"
TOKEN="${TELEGRAM_BOT_TOKEN}"

echo "TAG:HOST=\$(hostname)"
echo "TAG:DATE=\$(date -Is)"

# --- pm2 status -----------------------------------------------------------
if ! command -v pm2 >/dev/null 2>&1; then
  echo "TAG:PM2_INSTALLED=no"
  echo "TAG:STATUS=missing"
else
  echo "TAG:PM2_INSTALLED=yes"
  STATUS=\$(pm2 jlist 2>/dev/null | APP="\$APP" node -e '
    let raw="";process.stdin.on("data",c=>raw+=c).on("end",()=>{
      try{const list=JSON.parse(raw||"[]");
        const p=list.find(x=>x.name===process.env.APP);
        if(!p){console.log("missing");return}
        const e=p.pm2_env||{}, m=p.monit||{};
        console.log([e.status||"unknown",e.restart_time||0,e.pm_uptime||0,m.memory||0,m.cpu||0].join("|"));
      }catch(err){console.log("parse-error")}
    });
  ')
  IFS='|' read -r S R U MEM CPU <<<"\$STATUS"
  echo "TAG:STATUS=\${S:-unknown}"
  echo "TAG:RESTARTS=\${R:-?}"
  echo "TAG:UPTIME_MS=\${U:-0}"
  echo "TAG:MEM=\${MEM:-0}"
  echo "TAG:CPU=\${CPU:-0}"
fi

# --- upstream reachability ------------------------------------------------
tg_code=\$(curl -sS -o /tmp/hc_tg.out -w '%{http_code}' --max-time 8 "https://api.telegram.org/bot\$TOKEN/getMe" 2>/dev/null)
[[ -z "\$tg_code" ]] && tg_code="000"
echo "TAG:TG_HTTP=\$tg_code"
if [[ "\$tg_code" == "200" ]]; then
  TG_OK=\$(node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>{try{const j=JSON.parse(r);console.log(j.ok?"true:"+((j.result&&j.result.username)||"?"):"false")}catch(e){console.log("false")}})' </tmp/hc_tg.out)
  echo "TAG:TG_OK=\$TG_OK"
else
  echo "TAG:TG_OK=false"
fi

max_code=\$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "https://botapi.max.ru/" 2>/dev/null)
[[ -z "\$max_code" ]] && max_code="000"
echo "TAG:MAX_HTTP=\$max_code"

# --- recent errors --------------------------------------------------------
ERR_LOG="/root/.pm2/logs/\${APP}-error-0.log"
OUT_LOG="/root/.pm2/logs/\${APP}-out-0.log"
if [[ -f "\$ERR_LOG" ]]; then
  ERR_COUNT=\$(tail -n 200 "\$ERR_LOG" 2>/dev/null | wc -l | tr -d ' ')
  echo "TAG:ERR_TAIL_LINES=\$ERR_COUNT"
  echo "TAG:ERR_SAMPLE<<END"
  tail -n 5 "\$ERR_LOG" 2>/dev/null
  echo "END"
fi
if [[ -f "\$OUT_LOG" ]]; then
  echo "TAG:OUT_SAMPLE<<END"
  tail -n 5 "\$OUT_LOG" 2>/dev/null
  echo "END"
fi

rm -f /tmp/hc_tg.out
REMOTE
)

section "SSH → ${REMOTE_USER}@${REMOTE_HOST}"
if ! RAW=$("${SSH_CMD[@]}" bash -s <<<"$REMOTE_SCRIPT" 2>&1); then
  echo "SSH/remote execution failed:" >&2
  echo "$RAW" >&2
  exit 1
fi

get_tag() { printf '%s\n' "$RAW" | awk -v k="TAG:$1=" 'index($0,k)==1{sub(k,"");print;exit}'; }
get_block() {
  printf '%s\n' "$RAW" | awk -v k="TAG:$1<<END" '
    $0==k{flag=1;next}
    flag && $0=="END"{exit}
    flag{print}
  '
}

HOST=$(get_tag HOST)
DATE=$(get_tag DATE)
STATUS=$(get_tag STATUS)
RESTARTS=$(get_tag RESTARTS)
UPTIME_MS=$(get_tag UPTIME_MS)
MEM=$(get_tag MEM)
CPU=$(get_tag CPU)
TG_HTTP=$(get_tag TG_HTTP)
TG_OK=$(get_tag TG_OK)
MAX_HTTP=$(get_tag MAX_HTTP)

UPTIME_HUMAN="n/a"
if [[ -n "$UPTIME_MS" && "$UPTIME_MS" != "0" ]]; then
  NOW_MS=$(( $(date +%s) * 1000 ))
  DELTA=$(( NOW_MS - UPTIME_MS ))
  (( DELTA < 0 )) && DELTA=0
  SECS=$(( DELTA / 1000 ))
  UPTIME_HUMAN="$(( SECS / 86400 ))d $(( (SECS % 86400) / 3600 ))h $(( (SECS % 3600) / 60 ))m"
fi

MEM_MB="n/a"
[[ -n "$MEM" && "$MEM" != "0" ]] && MEM_MB=$(( MEM / 1024 / 1024 ))

section "Report"
log "host:     ${HOST} (${DATE})"
log "pm2 app:  ${APP_NAME}"
log "status:   ${STATUS}"
log "uptime:   ${UPTIME_HUMAN}"
log "restarts: ${RESTARTS}"
log "mem:      ${MEM_MB} MB"
log "cpu:      ${CPU}%"
log "Telegram: HTTP ${TG_HTTP:-?}  ok=${TG_OK:-?}"
log "MAX:      HTTP ${MAX_HTTP:-?}"

if [[ $QUIET -eq 0 ]]; then
  ERR_SAMPLE=$(get_block ERR_SAMPLE)
  OUT_SAMPLE=$(get_block OUT_SAMPLE)
  if [[ -n "$ERR_SAMPLE" ]]; then
    section "pm2 error log (tail)"
    echo "$ERR_SAMPLE"
  fi
  if [[ -n "$OUT_SAMPLE" ]]; then
    section "pm2 out log (tail)"
    echo "$OUT_SAMPLE"
  fi
fi

# --- verdict --------------------------------------------------------------
EXIT=0
VERDICT="OK"
if [[ "$STATUS" != "online" ]]; then
  VERDICT="DOWN (pm2 status=${STATUS:-unknown})"
  EXIT=2
elif [[ "${TG_HTTP:-000}" != "200" ]]; then
  VERDICT="DEGRADED (Telegram unreachable: HTTP ${TG_HTTP:-000})"
  EXIT=3
elif [[ "${MAX_HTTP:-000}" == "000" ]]; then
  VERDICT="DEGRADED (MAX unreachable)"
  EXIT=3
fi

section "Verdict"
echo "$VERDICT"
exit $EXIT
