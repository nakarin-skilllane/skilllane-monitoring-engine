#!/usr/bin/env bash
# skilllane-monitoring engine demo (SPEC §10): docker infra, engine, the three demo
# processes and the traffic generator; Ctrl-C (or SIGTERM) stops them all.
#
#   scripts/demo.sh <kafka|rabbitmq|bullmq> [env]      env defaults to dev
#   scripts/demo.sh stdout [env]     no queue: a local check of the apps only
#
#   DEMO_DURATION=<s>     stop by itself after s seconds (automated runs)
#   SKIP_BUILD=1          do not build the packages first
#   TRAFFIC_RPS=8         traffic generator rate
#   LOG_PRETTY=true       readable demo-app logs in .demo/ (false = JSON lines)
#   DEMO_ENGINE_PORT=5100 engine HTTP port
#   DEMO_DRAIN_SECONDS=20 on stop, wait up to this long for the engine to drain the queue
#   CORE_VERSION=0.2.0-demo     service.version of school-core-api (api + worker)
#   ETL_VERSION=0.2.0-demo      service.version of school-etl-api
#   SERVICE_VERSION=<version>   one version for all three demo processes (overrides both)
#
# Variables already in the environment win over .env, which wins over
# .env.example; LOG_EXPORT and OTEL_ENV come from the arguments.
# Logs: .demo/<name>.log.
# Written for the macOS bash 3.2 too (no set -u / associative arrays).
set -o pipefail

usage() {
  echo "usage: scripts/demo.sh <kafka|rabbitmq|bullmq|stdout> [env=dev]" >&2
  exit 2
}
TRANSPORT="${1:-}"
DEMO_ENV="${2:-dev}"
DEMO_ENV="${DEMO_ENV#env=}"
case "$TRANSPORT" in kafka | rabbitmq | bullmq | stdout) ;; *) usage ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# skilllane-monitoring and its contract, linked from the sibling repo.
SDK_ROOT="${SDK_ROOT:-$ROOT/../skilllane-monitoring}"
LOG_DIR="$ROOT/.demo"
DEMO_DIR="$ROOT/apps/demo-api"
ENGINE_DIR="$ROOT/apps/engine"
cd "$ROOT" || exit 1
mkdir -p "$LOG_DIR"

say() { printf '[demo] %s\n' "$*"; }
die() {
  say "$*"
  exit 1
}

# --- environment ---------------------------------------------------------------
# load_env <file>: KEY=VALUE lines; a variable that is already set wins.
load_env() {
  local line key value
  [ -f "$1" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | '#'*) continue ;; esac
    key=${line%%=*}
    value=${line#*=}
    case "$key" in '' | *[!A-Za-z0-9_]*) continue ;; esac
    value=${value%\"}
    value=${value#\"}
    [ -z "${!key+x}" ] && export "$key=$value"
  done <"$1"
}
load_env "$ROOT/.env"
load_env "$ROOT/.env.example"
export LOG_EXPORT="$TRANSPORT" OTEL_ENV="$DEMO_ENV"
# The version column / "new since deploy" read it; a caller's value wins, and
# SERVICE_VERSION (caller or .env) overrides the per-service ones.
CORE_VERSION="${SERVICE_VERSION:-${CORE_VERSION:-0.2.0-demo}}"
ETL_VERSION="${SERVICE_VERSION:-${ETL_VERSION:-0.2.0-demo}}"
unset NODE_OPTIONS # only the demo apps load skilllane-monitoring (the engine never does)
ENGINE_HTTP_PORT="${DEMO_ENGINE_PORT:-5100}"
ENGINE_URL="http://localhost:$ENGINE_HTTP_PORT"

for port in "$ENGINE_HTTP_PORT" 5101 5102; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    die "port $port is already in use; stop what runs there first"
  fi
done

# --- children ------------------------------------------------------------------
PIDS=()
NAMES=()
DEAD=()
TAIL_PID=""
STOPPED=0

# start <name> <dir> <command...>: output to .demo/<name>.log. Job control
# (set -m) only around the start: the child gets its own process group, so a
# terminal Ctrl-C reaches only this script, which then stops the children in
# order (the apps flush their telemetry before the engine stops).
start() {
  local name=$1 dir=$2
  shift 2
  set -m
  (cd "$dir" && exec "$@") >"$LOG_DIR/$name.log" 2>&1 &
  PIDS+=($!)
  set +m
  # Not a shell job any more: no "Terminated" reports; stop_all polls the pid.
  disown "$!" 2>/dev/null
  NAMES+=("$name")
}

pid_of() {
  local i
  for ((i = 0; i < ${#NAMES[@]}; i++)); do
    [ "${NAMES[$i]}" = "$1" ] && echo "${PIDS[$i]}"
  done
}

# stop_all <name...>: SIGTERM together, then wait up to 10 s, then SIGKILL.
stop_all() {
  local name pid pids="" n
  for name in "$@"; do
    pid=$(pid_of "$name")
    [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null && pids="$pids $pid"
  done
  for ((n = 0; n < 50; n++)); do
    local alive=""
    for pid in $pids; do kill -0 "$pid" 2>/dev/null && alive="$alive $pid"; done
    [ -z "$alive" ] && return 0
    sleep 0.2
  done
  for pid in $pids; do kill -KILL "$pid" 2>/dev/null; done
}

# wait_drain: the apps flush their last batch on exit; let the engine write it
# (GET /api/health pending = 0) before it stops, so nothing stays on the queue.
wait_drain() {
  local n p="" pid limit=$((${DEMO_DRAIN_SECONDS:-20} * 2))
  [ "$TRANSPORT" = stdout ] && return 0
  pid=$(pid_of engine)
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 0
  for ((n = 0; n < limit; n++)); do
    p=$(curl -fsS --max-time 2 "$ENGINE_URL/api/health" 2>/dev/null | sed -n 's/.*"pending":\([0-9][0-9]*\).*/\1/p')
    [ "$p" = 0 ] && return 0
    sleep 0.5
  done
  say "the engine still has ${p:-?} message(s) pending; they stay on the queue for the next run"
}

cleanup() {
  [ "$STOPPED" = 1 ] && return
  STOPPED=1
  trap - INT TERM
  [ ${#PIDS[@]} -gt 0 ] && say "stopping (traffic, then the demo apps, then the engine)…"
  stop_all traffic
  sleep 0.3 # the traffic total line reaches the terminal
  [ -n "$TAIL_PID" ] && kill "$TAIL_PID" 2>/dev/null
  stop_all school-core-api school-core-worker school-etl-api
  wait_drain
  stop_all engine
  wait 2>/dev/null
  [ ${#PIDS[@]} -gt 0 ] && say "stopped. Logs are in .demo/"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# wait_http <name> <url> <seconds>
wait_http() {
  local name=$1 url=$2 limit=$3 n pid
  pid=$(pid_of "$name")
  for ((n = 0; n < limit; n++)); do
    curl -fsS -o /dev/null --max-time 2 "$url" 2>/dev/null && return 0
    if ! kill -0 "$pid" 2>/dev/null; then
      say "$name exited during startup. Last lines of .demo/$name.log:"
      tail -n 25 "$LOG_DIR/$name.log"
      exit 1
    fi
    sleep 1
  done
  die "$name did not answer $url within ${limit}s; see .demo/$name.log"
}

# --- 1. infra ------------------------------------------------------------------
say "docker infra (compose project skilllane-monitoring-engine)…"
docker compose up -d --wait >"$LOG_DIR/infra.log" 2>&1 ||
  {
    tail -n 25 "$LOG_DIR/infra.log"
    die "docker compose up failed (is Docker Desktop running?)"
  }

# --- 2. build ------------------------------------------------------------------
if [ "${SKIP_BUILD:-0}" != 1 ]; then
  say "building contract, SDK ($SDK_ROOT), engine, demo-api…"
  (cd "$SDK_ROOT" && pnpm build) >"$LOG_DIR/build-sdk.log" 2>&1 || die "SDK build failed; see .demo/build-sdk.log"
  pnpm --filter "@skilllane/monitoring-engine..." --filter "@skilllane/monitoring-demo-api..." build >"$LOG_DIR/build.log" 2>&1 ||
    {
      tail -n 30 "$LOG_DIR/build.log"
      die "build failed; see .demo/build.log"
    }
fi

# --- 3. engine -----------------------------------------------------------------
say "engine (ENGINE_ROLE=all, :$ENGINE_HTTP_PORT, LOG_EXPORT=$TRANSPORT)…"
start engine "$ENGINE_DIR" env ENGINE_ROLE=all ENGINE_PORT="$ENGINE_HTTP_PORT" NO_COLOR=1 node dist/main.js
wait_http engine "$ENGINE_URL/api/health" 90

# --- 4. demo apps --------------------------------------------------------------
say "demo apps (school-core-api api + worker, school-etl-api)…"
APP_ENV=(env NODE_OPTIONS="--require skilllane-monitoring/register" LOG_PRETTY="${LOG_PRETTY:-true}")
start school-etl-api "$DEMO_DIR" "${APP_ENV[@]}" SERVICE_VERSION="$ETL_VERSION" \
  DEMO_SERVICE=etl APP_ROLE=api OTEL_SERVICE_NAME=school-etl-api DEMO_PORT=5102 node dist/src/main.js
start school-core-worker "$DEMO_DIR" "${APP_ENV[@]}" SERVICE_VERSION="$CORE_VERSION" \
  DEMO_SERVICE=core APP_ROLE=worker OTEL_SERVICE_NAME=school-core-api node dist/src/main.js
start school-core-api "$DEMO_DIR" "${APP_ENV[@]}" SERVICE_VERSION="$CORE_VERSION" \
  DEMO_SERVICE=core APP_ROLE=api OTEL_SERVICE_NAME=school-core-api DEMO_PORT=5101 \
  DEMO_ETL_URL=http://localhost:5102 node dist/src/main.js
wait_http school-etl-api "http://localhost:5102/health" 60
wait_http school-core-api "http://localhost:5101/health" 60

# --- 5. traffic ----------------------------------------------------------------
start traffic "$DEMO_DIR" env TRAFFIC_URL=http://localhost:5101 \
  TRAFFIC_RPS="${TRAFFIC_RPS:-8}" node scripts/traffic.js

# --- where to look ---------------------------------------------------------------
E="env=$DEMO_ENV"
cat <<INFO

  transport $TRANSPORT · env $DEMO_ENV · version school-core-api $CORE_VERSION, school-etl-api $ETL_VERSION · logs .demo/<name>.log
  engine     $ENGINE_URL/api/health
             $ENGINE_URL/api/overview?$E&from=now-15m
             $ENGINE_URL/api/logs?$E
             $ENGINE_URL/api/errors?$E
             $ENGINE_URL/api/traces?$E
             $ENGINE_URL/api/jobs?$E
             $ENGINE_URL/api/dependencies?$E
  demo apps  school-core-api http://localhost:5101 · school-etl-api http://localhost:5102
INFO
case "$TRANSPORT" in
kafka) echo "  queue      Kafka localhost:29092, topics ${LOG_TOPIC_LOGS:-skilllane-monitoring.logs} / ${LOG_TOPIC_SPANS:-skilllane-monitoring.spans}" ;;
rabbitmq) echo "  queue      RabbitMQ UI http://localhost:15673 (skilllane_monitoring / skilllane_monitoring), exchange ${LOG_RABBITMQ_EXCHANGE:-skilllane-monitoring.telemetry}" ;;
bullmq) echo "  queue      BullMQ on redis://localhost:6390, queues ${LOG_BULLMQ_PREFIX:-bull}:${LOG_TOPIC_LOGS:-skilllane-monitoring.logs} / ${LOG_BULLMQ_PREFIX:-bull}:${LOG_TOPIC_SPANS:-skilllane-monitoring.spans}" ;;
stdout) echo "  queue      none (stdout): the engine ingests nothing; the apps only log to .demo/" ;;
esac
cat <<INFO
  clickhouse http://localhost:8123/play (skilllane_monitoring_reader / skilllane_monitoring_reader), database skilllane_monitoring
  chaos      scripts/chaos-redis.sh   (stops the app Redis :6391 for 45 s)
  stop       Ctrl-C${DEMO_DURATION:+ (or after ${DEMO_DURATION}s)}

INFO

# Show the traffic summary lines here; everything else stays in .demo/.
tail -n +1 -F "$LOG_DIR/traffic.log" 2>/dev/null &
TAIL_PID=$!
disown "$TAIL_PID" 2>/dev/null

STARTED=$(date +%s)
while :; do
  sleep 1
  for ((i = 0; i < ${#PIDS[@]}; i++)); do
    if [ -z "${DEAD[$i]}" ] && ! kill -0 "${PIDS[$i]}" 2>/dev/null; then
      DEAD[$i]=1
      say "${NAMES[$i]} exited; see .demo/${NAMES[$i]}.log"
    fi
  done
  if [ -n "$DEMO_DURATION" ] && [ $(($(date +%s) - STARTED)) -ge "$DEMO_DURATION" ]; then
    say "DEMO_DURATION=${DEMO_DURATION}s reached"
    exit 0
  fi
done
