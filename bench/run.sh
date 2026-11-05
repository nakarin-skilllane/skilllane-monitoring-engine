#!/usr/bin/env bash
# Runs the whole benchmark for one or more targets, one target at a time, and writes bench/results/<target>-*.json.
# Needs only Docker (compose v2): the verifier / load generator runs as the `loadgen` container on the stack's network.
#
#   bench/run.sh node go rust dotnet            every target, every profile, 3 runs
#   RUNS=1 PROFILES=logs bench/run.sh go        a quick pass
#   STEPS=8,16,32 STEP_SECONDS=10 …             shorter ramps (default 8…256 connections, 30 s each)
#   BENCH_INFLIGHT=512 BENCH_FLUSH_ROWS=20000 OUT=bench/results-wide PROFILES=mixed STEPS=64,128,256,512 bench/run.sh …
#                                               an HTTP-only pass without the engine's 64-in-flight cap
#
# Per target: build its image → truncate the bench tables → start it → verify (correctness gate, fails the target)
# → for each profile and run: HTTP ramp with docker stats sampled every second → Kafka drain (produce first, then
# restart the target with a fresh consumer group so the drain time is the consumer's) → stop it.
set -euo pipefail
cd "$(dirname "$0")/.."
C="docker compose -f bench/docker-compose.yml"
RUNS=${RUNS:-3}
PROFILES=${PROFILES:-logs spans mixed}
STEPS=${STEPS:-8,16,32,64,128,256}
STEP_SECONDS=${STEP_SECONDS:-30}
KAFKA_ROWS=${KAFKA_ROWS:-500000}
# KAFKA_RUNS=0 skips the Kafka part (an HTTP-only pass); OUT keeps a pass apart (bench/results-inflight512)
KAFKA_RUNS=${KAFKA_RUNS:-$RUNS}
OUT=${OUT:-bench/results}
# the loadgen container writes to /app/results: mount OUT there (a path relative to bench/, where the compose file is)
export BENCH_OUT="./$(basename "$OUT")"
mkdir -p "$OUT"
say() { printf '\n[bench %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
ch() { $C exec -T clickhouse clickhouse-client --user skilllane_monitoring --password skilllane_monitoring -q "$1"; }
load() { $C --profile load run --rm -T loadgen "$@"; }

truncate_tables() { for t in logs spans; do ch "TRUNCATE TABLE skilllane_monitoring.$t"; done; }
# Empty the Kafka topics: a target's fresh consumer group would otherwise start at the beginning of what earlier runs
# produced (and consume it while the HTTP ramp runs, or drain 1.5M rows while being credited for 500k).
reset_topics() {
  for t in skilllane-monitoring.logs skilllane-monitoring.spans; do
    $C exec -T kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --delete --topic "$t" >/dev/null 2>&1 || true
  done
  sleep 3
  for t in skilllane-monitoring.logs skilllane-monitoring.spans; do
    $C exec -T kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --create --topic "$t" --partitions 3 --replication-factor 1 >/dev/null
  done
}
apply_schema() {
  ch "CREATE DATABASE IF NOT EXISTS skilllane_monitoring"
  $C exec -T clickhouse clickhouse-client --user skilllane_monitoring --password skilllane_monitoring --multiquery < clickhouse/schema.sql
}

# docker stats of a container every second into a csv until the .run marker is removed
stats_start() { # $1 container $2 out.csv
  : > "$2"
  touch "$2.run"
  ( while [ -f "$2.run" ]; do docker stats --no-stream --format '{{.CPUPerc}},{{.MemUsage}}' "$1" >> "$2" 2>/dev/null || true; sleep 1; done ) &
}
stats_stop() { rm -f "$1.run"; sleep 1.5; }

wait_healthy() { # $1 target
  for i in $(seq 1 90); do
    if load load/health.mjs "http://ingest-$1:5100" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  say "$1: did not answer /api/health in 90 s"; return 1
}

say "stack: clickhouse + kafka + loadgen image"
$C up -d --wait clickhouse kafka
$C --profile load build loadgen
apply_schema

for target in "$@"; do
  svc="ingest-$target"
  say "$target: build"
  $C --profile "$target" build "$svc"
  truncate_tables
  reset_topics
  say "$target: start"
  $C --profile "$target" up -d "$svc"
  wait_healthy "$target"
  cid=$($C --profile "$target" ps -q "$svc")
  docker image inspect "bench-$svc" --format '{{.Size}}' > "$OUT/$target-image-bytes.txt"

  say "$target: verify (correctness gate)"
  if ! load load/verify.mjs --url "http://$svc:5100" --env "bench-$target" --delete | tee "$OUT/$target-verify.txt"; then
    say "$target: VERIFY FAILED — not benchmarked"
    $C --profile "$target" stop "$svc"
    continue
  fi

  for profile in $PROFILES; do
    for run in $(seq 1 "$RUNS"); do
      say "$target: http $profile run $run"
      truncate_tables
      stats_start "$cid" "$OUT/$target-http-$profile-$run.stats.csv"
      load load/load.mjs http --url "http://$svc:5100" --profile "$profile" --env bench-load --steps "$STEPS" --step-seconds "$STEP_SECONDS" --out "results/$target-http-$profile-$run.json"
      stats_stop "$OUT/$target-http-$profile-$run.stats.csv"
    done
  done

  for run in $(seq 1 "$KAFKA_RUNS"); do
    say "$target: kafka run $run (produce, then restart the consumer with a fresh group)"
    $C --profile "$target" stop "$svc"
    truncate_tables
    reset_topics
    group="bench-$target-$run"
    load load/load.mjs kafka --rows "$KAFKA_ROWS" --profile logs --env bench-load --consumer-group "$group" --topic-wait 900 --out "results/$target-kafka-$run.json" &
    loadpid=$!
    sleep 8
    # the Node engine names its group through ENGINE_CONSUMER_GROUP; the prototypes through BENCH_CONSUMER_GROUP
    ENGINE_CONSUMER_GROUP="$group" BENCH_CONSUMER_GROUP="$group" $C --profile "$target" up -d "$svc"
    cid=$($C --profile "$target" ps -q "$svc")
    stats_start "$cid" "$OUT/$target-kafka-$run.stats.csv"
    wait $loadpid
    stats_stop "$OUT/$target-kafka-$run.stats.csv"
  done

  say "$target: stop"
  $C --profile "$target" stop "$svc"
done

say "done → $OUT (node bench/load/summarize.mjs for RESULTS.md)"
