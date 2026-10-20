#!/usr/bin/env bash
# Stops the demo app's own Redis (compose service redis-app, :6391) for
# CHAOS_DOWN_SECONDS (default 45), then starts it again. The demo apps log
# dependency.down → dependency.still_down (every 30 s) → dependency.up.
# Only redis-app: the telemetry Redis (:6390) and the brokers stay up.
set -o pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
DOWN="${CHAOS_DOWN_SECONDS:-45}"

bring_back() {
  echo "[chaos] $(date +%T) starting redis-app"
  docker compose start redis-app >/dev/null
}
trap 'echo "[chaos] interrupted"; bring_back; exit 130' INT TERM

echo "[chaos] $(date +%T) stopping redis-app (:6391) for ${DOWN}s"
docker compose stop redis-app >/dev/null || exit 1
sleep "$DOWN" &
wait $!
bring_back
echo "[chaos] $(date +%T) redis-app is back"
