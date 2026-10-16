#!/usr/bin/env bash
# Starts the API (:3001) and web app (:3000) against the local dev database for manual testing.
# Needs the dev Postgres from infra/docker-compose.yml (port 5434) and a .env at the repo root.
# Dictation pilot: enabled for the dev oncologist (oncologist@opd.local) unless DICTATION_PILOT_USER_ID is already set.
# Stop with Ctrl-C; both servers are stopped together.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "missing .env at the repo root" >&2; exit 1; }
set -a; . ./.env; set +a

if [ -z "${DICTATION_PILOT_USER_ID:-}" ] && [ -z "${DICTATION_PILOT_EMAIL:-}" ]; then
  export DICTATION_PILOT_EMAIL="oncologist@opd.local"
  echo "dictation pilot enabled for $DICTATION_PILOT_EMAIL"
fi

bun apps/api/src/index.ts & api=$!
bun apps/web/src/server.ts & web=$!
trap 'kill $api $web 2>/dev/null || true' EXIT INT TERM

for i in $(seq 1 30); do
  if curl -fs http://localhost:3001/health >/dev/null 2>&1 && curl -fs http://localhost:3000/ >/dev/null 2>&1; then
    echo
    echo "Ready:  http://localhost:3000"
    echo "Staff:       staff@opd.local / staff-password"
    echo "Oncologist:  oncologist@opd.local / onc-password"
    break
  fi
  sleep 1
done

wait
