import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
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

const desktopFieldValue = (value) => value.replace(/[\r\n]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim()
const quoteDesktopValue = (value) => desktopFieldValue(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
const quoteDesktopExecValue = (value) => quoteDesktopValue(value).replace(/%/g, '%%')

const build = spawnSync('npm', ['run', 'build'], {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

if (build.status !== 0) {
  process.exit(build.status ?? 1)
}

const launcherSource = await readFile(launcherPath, 'utf8')
if (!launcherSource.startsWith('#!/usr/bin/env bash\n')) {
  throw new Error(`Desktop launcher is missing or malformed at ${launcherPath}`)
}
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
Exec="${quoteDesktopExecValue(launcherPath)}"
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
