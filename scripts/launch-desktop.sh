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

state_dir="${XDG_STATE_HOME:-$home_dir/.local/state}/codex-realtime-linux"
mkdir -p "$state_dir"
exec >> "$state_dir/desktop-launch.log" 2>&1

if [ ! -x ./node_modules/.bin/electron ]; then
  echo "Electron is not installed. Run npm install in $repo_root."
  exit 1
fi

if [ ! -f ./dist/index.html ]; then
  npm run build
fi

exec env NODE_ENV=production ./node_modules/.bin/electron electron/main.cjs
