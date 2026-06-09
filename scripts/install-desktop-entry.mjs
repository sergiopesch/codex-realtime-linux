import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appId = 'codex-realtime-linux'
const desktopFileName = `${appId}.desktop`
const configuredAbsoluteDir = (value, fallback) => {
  const candidate = typeof value === 'string' && value.trim() ? value.trim() : fallback
  return path.isAbsolute(candidate) ? path.resolve(candidate) : fallback
}
const xdgDataHome = configuredAbsoluteDir(process.env.XDG_DATA_HOME, path.join(os.homedir(), '.local', 'share'))
const applicationsDir = path.join(xdgDataHome, 'applications')
const iconBaseDir = path.join(xdgDataHome, 'icons', 'hicolor')
const iconSource = path.join(repoRoot, 'public', 'codex-app-icon.png')
const launcherPath = path.join(repoRoot, 'scripts', 'launch-desktop.sh')
const desktopPath = path.join(applicationsDir, desktopFileName)
const iconSizes = [16, 24, 32, 48, 64, 128, 256, 512]

const quoteDesktopValue = (value) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

const build = spawnSync('npm', ['run', 'build'], {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

if (build.status !== 0) {
  process.exit(build.status ?? 1)
}

await mkdir(path.dirname(launcherPath), { recursive: true })
await writeFile(
  launcherPath,
  `#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "\${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
cd "$repo_root"

current_user="\${USER:-$(id -un 2>/dev/null || true)}"
if [ "\${CODEX_REALTIME_DIALOUT_REEXEC:-}" != "1" ] &&
  [ -n "$current_user" ] &&
  command -v sg >/dev/null 2>&1 &&
  id -nG "$current_user" 2>/dev/null | tr ' ' '\\n' | grep -qx dialout &&
  ! id -nG | tr ' ' '\\n' | grep -qx dialout; then
  reexec_cmd="$(printf 'cd %q && %q' "$repo_root" "$repo_root/scripts/launch-desktop.sh")"
  exec env CODEX_REALTIME_DIALOUT_REEXEC=1 sg dialout -c "$reexec_cmd"
fi

home_dir="\${HOME:-}"
if [ -z "$home_dir" ]; then
  home_dir="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6 || true)"
fi
if [ -z "$home_dir" ]; then
  home_dir="$repo_root"
fi

xdg_state_home="\${XDG_STATE_HOME:-}"
if [ -z "$xdg_state_home" ] || [ "\${xdg_state_home#/}" = "$xdg_state_home" ]; then
  xdg_state_home="$home_dir/.local/state"
fi
state_dir="$xdg_state_home/codex-realtime-linux"
mkdir -p "$state_dir"
desktop_log="$state_dir/desktop-launch.log"
max_log_bytes=1048576
if [ -f "$desktop_log" ] && [ "$(wc -c < "$desktop_log" 2>/dev/null || echo 0)" -gt "$max_log_bytes" ]; then
  mv -f "$desktop_log" "$desktop_log.1"
fi
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
`,
)
await chmod(launcherPath, 0o755)

for (const size of iconSizes) {
  const iconDir = path.join(iconBaseDir, `${size}x${size}`, 'apps')
  const iconPath = path.join(iconDir, `${appId}.png`)
  await mkdir(iconDir, { recursive: true })

  const scaled = spawnSync('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-i',
    iconSource,
    '-vf',
    `scale=${size}:${size}:flags=lanczos`,
    '-frames:v',
    '1',
    iconPath,
  ])

  if (scaled.status !== 0) await copyFile(iconSource, iconPath)
}

await mkdir(applicationsDir, { recursive: true })
await writeFile(
  desktopPath,
  `[Desktop Entry]
Version=1.0
Type=Application
Name=Codex
Comment=Voice-first Codex desktop client
Exec="${quoteDesktopValue(launcherPath)}"
Path=${quoteDesktopValue(repoRoot)}
TryExec=${quoteDesktopValue(launcherPath)}
Icon=${appId}
Terminal=false
Categories=Development;
StartupNotify=true
StartupWMClass=Codex
`,
)
await chmod(desktopPath, 0o755)

spawnSync('update-desktop-database', [applicationsDir], { stdio: 'ignore' })
spawnSync('gtk-update-icon-cache', ['-q', iconBaseDir], { stdio: 'ignore' })

console.log(`Installed ${desktopPath}`)
