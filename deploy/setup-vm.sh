#!/usr/bin/env bash
# Deploy skilllane-monitoring on one machine, from git: clone this repo, build the images
# there, docker compose up. The SDK and the wire contract come from npm (skilllane-monitoring). Made for an Ubuntu 24.04 VM (Oracle A1 or any VPS); on macOS it
# runs the same steps without the Docker install / firewall part, as a local rehearsal.
# Idempotent: run it again to pull the latest commits and rebuild.
#
#   DOMAIN=monitor.example.com-less-domain bash setup-vm.sh      # on the VM (asks when unset)
#   bash setup-vm.sh                                              # on a Mac: DOMAIN=localhost
#
# Settings (env):
#   DOMAIN        public domain: monitor.<DOMAIN> and engine.<DOMAIN> must point at this machine
#   WORKDIR       where the repo is checked out   (default $HOME/skilllane-monitoring-deploy)
#   ENGINE_REPO   git URL of this repo            (default github nakarin-skilllane/skilllane-monitoring-engine)
#   BRANCH        branch to deploy                (default main)
#   SOURCE        clone (default) | local — local copies the working tree from LOCAL_ENGINE
#                 instead of cloning: for checking uncommitted work, never for a VM
#
# What it does:
#   1. [Linux] Docker Engine + compose plugin; open 80/443 in the host iptables (Oracle's
#      Ubuntu image rejects everything but 22 there — the VCN security list is separate)
#   2. clone or pull the repo into WORKDIR
#   3. deploy/.env from .env.example with random secrets (kept when it exists)
#   4. docker compose build (both images, on this machine) and docker compose up -d
set -euo pipefail

WORKDIR="${WORKDIR:-$HOME/skilllane-monitoring-deploy}"
ENGINE_REPO="${ENGINE_REPO:-https://github.com/nakarin-skilllane/skilllane-monitoring-engine.git}"
BRANCH="${BRANCH:-main}"
SOURCE="${SOURCE:-clone}"
OS="$(uname -s)"

say() { printf '\n\033[1m[setup] %s\033[0m\n' "$*"; }
rand() { openssl rand -hex "$1"; }

# ---- 1. host: Docker + firewall (Linux only) -------------------------------------------
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

  if sudo iptables -S INPUT | grep -q -- '-j REJECT'; then
    for port in 80 443; do
      sudo iptables -C INPUT -p tcp --dport "$port" -m conntrack --ctstate NEW,ESTABLISHED -j ACCEPT 2>/dev/null \
        || sudo iptables -I INPUT 5 -p tcp --dport "$port" -m conntrack --ctstate NEW,ESTABLISHED -j ACCEPT
    done
    sudo iptables -C INPUT -p udp --dport 443 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 5 -p udp --dport 443 -j ACCEPT
    if command -v netfilter-persistent >/dev/null 2>&1; then sudo netfilter-persistent save >/dev/null
    else sudo mkdir -p /etc/iptables && sudo sh -c 'iptables-save > /etc/iptables/rules.v4'; fi
    say "host firewall: 80/tcp 443/tcp 443/udp open"
  fi
else
  say "$OS: skipping Docker install and firewall (local rehearsal)"
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

DEPLOY="$WORKDIR/skilllane-monitoring-engine/deploy"
cd "$DEPLOY"
if [ "$SOURCE" = local ]; then TAG="local-$(date +%Y%m%d%H%M)"
else TAG="$(git -C "$WORKDIR/skilllane-monitoring-engine" rev-parse --short HEAD)"; fi

# ---- 3. .env -----------------------------------------------------------------------------
if [ ! -f .env ]; then
  domain="${DOMAIN:-}"
  if [ -z "$domain" ]; then
    if [ "$OS" = Darwin ]; then domain=localhost
    else read -rp "DOMAIN (monitor.<DOMAIN> and engine.<DOMAIN> point at this VM): " domain; fi
  fi
  [ -n "$domain" ] || { echo "DOMAIN is required"; exit 1; }
  awk -v d="$domain" -v t="$TAG" \
      -v p1="$(rand 24)" -v p2="$(rand 24)" -v p3="$(rand 12)" -v p4="$(rand 32)" -v p5="$(rand 32)" '
    /^DOMAIN=/                               { print "DOMAIN=" d; next }
    /^IMAGE_TAG=/                            { print "IMAGE_TAG=" t; next }
    /^CLICKHOUSE_PASSWORD=/                  { print "CLICKHOUSE_PASSWORD=" p1; next }
    /^CLICKHOUSE_READER_PASSWORD=/           { print "CLICKHOUSE_READER_PASSWORD=" p2; next }
    /^SKILLLANE_MONITORING_ADMIN_PASSWORD=/  { print "SKILLLANE_MONITORING_ADMIN_PASSWORD=" p3; next }
    /^SKILLLANE_MONITORING_AUTH_SECRET=/     { print "SKILLLANE_MONITORING_AUTH_SECRET=" p4; next }
    /^ENGINE_INGEST_TOKEN=/                  { print "ENGINE_INGEST_TOKEN=" p5; next }
    { print }' .env.example > .env
  chmod 600 .env
  say ".env written (random secrets; printed at the end)"
else
  # keep secrets, move the tag to this build
  awk -v t="$TAG" '/^IMAGE_TAG=/ { print "IMAGE_TAG=" t; next } { print }' .env > .env.tmp && mv .env.tmp .env && chmod 600 .env
  say ".env kept; IMAGE_TAG=$TAG"
fi
env_get() { grep -E "^$1=" .env | cut -d= -f2-; }
[ -n "$(env_get CLICKHOUSE_S3_ENDPOINT)" ] || say "CLICKHOUSE_S3_ENDPOINT not set: cold storage off, everything stays on this disk"

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

domain="$(env_get DOMAIN)"
cat <<MSG

  monitor   https://monitor.$domain      sign in: $(env_get SKILLLANE_MONITORING_ADMIN_USERNAME) / $(env_get SKILLLANE_MONITORING_ADMIN_PASSWORD)
  engine    https://engine.$domain/api/health
  apps      LOG_HTTP_URL=https://engine.$domain  LOG_HTTP_TOKEN=$(env_get ENGINE_INGEST_TOKEN)

  logs      cd $DEPLOY && docker compose logs -f engine caddy
  update    bash $DEPLOY/setup-vm.sh      (pulls $BRANCH, rebuilds, restarts what changed)
MSG
if [ "$domain" = localhost ]; then
  cat <<MSG
  localhost: Caddy signs *.localhost with its own CA, so:
    curl -k --resolve engine.localhost:443:127.0.0.1 https://engine.localhost/api/health
    open https://monitor.localhost   (accept the certificate warning)
MSG
fi
