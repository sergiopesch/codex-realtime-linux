#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
cd "$repo_root"

current_user="${USER:-$(id -un 2>/dev/null || true)}"
if [ "${CODEX_REALTIME_DIALOUT_REEXEC:-}" != "1" ] &&
  [ -n "$current_user" ] &&
  command -v sg >/dev/null 2>&1 &&
  id -nG "$current_user" 2>/dev/null | tr ' ' '\n' | grep -qx dialout &&
  ! id -nG | tr ' ' '\n' | grep -qx dialout; then
  reexec_cmd="$(printf 'cd %q && %q' "$repo_root" "$repo_root/scripts/launch-desktop.sh")"
  exec env CODEX_REALTIME_DIALOUT_REEXEC=1 sg dialout -c "$reexec_cmd"
fi

home_dir="${HOME:-}"
if [ -z "$home_dir" ]; then
  home_dir="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6 || true)"
fi
if [ -z "$home_dir" ]; then
  home_dir="$repo_root"
fi

xdg_state_home="${XDG_STATE_HOME:-}"
if [ -z "$xdg_state_home" ] || [ "${xdg_state_home#/}" = "$xdg_state_home" ]; then
  xdg_state_home="$home_dir/.local/state"
fi
state_dir="$xdg_state_home/codex-realtime-linux"
mkdir -p "$state_dir"
chmod 700 "$state_dir" 2>/dev/null || true
desktop_log="$state_dir/desktop-launch.log"
max_log_bytes=1048576
if [ -f "$desktop_log" ] && [ "$(wc -c < "$desktop_log" 2>/dev/null || echo 0)" -gt "$max_log_bytes" ]; then
  mv -f "$desktop_log" "$desktop_log.1"
  chmod 600 "$desktop_log.1" 2>/dev/null || true
fi
: >> "$desktop_log"
chmod 600 "$desktop_log" 2>/dev/null || true
exec >> "$desktop_log" 2>&1

electron_bin="./node_modules/electron/dist/electron"
if [ ! -x "$electron_bin" ]; then
  electron_bin="./node_modules/.bin/electron"
fi

if [ ! -x "$electron_bin" ]; then
  echo "Electron is not installed. Run npm install in $repo_root."
  exit 1
fi

if [ ! -f ./dist/index.html ]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "Built renderer is missing and npm is not available. Run npm run build in $repo_root."
    exit 1
  fi
  npm run build
fi

exec env NODE_ENV=production "$electron_bin" electron/main.cjs
