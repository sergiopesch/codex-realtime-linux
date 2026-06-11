import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appId = 'codex-realtime-linux'
const serviceName = 'codex-realtime-linux-app.service'
const defaultPort = 3311

function configuredAbsoluteDir(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback
  const candidate = value.trim()
  if (!path.isAbsolute(candidate) || /[\u0000-\u001f\u007f]/.test(candidate)) return fallback
  return path.resolve(candidate)
}

const xdgDataHome = configuredAbsoluteDir(process.env.XDG_DATA_HOME, path.join(os.homedir(), '.local', 'share'))
const xdgStateHome = configuredAbsoluteDir(process.env.XDG_STATE_HOME, path.join(os.homedir(), '.local', 'state'))
const desktopEntryPath = path.join(xdgDataHome, 'applications', `${appId}.desktop`)
const launcherPath = path.join(repoRoot, 'scripts', 'launch-desktop.sh')
const desktopLogPath = path.join(xdgStateHome, appId, 'desktop-launch.log')
const apiLogPath = path.join(xdgStateHome, appId, 'api-server.log')

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    proc.once('error', reject)
    proc.once('exit', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}.\n${stdout}\n${stderr}`.trim()))
    })
  })
}

async function assertFile(filePath, label) {
  try {
    const details = await stat(filePath)
    if (!details.isFile()) throw new Error(`${label} is not a file: ${filePath}`)
    return details
  } catch (error) {
    throw new Error(`${label} was not found at ${filePath}. ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function assertExecutable(filePath, label) {
  await assertFile(filePath, label)
  try {
    await access(filePath, constants.X_OK)
  } catch {
    throw new Error(`${label} is not executable: ${filePath}`)
  }
}

async function waitForStatus() {
  let lastError
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${defaultPort}/api/status`)
      if (response.ok) return response.json()
      lastError = new Error(`/api/status returned HTTP ${response.status}.`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw lastError ?? new Error('/api/status did not become healthy.')
}

async function restartUserServiceIfAvailable() {
  try {
    await run('systemctl', ['--user', 'status', serviceName])
  } catch {
    return false
  }
  await run('systemctl', ['--user', 'restart', serviceName])
  return true
}

async function main() {
  await run(process.execPath, ['scripts/install-desktop-entry.mjs'])

  const desktopEntry = await readFile(desktopEntryPath, 'utf8')
  if (!desktopEntry.includes('Name=Codex')) throw new Error('Desktop entry is missing Name=Codex.')
  if (!desktopEntry.includes('Type=Application')) throw new Error('Desktop entry is missing Type=Application.')
  if (!desktopEntry.includes(launcherPath)) throw new Error('Desktop entry does not point at this repo launcher.')
  await assertExecutable(launcherPath, 'Desktop launcher')
  await assertFile(path.join(xdgDataHome, 'icons', 'hicolor', '512x512', 'apps', `${appId}.png`), '512px app icon')

  const restartedService = await restartUserServiceIfAvailable()
  const status = await waitForStatus()
  if (status.appRoot !== repoRoot) {
    throw new Error(`/api/status appRoot mismatch. Expected ${repoRoot}, received ${status.appRoot ?? '<missing>'}.`)
  }
  if (status.appName !== appId) {
    throw new Error(`/api/status appName mismatch. Expected ${appId}, received ${status.appName ?? '<missing>'}.`)
  }

  if (restartedService) {
    await assertFile(desktopLogPath, 'Desktop launch log')
    await assertFile(apiLogPath, 'API server log')
  }

  console.log(`Desktop release smoke passed${restartedService ? ' with user service restart' : ' against the running local API'}.`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error)
  process.exit(1)
})
