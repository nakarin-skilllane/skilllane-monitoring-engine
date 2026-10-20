#!/usr/bin/env bash
# One command for the real app (not the demo apps): infra + engine + monitor,
# and optionally school-core-api from the monorepo, sending to the same queue.
# Ctrl-C stops everything it started (infra keeps running; `docker compose stop`).
#
#   scripts/stack.sh                 infra + engine + monitor
#   scripts/stack.sh --with-core     + school-core-api (role api, pnpm start:dev)
#
#   LOG_EXPORT=kafka                 kafka | rabbitmq | bullmq (engine and app)
#   CORE_DIR=~/Documents/Work/pluton-monorepo/packages/school-core-api
#   CORE_ENV=local                   OTEL_ENV of the app = the env to pick in the monitor
#   MONITOR_MODE=start               start (built .next) | dev (hot reload)
#
# Logs: .demo/stack-engine.log, .demo/stack-monitor.log, .demo/stack-core.log
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# skilllane-monitoring and its contract, linked from the sibling repo.
SDK_ROOT="${SDK_ROOT:-$ROOT/../skilllane-monitoring}"
LOG_DIR="$ROOT/.demo"
mkdir -p "$LOG_DIR"

WITH_CORE=0
[ "${1:-}" = "--with-core" ] && WITH_CORE=1

export LOG_EXPORT="${LOG_EXPORT:-kafka}"
CORE_DIR="${CORE_DIR:-$HOME/Documents/Work/pluton-monorepo/packages/school-core-api}"
CORE_ENV="${CORE_ENV:-local}"
MONITOR_MODE="${MONITOR_MODE:-start}"

# Connection the app needs to reach the POC's broker (host ports of docker-compose.yml).
case "$LOG_EXPORT" in
  kafka) APP_QUEUE_ENV=(LOG_KAFKA_BROKERS=localhost:29092) ;;
  rabbitmq) APP_QUEUE_ENV=(LOG_RABBITMQ_URL=amqp://skilllane_monitoring:skilllane_monitoring@localhost:5673/) ;;
  bullmq) APP_QUEUE_ENV=(LOG_BULLMQ_REDIS_URL=redis://localhost:6390/0) ;;
  *) echo "LOG_EXPORT must be kafka, rabbitmq or bullmq (got: $LOG_EXPORT)" >&2; exit 64 ;;
esac

[ -f "$ROOT/.env" ] || cp "$ROOT/.env.example" "$ROOT/.env"

PIDS=()
stop_all() {
  echo
  echo "Stopping…"
  # The app first, so its last telemetry reaches the queue before the engine stops.
  for ((i = ${#PIDS[@]} - 1; i >= 0; i--)); do
    kill -TERM "${PIDS[$i]}" 2>/dev/null || true
    wait "${PIDS[$i]}" 2>/dev/null || true
  done
  echo "Stopped. Infra is still up: (cd $ROOT && docker compose stop)"
}
trap stop_all INT TERM

wait_http() { # wait_http <url> <name> <seconds>
  for _ in $(seq 1 "$3"); do
    curl -fs -o /dev/null "$1" && { echo "  $2 ready"; return 0; }
    sleep 1
  done
  echo "  $2 did not answer at $1 (see logs in $LOG_DIR)" >&2
  return 1
}

echo "1/4 Infra (ClickHouse, Kafka, RabbitMQ, Redis)…"
(cd "$ROOT" && docker compose up -d --wait >/dev/null)

echo "2/4 Engine :5100 (LOG_EXPORT=$LOG_EXPORT)…"
[ -f "$ROOT/apps/engine/dist/main.js" ] || { (cd "$SDK_ROOT" && pnpm build >/dev/null) && (cd "$ROOT" && pnpm --filter @skilllane/monitoring-engine build >/dev/null); }
(cd "$ROOT" && exec node apps/engine/dist/main.js) >"$LOG_DIR/stack-engine.log" 2>&1 &
PIDS+=($!)
wait_http http://localhost:5100/api/health engine 60

echo "3/4 Monitor :3300 ($MONITOR_MODE)…"
if [ "$MONITOR_MODE" = start ] && [ ! -f "$ROOT/apps/monitor/.next/BUILD_ID" ]; then
  (cd "$ROOT" && pnpm --filter @skilllane/monitoring-monitor build >"$LOG_DIR/stack-monitor-build.log" 2>&1)
fi
(cd "$ROOT" && exec pnpm --filter @skilllane/monitoring-monitor "$MONITOR_MODE") >"$LOG_DIR/stack-monitor.log" 2>&1 &
PIDS+=($!)
wait_http http://localhost:3300 monitor 90

if [ "$WITH_CORE" = 1 ]; then
  echo "4/4 school-core-api (role api, OTEL_ENV=$CORE_ENV)…"
  (
    cd "$CORE_DIR"
    exec env LOGGING_ENGINE=new LOG_EXPORT="$LOG_EXPORT" "${APP_QUEUE_ENV[@]}" \
      OTEL_SERVICE_NAME=school-core-api OTEL_ENV="$CORE_ENV" \
      SERVICE_VERSION="${SERVICE_VERSION:-0.0.0-local}" \
      pnpm start:dev
  ) >"$LOG_DIR/stack-core.log" 2>&1 &
  PIDS+=($!)
else
  echo "4/4 (skipped) start the app yourself with:"
  echo "    LOG_EXPORT=$LOG_EXPORT ${APP_QUEUE_ENV[*]} OTEL_ENV=$CORE_ENV pnpm start:dev"
fi

cat <<EOF

Running. Ctrl-C stops what this script started.
  Monitor     http://localhost:3300/overview?env=$CORE_ENV
  Engine API  http://localhost:5100/api/health
  ClickHouse  http://localhost:8123/play  (skilllane_monitoring_reader / skilllane_monitoring_reader)
  Logs        $LOG_DIR/stack-*.log
EOF

wait
