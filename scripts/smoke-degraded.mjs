import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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

async function waitForStatus(baseUrl, proc) {
  let lastError
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (proc.exitCode != null) throw new Error(`API server exited before it was ready with code ${proc.exitCode}.`)
    try {
      const response = await fetch(`${baseUrl}/api/status`)
      if (response.ok) return
      lastError = new Error(`/api/status returned HTTP ${response.status}.`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 125))
  }
  throw lastError ?? new Error('API server did not become ready.')
}

async function startServer(tempDir, extraEnv = {}) {
  const port = await getAvailablePort()
  const statePath = path.join(tempDir, `state-${port}.json`)
  const secretsPath = path.join(tempDir, `secrets-${port}.json`)
  const proc = spawnLogged(process.execPath, ['server/index.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      OPENAI_API_KEY: '',
      OPENAI_ADMIN_KEY: '',
      CODEX_USE_OPENAI_API_KEY: 'false',
      CODEX_REALTIME_STATE_PATH: statePath,
      CODEX_REALTIME_SECRETS_PATH: secretsPath,
      CODEX_RPC_TIMEOUT_MS: '1000',
      ...extraEnv,
    },
  })
  const baseUrl = `http://127.0.0.1:${port}`
  try {
    await waitForStatus(baseUrl, proc)
  } catch (error) {
    console.error(proc.output())
    throw error
  }
  return { baseUrl, proc, statePath, secretsPath }
}

async function startFakeOpenAiServer(handler) {
  const port = await getAvailablePort()
  const server = createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

async function readJson(response) {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Expected JSON response, got: ${text.slice(0, 500)}`)
  }
}

async function assertStatus(response, expectedStatus, expectedCode, label) {
  const body = await readJson(response)
  if (response.status !== expectedStatus || body.code !== expectedCode) {
    throw new Error(`${label} expected HTTP ${expectedStatus}/${expectedCode}, got HTTP ${response.status}/${body.code ?? '<missing>'}.`)
  }
  return body
}

async function writeUnexpectedCodex(tempDir) {
  const fakeCodexPath = path.join(tempDir, 'unexpected-codex-app-server.mjs')
  await writeFile(
    fakeCodexPath,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline'

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.id == null) return
  const result = message.method === 'thread/start' ? { thread: {} } : {}
  process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n')
})
`,
  )
  await chmod(fakeCodexPath, 0o755)
  return fakeCodexPath
}

async function writeUnauthenticatedCodex(tempDir) {
  const fakeCodexPath = path.join(tempDir, 'unauthenticated-codex-app-server.mjs')
  await writeFile(
    fakeCodexPath,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline'

const responses = {
  initialize: {},
  'account/read': { account: null },
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

async function writeSlowCodex(tempDir) {
  const fakeCodexPath = path.join(tempDir, 'slow-codex-app-server.mjs')
  await writeFile(
    fakeCodexPath,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline'

createInterface({ input: process.stdin }).on('line', () => {})
`,
  )
  await chmod(fakeCodexPath, 0o755)
  return fakeCodexPath
}

async function scenarioFirstRunAndMissingRealtime(tempDir) {
  const missingCodexPath = path.join(tempDir, 'missing-codex-bin')
  const { baseUrl, proc, statePath, secretsPath } = await startServer(tempDir, { CODEX_BIN: missingCodexPath })
  try {
    const state = await readJson(await fetch(`${baseUrl}/api/app-state`))
    if (!Array.isArray(state.workspaces) || state.workspaces.length !== 0) {
      throw new Error('First-run state should contain no saved workspaces.')
    }
    if (!state.conversationsByWorkspace || Object.keys(state.conversationsByWorkspace).length !== 0) {
      throw new Error('First-run state should contain no saved conversations.')
    }

    const status = await readJson(await fetch(`${baseUrl}/api/status`))
    if (status.realtime !== false || status.openAiKeySource !== 'missing') {
      throw new Error('First-run status should report missing Realtime credentials.')
    }

    await assertStatus(await fetch(`${baseUrl}/api/realtime/token`, { method: 'POST' }), 503, 'openai_api_key_required', 'missing Realtime key')
    await assertStatus(await fetch(`${baseUrl}/api/codex/account`), 502, 'codex_account_failed', 'missing Codex CLI')

    await stat(path.dirname(statePath))
    try {
      await stat(secretsPath)
      throw new Error('First-run status reads should not create a secrets file.')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  } finally {
    await stopProcess(proc)
  }
}

async function scenarioCorruptedStateAndSecrets(tempDir) {
  const statePath = path.join(tempDir, 'corrupt-state.json')
  const secretsPath = path.join(tempDir, 'corrupt-secrets.json')
  const recoveredWorkspace = await mkdtemp(path.join(tempDir, 'recovered-workspace-'))
  await mkdir(path.dirname(statePath), { recursive: true })
  await writeFile(statePath, '{not json')
  await writeFile(`${statePath}.bak`, JSON.stringify({
    workspaces: [{ id: recoveredWorkspace, path: recoveredWorkspace, name: 'Recovered Workspace' }],
    conversationsByWorkspace: {
      [recoveredWorkspace]: [{
        id: 'recovered-thread',
        title: 'Recovered Thread',
        status: 'ready',
        source: 'local',
        prompt: '',
        response: '',
        traces: [],
        transcript: [],
      }],
    },
  }))
  await writeFile(secretsPath, '{not json')

  const { baseUrl, proc } = await startServer(tempDir, {
    CODEX_REALTIME_STATE_PATH: statePath,
    CODEX_REALTIME_SECRETS_PATH: secretsPath,
  })
  try {
    const state = await readJson(await fetch(`${baseUrl}/api/app-state`))
    if (state.workspaces[0]?.path !== recoveredWorkspace) {
      throw new Error('Corrupted primary state did not recover workspace data from backup.')
    }
    if (state.conversationsByWorkspace[recoveredWorkspace]?.[0]?.id !== 'recovered-thread') {
      throw new Error('Corrupted primary state did not recover conversations from backup.')
    }
    const events = await readJson(await fetch(`${baseUrl}/api/codex/events`))
    const methods = new Set((events.data ?? []).map((event) => event.method))
    if (!methods.has('app-state/read-error') || !methods.has('app-state/recovered-from-backup')) {
      throw new Error('Corrupted state recovery did not emit expected app-state events.')
    }
    const status = await readJson(await fetch(`${baseUrl}/api/status`))
    if (status.realtime !== false || status.openAiKeySource !== 'missing') {
      throw new Error('Malformed saved secrets should not produce a usable Realtime key.')
    }
  } finally {
    await stopProcess(proc)
  }
}

async function scenarioUnexpectedCodexPayload(tempDir) {
  const workspacePath = await mkdtemp(path.join(tempDir, 'unexpected-codex-workspace-'))
  const fakeCodexPath = await writeUnexpectedCodex(tempDir)
  const { baseUrl, proc } = await startServer(tempDir, { CODEX_BIN: fakeCodexPath })
  try {
    const response = await fetch(`${baseUrl}/api/codex/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: workspacePath, goal: 'Review this workspace and summarize it.' }),
    })
    await assertStatus(response, 502, 'codex_invalid_response', 'unexpected Codex app-server payload')
  } finally {
    await stopProcess(proc)
  }
}

async function scenarioUnauthenticatedCodexAccount(tempDir) {
  const fakeCodexPath = await writeUnauthenticatedCodex(tempDir)
  const { baseUrl, proc } = await startServer(tempDir, { CODEX_BIN: fakeCodexPath })
  try {
    const response = await fetch(`${baseUrl}/api/codex/account`)
    const body = await readJson(response)
    if (response.status !== 200 || body.account !== null) {
      throw new Error(`Unauthenticated Codex account should return a bounded empty account, got HTTP ${response.status}.`)
    }
  } finally {
    await stopProcess(proc)
  }
}

async function scenarioSlowCodexBridge(tempDir) {
  const fakeCodexPath = await writeSlowCodex(tempDir)
  const { baseUrl, proc } = await startServer(tempDir, { CODEX_BIN: fakeCodexPath, CODEX_RPC_TIMEOUT_MS: '1000' })
  try {
    await assertStatus(await fetch(`${baseUrl}/api/codex/account`), 502, 'codex_account_failed', 'slow Codex app-server response')
    const events = await readJson(await fetch(`${baseUrl}/api/codex/events`))
    const methods = new Set((events.data ?? []).map((event) => event.method))
    if (!methods.has('app-server/request-timeout')) {
      throw new Error('Slow Codex app-server response did not emit a timeout event.')
    }
  } finally {
    await stopProcess(proc)
  }
}

async function scenarioInvalidRealtimeKey(tempDir) {
  const fakeOpenAi = await startFakeOpenAiServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/realtime/client_secrets') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Not found' } }))
      return
    }
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Incorrect API key provided.' } }))
  })
  const { baseUrl, proc } = await startServer(tempDir, {
    OPENAI_API_KEY: `sk-${'test'.repeat(16)}`,
    CODEX_REALTIME_OPENAI_API_BASE_URL: fakeOpenAi.baseUrl,
  })
  try {
    const body = await assertStatus(
      await fetch(`${baseUrl}/api/realtime/token`, { method: 'POST' }),
      502,
      'realtime_token_failed',
      'invalid upstream Realtime key',
    )
    if (!/Incorrect API key provided/.test(body.error ?? '')) {
      throw new Error('Invalid upstream Realtime key did not return the upstream error message.')
    }
  } finally {
    await stopProcess(proc)
    await fakeOpenAi.close()
  }
}

async function scenarioRealtimeTokenTimeout(tempDir) {
  const fakeOpenAi = await startFakeOpenAiServer(() => {})
  const { baseUrl, proc } = await startServer(tempDir, {
    OPENAI_API_KEY: `sk-${'slow'.repeat(16)}`,
    CODEX_REALTIME_OPENAI_API_BASE_URL: fakeOpenAi.baseUrl,
    UPSTREAM_FETCH_TIMEOUT_MS: '1000',
  })
  try {
    await assertStatus(
      await fetch(`${baseUrl}/api/realtime/token`, { method: 'POST' }),
      502,
      'realtime_token_failed',
      'Realtime token upstream timeout',
    )
  } finally {
    await stopProcess(proc)
    await fakeOpenAi.close()
  }
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codex-realtime-degraded-smoke-'))
  try {
    await scenarioFirstRunAndMissingRealtime(tempDir)
    await scenarioCorruptedStateAndSecrets(tempDir)
    await scenarioInvalidRealtimeKey(tempDir)
    await scenarioRealtimeTokenTimeout(tempDir)
    await scenarioUnexpectedCodexPayload(tempDir)
    await scenarioUnauthenticatedCodexAccount(tempDir)
    await scenarioSlowCodexBridge(tempDir)
    console.log('Degraded-mode smoke passed.')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error)
  process.exit(1)
})
