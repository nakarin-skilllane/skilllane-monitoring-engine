#!/usr/bin/env bash
# Long-running local stack for building and showing the monitor UI:
# scripts/demo.sh (engine :5100 + demo apps + traffic) detached from the
# terminal, plus the monitor (Next.js :3300) when apps/monitor exists.
#
#   scripts/live.sh start | stop | restart | status | seed | monitor | stack
#   (monitor = restart only the Next.js monitor (the stack must be running);
#    stack = restart only demo.sh — engine, demo apps, traffic — and leave the monitor running)
#
#   LIVE_TRANSPORT=kafka     queue for demo.sh
#   LIVE_ENV=prod            env of the live traffic (the seed uses prod too)
#   CORE_VERSION=31.4.0      school-core-api: the seeded deploy's version, so live errors are not "new"
#   ETL_VERSION=4.2.1        school-etl-api: its seeded version, so it shows no deploy
#   SERVICE_VERSION=<v>      one version for all three demo processes (overrides both)
#   TRAFFIC_RPS=1            close to the seeded rate
#   MONITOR_MODE=start       start = production (next start), the way the monitor is demoed: when
#                            apps/monitor/.next is missing or older than any monitor source, it runs
#                            `pnpm --filter @skilllane/monitoring-monitor build` first (log .demo/monitor-build.log);
#                            dev = next dev (hot reload, slower pages, dev overlay)
#   SKIP_BUILD=0             1 = reuse dist/ of the packages (the monitor build check above still runs)
#
# Logs: .demo/live.out (demo.sh), .demo/<name>.log (children), .demo/monitor.log.
set -o pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/.demo"
mkdir -p "$LOG_DIR"
STACK_PID="$LOG_DIR/live.pid"
MONITOR_PID="$LOG_DIR/monitor.pid"
MONITOR_MODE_FILE="$LOG_DIR/monitor.mode"
MONITOR_DIR="$ROOT/apps/monitor"
say() { printf '[live] %s\n' "$*"; }

# detach <pidfile> <log> <command...>: own session (survives the caller's shell)
detach() {
  local pidfile=$1 log=$2
  shift 2
  PIDF="$pidfile" nohup perl -MPOSIX -e '
    my $p = fork; die "fork: $!" unless defined $p;
    if ($p) { open my $f, ">", $ENV{PIDF} or die; print $f $p; close $f; exit 0 }
    POSIX::setsid(); exec @ARGV or die "exec: $!"' -- "$@" >"$log" 2>&1 </dev/null &
  wait $! 2>/dev/null
}

alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

# running_mode: start | dev of the running monitor (.demo/monitor.mode, else its command line), ? when unknown
running_mode() {
  local m
  m=$(cat "$MONITOR_MODE_FILE" 2>/dev/null)
  [ -n "$m" ] || m=$(ps -o command= -p "$(cat "$MONITOR_PID")" 2>/dev/null | sed -nE 's/.*run (start|dev).*/\1/p')
  echo "${m:-?}"
}

# monitor_build_fresh: .next/BUILD_ID exists and no monitor source is newer than it
monitor_build_fresh() {
  local id="$MONITOR_DIR/.next/BUILD_ID" src newer
  [ -f "$id" ] || return 1
  for src in app components lib public scripts next.config.ts package.json tsconfig.json; do
    [ -e "$MONITOR_DIR/$src" ] || continue
    newer=$(find "$MONITOR_DIR/$src" -newer "$id" -type f -print -quit 2>/dev/null)
    [ -z "$newer" ] || return 1
  done
  return 0
}

wait_url() {
  local url=$1 limit=$2 n
  for ((n = 0; n < limit; n++)); do
    curl -fsS -o /dev/null --max-time 2 "$url" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

start_stack() {
  if alive "$STACK_PID"; then
    say "stack already running (pid $(cat "$STACK_PID"))"
  else
    say "starting demo.sh ${LIVE_TRANSPORT:-kafka} ${LIVE_ENV:-prod} (log .demo/live.out)…"
    (cd "$ROOT" && CORE_VERSION="${CORE_VERSION:-31.4.0}" ETL_VERSION="${ETL_VERSION:-4.2.1}" TRAFFIC_RPS="${TRAFFIC_RPS:-1}" \
      SKIP_BUILD="${SKIP_BUILD:-0}" detach "$STACK_PID" "$LOG_DIR/live.out" \
      bash scripts/demo.sh "${LIVE_TRANSPORT:-kafka}" "${LIVE_ENV:-prod}")
    if wait_url http://localhost:5101/health 240; then
      say "engine http://localhost:5100 · demo apps :5101 :5102 · traffic on"
    else
      say "stack did not come up; last lines of .demo/live.out:"
      tail -n 30 "$LOG_DIR/live.out"
      return 1
    fi
  fi
  [ -f "$ROOT/apps/monitor/package.json" ] || return 0
  if alive "$MONITOR_PID"; then
    say "monitor already running (pid $(cat "$MONITOR_PID"), next $(running_mode))"
    return 0
  fi
  local mode=${MONITOR_MODE:-start}
  case $mode in
  start | dev) ;;
  *)
    say "MONITOR_MODE must be start or dev (got '$mode')"
    return 1
    ;;
  esac
  # never build or start over a monitor this script did not start (it serves .next); a stopped one
  # may hold the port for a moment
  local n
  for ((n = 0; n < 10; n++)); do
    lsof -nP -iTCP:3300 -sTCP:LISTEN >/dev/null 2>&1 || break
    sleep 1
  done
  if lsof -nP -iTCP:3300 -sTCP:LISTEN >/dev/null 2>&1; then
    say "port 3300 is in use by another process; monitor not started (stop it, then scripts/live.sh monitor)"
    return 1
  fi
  if [ "$mode" = start ] && ! monitor_build_fresh; then
    say "monitor: .next missing or older than the sources: building (pnpm --filter @skilllane/monitoring-monitor build, log .demo/monitor-build.log)…"
    if ! (cd "$ROOT" && pnpm --filter @skilllane/monitoring-monitor build >"$LOG_DIR/monitor-build.log" 2>&1); then
      say "monitor build failed; last lines of .demo/monitor-build.log:"
      tail -n 30 "$LOG_DIR/monitor-build.log"
      return 1
    fi
  fi
  say "starting monitor (next $mode, :3300, log .demo/monitor.log)…"
  echo "$mode" >"$MONITOR_MODE_FILE"
  (cd "$MONITOR_DIR" && detach "$MONITOR_PID" "$LOG_DIR/monitor.log" pnpm run "$mode")
  if wait_url http://localhost:3300/ 120; then
    say "monitor http://localhost:3300"
  else
    say "monitor did not answer; last lines of .demo/monitor.log:"
    tail -n 30 "$LOG_DIR/monitor.log"
    return 1
  fi
}

# stop_pid <pidfile> <seconds>: SIGTERM the session, wait, then SIGKILL
stop_pid() {
  local pidfile=$1 limit=$(($2 * 5)) pid n
  alive "$pidfile" || { rm -f "$pidfile"; return 0; }
  pid=$(cat "$pidfile")
  kill -TERM "$pid" 2>/dev/null
  for ((n = 0; n < limit; n++)); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
  done
  kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null
  # whatever is left in that session (next dev workers)
  pkill -TERM -s "$pid" 2>/dev/null
  rm -f "$pidfile"
}

stop_stack() {
  say "stopping monitor…"
  stop_pid "$MONITOR_PID" 10 && rm -f "$MONITOR_MODE_FILE"
  say "stopping demo stack (drains the queue first)…"
  stop_pid "$STACK_PID" 60
  local port
  for port in 5100 5101 5102 3300; do
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && say "port $port still in use"
  done
  return 0
}

status() {
  alive "$STACK_PID" && say "stack pid $(cat "$STACK_PID")" || say "stack stopped"
  if alive "$MONITOR_PID"; then
    local fresh=''
    [ "$(running_mode)" = start ] && ! monitor_build_fresh && fresh=' · sources changed since the build: scripts/live.sh monitor rebuilds'
    say "monitor pid $(cat "$MONITOR_PID") (next $(running_mode))$fresh"
  else
    say "monitor stopped"
  fi
  curl -fsS --max-time 2 http://localhost:5100/api/health 2>/dev/null && echo
}

case "${1:-}" in
start) start_stack ;;
stop) stop_stack ;;
restart) stop_stack && start_stack ;;
status) status ;;
seed) (cd "$ROOT" && node apps/engine/scripts/seed-demo.js) ;;
stack)
  say "stopping demo stack (drains the queue first)…"
  stop_pid "$STACK_PID" 60
  start_stack
  ;;
monitor)
  stop_pid "$MONITOR_PID" 10 && rm -f "$MONITOR_MODE_FILE"
  alive "$STACK_PID" || { say "stack is not running; use start"; exit 1; }
  start_stack
  ;;
*)
  echo "usage: scripts/live.sh start|stop|restart|status|seed|monitor|stack" >&2
  exit 2
  ;;
esac
