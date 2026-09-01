#!/usr/bin/env bash
#
# install.sh -- install the Tab Share shortener as a service on Linux.
#
#   Root  : system service at /opt/tab-share-shortener, runs as user `tabshare`,
#           systemd unit /etc/systemd/system/tab-share-shortener.service
#   Non-root: user service under ~/.local/share, systemd --user unit
#
# Re-run to update: it copies the current source over the install dir and
# restarts. Config from a previous install is read back from the systemd unit,
# so a bare `NONINTERACTIVE=1 bash deploy/install.sh` re-deploys cleanly. Pass
# an env var to change that value; everything else is preserved.
#
# Env you can preset (otherwise you're prompted):
#   SHORTENER_BASE   e.g. https://s.example.com   (default http://localhost:PORT)
#   SHORTENER_HOSTS  e.g. you.github.io           (default kaikayy.github.io)
#   SHORTENER_PORT   default 8779
#   STORE_BACKEND    file | sqlite                (default sqlite if Node >= 24)
#   NONINTERACTIVE=1 skip all prompts, take defaults / env

set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
say()  { printf '  %s\n' "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
ask()  { # ask VAR "prompt" "default"
  local __v=$1 __p=$2 __d=${3:-} __in
  if [ "${NONINTERACTIVE:-}" = 1 ]; then printf -v "$__v" '%s' "${!__v:-$__d}"; return; fi
  read -r -p "$__p${__d:+ [$__d]}: " __in || true
  printf -v "$__v" '%s' "${__in:-${!__v:-$__d}}"
}

# --- prerequisites -----------------------------------------------------------
command -v node >/dev/null || die "Node.js not found. Install Node 20+ (24+ for the sqlite backend)."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || die "Node $(node -v) is too old; need 20+."
command -v systemctl >/dev/null || die "systemd not found (this script targets systemd hosts)."

IS_ROOT=0; [ "$(id -u)" -eq 0 ] && IS_ROOT=1

if [ "$IS_ROOT" -eq 1 ]; then
  UNIT=/etc/systemd/system/tab-share-shortener.service
else
  UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/tab-share-shortener.service"
fi
# value of Environment=NAME= from a previous install's unit (empty if none)
unit_env() { [ -f "$UNIT" ] && sed -n "s/^Environment=$1=//p" "$UNIT" | head -1 || true; }

# --- gather config -------------------------------------------------------
# precedence: env var you pass  ->  previous install's unit  ->  built-in default
SHORTENER_PORT=${SHORTENER_PORT:-$(unit_env SHORTENER_PORT)}; SHORTENER_PORT=${SHORTENER_PORT:-8779}
ask SHORTENER_PORT "Port"
SHORTENER_BASE=${SHORTENER_BASE:-$(unit_env SHORTENER_BASE)}; SHORTENER_BASE=${SHORTENER_BASE:-http://localhost:$SHORTENER_PORT}
ask SHORTENER_BASE "Public base URL (no trailing slash)"
SHORTENER_HOSTS=${SHORTENER_HOSTS:-$(unit_env SHORTENER_HOSTS)}; SHORTENER_HOSTS=${SHORTENER_HOSTS:-kaikayy.github.io}
ask SHORTENER_HOSTS "Allowed target host(s), comma-separated (your viewer host)"

DEFAULT_BACKEND=file; [ "$NODE_MAJOR" -ge 24 ] && DEFAULT_BACKEND=sqlite
STORE_BACKEND=${STORE_BACKEND:-$(unit_env SHORTENER_STORE_BACKEND)}; STORE_BACKEND=${STORE_BACKEND:-$DEFAULT_BACKEND}
ask STORE_BACKEND "Storage backend (file | sqlite)"
[ "$STORE_BACKEND" = sqlite ] && [ "$NODE_MAJOR" -lt 24 ] && die "sqlite backend needs Node 24+ (have $(node -v))."

if [ "$IS_ROOT" -eq 1 ]; then
  APP_DIR=/opt/tab-share-shortener
  DATA_DIR=/var/lib/tab-share-shortener
  RUN_USER=tabshare
  SYSTEMCTL="systemctl"
else
  APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/tab-share-shortener/app"
  DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/tab-share-shortener/data"
  RUN_USER="$(id -un)"
  SYSTEMCTL="systemctl --user"
fi
STORE_EXT=json; [ "$STORE_BACKEND" = sqlite ] && STORE_EXT=sqlite
STORE_PATH="$DATA_DIR/links.$STORE_EXT"

echo
say "install dir : $APP_DIR"
say "data dir    : $DATA_DIR"
say "unit        : $UNIT"
say "runs as     : $RUN_USER"
say "base / hosts: $SHORTENER_BASE  /  $SHORTENER_HOSTS"
say "backend     : $STORE_BACKEND ($STORE_PATH)"
echo
if [ "${NONINTERACTIVE:-}" != 1 ]; then read -r -p "Proceed? [y/N] " ok; [ "${ok:-}" = y ] || exit 1; fi

# --- lay down files --------------------------------------------------------
if [ "$IS_ROOT" -eq 1 ] && ! id "$RUN_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$RUN_USER"
fi
mkdir -p "$APP_DIR" "$DATA_DIR"
cp -r "$SRC_DIR/src" "$SRC_DIR/package.json" "$SRC_DIR/LICENSE" "$APP_DIR/"
if [ "$IS_ROOT" -eq 1 ]; then
  chown -R "$RUN_USER:$RUN_USER" "$APP_DIR" "$DATA_DIR"
  chmod 750 "$DATA_DIR"
fi

# --- systemd unit --------------------------------------------------------
mkdir -p "$(dirname "$UNIT")"
{
  echo "[Unit]"
  echo "Description=Tab Share link shortener"
  echo "After=network-online.target"
  echo "Wants=network-online.target"
  echo
  echo "[Service]"
  echo "Type=simple"
  echo "WorkingDirectory=$APP_DIR"
  echo "ExecStart=$(command -v node) src/server.mjs"
  echo "ExecReload=/bin/kill -HUP \$MAINPID"
  echo "Restart=on-failure"
  echo "RestartSec=2"
  [ "$IS_ROOT" -eq 1 ] && echo "User=$RUN_USER"
  echo "Environment=SHORTENER_HOST=127.0.0.1"
  echo "Environment=SHORTENER_PORT=$SHORTENER_PORT"
  echo "Environment=SHORTENER_BASE=$SHORTENER_BASE"
  echo "Environment=SHORTENER_HOSTS=$SHORTENER_HOSTS"
  echo "Environment=SHORTENER_STORE=$STORE_PATH"
  echo "Environment=SHORTENER_STORE_BACKEND=$STORE_BACKEND"
  echo "Environment=SHORTENER_TRUST_PROXY=1"
  [ -n "${SHORTENER_HOSTS_FILE:-}" ] && echo "Environment=SHORTENER_HOSTS_FILE=$SHORTENER_HOSTS_FILE"
  [ -n "${SHORTENER_LOG:-}" ] && echo "Environment=SHORTENER_LOG=$SHORTENER_LOG"
  [ -n "${SHORTENER_LOG_DAYS:-}" ] && echo "Environment=SHORTENER_LOG_DAYS=$SHORTENER_LOG_DAYS"
  echo "NoNewPrivileges=true"
  echo "PrivateTmp=true"
  if [ "$IS_ROOT" -eq 1 ]; then
    echo "ProtectSystem=strict"
    echo "ProtectHome=true"
    echo "ReadWritePaths=$DATA_DIR${SHORTENER_LOG:+ $SHORTENER_LOG}"
  fi
  echo
  echo "[Install]"
  [ "$IS_ROOT" -eq 1 ] && echo "WantedBy=multi-user.target" || echo "WantedBy=default.target"
} > "$UNIT"

# --- start --------------------------------------------------------------
$SYSTEMCTL daemon-reload
$SYSTEMCTL enable --now tab-share-shortener
[ "$IS_ROOT" -eq 0 ] && loginctl enable-linger "$RUN_USER" >/dev/null 2>&1 || true

sleep 1
echo
if curl -fsS "http://127.0.0.1:$SHORTENER_PORT/api/health" >/dev/null 2>&1; then
  say "OK -- health check passed on 127.0.0.1:$SHORTENER_PORT"
else
  say "started, but health check failed -- see: $SYSTEMCTL status tab-share-shortener"
fi
echo
say "Put a TLS-terminating reverse proxy in front for $SHORTENER_BASE (see SELF-HOSTING.md)."
say "Extension endpoint: $SHORTENER_BASE/new?url=   (or ?mode=words&url= for word slugs)"
