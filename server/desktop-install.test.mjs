import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const repoRoot = path.resolve(import.meta.dirname, '..')

test('desktop installer writes launcher entry and icons under configured XDG data root', async (t) => {
  const xdgDataHome = await mkdtemp(path.join(os.tmpdir(), 'codex-realtime-desktop-install-'))
  t.after(() => rm(xdgDataHome, { recursive: true, force: true }))

  const install = spawnSync(process.execPath, ['scripts/install-desktop-entry.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      XDG_DATA_HOME: xdgDataHome,
    },
    encoding: 'utf8',
  })

  assert.equal(install.status, 0, install.stderr || install.stdout)

  const desktopPath = path.join(xdgDataHome, 'applications', 'codex-realtime-linux.desktop')
  const desktopEntry = await readFile(desktopPath, 'utf8')
  const launcherPath = path.join(repoRoot, 'scripts', 'launch-desktop.sh')

  assert.match(desktopEntry, /\[Desktop Entry\]/)
  assert.match(desktopEntry, /Name=Codex/)
  assert.match(desktopEntry, new RegExp(`Exec="${launcherPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`))
  assert.match(desktopEntry, new RegExp(`TryExec=${launcherPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.match(desktopEntry, /Icon=codex-realtime-linux/)
  assert.match(desktopEntry, /Terminal=false/)

  assert.equal((await stat(desktopPath)).mode & 0o777, 0o755)
  assert.equal((await stat(launcherPath)).mode & 0o111, 0o111)
  assert.equal(
    (await stat(path.join(xdgDataHome, 'icons', 'hicolor', '512x512', 'apps', 'codex-realtime-linux.png'))).isFile(),
    true,
  )
})
