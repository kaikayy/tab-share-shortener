#!/usr/bin/env bash
#
# backup.sh -- copy the link store somewhere safe, once a day, keep the last N.
#
# The store writes atomically (tmp + rename) so a plain copy is always
# consistent. Run from cron:
#
#   15 4 * * *  bash "$HOME/files/tab-share-shortener/deploy/backup.sh"
#
# Env:
#   TSS_BACKUP_DIR   where to put copies   (default ~/files/backups/tab-share-shortener)
#   TSS_BACKUP_KEEP  how many to keep      (default 30)
#   SHORTENER_STORE  path to links.json    (default ~/.local/share/tab-share-shortener/data/links.json)
#
set -euo pipefail

SRC="${SHORTENER_STORE:-${XDG_DATA_HOME:-$HOME/.local/share}/tab-share-shortener/data/links.json}"
DEST="${TSS_BACKUP_DIR:-$HOME/files/backups/tab-share-shortener}"
KEEP="${TSS_BACKUP_KEEP:-30}"

[ -f "$SRC" ] || { echo "backup: no store at $SRC" >&2; exit 0; }

mkdir -p "$DEST"
cp -p "$SRC" "$DEST/links-$(date +%F).json"

# keep only the newest $KEEP
ls -1t "$DEST"/links-*.json 2>/dev/null | tail -n "+$((KEEP + 1))" | xargs -r rm --
