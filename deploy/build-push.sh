#!/usr/bin/env bash
# OPTIONAL path. The normal deploy builds on the VM (setup-vm.sh). This builds the engine and
# monitor images on this machine and pushes them to GHCR, for a VM too small to build.
#
#   deploy/build-push.sh            build linux/arm64 (Oracle A1) and push
#   deploy/build-push.sh --local    build only, load into the local docker (no push)
#   PLATFORM=linux/amd64 deploy/build-push.sh   for an x86 VM
#
# Needs: docker with buildx, and for --push: docker login ghcr.io -u <github user> with a
# PAT that has write:packages. The context is this repo (working tree; .dockerignore applies).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REGISTRY="${REGISTRY:-ghcr.io/nakarin-skilllane}"
PLATFORM="${PLATFORM:-linux/arm64}"
PUSH=1
[ "${1:-}" = "--local" ] && PUSH=0

sha="$(git -C "$ROOT" rev-parse --short HEAD)"
dirty=""
[ -z "$(git -C "$ROOT" status --porcelain)" ] || dirty="-dirty"
TAG="${TAG:-$sha$dirty}"

out=(--load)
[ "$PUSH" = 1 ] && out=(--push)

for app in engine monitor; do
  image="$REGISTRY/skilllane-monitoring-$app"
  echo "== building $image:$TAG ($PLATFORM)"
  docker buildx build --platform "$PLATFORM" \
    -f "$ROOT/deploy/Dockerfile.$app" \
    -t "$image:$TAG" -t "$image:latest" \
    "${out[@]}" "$ROOT"
done

echo
echo "images: $REGISTRY/skilllane-monitoring-{engine,monitor}:$TAG (also :latest)"
echo "on the VM: set IMAGE_TAG=$TAG in deploy/.env, then docker compose pull && docker compose up -d"
