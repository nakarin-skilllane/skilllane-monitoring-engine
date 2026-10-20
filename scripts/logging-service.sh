#!/usr/bin/env bash
# The logging service in the foreground, like any app: skilllane-monitoring engine (:5100,
# ingest + API) and skilllane monitor (:3300), their output prefixed in this
# terminal. Ctrl-C stops both.
#
# The infra (ClickHouse, Kafka / RabbitMQ / Redis) is started separately and
# left up; this only checks it answers. Apps point their env at the queue.
#
#   scripts/logging-service.sh
#
#   LOG_EXPORT=kafka      queue the engine subscribes to: kafka | rabbitmq | bullmq
#   MONITOR_MODE=start    start (built .next) | dev (hot reload)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# skilllane-monitoring and its contract, linked from the sibling repo.
SDK_ROOT="${SDK_ROOT:-$ROOT/../skilllane-monitoring}"
export LOG_EXPORT="${LOG_EXPORT:-kafka}"
MONITOR_MODE="${MONITOR_MODE:-start}"

say() { printf '[logging-service] %s\n' "$*"; }

case "$LOG_EXPORT" in
  kafka) QUEUE_PORT=29092 APP_ENV="LOG_KAFKA_BROKERS=localhost:29092" ;;
  rabbitmq) QUEUE_PORT=5673 APP_ENV="LOG_RABBITMQ_URL=amqp://skilllane_monitoring:skilllane_monitoring@localhost:5673/" ;;
  bullmq) QUEUE_PORT=6390 APP_ENV="LOG_BULLMQ_REDIS_URL=redis://localhost:6390/0" ;;
  *) say "LOG_EXPORT must be kafka, rabbitmq or bullmq (got: $LOG_EXPORT)"; exit 64 ;;
esac

port_taken() { lsof -iTCP:"$1" -sTCP:LISTEN -P >/dev/null 2>&1; }

# Infra is not started here: report what is missing instead of hiding it.
if ! curl -fs -m 2 -o /dev/null http://localhost:8123/ping; then
  say "ClickHouse is not answering on :8123 — start the infra first (cd $ROOT && docker compose up -d --wait)"
  exit 1
fi
if ! nc -z localhost "$QUEUE_PORT" 2>/dev/null; then
  say "$LOG_EXPORT is not listening on :$QUEUE_PORT — start the infra first (cd $ROOT && docker compose up -d --wait)"
  exit 1
fi
for port in 5100 3300; do
  if port_taken "$port"; then say "port $port is taken by another process; stop it first"; exit 1; fi
done

[ -f "$ROOT/.env" ] || cp "$ROOT/.env.example" "$ROOT/.env"

# stale <built file> <source dir|file>...: true when the build is missing or a source is newer than it.
stale() {
  local built=$1
  shift
  [ -f "$built" ] || return 0
  [ -n "$(find "$@" -newer "$built" -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' -o -name '*.json' -o -name '*.mjs' \) -not -path '*/node_modules/*' -print -quit 2>/dev/null)" ]
}

if stale "$ROOT/apps/engine/dist/main.js" "$ROOT/apps/engine/src" "$SDK_ROOT/packages/monitoring-contract/src"; then
  say "building the engine (sources changed)…"
  (cd "$SDK_ROOT" && pnpm build)
  (cd "$ROOT" && pnpm --filter @skilllane/monitoring-engine build)
fi
if [ "$MONITOR_MODE" = start ] &&
  stale "$ROOT/apps/monitor/.next/BUILD_ID" "$ROOT/apps/monitor/app" "$ROOT/apps/monitor/components" "$ROOT/apps/monitor/lib" \
    "$ROOT/apps/monitor/proxy.ts" "$ROOT/apps/monitor/next.config.ts"; then
  say "building the monitor (sources changed)…"
  (cd "$ROOT" && pnpm --filter @skilllane/monitoring-monitor build)
fi

PIDS=()
stop_all() {
  trap - INT TERM
  echo
  say "stopping…"
  kill -TERM "${PIDS[@]}" 2>/dev/null || true
  wait 2>/dev/null || true
  say "stopped"
  exit 0
}
trap stop_all INT TERM

# run <name> <command...>: in this terminal, each line prefixed with [name];
# PIDS keeps the command itself (not the sed after it), so stop_all reaches it.
run() {
  local name=$1
  shift
  ( cd "$ROOT" && exec "$@" ) > >(sed -u "s/^/[$name] /") 2>&1 &
  PIDS+=($!)
}

say "engine :5100 (LOG_EXPORT=$LOG_EXPORT), monitor :3300 ($MONITOR_MODE)"
say "apps send with: LOG_EXPORT=$LOG_EXPORT $APP_ENV"
say "monitor: http://localhost:3300/overview — Ctrl-C stops both"
run engine node apps/engine/dist/main.js
run monitor pnpm --filter @skilllane/monitoring-monitor "$MONITOR_MODE"

wait
