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
printf '\n[%s] Launching Codex desktop from %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$repo_root"

electron_bin="./node_modules/electron/dist/electron"
if [ ! -x "$electron_bin" ]; then
  electron_bin="./node_modules/.bin/electron"
fi
printf '[%s] Using Electron binary %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$electron_bin"

if [ ! -x "$electron_bin" ]; then
  echo "Electron is not installed. Run npm install in $repo_root."
  exit 1
fi

renderer_build_stamp="./dist/index.html"
renderer_build_stale=0
renderer_build_inputs=(
  "./index.html"
  "./package.json"
  "./package-lock.json"
  "./vite.config.ts"
  "./tsconfig.json"
  "./tsconfig.app.json"
  "./src"
  "./public"
)
generated_artifact_dir="./public/agent-files"

renderer_input_newer_than_build() {
  local build_input="$1"
  if [ "$build_input" = "./public" ]; then
    find "$build_input" -path "$generated_artifact_dir" -prune -o -type f -newer "$renderer_build_stamp" -print -quit
    return
  fi
  find "$build_input" -newer "$renderer_build_stamp" -print -quit
}

if [ ! -f "$renderer_build_stamp" ]; then
  renderer_build_stale=1
else
  for build_input in "${renderer_build_inputs[@]}"; do
    if [ -e "$build_input" ] && renderer_input_newer_than_build "$build_input" | grep -q .; then
      renderer_build_stale=1
      break
    fi
  done
fi

if [ "$renderer_build_stale" = "1" ]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "Built renderer is missing or stale and npm is not available. Run npm run build in $repo_root."
    exit 1
  fi
  printf '[%s] Building renderer before launch\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  npm run build
fi

exec env NODE_ENV=production "$electron_bin" electron/main.cjs
