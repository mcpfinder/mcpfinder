#!/bin/bash
# Local Glama capture for the snapshot build (LaunchAgent com.mcpfinder.glama-capture).
#
# Glama answers GitHub-hosted IPs with empty bodies, so the crawl runs on our
# Macs and the GitHub-hosted build replays it from R2 (see
# scripts/glama-capture-lib.mjs and .github/workflows/snapshot.yml).
#
# ROLE=primary  (aic-studio)    capture every run.
# ROLE=fallback (aic-wfs-mini)  capture only when R2 latest.json is missing or
#                               older than FALLBACK_MAX_AGE_HOURS (default 7).
#                               install.sh gives the fallback a 1 h interval, so
#                               it starts by ~8 h + crawl time, inside the build's
#                               12 h limit.
#
# install.sh copies this file out of the repo (git updates must not rewrite a
# running bash script); each run installs main's version for the next run. Old captures expire through the bucket's
# lifecycle rule (3 days); only latest.json's target is ever read.
#
# Credentials come from the login Keychain (account $USER):
#   GLAMA_API_KEY, MCPFINDER_GLAMA_CAPTURE_R2_ACCESS_KEY_ID,
#   MCPFINDER_GLAMA_CAPTURE_R2_SECRET_ACCESS_KEY
# Secrets never go on a command line or into the log: curl gets them through a
# config on a file descriptor, node through the environment.
set -euo pipefail
umask 077

ROLE="${ROLE:-primary}"
FALLBACK_MAX_AGE_HOURS="${FALLBACK_MAX_AGE_HOURS:-7}"
R2_ACCOUNT_ID="${R2_ACCOUNT_ID:-9e7cfb40f9896e268a8212dc58e20780}"
R2_BUCKET="${R2_BUCKET:-mcpfinder-glama-capture}"
REPO_URL="${REPO_URL:-https://github.com/mcpfinder/mcpfinder.git}"
BASE="${BASE:-$HOME/Library/Application Support/mcpfinder-glama-capture}"
LOG="${LOG:-$HOME/Library/Logs/mcpfinder-glama-capture.log}"
LOG_MAX_BYTES=$((5 * 1024 * 1024))
LOG_KEEP=5
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$BASE" "$(dirname "$LOG")"

# --- log rotation (size based, keep $LOG_KEEP) ------------------------------
if [ -f "$LOG" ] && [ "$(stat -f %z "$LOG")" -gt "$LOG_MAX_BYTES" ]; then
  for i in $(seq $((LOG_KEEP - 1)) -1 1); do
    [ -f "$LOG.$i" ] && mv -f "$LOG.$i" "$LOG.$((i + 1))"
  done
  mv -f "$LOG" "$LOG.1"
fi
exec >>"$LOG" 2>&1
log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [$ROLE] $*"; }

# --- single instance (shlock: atomic, clears a lock whose pid is dead) -----
LOCK="$BASE/lock.pid"
if ! shlock -f "$LOCK" -p $$; then
  log "another run (pid $(cat "$LOCK" 2>/dev/null || echo ?)) holds the lock; exiting"
  exit 0
fi
WORK=""
cleanup() { [ -n "$WORK" ] && rm -rf "$WORK"; rm -f "$LOCK"; }
trap cleanup EXIT

kc() { security find-generic-password -s "$1" -a "$USER" -w; }
R2_KEY_ID=$(kc MCPFINDER_GLAMA_CAPTURE_R2_ACCESS_KEY_ID)
R2_SECRET=$(kc MCPFINDER_GLAMA_CAPTURE_R2_SECRET_ACCESS_KEY)
[ -n "$R2_KEY_ID" ] && [ -n "$R2_SECRET" ] || { log "R2 Keychain items are empty"; exit 1; }
R2_URL="https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com/$R2_BUCKET"

# r2 <curl args...>: signed S3 request; credentials via fd, not argv.
r2() {
  curl --fail --silent --show-error --retry 3 --max-time 600 \
    --aws-sigv4 "aws:amz:auto:s3" \
    --config <(printf 'user = "%s:%s"\n' "$R2_KEY_ID" "$R2_SECRET") "$@"
}

log "start (pid $$)"

# --- repo: dedicated clone tracking origin/main -----------------------------
REPO="$BASE/repo"
if [ ! -d "$REPO/.git" ]; then
  git clone --quiet "$REPO_URL" "$REPO"
fi
git -C "$REPO" fetch --quiet origin main
git -C "$REPO" checkout --quiet --force -B main origin/main
git -C "$REPO" clean -fdxq -e node_modules
COMMIT=$(git -C "$REPO" rev-parse --short HEAD)
log "repo at $COMMIT"
# Self-update: install main's wrapper for the NEXT run (rename = new inode, so
# this running copy is untouched). Plist changes still need install.sh.
NEW="$REPO/ops/glama-capture/glama-capture-launchd.sh"
if [ -f "$NEW" ] && ! cmp -s "$0" "$NEW"; then
  cp "$NEW" "$0.new" && chmod 700 "$0.new" && mv -f "$0.new" "$0"
  log "wrapper updated from main ($COMMIT); takes effect next run"
fi

# --- fallback: skip while the primary's capture is fresh --------------------
if [ "$ROLE" = fallback ]; then
  latest=$(r2 "$R2_URL/latest.json" 2>/dev/null || true)
  age=$(printf '%s' "$latest" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{const t=Date.parse(JSON.parse(s).capturedAt);
        console.log(Number.isFinite(t)?Math.floor((Date.now()-t)/1000):-1)}
      catch{console.log(-1)}})')
  if [ "$age" -ge 0 ] && [ "$age" -lt $((FALLBACK_MAX_AGE_HOURS * 3600)) ]; then
    log "latest capture is $((age / 60)) min old (< ${FALLBACK_MAX_AGE_HOURS}h); fallback skips"
    exit 0
  fi
  log "latest capture missing or stale (age_s=$age); fallback captures"
fi

cd "$REPO"
PNPM_VERSION=$(node -p 'require("./package.json").packageManager.split("@")[1]')
pnpm() { npx --yes "pnpm@$PNPM_VERSION" "$@"; }
pnpm install --frozen-lockfile --silent
pnpm --filter @mcpfinder/core build >/dev/null

# --- capture ----------------------------------------------------------------
WORK=$(mktemp -d "$BASE/run.XXXXXX")
GLAMA_KEY=$(kc GLAMA_API_KEY)
[ -n "$GLAMA_KEY" ] || { log "Keychain item GLAMA_API_KEY is empty"; exit 1; }
GLAMA_API_KEY="$GLAMA_KEY" \
  MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES=30 \
  MCPFINDER_CRAWL_RESTART_BASE_MS=15000 \
  NODE_OPTIONS=--dns-result-order=ipv4first \
  node scripts/glama-capture.mjs --out="$WORK/capture"

# --- upload: objects first, pointer last ------------------------------------
TS=$(date -u +%Y%m%dT%H%M%SZ)
H="$WORK/capture/header.json"
G="$WORK/capture/responses.jsonl.gz"
r2 -o /dev/null -H 'content-type: application/json' -T "$H" "$R2_URL/$TS/header.json"
r2 -o /dev/null -H 'content-type: application/gzip' -T "$G" "$R2_URL/$TS/responses.jsonl.gz"
node -e '
  const fs=require("node:fs"),c=require("node:crypto");
  const [h,g,ts,host,role,commit]=process.argv.slice(1);
  const hd=JSON.parse(fs.readFileSync(h,"utf8"));
  const sha=f=>c.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  fs.writeFileSync(process.argv[7], JSON.stringify({v:1,prefix:ts+"/",
    capturedAt:hd.capturedAt,servers:hd.servers,responses:hd.responses,
    headerSha256:sha(h),responsesSha256:sha(g),responsesBytes:fs.statSync(g).size,
    host,role,commit,uploadedAt:new Date().toISOString()})+"\n");
' "$H" "$G" "$TS" "$(scutil --get LocalHostName 2>/dev/null || hostname -s)" "$ROLE" "$COMMIT" "$WORK/latest.json"
r2 -o /dev/null -H 'content-type: application/json' -H 'cache-control: no-store' \
  -T "$WORK/latest.json" "$R2_URL/latest.json"
log "uploaded $TS/ ($(stat -f %z "$G") bytes, $(node -p "require('$H').servers") servers)"
