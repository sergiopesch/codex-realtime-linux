#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
cd "$repo_root"

if [ "${CODEX_REALTIME_DIALOUT_REEXEC:-}" != "1" ] &&
  command -v sg >/dev/null 2>&1 &&
  getent group dialout | grep -Eq "(^|[:,])$USER($|,)" &&
  ! id -nG | tr ' ' '\n' | grep -qx dialout; then
  exec env CODEX_REALTIME_DIALOUT_REEXEC=1 sg dialout -c "cd '$repo_root' && ./scripts/launch-desktop.sh"
fi

state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/codex-realtime-linux"
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
