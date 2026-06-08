import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')

async function getAvailablePort() {
  return new Promise((resolve, reject) => {
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
}

async function waitForServer(baseUrl, proc) {
  let lastError
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (proc.exitCode != null) {
      throw new Error(`Server exited before it was ready with code ${proc.exitCode}.`)
    }
    try {
      const response = await fetch(`${baseUrl}/api/app-state`)
      if (response.ok) return
      lastError = new Error(`Server returned ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw lastError ?? new Error('Server did not become ready.')
}

async function startTestServer(t) {
  const port = await getAvailablePort()
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codex-realtime-api-test-'))
  const proc = spawn(process.execPath, ['server/index.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      CODEX_REALTIME_STATE_PATH: path.join(tempDir, 'state.json'),
      CODEX_REALTIME_SECRETS_PATH: path.join(tempDir, 'secrets.json'),
      CODEX_RPC_TIMEOUT_MS: '5000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stderr = []
  proc.stderr.on('data', (chunk) => stderr.push(chunk.toString()))

  t.after(async () => {
    if (proc.exitCode == null) {
      proc.kill('SIGTERM')
      await new Promise((resolve) => proc.once('exit', resolve))
    }
    await rm(tempDir, { recursive: true, force: true })
  })

  const baseUrl = `http://127.0.0.1:${port}`
  await waitForServer(baseUrl, proc)
  return {
    baseUrl,
    stderr: () => stderr.join(''),
  }
}

async function readJson(response) {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

test('server enforces workspace scoped state and artifact routes over HTTP', async (t) => {
  const { baseUrl } = await startTestServer(t)
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'codex-realtime-workspace-'))
  t.after(() => rm(workspacePath, { recursive: true, force: true }))

  const artifactDir = path.join(workspacePath, 'public', 'agent-files', 'sample-report')
  await mkdir(artifactDir, { recursive: true })
  await writeFile(path.join(artifactDir, 'index.html'), '<!doctype html><title>Sample report</title>')
  await writeFile(path.join(artifactDir, 'notes.txt'), 'workspace note')

  const artifactList = await fetch(`${baseUrl}/api/artifacts?workspacePath=${encodeURIComponent(workspacePath)}`)
  assert.equal(artifactList.status, 200)
  const artifactBody = await artifactList.json()
  assert.equal(artifactBody.data.length, 1)
  assert.equal(artifactBody.data[0].relativePath, 'public/agent-files/sample-report/index.html')

  const token = Buffer.from(path.resolve(workspacePath), 'utf8').toString('base64url')
  const preview = await fetch(`${baseUrl}/workspace-artifacts/${token}/sample-report/index.html`)
  assert.equal(preview.status, 200)
  assert.match(await preview.text(), /Sample report/)

  const traversal = await fetch(`${baseUrl}/workspace-artifacts/${token}/sample-report/..%2F..%2F..%2Fpackage.json`)
  assert.equal(traversal.status, 403)

  const invalidToken = await fetch(`${baseUrl}/workspace-artifacts/not-a-workspace-token/sample-report/index.html`)
  assert.equal(invalidToken.status, 400)
  assert.match(await invalidToken.text(), /workspace token must be an absolute local path/)

  const missingWorkspaceSave = await fetch(`${baseUrl}/api/app-state/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspacePath: path.join(os.tmpdir(), 'missing-codex-realtime-workspace'),
      conversation: { id: 'missing', title: 'Missing' },
    }),
  })
  assert.equal(missingWorkspaceSave.status, 404)
  assert.equal((await readJson(missingWorkspaceSave)).code, 'workspace_not_found')

  const validSave = await fetch(`${baseUrl}/api/app-state/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspacePath,
      conversation: { id: 'ok', title: 'OK' },
    }),
  })
  assert.equal(validSave.status, 200)
  const validBody = await validSave.json()
  assert.equal(validBody.conversation.id, 'ok')
  assert.equal(validBody.state.conversationsByWorkspace[workspacePath].length, 1)
})
