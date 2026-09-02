#!/usr/bin/env bash
#
# auto-update.sh -- match the checkout to origin and redeploy if it changed.
#
# Run it from a git checkout of this repo (the arg, or the repo the script lives
# in). Safe to run on a timer: it does nothing when already up to date, and
# `install.sh` reuses the config from the existing systemd unit.
#
# This is a deploy mirror -- it does not carry local commits -- so it hard-resets
# to the upstream branch rather than merging. That way a force-push upstream
# (e.g. a history rewrite) self-heals instead of wedging the timer.
#
#   bash deploy/auto-update.sh [/path/to/checkout]
#
set -euo pipefail

REPO="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$REPO"

[ -d .git ] || { echo "auto-update: $REPO is not a git checkout" >&2; exit 1; }

git fetch --quiet origin
LOCAL=$(git rev-parse @)
REMOTE=$(git rev-parse '@{u}')

if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0
fi

echo "auto-update: ${LOCAL:0:9} -> ${REMOTE:0:9}, redeploying"
git reset --hard --quiet "$REMOTE"
NONINTERACTIVE=1 bash deploy/install.sh
