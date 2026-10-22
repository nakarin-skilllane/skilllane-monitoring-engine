#!/usr/bin/env bash
# Run setup-vm.sh on the VM over ssh (the VM clones the repo itself; only the script is copied).
#
#   deploy/push-to-vm.sh ubuntu@<public ip> [-i ~/.ssh/key]
#
# Private repo: the VM's git clone will ask for GitHub credentials (use a PAT with
# repo read access as the password), or put a deploy key in ~/.ssh on the VM and set
# ENGINE_REPO to the ssh URL.
set -euo pipefail
[ $# -ge 1 ] || { echo "usage: $0 user@host [ssh options...]"; exit 64; }
HERE="$(cd "$(dirname "$0")" && pwd)"
target="$1"; shift
scp "$@" "$HERE/setup-vm.sh" "$target:setup-vm.sh"
ssh -t "$@" "$target" "BRANCH='${BRANCH:-main}' ENGINE_REPO='${ENGINE_REPO:-}' bash setup-vm.sh"
