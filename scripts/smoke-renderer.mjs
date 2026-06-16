import { spawn } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const commonChromiumExecutables = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  '/snap/bin/chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
].filter(Boolean)

const getAvailablePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (typeof address === 'object' && address?.port) resolve(address.port)
        else reject(new Error('Unable to allocate a local test port.'))
      })
    })
  })

async function pathExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function chromiumExecutable() {
  for (const executable of commonChromiumExecutables) {
    if (executable && await pathExists(executable)) return executable
  }
  throw new Error(
    'No Chromium executable was found. Install chromium or set PLAYWRIGHT_CHROMIUM_EXECUTABLE=/absolute/path/to/chromium.',
  )
}

async function waitForHttp(url, proc, label) {
  let lastError
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (proc.exitCode != null) throw new Error(`${label} exited before it was ready with code ${proc.exitCode}.`)
    try {
      const response = await fetch(url)
      if (response.ok) return
      lastError = new Error(`${label} returned HTTP ${response.status}.`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 125))
  }
  throw lastError ?? new Error(`${label} did not become ready.`)
}

function spawnLogged(command, args, options) {
  const proc = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
  const output = []
  proc.stdout.on('data', (chunk) => output.push(chunk.toString()))
  proc.stderr.on('data', (chunk) => output.push(chunk.toString()))
  proc.output = () => output.join('').slice(-8000)
  return proc
}

async function stopProcess(proc) {
  if (!proc || proc.exitCode != null) return
  proc.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => proc.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2500)),
  ])
  if (proc.exitCode == null) proc.kill('SIGKILL')
}

async function writeFakeCodex(tempDir) {
  const fakeCodexPath = path.join(tempDir, 'fake-codex-app-server.mjs')
  await writeFile(
    fakeCodexPath,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline'

const responses = {
  initialize: {},
  'thread/list': { data: [] },
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.id == null) return
  process.stdout.write(JSON.stringify({ id: message.id, result: responses[message.method] ?? {} }) + '\\n')
})
`,
  )
  await chmod(fakeCodexPath, 0o755)
  return fakeCodexPath
}

async function assertVisible(locator, label) {
  try {
    await locator.waitFor({ state: 'visible', timeout: 7000 })
  } catch (error) {
    throw new Error(`Expected visible: ${label}. ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function assertHidden(locator, label) {
  try {
    await locator.waitFor({ state: 'hidden', timeout: 7000 })
  } catch (error) {
    throw new Error(`Expected hidden: ${label}. ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function assertMissing(filePath, label) {
  try {
    await access(filePath)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  throw new Error(`Expected missing file after cleanup: ${label}.`)
}

async function fileExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function generatedArtifactFor(apiPort, workspacePath, relativePath) {
  const response = await fetch(`http://127.0.0.1:${apiPort}/api/artifacts?workspacePath=${encodeURIComponent(workspacePath)}`)
  if (!response.ok) throw new Error(`Generated artifact lookup failed with HTTP ${response.status}.`)
  const body = await response.json()
  const artifact = Array.isArray(body?.data)
    ? body.data.find((item) => item?.workspacePath === workspacePath && item?.relativePath === relativePath)
    : null
  if (!artifact?.url) throw new Error(`Generated artifact was not indexed: ${relativePath}.`)
  return artifact
}

async function main() {
  const browserPath = await chromiumExecutable()
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codex-realtime-renderer-smoke-'))
  const workspacePath = path.join(tempDir, 'workspace')
  const artifactDir = path.join(workspacePath, 'public', 'agent-files', 'smoke-report')
  const apiPort = await getAvailablePort()
  const uiPort = await getAvailablePort()
  const fakeCodexPath = await writeFakeCodex(tempDir)
  let apiProc
  let viteProc
  let browser

  try {
    await mkdir(artifactDir, { recursive: true })
    await writeFile(path.join(artifactDir, 'index.html'), '<!doctype html><title>Smoke Report</title><button>Next</button>')
    await writeFile(path.join(workspacePath, 'public', 'agent-files', 'hello-world.html'), '<!doctype html><title>Hello world</title><h1>Hello world</h1>')

    apiProc = spawnLogged(process.execPath, ['server/index.mjs'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PORT: String(apiPort),
        OPENAI_API_KEY: '',
        OPENAI_ADMIN_KEY: '',
        CODEX_BIN: fakeCodexPath,
        CODEX_API_KEY: '',
        CODEX_USE_OPENAI_API_KEY: 'false',
        CODEX_REALTIME_STATE_PATH: path.join(tempDir, 'state.json'),
        CODEX_REALTIME_SECRETS_PATH: path.join(tempDir, 'secrets.json'),
        CODEX_REALTIME_ALLOWED_ORIGINS: `http://127.0.0.1:${uiPort}`,
        CODEX_RPC_TIMEOUT_MS: '5000',
      },
    })
    await waitForHttp(`http://127.0.0.1:${apiPort}/api/status`, apiProc, 'API server')

    const workspaceResponse = await fetch(`http://127.0.0.1:${apiPort}/api/app-state/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: { id: workspacePath, path: workspacePath, name: 'Smoke Workspace' } }),
    })
    if (!workspaceResponse.ok) throw new Error(`Workspace setup failed with HTTP ${workspaceResponse.status}.`)

    const viteBin = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js')
    viteProc = spawnLogged(
      process.execPath,
      [viteBin, '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort', '--mode', 'smoke'],
      {
        cwd: repoRoot,
        env: { ...process.env, PORT: String(apiPort), BROWSER: 'none' },
      },
    )
    await waitForHttp(`http://127.0.0.1:${uiPort}/`, viteProc, 'Vite server')

    browser = await chromium.launch({
      executablePath: browserPath,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.goto(`http://127.0.0.1:${uiPort}/?smoke=1`, { waitUntil: 'networkidle' })

    await assertVisible(page.getByRole('heading', { name: /What should we build in Smoke Workspace/i }), 'voice home')
    await assertVisible(page.getByRole('button', { name: 'Settings' }), 'Settings utility button')
    await assertVisible(page.getByRole('button', { name: 'Usage' }), 'Usage utility button')
    await assertVisible(page.getByRole('button', { name: 'Profile' }), 'Profile utility button')
    await assertVisible(page.getByText('No threads yet'), 'empty workspace state')

    await page.getByRole('button', { name: 'Settings' }).click()
    await assertVisible(page.getByRole('heading', { name: 'Settings' }), 'Settings screen')
    await assertVisible(page.getByRole('button', { name: 'Usage' }), 'Usage remains visible from Settings')
    await assertVisible(page.getByRole('button', { name: 'Profile' }), 'Profile remains visible from Settings')

    await page.getByRole('button', { name: 'Usage' }).click()
    await assertVisible(page.getByText(/Add OPENAI_ADMIN_KEY|Admin usage is not configured/), 'Usage empty state')
    await assertVisible(page.getByRole('button', { name: 'Settings' }), 'Settings remains visible from Usage')
    await assertVisible(page.getByRole('button', { name: 'Profile' }), 'Profile remains visible from Usage')

    await page.getByRole('button', { name: 'Profile' }).click()
    await assertVisible(page.locator('.system-account'), 'Profile screen')
    await assertVisible(page.getByRole('button', { name: 'Settings' }), 'Settings remains visible from Profile')
    await assertVisible(page.getByRole('button', { name: 'Usage' }), 'Usage remains visible from Profile')

    await page.getByRole('button', { name: /Smoke Workspace/ }).click()
    await assertVisible(page.getByRole('heading', { name: /What should we build in Smoke Workspace/i }), 'voice home after workspace click')
    await page.getByLabel('Toggle transcript').first().click()
    await assertVisible(page.getByLabel('Voice transcript'), 'transcript panel')
    await assertHidden(page.getByLabel('Generated artifact preview'), 'old artifact preview before smoke event')

    const smokeArtifact = await generatedArtifactFor(apiPort, workspacePath, 'public/agent-files/smoke-report/index.html')
    const artifactUrl = smokeArtifact.url
    await page.evaluate((detail) => {
      window.dispatchEvent(new CustomEvent('codex:smoke-open-artifact-preview', { detail }))
    }, {
      ...smokeArtifact,
    })
    await assertVisible(page.getByLabel('Generated artifact preview'), 'generated artifact preview')
    await assertVisible(page.getByRole('button', { name: 'Delete generated preview' }), 'preview delete button')
    await assertVisible(page.getByRole('button', { name: 'Refresh preview' }), 'preview refresh button')
    await assertVisible(page.getByRole('button', { name: 'Close preview' }), 'preview close button')
    await assertVisible(page.locator(`iframe[src="${artifactUrl}"]`), 'preview iframe')
    await page.getByRole('button', { name: 'Refresh preview' }).click()
    await assertVisible(page.locator(`iframe[src="${artifactUrl}"]`), 'refreshed preview iframe')
    await page.getByRole('button', { name: 'Close preview' }).click()
    await assertHidden(page.getByLabel('Generated artifact preview'), 'closed generated artifact preview')

    const flatArtifact = await generatedArtifactFor(apiPort, workspacePath, 'public/agent-files/hello-world.html')
    const flatArtifactUrl = flatArtifact.url
    await page.evaluate((detail) => {
      window.dispatchEvent(new CustomEvent('codex:smoke-open-artifact-preview', { detail }))
    }, {
      ...flatArtifact,
    })
    await assertVisible(page.getByLabel('Generated artifact preview'), 'flat generated artifact preview')
    await assertVisible(page.locator(`iframe[src="${flatArtifactUrl}"]`), 'flat preview iframe')
    await page.getByRole('button', { name: 'Delete generated preview' }).click()
    try {
      await assertHidden(page.getByLabel('Generated artifact preview'), 'deleted flat generated artifact preview')
    } catch (error) {
      const errorStrip = await page.locator('.error-strip').textContent().catch(() => '')
      const noticeStrip = await page.locator('.notice-strip').textContent().catch(() => '')
      const stillExists = await fileExists(path.join(workspacePath, 'public', 'agent-files', 'hello-world.html'))
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} UI error: ${errorStrip || 'none'}. Notice: ${noticeStrip || 'none'}. File exists: ${stillExists}.`,
      )
    }
    await assertMissing(path.join(workspacePath, 'public', 'agent-files', 'hello-world.html'), 'flat generated artifact')

    console.log('Renderer smoke passed.')
  } catch (error) {
    if (apiProc?.output) console.error(`\nAPI output:\n${apiProc.output()}`)
    if (viteProc?.output) console.error(`\nVite output:\n${viteProc.output()}`)
    throw error
  } finally {
    await browser?.close().catch(() => {})
    await stopProcess(viteProc)
    await stopProcess(apiProc)
    await rm(tempDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error)
  process.exit(1)
})
