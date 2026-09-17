#!/usr/bin/env bash
# Starts API (:8720), worker, and web (:8721) against scripts/localnet.sh services.
# Development only: generates .local/dev.env with a random local keyring on first run.
#   scripts/dev.sh up | down | logs
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCAL="$ROOT/.local"
mkdir -p "$LOCAL"
if [[ ! -f "$LOCAL/dev.env" ]]; then
  echo "Write $LOCAL/dev.env first (see .env.example); it must set SIGNER_KEYRING." >&2
  exit 1
fi

start() { # name port command...
  local name=$1 port=$2; shift 2
  if [[ -f "$LOCAL/$name.pid" ]] && kill -0 "$(cat "$LOCAL/$name.pid")" 2>/dev/null; then echo "$name already running"; return; fi
  if [[ "$port" != "-" ]] && lsof -ti :"$port" >/dev/null 2>&1; then echo "port $port is held by another process; not starting $name" >&2; return 1; fi
  # set -m gives each service its own process group, so stop() cannot reach anything else.
  (set -m; set -a; source "$LOCAL/dev.env"; set +a; cd "$ROOT"; nohup "$@" >"$LOCAL/$name.log" 2>&1 & echo $! >"$LOCAL/$name.pid")
  echo "$name started (pid $(cat "$LOCAL/$name.pid"))"
}

stop() {
  local name=$1
  [[ -f "$LOCAL/$name.pid" ]] || return 0
  local pid; pid=$(cat "$LOCAL/$name.pid")
  if kill -0 "$pid" 2>/dev/null; then
    # The recorded pid is a pnpm wrapper; stop its process group so child servers go too.
    local group; group=$(ps -o pgid= -p "$pid" | tr -d ' ')
    if [[ "$group" == "$pid" ]]; then kill -- "-$pid"; else kill "$pid"; fi
    echo "stopped $name"
  fi
  rm -f "$LOCAL/$name.pid"
}

case "${1:-}" in
  up)
    # API and worker import workspace packages through their built dist.
    pnpm --silent turbo run build --filter='./packages/*' --output-logs=errors-only
    start api 8720 pnpm --filter @ai-neobank/api dev
    start worker - pnpm --filter @ai-neobank/worker dev
    start web 8721 pnpm --filter @ai-neobank/web dev
    ;;
  down) stop web; stop worker; stop api ;;
  logs) tail -n 40 "$LOCAL/api.log" "$LOCAL/worker.log" "$LOCAL/web.log" ;;
  *) echo "usage: $0 up|down|logs" >&2; exit 2 ;;
esac
