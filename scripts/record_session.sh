#!/usr/bin/env bash
# One recording session on the Mac, started and stopped by Build (not the founder):
#   1. the server on 127.0.0.1 with a fresh access code and a hard Meta spend stop for this run;
#   2. a Cloudflare quick tunnel to it, so the iPhone gets an https link (no account, no cloud deploy);
#   3. the phone link (with the code) printed as text and as a terminal QR code;
#   4. the Agent Console recorded in the background (headless, nothing opens on screen) into recordings/;
#   Ctrl-C (or --duration) stops all of it: capture, console window, tunnel, server.
#
# Usage: scripts/record_session.sh [--no-tunnel] [--no-capture] [--open] [--spend-stop USD] [--port N] [--duration S]
#   --no-tunnel   local only (http://127.0.0.1): for testing the script, the phone cannot use it
#   --duration S  stop by itself after S seconds (tests)
# The Meta key is read from META_API_KEY or from META_ENV_FILE (default ../.secrets/meta_model_api.env)
# into this process only. Nothing here prints a key; the access code appears only in the phone link.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PORT=8642; TUNNEL=1; CAPTURE=1; OPEN=1; STOP=5; DURATION=0
ENV_FILE="${META_ENV_FILE:-$ROOT/../.secrets/meta_model_api.env}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-tunnel) TUNNEL=0 ;;
    --no-capture) CAPTURE=0 ;;
    --no-open) OPEN=0 ;;
    --open) OPEN=2 ;;
    --spend-stop) STOP="$2"; shift ;;
    --port) PORT="$2"; shift ;;
    --duration) DURATION="$2"; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

die() { echo "Stopped: $*" >&2; exit 1; }
mkdir -p .data recordings; chmod 700 .data
SERVER_PID=""; TUNNEL_PID=""; CAPTURE_PID=""; CHROME_PID=""; TIMER_PID=""; MOVIE=""
HDR=".data/session_header"; LINKFILE=".data/session_link.txt"

cleanup() {
  trap - EXIT INT TERM
  echo
  if [[ -n "$SERVER_PID" && -f "$HDR" ]]; then
    curl -s -m 3 -H @"$HDR" "http://127.0.0.1:$PORT/api/health" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const h=JSON.parse(s);console.log(`Meta spend this session: $${h.session.spentUsd} (stop at $${h.session.stopUsd})`)}catch{}})' || true
  fi
  # Stop the capture first: ffmpeg finishes writing the movie on TERM (background jobs ignore INT).
  if [[ -n "$CAPTURE_PID" ]] && kill -0 "$CAPTURE_PID" 2>/dev/null; then kill -TERM "$CAPTURE_PID" 2>/dev/null || true; for _ in $(seq 1 20); do kill -0 "$CAPTURE_PID" 2>/dev/null || break; sleep 0.5; done; kill -KILL "$CAPTURE_PID" 2>/dev/null || true; fi
  for pid in "$TIMER_PID" "$CHROME_PID" "$TUNNEL_PID" "$SERVER_PID"; do [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true; done
  for pid in "$CHROME_PID" "$TUNNEL_PID" "$SERVER_PID"; do [[ -n "$pid" ]] && wait "$pid" 2>/dev/null || true; done
  rm -f "$HDR" "$LINKFILE" .data/tunnel.log
  rm -rf .data/console-chrome
  if [[ -n "$MOVIE" && -s "$MOVIE" ]]; then echo "Console recording: $ROOT/$MOVIE ($(du -h "$MOVIE" | cut -f1))"; elif [[ -n "$MOVIE" ]]; then echo "No console recording was saved (see .data/capture.log)."; fi
  echo "Stopped: capture, console window, tunnel and server."
}
trap cleanup EXIT
trap 'cleanup; exit 0' INT TERM

# --- key: into this process's environment only, never printed ---
if [[ -z "${META_API_KEY:-}" ]]; then
  [[ -f "$ENV_FILE" ]] || die "no META_API_KEY and no env file at META_ENV_FILE"
  set -a; . "$ENV_FILE"; set +a
fi
[[ -n "${META_API_KEY:-}" ]] || die "META_API_KEY is empty"
echo "Meta key: loaded"
# Natural voice (Deepgram Aura-2): DEEPGRAM_API_KEY from env or ../.secrets/member_deepgram.env; browser voice without it.
DG_FILE="${DEEPGRAM_ENV_FILE:-$ROOT/../.secrets/member_deepgram.env}"
if [[ -z "${DEEPGRAM_API_KEY:-}" && -f "$DG_FILE" ]]; then
  DEEPGRAM_API_KEY="$(sed -n 's/^MEMBER_DEEPGRAM_API_TOKEN[[:space:]]*=[[:space:]]*//p' "$DG_FILE" | tr -d "\"'" | head -1)"; export DEEPGRAM_API_KEY
fi
[[ -n "${DEEPGRAM_API_KEY:-}" ]] && echo "Natural voice: on" || echo "Natural voice: off (browser voice)"

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then die "port $PORT is already in use (another server?)"; fi

# --- 1. server (127.0.0.1 only) ---
HOST=127.0.0.1 PORT="$PORT" SPEND_STOP_USD="$STOP" TRUST_PROXY=1 node src/server.mjs > .data/server.log 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do [[ -s .data/access_code ]] && grep -q "snap-to-booked on" .data/server.log 2>/dev/null && break; sleep 0.2; done
kill -0 "$SERVER_PID" 2>/dev/null || die "the server did not start (see .data/server.log)"
umask 077; printf 'x-access-code: %s\n' "$(cat .data/access_code)" > "$HDR"
[[ "$(curl -s -o /dev/null -w '%{http_code}' -m 3 -H @"$HDR" "http://127.0.0.1:$PORT/api/health")" == "200" ]] || die "health check failed"
echo "Server: http://127.0.0.1:$PORT (localhost only), spend stop \$$STOP for this session"

# --- 2. https tunnel (Cloudflare quick tunnel: temporary URL, no account) ---
BASE="http://127.0.0.1:$PORT"
if [[ "$TUNNEL" == 1 ]]; then
  command -v cloudflared >/dev/null || die "cloudflared is not installed (brew install cloudflared), or run with --no-tunnel"
  cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" > .data/tunnel.log 2>&1 &
  TUNNEL_PID=$!
  URL=""
  for _ in $(seq 1 60); do URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' .data/tunnel.log | head -1 || true)"; [[ -n "$URL" ]] && break; sleep 0.5; done
  [[ -n "$URL" ]] || die "the tunnel did not give a URL (see .data/tunnel.log)"
  BASE="$URL"
  echo "Tunnel: up (https)"
else
  echo "Tunnel: skipped (--no-tunnel): the phone link below works on this Mac only"
fi

# --- 3. phone link, text and QR ---
CODE="$(cat .data/access_code)"
LINK="$BASE/k/$CODE?to=go"
printf '%s\n' "$LINK" > "$LINKFILE"
echo
echo "Phone link (private; it carries today's access code):"
echo "  $LINK"
node scripts/qr.mjs "$LINK"
echo

# --- 4. Agent Console: recorded in the background, nothing opens on screen ---
# A headless Chrome nobody sees renders the console and scripts/console_capture.mjs records only
# that page (no screen-recording permission, nothing else on the Mac is captured).
# --open also shows it in its own window, for watching live.
if [[ "$CAPTURE" == 1 ]]; then
  MOVIE="recordings/console_$(date +%Y%m%d_%H%M%S).mp4"
  node scripts/console_capture.mjs "http://127.0.0.1:$PORT/k/$CODE?to=console" "$MOVIE" > .data/capture.log 2>&1 &
  CAPTURE_PID=$!
  echo "Agent Console: recording in the background to $MOVIE"
fi
if [[ "$OPEN" == 2 && -x "$CHROME" ]]; then
  # A separate, throwaway Chrome profile: never the founder's own browser profiles.
  "$CHROME" --user-data-dir="$ROOT/.data/console-chrome" --no-first-run --no-default-browser-check --window-size=1280,900 \
    --app="http://127.0.0.1:$PORT/k/$CODE?to=console" > /dev/null 2>&1 &
  CHROME_PID=$!
  echo "Agent Console: also open in its own window"
fi
unset CODE LINK

if [[ "$DURATION" != 0 ]]; then
  echo "Stops by itself in ${DURATION}s."
  (sleep "$DURATION"; kill -TERM $$ 2>/dev/null) &
  TIMER_PID=$!
else
  echo "Recording session is live. Press Ctrl-C here to stop everything."
fi
while kill -0 "$SERVER_PID" 2>/dev/null; do sleep 1; done
echo "The server stopped (see .data/server.log)."
