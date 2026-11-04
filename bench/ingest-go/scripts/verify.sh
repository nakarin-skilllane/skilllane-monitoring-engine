#!/usr/bin/env bash
# Posts every envelope of bench/fixture/envelopes.jsonl to a running ingest, with
# `deployment.environment.name` rewritten from `bench` to $BENCH_ENV (default
# bench-go), then compares the ClickHouse row counts for that env with the
# expected files. Run from anywhere; needs curl and the dev ClickHouse.
#
#   bench/ingest-go/scripts/verify.sh [http://localhost:5100]
#   BENCH_ENV=bench-go CLICKHOUSE_URL=http://localhost:8123 CLICKHOUSE_USER=… CLICKHOUSE_PASSWORD=…
#
# Afterwards, delete the rows (what the brief asks for):
#   bench/ingest-go/scripts/verify.sh --delete
set -euo pipefail
URL="${1:-http://localhost:5100}"
ENV_NAME="${BENCH_ENV:-bench-go}"
CH_URL="${CLICKHOUSE_URL:-http://localhost:8123}"
CH_USER="${CLICKHOUSE_USER:-skilllane_monitoring}"
CH_PASS="${CLICKHOUSE_PASSWORD:-skilllane_monitoring}"
CH_DB="${CLICKHOUSE_DATABASE:-skilllane_monitoring}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
FIXTURE="$ROOT/bench/fixture"

ch() { curl -sS --fail-with-body -u "$CH_USER:$CH_PASS" "$CH_URL/" --data-binary "$1"; }

if [ "${1:-}" = "--delete" ]; then
  ch "ALTER TABLE $CH_DB.logs DELETE WHERE env = '$ENV_NAME' SETTINGS mutations_sync = 2"
  ch "ALTER TABLE $CH_DB.spans DELETE WHERE env = '$ENV_NAME' SETTINGS mutations_sync = 2"
  echo "deleted env=$ENV_NAME: logs $(ch "SELECT count() FROM $CH_DB.logs WHERE env = '$ENV_NAME'") · spans $(ch "SELECT count() FROM $CH_DB.spans WHERE env = '$ENV_NAME'")"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# deployment.environment.name: bench → $ENV_NAME, nothing else touched
sed "s/\"deployment.environment.name\":\"bench\"/\"deployment.environment.name\":\"$ENV_NAME\"/" "$FIXTURE/envelopes.jsonl" > "$TMP/envelopes.jsonl"

codes="$TMP/codes"; : > "$codes"
n=0; start=$(date +%s)
while IFS= read -r line; do
  n=$((n+1))
  stream=$(printf '%s' "$line" | sed -E 's/^\{"v":1,"stream":"([a-z]+)".*/\1/')
  printf '%s' "$line" > "$TMP/body.json"
  curl -s -o /dev/null -w '%{http_code}\n' -H 'Content-Type: application/json' --data-binary "@$TMP/body.json" "$URL/api/ingest/$stream" >> "$codes"
done < "$TMP/envelopes.jsonl"
end=$(date +%s)
echo "posted $n envelopes in $((end-start)) s: status codes $(sort "$codes" | uniq -c | tr -s ' ' | tr '\n' ';')"

sleep 2
logs=$(ch "SELECT count() FROM $CH_DB.logs WHERE env = '$ENV_NAME'")
spans=$(ch "SELECT count() FROM $CH_DB.spans WHERE env = '$ENV_NAME'")
want_logs=$(wc -l < "$FIXTURE/expected-logs.jsonl" | tr -d ' ')
want_spans=$(wc -l < "$FIXTURE/expected-spans.jsonl" | tr -d ' ')
echo "clickhouse env=$ENV_NAME: logs $logs (expected $want_logs) · spans $spans (expected $want_spans)"
if [ "$logs" = "$want_logs" ] && [ "$spans" = "$want_spans" ]; then echo "row counts OK"; else echo "row counts DIFFER"; exit 1; fi
