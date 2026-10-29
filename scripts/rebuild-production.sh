#!/usr/bin/env bash
set -euo pipefail

# Rebuild the production web assets and release bridge for the checkout that
# herdr-web.service actually serves, then restart the unit and health-check it.
#
# usage: scripts/rebuild-production.sh [--no-restart]
#
# Env overrides:
#   APP_DIR=<checkout>          default: inferred from the unit's --static-dir
#   SERVICE=herdr-web.service   systemd user unit to restart
#   HEALTH_URL=http://127.0.0.1:8789/api/capabilities

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE="${SERVICE:-herdr-web.service}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8789/api/capabilities}"
RESTART=1

for arg in "$@"; do
  case "$arg" in
    --no-restart) RESTART=0 ;;
    -h|--help)
      sed -n '4,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

# Build the tree that is being served, not necessarily this checkout.
if [[ -z "${APP_DIR:-}" ]]; then
  static_dir="$(systemctl --user show "$SERVICE" -p ExecStart --value 2>/dev/null \
    | grep -o -- '--static-dir [^ ]*' | awk '{print $2}' | head -1 || true)"
  if [[ -n "$static_dir" && -d "$static_dir" ]]; then
    APP_DIR="$(cd "$(dirname "$static_dir")/.." && pwd)"
  else
    APP_DIR="$ROOT"
  fi
fi
if [[ ! -d "$APP_DIR/web" || ! -d "$APP_DIR/bridge" ]]; then
  echo "APP_DIR=$APP_DIR is not a herdr-web checkout" >&2
  exit 1
fi

# cargo often lives in ~/.cargo/bin, which non-login shells miss.
if ! command -v cargo >/dev/null 2>&1 && [[ -x "${HOME}/.cargo/bin/cargo" ]]; then
  export PATH="${HOME}/.cargo/bin:${PATH}"
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo not found; install Rust or add ~/.cargo/bin to PATH" >&2
  exit 1
fi

echo "==> rebuilding $APP_DIR"
git -C "$APP_DIR" log -1 --format='    %h %s' || true

echo "==> building web assets"
npm run build --prefix "$APP_DIR/web"

echo "==> building release bridge"
cargo build --release --manifest-path "$APP_DIR/bridge/Cargo.toml" --bin herdr-web-bridge

if [[ "$RESTART" -eq 1 ]]; then
  echo "==> restarting $SERVICE"
  systemctl --user restart "$SERVICE"
  systemctl --user --no-pager --lines=0 status "$SERVICE" || true
fi

echo "==> health check $HEALTH_URL"
for _ in $(seq 1 20); do
  if curl -fsS -o /dev/null "$HEALTH_URL"; then
    echo "ok: production bridge is serving"
    exit 0
  fi
  sleep 0.5
done

echo "failed: $HEALTH_URL did not answer; check journalctl --user -u $SERVICE" >&2
exit 1
