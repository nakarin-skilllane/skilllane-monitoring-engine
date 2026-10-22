#!/usr/bin/env bash
# Deploy skilllane-monitoring on one machine, from git: clone this repo, build the images
# there, docker compose up. The SDK and the wire contract come from npm (skilllane-monitoring). Made for an Ubuntu 24.04 VM (Oracle A1 or any VPS); on macOS it
# runs the same steps without the Docker install / firewall part, as a local rehearsal.
# Idempotent: run it again to pull the latest commits and rebuild.
#
#   bash setup-vm.sh
#
# Settings (env):
#   WORKDIR       where the repo is checked out   (default $HOME/skilllane-monitoring-deploy)
#   ENGINE_REPO   git URL of this repo            (default github nakarin-skilllane/skilllane-monitoring-engine)
#   BRANCH        branch to deploy                (default main)
#   SOURCE        clone (default) | local — local copies the working tree from LOCAL_ENGINE
#                 instead of cloning: for checking uncommitted work, never for a VM
#
# What it does:
#   1. [Linux] Docker Engine + compose plugin
#   2. clone or pull the repo into WORKDIR
#   3. .env at the repo root (deploy/.env links to it) from .env.example with random secrets
#      and no dev queues (kept when it exists; an older deploy/.env file is moved there)
#   4. docker compose build (both images, on this machine) and docker compose up -d
set -euo pipefail

WORKDIR="${WORKDIR:-$HOME/skilllane-monitoring-deploy}"
ENGINE_REPO="${ENGINE_REPO:-https://github.com/nakarin-skilllane/skilllane-monitoring-engine.git}"
BRANCH="${BRANCH:-main}"
SOURCE="${SOURCE:-clone}"
OS="$(uname -s)"

say() { printf '\n\033[1m[setup] %s\033[0m\n' "$*"; }
rand() { openssl rand -hex "$1"; }

# ---- 1. host: Docker (Linux only) ---------------------------------------------------------
DOCKER="docker"
if [ "$OS" = Linux ]; then
  if ! command -v docker >/dev/null 2>&1; then
    say "installing Docker Engine"
    curl -fsSL https://get.docker.com | sudo sh
  fi
  if ! id -nG "$USER" | grep -qw docker; then
    sudo usermod -aG docker "$USER"
    say "added $USER to the docker group (active at next login; using sudo now)"
  fi
  docker info >/dev/null 2>&1 || DOCKER="sudo docker"
  command -v git >/dev/null 2>&1 || sudo apt-get install -y git

else
  say "$OS: skipping Docker install (local rehearsal)"
  docker info >/dev/null 2>&1 || { echo "Docker is not running"; exit 1; }
fi

# ---- 2. source --------------------------------------------------------------------------
mkdir -p "$WORKDIR"
fetch() { # fetch <repo url> <dir> <local path>
  local url=$1 dir=$2 local_path=$3
  if [ "$SOURCE" = local ]; then
    [ -d "$local_path" ] || { echo "SOURCE=local: $local_path not found"; exit 1; }
    say "copying working tree $local_path → $dir"
    rsync -a --delete --exclude node_modules --exclude .git --exclude dist --exclude .next \
      --exclude .demo --exclude '*.log' --exclude '.env' --exclude .DS_Store "$local_path/" "$dir/"
  elif [ -d "$dir/.git" ]; then
    say "updating $dir ($BRANCH)"
    git -C "$dir" fetch --quiet origin "$BRANCH" && git -C "$dir" checkout --quiet "$BRANCH" && git -C "$dir" pull --quiet --ff-only origin "$BRANCH"
  else
    say "cloning $url ($BRANCH) → $dir"
    git clone --quiet --branch "$BRANCH" "$url" "$dir"
  fi
}
fetch "$ENGINE_REPO" "$WORKDIR/skilllane-monitoring-engine" "${LOCAL_ENGINE:-}"

ROOT="$WORKDIR/skilllane-monitoring-engine"
DEPLOY="$ROOT/deploy"
cd "$ROOT"
if [ "$SOURCE" = local ]; then TAG="local-$(date +%Y%m%d%H%M)"
else TAG="$(git -C "$ROOT" rev-parse --short HEAD)"; fi

# ---- 3. .env (repo root; deploy/.env is a link to it) -------------------------------------
# A deploy made before the single .env kept its own file in deploy/: it becomes the root one.
if [ -f deploy/.env ] && [ ! -L deploy/.env ]; then
  [ ! -e .env ] || { echo "Both .env and deploy/.env exist: merge them into .env, delete deploy/.env, re-run"; exit 1; }
  mv deploy/.env .env && say "moved deploy/.env → .env"
fi
if [ ! -f .env ]; then
  # .env.example carries the dev stack's queues and CORS: a deploy starts with HTTP ingest only.
  awk -v t="$TAG" \
      -v p1="$(rand 24)" -v p2="$(rand 24)" -v p3="$(rand 12)" -v p4="$(rand 32)" -v p5="$(rand 32)" '
    /^IMAGE_TAG=/                            { print "IMAGE_TAG=" t; next }
    /^CLICKHOUSE_PASSWORD=/                  { print "CLICKHOUSE_PASSWORD=" p1; next }
    /^CLICKHOUSE_READER_PASSWORD=/           { print "CLICKHOUSE_READER_PASSWORD=" p2; next }
    /^SKILLLANE_MONITORING_ADMIN_PASSWORD=/  { print "SKILLLANE_MONITORING_ADMIN_PASSWORD=" p3; next }
    /^SKILLLANE_MONITORING_AUTH_SECRET=/     { print "SKILLLANE_MONITORING_AUTH_SECRET=" p4; next }
    /^ENGINE_INGEST_TOKEN=/                  { print "ENGINE_INGEST_TOKEN=" p5; next }
    /^(LOG_KAFKA_BROKERS|LOG_RABBITMQ_URL|LOG_BULLMQ_REDIS_URL|ENGINE_CORS_ORIGIN)=/ { sub(/=.*/, "="); print; next }
    { print }' .env.example > .env
  chmod 600 .env
  say ".env written (random secrets; printed at the end)"
else
  # keep secrets, move the tag to this build
  awk -v t="$TAG" '/^IMAGE_TAG=/ { print "IMAGE_TAG=" t; next } { print }' .env > .env.tmp && mv .env.tmp .env && chmod 600 .env
  say ".env kept; IMAGE_TAG=$TAG"
fi
ln -sfn ../.env deploy/.env
cd "$DEPLOY"
env_get() { grep -E "^$1=" .env | cut -d= -f2-; }
[ -n "$(env_get CLICKHOUSE_S3_URL)" ] || say "CLICKHOUSE_S3_URL not set: cold storage off, everything stays on this disk"

# ---- 4. build + up -------------------------------------------------------------------------
say "building images on this machine (first time: several minutes)"
$DOCKER compose build
say "starting"
$DOCKER compose up -d --remove-orphans
say "waiting for the engine and the monitor"
for _ in $(seq 1 60); do
  st="$($DOCKER compose ps --format '{{.Service}}={{.Health}}' | tr '\n' ' ')"
  case "$st" in *"engine=healthy"*"monitor=healthy"*|*"monitor=healthy"*"engine=healthy"*) break;; esac
  sleep 5
done
$DOCKER compose ps --format 'table {{.Service}}\t{{.Status}}'

cat <<MSG

  monitor   http://localhost:3300      sign in: $(env_get SKILLLANE_MONITORING_ADMIN_USERNAME) / $(env_get SKILLLANE_MONITORING_ADMIN_PASSWORD)
  engine    http://localhost:5100/api/health
  apps      LOG_HTTP_URL=http://localhost:5100  LOG_HTTP_TOKEN=$(env_get ENGINE_INGEST_TOKEN)

  logs      cd $DEPLOY && docker compose logs -f engine
  update    bash $DEPLOY/setup-vm.sh      (pulls $BRANCH, rebuilds, restarts what changed)
MSG
