#!/usr/bin/env bash
# Local chains for this repo, on this repo's own port block (see CLAUDE.md).
#   scripts/localnet.sh up      start postgres :8723, anvil :8722, solana-test-validator :8724 (ws 8725, faucet 8726)
#   scripts/localnet.sh down    stop both, by recorded PID only
#   scripts/localnet.sh status  print what is listening
# The Squads v4 program is cloned from devnet at genesis so the Squads adapter
# tests run against the real program bytes. State lives in .local/ (gitignored).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCAL="$ROOT/.local"
mkdir -p "$LOCAL"

ANVIL_PORT=8722
PG_PORT=8723
PG_BIN="$(dirname "$(command -v postgres)")"
SOL_RPC=8724
SOL_FAUCET=8726
SQUADS_PROGRAM=SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf
SQUADS_CONFIG=BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr
SQUADS_TREASURY=HM5y4mz3Bt9JY9mr1hkyhnvqxSH4H2u2451j7Hc2dtvK

owned() { # port pidfile -> 0 if the port is held by our recorded pid
  local port=$1 pidfile=$2 pid
  [[ -f "$pidfile" ]] || return 1
  pid=$(cat "$pidfile")
  kill -0 "$pid" 2>/dev/null || return 1
  lsof -ti :"$port" 2>/dev/null | grep -qx "$pid"
}

pg_up() {
  if [[ ! -f "$LOCAL/pg/PG_VERSION" ]]; then
    "$PG_BIN/initdb" -D "$LOCAL/pg" -U relay --auth=trust >"$LOCAL/postgres-init.log" 2>&1
  fi
  if ! "$PG_BIN/pg_ctl" -D "$LOCAL/pg" status >/dev/null 2>&1; then
    "$PG_BIN/pg_ctl" -D "$LOCAL/pg" -l "$LOCAL/postgres.log" -o "-p $PG_PORT -k $LOCAL -c listen_addresses=127.0.0.1" -w start >/dev/null
    echo "postgres started on :$PG_PORT"
  fi
  "$PG_BIN/psql" -h 127.0.0.1 -p $PG_PORT -U relay -d postgres -tAc "select 1 from pg_database where datname = 'relay'" | grep -q 1 \
    || "$PG_BIN/psql" -h 127.0.0.1 -p $PG_PORT -U relay -d postgres -c "create database relay" >/dev/null
}

up() {
  pg_up
  for port in $ANVIL_PORT $SOL_RPC $((SOL_RPC + 1)) $SOL_FAUCET; do
    if lsof -ti :"$port" >/dev/null 2>&1; then
      if owned "$port" "$LOCAL/anvil.pid" || owned "$port" "$LOCAL/validator.pid"; then continue; fi
      echo "port $port is held by another process; refusing to start" >&2
      lsof -nP -iTCP:"$port" -sTCP:LISTEN >&2 || true
      exit 1
    fi
  done
  if ! owned $ANVIL_PORT "$LOCAL/anvil.pid"; then
    anvil --port $ANVIL_PORT --chain-id 31337 --silent >"$LOCAL/anvil.log" 2>&1 &
    echo $! >"$LOCAL/anvil.pid"
    echo "anvil started on :$ANVIL_PORT (pid $!)"
  fi
  if ! owned $SOL_RPC "$LOCAL/validator.pid"; then
    solana-test-validator \
      --ledger "$LOCAL/ledger" \
      --rpc-port $SOL_RPC \
      --faucet-port $SOL_FAUCET \
      --gossip-port 8727 \
      --dynamic-port-range 8730-8755 \
      --bind-address 127.0.0.1 \
      --url https://api.devnet.solana.com \
      --clone-upgradeable-program $SQUADS_PROGRAM \
      --maybe-clone $SQUADS_CONFIG \
      --maybe-clone $SQUADS_TREASURY \
      --limit-ledger-size 20000 \
      --reset --quiet >"$LOCAL/validator.log" 2>&1 &
    echo $! >"$LOCAL/validator.pid"
    echo "solana-test-validator started on :$SOL_RPC (pid $!)"
  fi
  for _ in $(seq 1 60); do
    if curl -sf -m 2 "http://127.0.0.1:$SOL_RPC" -X POST -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q '"ok"'; then
      echo "validator healthy"
      (cd "$ROOT" && EVM_RPC_URL="http://127.0.0.1:$ANVIL_PORT" pnpm --silent --filter @ai-neobank/worker exec tsx src/deploy-safe-local.ts) || echo "Safe fixture deployment failed; Safe treasuries will be unavailable locally" >&2
      status; return
    fi
    sleep 2
  done
  echo "validator did not become healthy; see $LOCAL/validator.log" >&2
  exit 1
}

down() {
  "$PG_BIN/pg_ctl" -D "$LOCAL/pg" status >/dev/null 2>&1 && "$PG_BIN/pg_ctl" -D "$LOCAL/pg" -w stop >/dev/null && echo "stopped postgres"
  for name in anvil validator; do
    local pidfile="$LOCAL/$name.pid"
    [[ -f "$pidfile" ]] || continue
    local pid; pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null && ps -o command= -p "$pid" | grep -qE 'anvil|solana-test-validator'; then
      kill "$pid" && echo "stopped $name (pid $pid)"
    fi
    rm -f "$pidfile"
  done
}

status() {
  for port in $PG_PORT $ANVIL_PORT $SOL_RPC $SOL_FAUCET; do
    printf '%s: ' "$port"; lsof -nP -iTCP:"$port" -sTCP:LISTEN -Fc 2>/dev/null | sed -n 's/^c//p' | head -1 || true; echo
  done
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  status) status ;;
  *) echo "usage: $0 up|down|status" >&2; exit 2 ;;
esac
