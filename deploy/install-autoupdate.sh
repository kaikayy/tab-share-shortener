#!/usr/bin/env bash
#
# install-autoupdate.sh -- systemd timer that runs auto-update.sh every 10 min.
#
# Run from a git checkout of this repo. Root -> system timer; non-root -> a
# `systemctl --user` timer (needs linger, which install.sh already enables).
#
#   bash deploy/install-autoupdate.sh [interval]      # default: 10min
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INTERVAL="${1:-10min}"
[ -d "$REPO/.git" ] || { echo "run this from a git checkout (found no .git in $REPO)" >&2; exit 1; }

if [ "$(id -u)" -eq 0 ]; then
  DIR=/etc/systemd/system; SC="systemctl"
else
  DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"; SC="systemctl --user"
fi
mkdir -p "$DIR"

cat > "$DIR/tab-share-shortener-update.service" <<EOF
[Unit]
Description=Tab Share shortener -- pull latest and redeploy
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/env bash $REPO/deploy/auto-update.sh $REPO
EOF

cat > "$DIR/tab-share-shortener-update.timer" <<EOF
[Unit]
Description=Check for Tab Share shortener updates

[Timer]
OnBootSec=2min
OnUnitActiveSec=$INTERVAL
Persistent=true

[Install]
WantedBy=timers.target
EOF

$SC daemon-reload
$SC enable --now tab-share-shortener-update.timer

echo "  ok -- update timer active (every $INTERVAL)"
echo "  next run:  $SC list-timers tab-share-shortener-update.timer"
echo "  logs:      journalctl $([ "$(id -u)" -eq 0 ] || echo --user) -u tab-share-shortener-update.service"
