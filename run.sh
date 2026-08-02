#!/usr/bin/env bash
#
# Start Runthru.
#
#   ./run.sh            start the studio        → http://localhost:4400
#   ./run.sh exports    serve exported bundles  → http://localhost:4500
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

MODE="${1:-studio}"
PORT="${PORT:-4400}"
EXPORT_PORT="${EXPORT_PORT:-4500}"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
warn() { printf '\033[33m%s\033[0m\n' "$1"; }
fail() { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "Node.js is not installed. Get it from https://nodejs.org (v18 or newer)."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || fail "Node 18 or newer is required (you have $(node -v))."

# Dependencies
if [ ! -d node_modules ]; then
  bold "Installing dependencies…"
  npm install
fi

# The recording browser. Playwright keeps it outside the project, so check separately.
if ! node -e 'require("playwright").chromium.executablePath()' >/dev/null 2>&1; then
  bold "Downloading the recording browser (one-off)…"
  npx playwright install chromium
fi

# ---------------------------------------------------------------- exports mode

if [ "$MODE" = "exports" ] || [ "$MODE" = "export" ]; then
  [ -d dist ] || fail "Nothing exported yet. Open the studio and use Export first."
  shift || true
  bold "Serving exports on http://localhost:${EXPORT_PORT}"
  exec node server/serve-export.js "$@"
fi

# ---------------------------------------------------------------- studio mode

# API key: the studio runs fine without one, only the AI features are disabled.
# The studio itself offers to connect a key on first launch, so no nagging here.
if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
fi

# A previous instance would just fail to bind, so clear it out first.
# Match only the LISTENing process: a plain port lookup also returns every client connected
# to it, such as a browser tab left open on the studio.
EXISTING="$(lsof -ti "tcp:${PORT}" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
if [ -n "$EXISTING" ]; then
  if ps -p "$EXISTING" -o command= 2>/dev/null | grep -q 'server/index.js'; then
    warn "Restarting the studio already running on port ${PORT}…"
    kill "$EXISTING" 2>/dev/null || true
    sleep 1
  else
    fail "Port ${PORT} is in use by something else (PID ${EXISTING}). Set PORT=xxxx to use another."
  fi
fi

URL="http://localhost:${PORT}"

# Open a browser once the server is actually accepting connections.
(
  for _ in $(seq 1 40); do
    if curl -fsS -o /dev/null "$URL" 2>/dev/null; then
      command -v open >/dev/null 2>&1 && open "$URL"
      break
    fi
    sleep 0.25
  done
) &

exec node server/index.js
