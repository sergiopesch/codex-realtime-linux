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

async function startTestServer(t, extraEnv = {}) {
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
      ...extraEnv,
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
  const unsafeArtifactDir = path.join(workspacePath, 'public', 'agent-files', 'unsafe report')
  await mkdir(unsafeArtifactDir, { recursive: true })
  await writeFile(path.join(unsafeArtifactDir, 'index.html'), '<!doctype html><title>Unsafe report</title>')

  const artifactList = await fetch(`${baseUrl}/api/artifacts?workspacePath=${encodeURIComponent(workspacePath)}`)
  assert.equal(artifactList.status, 200)
  const artifactBody = await artifactList.json()
  assert.equal(artifactBody.data.length, 1)
  assert.equal(artifactBody.data[0].relativePath, 'public/agent-files/sample-report/index.html')
  assert.equal(artifactBody.data.some((artifact) => artifact.relativePath.includes('unsafe report')), false)

  const token = Buffer.from(path.resolve(workspacePath), 'utf8').toString('base64url')
  const preview = await fetch(`${baseUrl}/workspace-artifacts/${token}/sample-report/index.html`)
  assert.equal(preview.status, 200)
  assert.match(await preview.text(), /Sample report/)

  const traversal = await fetch(`${baseUrl}/workspace-artifacts/${token}/sample-report/..%2F..%2F..%2Fpackage.json`)
  assert.equal(traversal.status, 403)

  const invalidToken = await fetch(`${baseUrl}/workspace-artifacts/not-a-workspace-token/sample-report/index.html`)
  assert.equal(invalidToken.status, 400)
  assert.match(await invalidToken.text(), /Invalid workspace token/)

  const relativeToken = Buffer.from('relative-workspace', 'utf8').toString('base64url')
  const relativeWorkspaceToken = await fetch(`${baseUrl}/workspace-artifacts/${relativeToken}/sample-report/index.html`)
  assert.equal(relativeWorkspaceToken.status, 400)
  assert.match(await relativeWorkspaceToken.text(), /Invalid workspace token/)

  const missingWorkspaceToken = Buffer.from(path.join(os.tmpdir(), 'missing-codex-realtime-preview-workspace'), 'utf8').toString('base64url')
  const missingWorkspacePreview = await fetch(`${baseUrl}/workspace-artifacts/${missingWorkspaceToken}/sample-report/index.html`)
  assert.equal(missingWorkspacePreview.status, 404)
  assert.match(await missingWorkspacePreview.text(), /workspace token does not exist/)

  const blockedOrigin = await fetch(`${baseUrl}/api/status`, {
    headers: { Origin: 'https://example.invalid' },
  })
  assert.equal(blockedOrigin.status, 403)
  assert.equal((await readJson(blockedOrigin)).code, 'origin_not_allowed')

  const formUpload = await fetch(`${baseUrl}/api/arduino/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'action=onboard_led_on',
  })
  assert.equal(formUpload.status, 415)
  assert.equal((await readJson(formUpload)).code, 'json_required')

  const malformedJson = await fetch(`${baseUrl}/api/app-state/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"workspacePath":',
  })
  assert.equal(malformedJson.status, 400)
  assert.equal((await readJson(malformedJson)).code, 'invalid_json')

  const missingTaskWorkspace = await fetch(`${baseUrl}/api/codex/task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal: 'Create an HTML presentation about this workspace.' }),
  })
  assert.equal(missingTaskWorkspace.status, 400)
  assert.equal((await readJson(missingTaskWorkspace)).code, 'invalid_workspace_path')

  const missingArtifactWorkspace = await fetch(`${baseUrl}/api/artifacts?workspacePath=${encodeURIComponent(path.join(os.tmpdir(), 'missing-codex-realtime-artifacts'))}`)
  assert.equal(missingArtifactWorkspace.status, 404)
  assert.equal((await readJson(missingArtifactWorkspace)).code, 'workspace_not_found')

  const missingWorkspaceAdd = await fetch(`${baseUrl}/api/app-state/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace: { path: path.join(os.tmpdir(), 'missing-codex-realtime-workspace-add') } }),
  })
  assert.equal(missingWorkspaceAdd.status, 404)
  assert.equal((await readJson(missingWorkspaceAdd)).code, 'workspace_not_found')

  const invalidWorkspaceDelete = await fetch(`${baseUrl}/api/app-state/workspaces/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspacePath: 'relative-workspace' }),
  })
  assert.equal(invalidWorkspaceDelete.status, 400)
  assert.equal((await readJson(invalidWorkspaceDelete)).code, 'invalid_workspace_path')

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
    headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' },
    body: JSON.stringify({
      workspacePath,
      conversation: { id: 'ok', title: 'OK' },
    }),
  })
  assert.equal(validSave.status, 200)
  const validBody = await validSave.json()
  assert.equal(validBody.conversation.id, 'ok')
  assert.equal(validBody.state.conversationsByWorkspace[workspacePath].length, 1)

  const oversizedText = 'x'.repeat(10_000)
  const boundedSave = await fetch(`${baseUrl}/api/app-state/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspacePath,
      conversation: {
        id: oversizedText,
        title: oversizedText,
        age: oversizedText,
        status: 'unexpected',
        prompt: oversizedText,
        response: oversizedText,
        traces: Array.from({ length: 60 }, (_, index) => `${index}-${oversizedText}`),
        transcript: [
          { speaker: 'user', text: oversizedText, extra: oversizedText },
          { speaker: 'system', text: 'should be dropped' },
          { speaker: 'codex', text: oversizedText, metadata: { unsafe: oversizedText } },
        ],
        source: 'demo',
        codexThreadId: oversizedText,
      },
    }),
  })
  assert.equal(boundedSave.status, 200)
  const boundedBody = await boundedSave.json()
  assert.equal(boundedBody.conversation.id.length, 240)
  assert.equal(boundedBody.conversation.title.length, 180)
  assert.equal(boundedBody.conversation.age.length, 40)
  assert.equal(boundedBody.conversation.status, 'draft')
  assert.equal(boundedBody.conversation.prompt.length, 8000)
  assert.equal(boundedBody.conversation.response.length, 8000)
  assert.equal(boundedBody.conversation.traces.length, 40)
  assert.equal(boundedBody.conversation.traces[0].length, 500)
  assert.equal(boundedBody.conversation.transcript.length, 2)
  assert.deepEqual(Object.keys(boundedBody.conversation.transcript[0]).sort(), ['speaker', 'text'])
  assert.equal(boundedBody.conversation.transcript[0].text.length, 8000)
  assert.equal(boundedBody.conversation.source, 'local')
  assert.equal(boundedBody.conversation.codexThreadId.length, 240)

  const missingPatchId = await fetch(`${baseUrl}/api/app-state/conversations`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspacePath, patch: { title: 'No id' } }),
  })
  assert.equal(missingPatchId.status, 400)
  assert.equal((await readJson(missingPatchId)).code, 'invalid_request')

  const invalidConversationDelete = await fetch(`${baseUrl}/api/app-state/conversations/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspacePath: 'relative-workspace', conversationId: '' }),
  })
  assert.equal(invalidConversationDelete.status, 400)
  assert.equal((await readJson(invalidConversationDelete)).code, 'invalid_request')
})

test('server returns json errors for oversized API request bodies', async (t) => {
  const { baseUrl } = await startTestServer(t, { CODEX_REALTIME_JSON_LIMIT: '64b' })

  const oversizedJson = await fetch(`${baseUrl}/api/app-state/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspacePath: '/tmp/codex-realtime-large-body', conversation: { title: 'Large body' } }),
  })
  assert.equal(oversizedJson.status, 413)
  assert.equal((await readJson(oversizedJson)).code, 'payload_too_large')
})

test('realtime token route returns stable json errors when voice cannot start', async (t) => {
  const { baseUrl } = await startTestServer(t, {
    OPENAI_API_KEY: '',
    CODEX_USE_OPENAI_API_KEY: 'false',
  })

  const missingKey = await fetch(`${baseUrl}/api/realtime/token`, {
    method: 'POST',
  })
  assert.equal(missingKey.status, 503)
  assert.equal((await readJson(missingKey)).code, 'openai_api_key_required')
})

test('visual context route validates image payloads before requiring upstream credentials', async (t) => {
  const { baseUrl } = await startTestServer(t, {
    OPENAI_API_KEY: '',
    CODEX_USE_OPENAI_API_KEY: 'false',
  })

  const invalidImage = await fetch(`${baseUrl}/api/vision/context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageDataUrl: 'not-an-image' }),
  })
  assert.equal(invalidImage.status, 400)
  assert.equal((await readJson(invalidImage)).code, 'invalid_visual_context')

  const oversizedImage = await fetch(`${baseUrl}/api/vision/context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageDataUrl: `data:image/png;base64,${'a'.repeat(13 * 1024 * 1024)}` }),
  })
  assert.equal(oversizedImage.status, 413)
  assert.equal((await readJson(oversizedImage)).code, 'visual_context_too_large')
})

test('settings OpenAI key route returns stable json validation errors', async (t) => {
  const { baseUrl } = await startTestServer(t)

  const missingKey = await fetch(`${baseUrl}/api/settings/openai-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  assert.equal(missingKey.status, 400)
  assert.equal((await readJson(missingKey)).code, 'api_key_required')

  const invalidKey = await fetch(`${baseUrl}/api/settings/openai-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: 'not-a-key' }),
  })
  assert.equal(invalidKey.status, 400)
  assert.equal((await readJson(invalidKey)).code, 'invalid_openai_api_key')
})

test('server returns json errors for unmatched API routes and unhandled route failures', async (t) => {
  const badSecretsPath = await mkdtemp(path.join(os.tmpdir(), 'codex-realtime-secrets-dir-'))
  t.after(() => rm(badSecretsPath, { recursive: true, force: true }))
  const { baseUrl } = await startTestServer(t, { CODEX_REALTIME_SECRETS_PATH: badSecretsPath })

  const missingApi = await fetch(`${baseUrl}/api/does-not-exist`)
  assert.equal(missingApi.status, 404)
  assert.equal(missingApi.headers.get('content-type')?.includes('application/json'), true)
  assert.equal((await readJson(missingApi)).code, 'api_not_found')

  const failedSecretWrite = await fetch(`${baseUrl}/api/settings/openai-key`, {
    method: 'DELETE',
  })
  assert.equal(failedSecretWrite.status, 500)
  assert.equal(failedSecretWrite.headers.get('content-type')?.includes('application/json'), true)
  assert.equal((await readJson(failedSecretWrite)).code, 'openai_key_remove_failed')
})
