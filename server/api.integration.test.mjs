import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises'
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

async function writeFakeCodexAppServer(tempDir) {
  const fakeCodexPath = path.join(tempDir, 'fake-codex-app-server.mjs')
  const logPath = path.join(tempDir, 'fake-codex-rpc.log')
  await writeFile(
    fakeCodexPath,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const logPath = process.env.FAKE_CODEX_RPC_LOG
const errorMethods = new Set((process.env.FAKE_CODEX_ERROR_METHODS ?? '').split(',').map((method) => method.trim()).filter(Boolean))
const errorMessage = process.env.FAKE_CODEX_ERROR_MESSAGE ?? 'Fake Codex app-server failure.'
const responses = {
  initialize: {},
  'thread/start': { thread: { id: 'thread-ok' } },
  'turn/start': { turn: { id: 'turn-ok' } },
  'thread/list': {
    data: [
      {
        id: 'thread-large-time',
        name: 'Malformed timestamp',
        preview: 'Timestamp should not break history.',
        cwd: process.env.FAKE_CODEX_THREAD_CWD,
        updatedAt: 1e20,
        status: { type: 'complete' },
        debugPayload: 'x'.repeat(5_000),
      },
      {
        name: 'Missing id',
        preview: 'History rows without stable ids should not become sidebar conversations.',
        cwd: process.env.FAKE_CODEX_THREAD_CWD,
        updatedAt: 1710000000,
        status: { type: 'complete' },
      },
    ],
  },
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (logPath) appendFileSync(logPath, \`\${JSON.stringify(message)}\\n\`)
  if (message.id == null) return
  if (errorMethods.has(message.method)) {
    process.stdout.write(\`\${JSON.stringify({ id: message.id, error: { message: errorMessage, code: 'fake_error' } })}\\n\`)
    return
  }
  const result = responses[message.method] ?? {}
  process.stdout.write(\`\${JSON.stringify({ id: message.id, result })}\\n\`)
})
`,
  )
  await chmod(fakeCodexPath, 0o755)
  return { fakeCodexPath, logPath }
}

test('server enforces workspace scoped state and artifact routes over HTTP', async (t) => {
  const { baseUrl } = await startTestServer(t)
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'codex-realtime-workspace-'))
  t.after(() => rm(workspacePath, { recursive: true, force: true }))
  const emptyStateWorkspacePath = await mkdtemp(path.join(os.tmpdir(), 'codex-realtime-empty-state-workspace-'))
  t.after(() => rm(emptyStateWorkspacePath, { recursive: true, force: true }))

  const artifactDir = path.join(workspacePath, 'public', 'agent-files', 'sample-report')
  await mkdir(artifactDir, { recursive: true })
  await writeFile(path.join(artifactDir, 'index.html'), '<!doctype html><title>Sample report</title>')
  await writeFile(path.join(artifactDir, 'notes.txt'), 'workspace note')
  await writeFile(path.join(artifactDir, '.env'), 'OPENAI_API_KEY=secret')
  await mkdir(path.join(artifactDir, 'assets', '.private'), { recursive: true })
  await writeFile(path.join(artifactDir, 'assets', '.private', 'secret.txt'), 'hidden generated file')
  const unsafeArtifactDir = path.join(workspacePath, 'public', 'agent-files', 'unsafe report')
  await mkdir(unsafeArtifactDir, { recursive: true })
  await writeFile(path.join(unsafeArtifactDir, 'index.html'), '<!doctype html><title>Unsafe report</title>')
  const escapedIndexDir = path.join(workspacePath, 'public', 'agent-files', 'escaped-index')
  await mkdir(escapedIndexDir, { recursive: true })
  const outsideIndexFile = path.join(workspacePath, 'outside-index.html')
  await writeFile(outsideIndexFile, '<!doctype html><title>Outside index</title>')
  await symlink(outsideIndexFile, path.join(escapedIndexDir, 'index.html'))
  await writeFile(path.join(escapedIndexDir, 'notes.txt'), 'escaped index note')
  const loopedIndexDir = path.join(workspacePath, 'public', 'agent-files', 'looped-index')
  await mkdir(loopedIndexDir, { recursive: true })
  await symlink('index.html', path.join(loopedIndexDir, 'index.html'))
  const orphanArtifactDir = path.join(workspacePath, 'public', 'agent-files', 'orphan-report')
  await mkdir(orphanArtifactDir, { recursive: true })
  await writeFile(path.join(orphanArtifactDir, 'notes.txt'), 'not a generated preview artifact')
  const outsideArtifactRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-realtime-outside-artifact-root-'))
  t.after(() => rm(outsideArtifactRoot, { recursive: true, force: true }))
  await writeFile(path.join(outsideArtifactRoot, 'index.html'), '<!doctype html><title>Outside artifact root</title>')
  await symlink(outsideArtifactRoot, path.join(workspacePath, 'public', 'agent-files', 'linked-root'), 'dir')

  const artifactList = await fetch(`${baseUrl}/api/artifacts?workspacePath=${encodeURIComponent(workspacePath)}`)
  assert.equal(artifactList.status, 200)
  const artifactBody = await artifactList.json()
  assert.equal(artifactBody.data.length, 1)
  assert.equal(artifactBody.data[0].relativePath, 'public/agent-files/sample-report/index.html')
  assert.equal(artifactBody.data.some((artifact) => artifact.relativePath.includes('unsafe report')), false)
  assert.equal(artifactBody.data.some((artifact) => artifact.id === 'escaped-index'), false)
  assert.equal(artifactBody.data.some((artifact) => artifact.id === 'looped-index'), false)
  assert.equal(artifactBody.data.some((artifact) => artifact.id === 'linked-root'), false)

  const artifactListWithoutWorkspace = await fetch(`${baseUrl}/api/artifacts`)
  assert.equal(artifactListWithoutWorkspace.status, 400)
  const missingWorkspaceBody = await readJson(artifactListWithoutWorkspace)
  assert.equal(missingWorkspaceBody.code, 'invalid_workspace_path')

  for (let index = 0; index < 45; index += 1) {
    const extraArtifactDir = path.join(workspacePath, 'public', 'agent-files', `extra-report-${String(index).padStart(2, '0')}`)
    await mkdir(extraArtifactDir, { recursive: true })
    await writeFile(path.join(extraArtifactDir, 'index.html'), `<!doctype html><title>Extra ${index}</title>`)
  }
  const oversizedName = `a${'b'.repeat(130)}`
  const oversizedArtifactDir = path.join(workspacePath, 'public', 'agent-files', oversizedName)
  await mkdir(oversizedArtifactDir, { recursive: true })
  await writeFile(path.join(oversizedArtifactDir, 'index.html'), '<!doctype html><title>Oversized report</title>')

  const boundedArtifactList = await fetch(`${baseUrl}/api/artifacts?workspacePath=${encodeURIComponent(workspacePath)}`)
  assert.equal(boundedArtifactList.status, 200)
  const boundedArtifactBody = await boundedArtifactList.json()
  assert.equal(boundedArtifactBody.data.length, 40)
  assert.equal(boundedArtifactBody.data.some((artifact) => artifact.id === oversizedName), false)
  assert.ok(boundedArtifactBody.data.every((artifact) => artifact.title.length <= 180))

  const token = Buffer.from(path.resolve(workspacePath), 'utf8').toString('base64url')
  const preview = await fetch(`${baseUrl}/workspace-artifacts/${token}/sample-report/index.html`)
  assert.equal(preview.status, 200)
  assert.match(preview.headers.get('content-type') ?? '', /^text\/html\b/)
  assert.equal(preview.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(preview.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(preview.headers.get('cache-control'), 'no-store')
  assert.match(preview.headers.get('permissions-policy') ?? '', /microphone=\(\)/)
  assert.match(preview.headers.get('permissions-policy') ?? '', /display-capture=\(\)/)
  assert.match(preview.headers.get('permissions-policy') ?? '', /serial=\(\)/)
  assert.match(preview.headers.get('content-security-policy') ?? '', /frame-ancestors 'self'/)
  assert.match(preview.headers.get('content-security-policy') ?? '', /object-src 'none'/)
  assert.match(preview.headers.get('content-security-policy') ?? '', /connect-src 'none'/)
  assert.doesNotMatch(preview.headers.get('content-security-policy') ?? '', /connect-src 'self'/)
  assert.match(await preview.text(), /Sample report/)

  const hiddenPreviewFile = await fetch(`${baseUrl}/workspace-artifacts/${token}/sample-report/.env`)
  assert.equal(hiddenPreviewFile.status, 404)

  const nestedHiddenPreviewFile = await fetch(`${baseUrl}/workspace-artifacts/${token}/sample-report/assets/.private/secret.txt`)
  assert.equal(nestedHiddenPreviewFile.status, 404)

  const orphanPreviewFile = await fetch(`${baseUrl}/workspace-artifacts/${token}/orphan-report/notes.txt`)
  assert.equal(orphanPreviewFile.status, 404)

  const escapedIndexAsset = await fetch(`${baseUrl}/workspace-artifacts/${token}/escaped-index/notes.txt`)
  assert.equal(escapedIndexAsset.status, 403)

  const traversal = await fetch(`${baseUrl}/workspace-artifacts/${token}/sample-report/..%2F..%2F..%2Fpackage.json`)
  assert.equal(traversal.status, 404)

  const outsidePreviewFile = path.join(workspacePath, 'outside-preview-secret.txt')
  await writeFile(outsidePreviewFile, 'outside artifact root')
  await symlink(outsidePreviewFile, path.join(artifactDir, 'outside-secret.txt'))
  const symlinkEscape = await fetch(`${baseUrl}/workspace-artifacts/${token}/sample-report/outside-secret.txt`)
  assert.equal(symlinkEscape.status, 403)

  const symlinkArtifactRoot = await fetch(`${baseUrl}/workspace-artifacts/${token}/linked-root/index.html`)
  assert.equal(symlinkArtifactRoot.status, 403)

  const outsideArtifactsDir = await mkdtemp(path.join(os.tmpdir(), 'codex-realtime-outside-agent-files-'))
  t.after(() => rm(outsideArtifactsDir, { recursive: true, force: true }))
  const symlinkedArtifactDir = path.join(outsideArtifactsDir, 'linked-report')
  await mkdir(symlinkedArtifactDir, { recursive: true })
  await writeFile(path.join(symlinkedArtifactDir, 'index.html'), '<!doctype html><title>Linked report</title>')
  const symlinkedWorkspacePath = await mkdtemp(path.join(os.tmpdir(), 'codex-realtime-symlinked-artifacts-workspace-'))
  t.after(() => rm(symlinkedWorkspacePath, { recursive: true, force: true }))
  await mkdir(path.join(symlinkedWorkspacePath, 'public'), { recursive: true })
  await symlink(outsideArtifactsDir, path.join(symlinkedWorkspacePath, 'public', 'agent-files'), 'dir')
  const symlinkedWorkspaceArtifacts = await fetch(`${baseUrl}/api/artifacts?workspacePath=${encodeURIComponent(symlinkedWorkspacePath)}`)
  assert.equal(symlinkedWorkspaceArtifacts.status, 200)
  assert.deepEqual((await symlinkedWorkspaceArtifacts.json()).data, [])
  const symlinkedWorkspaceToken = Buffer.from(path.resolve(symlinkedWorkspacePath), 'utf8').toString('base64url')
  const symlinkedWorkspacePreview = await fetch(`${baseUrl}/workspace-artifacts/${symlinkedWorkspaceToken}/linked-report/index.html`)
  assert.equal(symlinkedWorkspacePreview.status, 403)

  await writeFile(path.join(artifactDir, 'unsafe-preview.bin'), 'not a browser preview asset')
  const unsupportedPreview = await fetch(`${baseUrl}/workspace-artifacts/${token}/sample-report/unsafe-preview.bin`)
  assert.equal(unsupportedPreview.status, 415)
  assert.match(await unsupportedPreview.text(), /Unsupported artifact preview file type/)

  const oversizedPreviewFile = path.join(artifactDir, 'huge-preview.html')
  await writeFile(oversizedPreviewFile, '')
  await truncate(oversizedPreviewFile, 26 * 1024 * 1024)
  const oversizedPreview = await fetch(`${baseUrl}/workspace-artifacts/${token}/sample-report/huge-preview.html`)
  assert.equal(oversizedPreview.status, 413)

  const invalidToken = await fetch(`${baseUrl}/workspace-artifacts/not-a-workspace-token/sample-report/index.html`)
  assert.equal(invalidToken.status, 400)
  assert.equal(invalidToken.headers.get('x-content-type-options'), 'nosniff')
  assert.match(invalidToken.headers.get('content-security-policy') ?? '', /connect-src 'none'/)
  assert.match(await invalidToken.text(), /Invalid workspace token/)

  const oversizedToken = await fetch(`${baseUrl}/workspace-artifacts/${'a'.repeat(8193)}/sample-report/index.html`)
  assert.equal(oversizedToken.status, 400)
  assert.match(await oversizedToken.text(), /Invalid workspace token/)

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

  const nonObjectArduinoUpload = await fetch(`${baseUrl}/api/arduino/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '[]',
  })
  assert.equal(nonObjectArduinoUpload.status, 400)
  assert.equal((await readJson(nonObjectArduinoUpload)).code, 'invalid_request')

  const missingArduinoActionUpload = await fetch(`${baseUrl}/api/arduino/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  assert.equal(missingArduinoActionUpload.status, 400)
  assert.equal((await readJson(missingArduinoActionUpload)).code, 'arduino_invalid_action')

  const appShell = await fetch(`${baseUrl}/`)
  assert.equal(appShell.status, 200)
  assert.equal(appShell.headers.has('x-powered-by'), false)
  assert.match(appShell.headers.get('content-security-policy') ?? '', /connect-src 'self' https:\/\/api\.openai\.com/)
  assert.match(appShell.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/)
  assert.match(appShell.headers.get('permissions-policy') ?? '', /microphone=\(self\)/)
  assert.match(appShell.headers.get('permissions-policy') ?? '', /display-capture=\(self\)/)
  assert.equal(appShell.headers.get('x-frame-options'), 'DENY')
  assert.equal(appShell.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(appShell.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(appShell.headers.get('cache-control'), 'no-store')
  assert.match(await appShell.text(), /<div id="root"><\/div>/)

  const malformedJson = await fetch(`${baseUrl}/api/app-state/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"workspacePath":',
  })
  assert.equal(malformedJson.status, 400)
  assert.equal((await readJson(malformedJson)).code, 'invalid_json')

  const nonObjectWorkspaceSave = await fetch(`${baseUrl}/api/app-state/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '[]',
  })
  assert.equal(nonObjectWorkspaceSave.status, 400)
  assert.equal((await readJson(nonObjectWorkspaceSave)).code, 'invalid_request')

  const nonObjectWorkspaceObjectSave = await fetch(`${baseUrl}/api/app-state/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace: [] }),
  })
  assert.equal(nonObjectWorkspaceObjectSave.status, 400)
  assert.equal((await readJson(nonObjectWorkspaceObjectSave)).code, 'invalid_request')

  const nonObjectConversationSave = await fetch(`${baseUrl}/api/app-state/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '[]',
  })
  assert.equal(nonObjectConversationSave.status, 400)
  assert.equal((await readJson(nonObjectConversationSave)).code, 'invalid_request')

  const nonObjectConversationPatch = await fetch(`${baseUrl}/api/app-state/conversations`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: '[]',
  })
  assert.equal(nonObjectConversationPatch.status, 400)
  assert.equal((await readJson(nonObjectConversationPatch)).code, 'invalid_request')

  const nonObjectConversationPatchObject = await fetch(`${baseUrl}/api/app-state/conversations`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspacePath, conversationId: 'missing-conversation', patch: [] }),
  })
  assert.equal(nonObjectConversationPatchObject.status, 400)
  assert.equal((await readJson(nonObjectConversationPatchObject)).code, 'invalid_request')

  const nonObjectConversationDelete = await fetch(`${baseUrl}/api/app-state/conversations/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '[]',
  })
  assert.equal(nonObjectConversationDelete.status, 400)
  assert.equal((await readJson(nonObjectConversationDelete)).code, 'invalid_request')

  const nonObjectWeatherPost = await fetch(`${baseUrl}/api/weather/current`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '[]',
  })
  assert.equal(nonObjectWeatherPost.status, 400)
  assert.equal((await readJson(nonObjectWeatherPost)).code, 'invalid_request')

  const nonObjectCodexArchive = await fetch(`${baseUrl}/api/codex/thread/archive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '[]',
  })
  assert.equal(nonObjectCodexArchive.status, 400)
  assert.equal((await readJson(nonObjectCodexArchive)).code, 'invalid_request')

  const nonObjectCodexTask = await fetch(`${baseUrl}/api/codex/task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '[]',
  })
  assert.equal(nonObjectCodexTask.status, 400)
  assert.equal((await readJson(nonObjectCodexTask)).code, 'invalid_request')

  const nonObjectCodexSteer = await fetch(`${baseUrl}/api/codex/steer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '[]',
  })
  assert.equal(nonObjectCodexSteer.status, 400)
  assert.equal((await readJson(nonObjectCodexSteer)).code, 'invalid_request')

  const nonObjectCodexInterrupt = await fetch(`${baseUrl}/api/codex/interrupt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '[]',
  })
  assert.equal(nonObjectCodexInterrupt.status, 400)
  assert.equal((await readJson(nonObjectCodexInterrupt)).code, 'invalid_request')

  const missingTaskWorkspace = await fetch(`${baseUrl}/api/codex/task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal: 'Create an HTML presentation about this workspace.' }),
  })
  assert.equal(missingTaskWorkspace.status, 400)
  assert.equal((await readJson(missingTaskWorkspace)).code, 'invalid_workspace_path')

  const protectedAppArtifactTask = await fetch(`${baseUrl}/api/codex/task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cwd: repoRoot,
      goal: 'Create an HTML presentation about this app.',
    }),
  })
  assert.equal(protectedAppArtifactTask.status, 400)
  assert.equal((await readJson(protectedAppArtifactTask)).code, 'protected_app_workspace')

  const protectedAppDesiredArtifactTask = await fetch(`${baseUrl}/api/codex/task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cwd: repoRoot,
      goal: 'I need a presentation about this app.',
    }),
  })
  assert.equal(protectedAppDesiredArtifactTask.status, 400)
  assert.equal((await readJson(protectedAppDesiredArtifactTask)).code, 'protected_app_workspace')

  const protectedAppNounPhraseArtifactTask = await fetch(`${baseUrl}/api/codex/task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cwd: repoRoot,
      goal: 'A presentation about this app in the style of Apple.',
    }),
  })
  assert.equal(protectedAppNounPhraseArtifactTask.status, 400)
  assert.equal((await readJson(protectedAppNounPhraseArtifactTask)).code, 'protected_app_workspace')

  const protectedAppNonArtifactTask = await fetch(`${baseUrl}/api/codex/task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cwd: repoRoot,
      goal: 'Review this app source and summarize the current implementation.',
    }),
  })
  assert.equal(protectedAppNonArtifactTask.status, 400)
  assert.equal((await readJson(protectedAppNonArtifactTask)).code, 'protected_app_workspace')

  const protectedAppSubdirArtifactTask = await fetch(`${baseUrl}/api/codex/task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cwd: path.join(repoRoot, 'src'),
      goal: 'Create an HTML presentation about this folder.',
    }),
  })
  assert.equal(protectedAppSubdirArtifactTask.status, 400)
  assert.equal((await readJson(protectedAppSubdirArtifactTask)).code, 'protected_app_workspace')

  const symlinkedAppWorkspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-realtime-app-symlink-workspace-'))
  t.after(() => rm(symlinkedAppWorkspaceRoot, { recursive: true, force: true }))
  const symlinkedAppWorkspace = path.join(symlinkedAppWorkspaceRoot, 'linked-app')
  await symlink(repoRoot, symlinkedAppWorkspace, 'dir')
  const protectedSymlinkedAppArtifactTask = await fetch(`${baseUrl}/api/codex/task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cwd: symlinkedAppWorkspace,
      goal: 'Create an HTML presentation about this symlinked workspace.',
    }),
  })
  assert.equal(protectedSymlinkedAppArtifactTask.status, 400)
  assert.equal((await readJson(protectedSymlinkedAppArtifactTask)).code, 'protected_app_workspace')

  const protectedSymlinkedAppNonArtifactTask = await fetch(`${baseUrl}/api/codex/task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cwd: symlinkedAppWorkspace,
      goal: 'Inspect this project and summarize its structure.',
    }),
  })
  assert.equal(protectedSymlinkedAppNonArtifactTask.status, 400)
  assert.equal((await readJson(protectedSymlinkedAppNonArtifactTask)).code, 'protected_app_workspace')

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

  const missingConversationObjectSave = await fetch(`${baseUrl}/api/app-state/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspacePath }),
  })
  assert.equal(missingConversationObjectSave.status, 400)
  assert.equal((await readJson(missingConversationObjectSave)).code, 'invalid_request')

  const nonObjectConversationObjectSave = await fetch(`${baseUrl}/api/app-state/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspacePath, conversation: [] }),
  })
  assert.equal(nonObjectConversationObjectSave.status, 400)
  assert.equal((await readJson(nonObjectConversationObjectSave)).code, 'invalid_request')

  const missingConversationIdSave = await fetch(`${baseUrl}/api/app-state/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspacePath, conversation: { title: 'No id' } }),
  })
  assert.equal(missingConversationIdSave.status, 400)
  assert.equal((await readJson(missingConversationIdSave)).code, 'invalid_request')

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
        createdAt: oversizedText,
        updatedAt: 'not-a-timestamp',
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
  assert.match(boundedBody.conversation.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.match(boundedBody.conversation.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.notEqual(boundedBody.conversation.createdAt, oversizedText)
  assert.notEqual(boundedBody.conversation.updatedAt, 'not-a-timestamp')

  const missingPatchId = await fetch(`${baseUrl}/api/app-state/conversations`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspacePath, patch: { title: 'No id' } }),
  })
  assert.equal(missingPatchId.status, 400)
  assert.equal((await readJson(missingPatchId)).code, 'invalid_request')

  const missingPatchConversation = await fetch(`${baseUrl}/api/app-state/conversations`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspacePath, conversationId: 'missing-conversation', patch: { title: 'No target' } }),
  })
  assert.equal(missingPatchConversation.status, 404)
  assert.equal((await readJson(missingPatchConversation)).code, 'conversation_not_found')

  const missingPatchInEmptyWorkspace = await fetch(`${baseUrl}/api/app-state/conversations`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspacePath: emptyStateWorkspacePath, conversationId: 'missing-conversation', patch: { title: 'No target' } }),
  })
  assert.equal(missingPatchInEmptyWorkspace.status, 404)
  assert.equal((await readJson(missingPatchInEmptyWorkspace)).code, 'conversation_not_found')
  let stateAfterMissingConversationMutation = await (await fetch(`${baseUrl}/api/app-state`)).json()
  assert.equal(stateAfterMissingConversationMutation.conversationsByWorkspace[emptyStateWorkspacePath], undefined)

  const conflictingPatch = await fetch(`${baseUrl}/api/app-state/conversations`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspacePath,
      conversationId: 'ok',
      patch: {
        id: 'rewritten-id',
        workspacePath: emptyStateWorkspacePath,
        title: 'Patched title',
        status: 'ready',
      },
    }),
  })
  assert.equal(conflictingPatch.status, 200)
  const conflictingPatchBody = await conflictingPatch.json()
  assert.equal(conflictingPatchBody.conversation.id, 'ok')
  assert.equal(conflictingPatchBody.conversation.workspacePath, workspacePath)
  assert.equal(conflictingPatchBody.conversation.title, 'Patched title')
  assert.equal(conflictingPatchBody.state.conversationsByWorkspace[workspacePath][0].id, boundedBody.conversation.id)
  assert.equal(conflictingPatchBody.state.conversationsByWorkspace[workspacePath][1].id, 'ok')
  assert.equal(conflictingPatchBody.state.conversationsByWorkspace[emptyStateWorkspacePath], undefined)

  const deleteOneConversation = await fetch(`${baseUrl}/api/app-state/conversations/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspacePath, conversationId: 'ok' }),
  })
  assert.equal(deleteOneConversation.status, 200)
  const deleteOneConversationBody = await deleteOneConversation.json()
  assert.equal(deleteOneConversationBody.state.conversationsByWorkspace[workspacePath].length, 1)
  assert.equal(deleteOneConversationBody.state.conversationsByWorkspace[workspacePath][0].id, boundedBody.conversation.id)
  assert.equal(deleteOneConversationBody.state.conversationsByWorkspace[emptyStateWorkspacePath], undefined)

  const invalidConversationDelete = await fetch(`${baseUrl}/api/app-state/conversations/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspacePath: 'relative-workspace', conversationId: '' }),
  })
  assert.equal(invalidConversationDelete.status, 400)
  assert.equal((await readJson(invalidConversationDelete)).code, 'invalid_request')

  const missingWorkspaceDelete = await fetch(`${baseUrl}/api/app-state/conversations/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspacePath: path.join(os.tmpdir(), 'missing-codex-realtime-conversation-delete'),
      conversationId: 'ok',
    }),
  })
  assert.equal(missingWorkspaceDelete.status, 404)
  assert.equal((await readJson(missingWorkspaceDelete)).code, 'workspace_not_found')

  const missingConversationDelete = await fetch(`${baseUrl}/api/app-state/conversations/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspacePath: emptyStateWorkspacePath, conversationId: 'missing-conversation' }),
  })
  assert.equal(missingConversationDelete.status, 404)
  assert.equal((await readJson(missingConversationDelete)).code, 'conversation_not_found')
  stateAfterMissingConversationMutation = await (await fetch(`${baseUrl}/api/app-state`)).json()
  assert.equal(stateAfterMissingConversationMutation.conversationsByWorkspace[emptyStateWorkspacePath], undefined)
})

test('codex task returns public artifact metadata for external workspace artifacts', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codex-realtime-fake-codex-'))
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'codex-realtime-artifact-task-workspace-'))
  t.after(() => rm(tempDir, { recursive: true, force: true }))
  t.after(() => rm(workspacePath, { recursive: true, force: true }))
  const { fakeCodexPath, logPath } = await writeFakeCodexAppServer(tempDir)
  const { baseUrl } = await startTestServer(t, {
    CODEX_BIN: fakeCodexPath,
    CODEX_API_KEY: '',
    CODEX_APPROVAL_POLICY: 'never',
    CODEX_USE_OPENAI_API_KEY: 'false',
    FAKE_CODEX_RPC_LOG: logPath,
    FAKE_CODEX_THREAD_CWD: workspacePath,
  })

  const task = await fetch(`${baseUrl}/api/codex/task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cwd: workspacePath,
      goal: 'Create an HTML presentation about this workspace.',
    }),
  })
  assert.equal(task.status, 200)
  const body = await task.json()

  assert.equal(body.thread.id, 'thread-ok')
  assert.equal(body.turn.id, 'turn-ok')
  assert.equal(body.artifact.workspacePath, workspacePath)
  assert.match(
    body.artifact.relativeDir,
    /^public\/agent-files\/\d{8}t\d{6}-create-an-html-presentation-about-this-workspace-[a-z0-9-]+$/,
  )
  assert.equal(body.artifact.relativePath, `${body.artifact.relativeDir}/index.html`)
  assert.equal(
    body.artifact.url,
    `/workspace-artifacts/${Buffer.from(workspacePath, 'utf8').toString('base64url')}/${body.artifact.directoryName}/index.html`,
  )
  assert.equal('absoluteDir' in body.artifact, false)
  assert.equal('absolutePath' in body.artifact, false)
  assert.equal((await stat(path.join(workspacePath, body.artifact.relativeDir))).isDirectory(), true)

  const rpcMessages = (await readFile(logPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const threadStart = rpcMessages.find((message) => message.method === 'thread/start')
  assert.equal(threadStart?.params?.approvalPolicy, 'never')
  assert.equal(threadStart?.params?.sandbox, 'workspace-write')
  const turnStart = rpcMessages.find((message) => message.method === 'turn/start')
  const escapedRelativePath = body.artifact.relativePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const turnText = turnStart?.params?.input?.[0]?.text ?? ''
  assert.match(turnText, /Artifact workflow: inspect this selected workspace/)
  assert.match(turnText, new RegExp(escapedRelativePath))
  assert.match(turnText, /User goal:\nCreate an HTML presentation about this workspace\./)
  assert.doesNotMatch(turnText, /absoluteDir|absolutePath/)

  const threads = await fetch(`${baseUrl}/api/codex/threads?limit=10&cwd=${encodeURIComponent(workspacePath)}`)
  assert.equal(threads.status, 200)
  const threadsBody = await threads.json()
  assert.equal(threadsBody.conversations.length, 1)
  assert.equal(threadsBody.conversations[0].id, 'thread-large-time')
  assert.equal(threadsBody.conversations[0].workspacePath, workspacePath)
  assert.match(threadsBody.conversations[0].updatedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(threadsBody.data.length, 2)
  assert.equal(threadsBody.data[0].debugPayload.length, 1000)
  assert.equal(threadsBody.conversations.some((conversation) => /^codex-\d{4}-/.test(conversation.id)), false)

  const unscopedThreads = await fetch(`${baseUrl}/api/codex/threads?limit=10`)
  assert.equal(unscopedThreads.status, 400)
  assert.equal((await readJson(unscopedThreads)).code, 'invalid_workspace_path')

  const rpcMessagesAfterThreads = (await readFile(logPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const threadListMessages = rpcMessagesAfterThreads.filter((message) => message.method === 'thread/list')
  assert.equal(threadListMessages.length, 1)
  assert.equal(threadListMessages[0].params.cwd, workspacePath)
})

test('codex app-source tasks require an explicit environment opt-in', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codex-realtime-fake-codex-app-source-'))
  t.after(() => rm(tempDir, { recursive: true, force: true }))
  const { fakeCodexPath, logPath } = await writeFakeCodexAppServer(tempDir)
  const { baseUrl } = await startTestServer(t, {
    CODEX_ALLOW_APP_SOURCE_TASKS: 'true',
    CODEX_BIN: fakeCodexPath,
    CODEX_API_KEY: '',
    CODEX_USE_OPENAI_API_KEY: 'false',
    FAKE_CODEX_RPC_LOG: logPath,
    FAKE_CODEX_THREAD_CWD: repoRoot,
  })

  const status = await (await fetch(`${baseUrl}/api/status`)).json()
  assert.equal(status.codexAppSourceTasksAllowed, true)

  const task = await fetch(`${baseUrl}/api/codex/task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cwd: repoRoot,
      goal: 'Review this app source and summarize the current implementation.',
    }),
  })
  assert.equal(task.status, 200)
  const body = await task.json()
  assert.equal(body.thread.id, 'thread-ok')
  assert.equal(body.turn.id, 'turn-ok')
  assert.equal(body.artifact, null)

  const rpcMessages = (await readFile(logPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const threadStart = rpcMessages.find((message) => message.method === 'thread/start')
  assert.equal(threadStart?.params?.cwd, repoRoot)
})

test('codex routes bound app-server rpc error messages', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codex-realtime-rpc-error-'))
  t.after(() => rm(tempDir, { recursive: true, force: true }))
  const { fakeCodexPath } = await writeFakeCodexAppServer(tempDir)
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'codex-realtime-rpc-error-workspace-'))
  t.after(() => rm(workspacePath, { recursive: true, force: true }))
  const oversizedError = `RPC failed: ${'x'.repeat(2_000)}`

  const { baseUrl } = await startTestServer(t, {
    CODEX_BIN: fakeCodexPath,
    FAKE_CODEX_ERROR_METHODS: 'thread/list',
    FAKE_CODEX_ERROR_MESSAGE: oversizedError,
  })

  const response = await fetch(`${baseUrl}/api/codex/threads?cwd=${encodeURIComponent(workspacePath)}`)
  assert.equal(response.status, 502)
  const body = await readJson(response)
  assert.equal(body.error.length, 500)
  assert.match(body.error, /^RPC failed: x+/)
  assert.match(body.error, /\.\.\.$/)
  assert.doesNotMatch(body.error, /x{600}/)
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

test('server exposes desktop launch metadata when managed by Electron', async (t) => {
  const { baseUrl } = await startTestServer(t, {
    CODEX_DESKTOP_SERVER_TOKEN: 'test-desktop-token',
    CODEX_BIN: './relative-codex',
    CODEX_APPROVAL_POLICY: 'danger',
    REALTIME_TRANSCRIPTION_MODEL: 'test-transcribe-model',
  })

  const status = await fetch(`${baseUrl}/api/status`)
  assert.equal(status.status, 200)
  assert.equal(status.headers.has('x-powered-by'), false)
  const body = await status.json()
  assert.equal(body.desktopServer.token, 'test-desktop-token')
  assert.equal(Number.isInteger(body.desktopServer.pid), true)
  assert.equal(body.codexBin, 'codex')
  assert.equal(body.codexApprovalPolicy, 'on-request')
  assert.equal(body.codexAppSourceTasksAllowed, false)
  assert.equal(body.realtimeTranscriptionModel, 'test-transcribe-model')
})

test('usage route surfaces malformed OpenAI admin JSON as a clean error', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codex-realtime-openai-fetch-mock-'))
  t.after(() => rm(tempDir, { recursive: true, force: true }))
  const fetchMockPath = path.join(tempDir, 'mock-openai-fetch.mjs')
  await writeFile(
    fetchMockPath,
    `const realFetch = globalThis.fetch

globalThis.fetch = async (url, init) => {
  const href = String(url)
  if (href.startsWith('https://api.openai.com/v1/organization/costs')) {
    return new Response('{not json', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  if (href.startsWith('https://api.openai.com/v1/organization/usage/completions')) {
    return Response.json({ data: [] })
  }
  return realFetch(url, init)
}
`,
  )

  const { baseUrl } = await startTestServer(t, {
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${fetchMockPath}`.trim(),
    OPENAI_ADMIN_KEY: 'sk-admin-test',
    OPENAI_USAGE_GBP_RATE: '0.8',
  })

  const spend = await fetch(`${baseUrl}/api/spend`)
  assert.equal(spend.status, 200)
  const body = await spend.json()
  assert.equal(body.source, 'admin-api-error')
  assert.match(body.error, /Upstream response was not JSON/)
  assert.equal(body.data.totalCostGbp, null)
  assert.deepEqual(body.data.costBuckets, [])
  assert.deepEqual(body.data.tokenBuckets, [])
})

test('weather route supports documented GET queries with normalized results', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codex-realtime-weather-fetch-mock-'))
  t.after(() => rm(tempDir, { recursive: true, force: true }))
  const fetchMockPath = path.join(tempDir, 'mock-weather-fetch.mjs')
  await writeFile(
    fetchMockPath,
    `const realFetch = globalThis.fetch

globalThis.fetch = async (url, init) => {
  const href = String(url)
  if (href.startsWith('https://geocoding-api.open-meteo.com/v1/search')) {
    return Response.json({
      results: [{
        name: 'London',
        admin1: 'England',
        country: 'United Kingdom',
        latitude: 51.5,
        longitude: -0.12,
        timezone: 'Europe/London',
      }],
    })
  }
  if (href.startsWith('https://api.open-meteo.com/v1/forecast')) {
    return Response.json({
      timezone: 'Europe/London',
      current: {
        time: '2026-06-09T12:00',
        temperature_2m: 22.2,
        apparent_temperature: 21.8,
        relative_humidity_2m: 55,
        weather_code: 1,
        wind_speed_10m: 10,
        is_day: 1,
      },
    })
  }
  return realFetch(url, init)
}
`,
  )

  const { baseUrl } = await startTestServer(t, {
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${fetchMockPath}`.trim(),
  })

  const weather = await fetch(`${baseUrl}/api/weather/current?location=${encodeURIComponent('  London  ')}&units=metric`)
  assert.equal(weather.status, 200)
  const body = await weather.json()
  assert.equal(body.source, 'open-meteo')
  assert.equal(body.query, 'London')
  assert.equal(body.location.name, 'London')
  assert.equal(body.location.timezone, 'Europe/London')
  assert.equal(body.units.mode, 'metric')
  assert.equal(body.current.temperature, 22.2)
  assert.match(body.summary, /London, England, United Kingdom: 22\.2°C/)
})

test('server only trusts configured loopback API origins', async (t) => {
  const { baseUrl } = await startTestServer(t, {
    CODEX_REALTIME_ALLOWED_ORIGINS: [
      'http://127.0.0.1:6006',
      'http://localhost:6007',
      'http://[::1]:6008',
      'https://example.invalid',
      'http://127.0.0.1:6009/path',
      'http://user:pass@127.0.0.1:6010',
    ].join(','),
  })

  const trustedLoopback = await fetch(`${baseUrl}/api/status`, {
    headers: { Origin: 'http://127.0.0.1:6006' },
  })
  assert.equal(trustedLoopback.status, 200)
  assert.equal(trustedLoopback.headers.get('access-control-allow-origin'), 'http://127.0.0.1:6006')
  assert.equal(trustedLoopback.headers.get('vary'), 'Origin')

  const trustedLocalhost = await fetch(`${baseUrl}/api/status`, {
    headers: { Origin: 'http://localhost:6007' },
  })
  assert.equal(trustedLocalhost.status, 200)

  const trustedIpv6Loopback = await fetch(`${baseUrl}/api/status`, {
    headers: { Origin: 'http://[::1]:6008' },
  })
  assert.equal(trustedIpv6Loopback.status, 200)

  const trustedPreflight = await fetch(`${baseUrl}/api/app-state/conversations`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://127.0.0.1:6006',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  })
  assert.equal(trustedPreflight.status, 204)
  assert.equal(trustedPreflight.headers.get('access-control-allow-origin'), 'http://127.0.0.1:6006')
  assert.match(trustedPreflight.headers.get('access-control-allow-methods') ?? '', /POST/)
  assert.match(trustedPreflight.headers.get('access-control-allow-headers') ?? '', /Content-Type/)

  const untrustedRemote = await fetch(`${baseUrl}/api/status`, {
    headers: { Origin: 'https://example.invalid' },
  })
  assert.equal(untrustedRemote.status, 403)
  assert.equal((await readJson(untrustedRemote)).code, 'origin_not_allowed')

  const untrustedPathOrigin = await fetch(`${baseUrl}/api/status`, {
    headers: { Origin: 'http://127.0.0.1:6009' },
  })
  assert.equal(untrustedPathOrigin.status, 403)
  assert.equal((await readJson(untrustedPathOrigin)).code, 'origin_not_allowed')

  const untrustedCredentialOrigin = await fetch(`${baseUrl}/api/status`, {
    headers: { Origin: 'http://127.0.0.1:6010' },
  })
  assert.equal(untrustedCredentialOrigin.status, 403)
  assert.equal((await readJson(untrustedCredentialOrigin)).code, 'origin_not_allowed')
})

test('server bounds persisted app state loaded from disk', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codex-realtime-persisted-state-'))
  t.after(() => rm(tempDir, { recursive: true, force: true }))
  const statePath = path.join(tempDir, 'state.json')
  const secretsPath = path.join(tempDir, 'secrets.json')

  const manyWorkspaces = Array.from({ length: 100 }, (_, index) => ({
    id: path.join('/tmp', `codex-realtime-saved-${index}`),
    name: `Saved ${index}`,
  }))
  const conversations = Array.from({ length: 100 }, (_, index) => ({
    id: `conversation-${index}`,
    title: index === 0 ? 'Voice build 7' : `Conversation ${index}`,
    prompt: index === 0 ? 'Describe the next build step out loud.' : '',
    response: index === 0 ? 'This agent conversation is ready for realtime voice direction.' : '',
    traces: index === 0 ? ['Workspace selected', 'Voice direction pending', 'Codex execution ready'] : [],
    status: index === 0 ? 'draft' : undefined,
    source: index === 0 ? 'local' : undefined,
    codexThreadId: index === 0 ? null : undefined,
    transcript:
      index === 0
        ? [
            { speaker: 'user', text: 'Create a new agent conversation for this workspace.' },
            { speaker: 'codex', text: 'Ready. Start voice and describe the build goal.' },
          ]
        : [{ speaker: 'user', text: 'hello' }],
  }))
  const persistedWorkspaces = [
    manyWorkspaces[0],
    { ...manyWorkspaces[0], name: 'Duplicate saved workspace' },
    ...manyWorkspaces.slice(1),
  ]
  const persistedConversations = [
    conversations[0],
    {
      id: 'current-empty-voice-draft',
      title: 'Voice conversation 8',
      status: 'draft',
      source: 'local',
      prompt: '',
      response: '',
      traces: [],
      transcript: [],
      codexThreadId: null,
    },
    { title: 'Missing id should be ignored' },
    conversations[1],
    { ...conversations[1], title: 'Duplicate conversation 1' },
    ...conversations.slice(2),
  ]
  const emptyVoiceDrafts = Array.from({ length: 3 }, (_, index) => ({
    id: `empty-voice-draft-${index}`,
    title: `Voice conversation ${index + 1}`,
    status: 'draft',
    source: 'local',
    prompt: '',
    response: '',
    traces: [],
    transcript: [],
    codexThreadId: null,
  }))
  const emptyVoiceDraftWorkspace = path.join('/tmp', 'codex-realtime-empty-voice-drafts')
  const invalidConversationBuckets = Object.fromEntries(
    Array.from({ length: 50 }, (_, index) => [`relative-invalid-workspace-${index}`, []]),
  )
  await writeFile(
    statePath,
    JSON.stringify({
      workspaces: persistedWorkspaces,
      hiddenWorkspacePaths: [
        manyWorkspaces[0].id,
        manyWorkspaces[0].id,
        'relative-hidden-workspace',
        ...manyWorkspaces.map((workspace) => workspace.id),
      ],
      conversationsByWorkspace: {
        ...invalidConversationBuckets,
        ...Object.fromEntries(manyWorkspaces.map((workspace) => [workspace.id, persistedConversations])),
        [emptyVoiceDraftWorkspace]: emptyVoiceDrafts,
      },
    }),
  )

  const { baseUrl } = await startTestServer(t, {
    CODEX_REALTIME_STATE_PATH: statePath,
    CODEX_REALTIME_SECRETS_PATH: secretsPath,
  })
  const state = await (await fetch(`${baseUrl}/api/app-state`)).json()

  assert.equal(state.workspaces.length, 40)
  assert.equal(state.workspaces.filter((workspace) => workspace.path === manyWorkspaces[0].id).length, 1)
  assert.equal(state.hiddenWorkspacePaths.length, 80)
  assert.equal(state.hiddenWorkspacePaths.filter((workspacePath) => workspacePath === manyWorkspaces[0].id).length, 1)
  assert.equal(state.hiddenWorkspacePaths.includes('relative-hidden-workspace'), false)
  assert.equal(Object.keys(state.conversationsByWorkspace).length, 40)
  assert.equal(state.conversationsByWorkspace[manyWorkspaces[0].id].length, 80)
  assert.equal(state.conversationsByWorkspace[manyWorkspaces[0].id].some((conversation) => conversation.title === 'Voice conversation 7'), false)
  assert.equal(state.conversationsByWorkspace[manyWorkspaces[0].id].some((conversation) => conversation.title === 'Voice conversation 8'), true)
  assert.equal(state.conversationsByWorkspace[manyWorkspaces[0].id].some((conversation) => conversation.title === 'Missing id should be ignored'), false)
  assert.equal(state.conversationsByWorkspace[manyWorkspaces[0].id][0].title, 'Voice conversation 8')
  assert.equal(
    state.conversationsByWorkspace[manyWorkspaces[0].id].filter((conversation) => conversation.id === 'conversation-1').length,
    1,
  )
  assert.equal(state.conversationsByWorkspace[manyWorkspaces[0].id][0].workspacePath, manyWorkspaces[0].id)
  assert.deepEqual(state.conversationsByWorkspace[manyWorkspaces[0].id][0].transcript, [])
  assert.equal(state.conversationsByWorkspace[manyWorkspaces[0].id][1].transcript[0].text, 'hello')
  assert.equal(state.conversationsByWorkspace[emptyVoiceDraftWorkspace], undefined)
})

test('server preserves empty draft conversations when deleting one conversation', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codex-realtime-empty-draft-delete-state-'))
  t.after(() => rm(tempDir, { recursive: true, force: true }))
  const statePath = path.join(tempDir, 'state.json')
  const secretsPath = path.join(tempDir, 'secrets.json')
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'codex-realtime-empty-draft-delete-workspace-'))
  t.after(() => rm(workspacePath, { recursive: true, force: true }))

  await writeFile(
    statePath,
    JSON.stringify({
      workspaces: [{ id: workspacePath, path: workspacePath, name: 'Draft delete workspace' }],
      conversationsByWorkspace: {
        [workspacePath]: [
          { id: 'draft-1', title: 'Voice conversation 1', status: 'draft', source: 'local', prompt: '', response: '', traces: [], transcript: [] },
          { id: 'draft-2', title: 'Voice conversation 2', status: 'draft', source: 'local', prompt: '', response: '', traces: [], transcript: [] },
          { id: 'draft-3', title: 'Voice conversation 3', status: 'draft', source: 'local', prompt: '', response: '', traces: [], transcript: [] },
        ],
      },
    }),
  )

  const { baseUrl } = await startTestServer(t, {
    CODEX_REALTIME_STATE_PATH: statePath,
    CODEX_REALTIME_SECRETS_PATH: secretsPath,
  })

  const response = await fetch(`${baseUrl}/api/app-state/conversations/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspacePath, conversationId: 'draft-2' }),
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(
    body.state.conversationsByWorkspace[workspacePath].map((conversation) => conversation.id),
    ['draft-1', 'draft-3'],
  )
})

test('server returns normalized app state after mutations', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codex-realtime-mutation-state-'))
  t.after(() => rm(tempDir, { recursive: true, force: true }))
  const statePath = path.join(tempDir, 'state.json')
  const secretsPath = path.join(tempDir, 'secrets.json')
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'codex-realtime-mutation-workspace-'))
  t.after(() => rm(workspacePath, { recursive: true, force: true }))
  const existingWorkspaces = Array.from({ length: 45 }, (_, index) => ({
    id: path.join('/tmp', `codex-realtime-existing-${index}`),
    name: `Existing ${index}`,
  }))
  const existingConversations = Array.from({ length: 100 }, (_, index) => ({
    id: `existing-conversation-${index}`,
    title: `Existing conversation ${index}`,
  }))

  await writeFile(
    statePath,
    JSON.stringify({
      workspaces: existingWorkspaces,
      conversationsByWorkspace: {
        [workspacePath]: existingConversations,
      },
    }),
  )

  const { baseUrl } = await startTestServer(t, {
    CODEX_REALTIME_STATE_PATH: statePath,
    CODEX_REALTIME_SECRETS_PATH: secretsPath,
  })

  const workspaceSave = await fetch(`${baseUrl}/api/app-state/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace: { id: workspacePath, path: workspacePath, name: 'Mutation workspace' } }),
  })
  assert.equal(workspaceSave.status, 200)
  const workspaceBody = await workspaceSave.json()
  assert.equal(workspaceBody.state.workspaces.length, 40)
  assert.equal(workspaceBody.state.workspaces[0].path, workspacePath)

  const conversationSave = await fetch(`${baseUrl}/api/app-state/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspacePath,
      conversation: { id: 'new-conversation', title: 'New conversation' },
    }),
  })
  assert.equal(conversationSave.status, 200)
  const conversationBody = await conversationSave.json()
  assert.equal(conversationBody.state.conversationsByWorkspace[workspacePath].length, 80)
  assert.equal(conversationBody.state.conversationsByWorkspace[workspacePath][0].id, 'new-conversation')
  assert.equal(conversationBody.state.conversationsByWorkspace[workspacePath][0].workspacePath, workspacePath)

  const workspaceDelete = await fetch(`${baseUrl}/api/app-state/workspaces/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspacePath }),
  })
  assert.equal(workspaceDelete.status, 200)
  const workspaceDeleteBody = await workspaceDelete.json()
  assert.equal(workspaceDeleteBody.state.workspaces.some((workspace) => workspace.path === workspacePath), false)
  assert.equal(workspaceDeleteBody.state.hiddenWorkspacePaths.includes(workspacePath), true)
  assert.equal(workspaceDeleteBody.state.conversationsByWorkspace[workspacePath], undefined)

  const workspaceReAdd = await fetch(`${baseUrl}/api/app-state/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace: { id: workspacePath, path: workspacePath, name: 'Mutation workspace restored' } }),
  })
  assert.equal(workspaceReAdd.status, 200)
  const workspaceReAddBody = await workspaceReAdd.json()
  assert.equal(workspaceReAddBody.state.workspaces[0].path, workspacePath)
  assert.equal(workspaceReAddBody.state.hiddenWorkspacePaths.includes(workspacePath), false)
  assert.deepEqual(workspaceReAddBody.state.conversationsByWorkspace[workspacePath], [])

  const restoredConversationSave = await fetch(`${baseUrl}/api/app-state/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspacePath,
      conversation: { id: 'restored-conversation', title: 'Restored conversation' },
    }),
  })
  assert.equal(restoredConversationSave.status, 200)
  const restoredConversationBody = await restoredConversationSave.json()
  assert.equal(restoredConversationBody.state.conversationsByWorkspace[workspacePath].length, 1)

  const restoredConversationDelete = await fetch(`${baseUrl}/api/app-state/conversations/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspacePath, conversationId: 'restored-conversation' }),
  })
  assert.equal(restoredConversationDelete.status, 200)
  const restoredConversationDeleteBody = await restoredConversationDelete.json()
  assert.deepEqual(restoredConversationDeleteBody.state.conversationsByWorkspace[workspacePath], [])
})

test('server ignores oversized persisted app state and secrets files', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codex-realtime-oversized-state-'))
  t.after(() => rm(tempDir, { recursive: true, force: true }))
  const statePath = path.join(tempDir, 'state.json')
  const secretsPath = path.join(tempDir, 'secrets.json')
  await writeFile(statePath, 'x'.repeat(3 * 1024 * 1024))
  await writeFile(secretsPath, 'x'.repeat(128 * 1024))

  const { baseUrl } = await startTestServer(t, {
    CODEX_REALTIME_STATE_PATH: statePath,
    CODEX_REALTIME_SECRETS_PATH: secretsPath,
  })
  const state = await (await fetch(`${baseUrl}/api/app-state`)).json()
  const status = await (await fetch(`${baseUrl}/api/status`)).json()

  assert.deepEqual(state.workspaces, [])
  assert.deepEqual(state.hiddenWorkspacePaths, [])
  assert.deepEqual(state.conversationsByWorkspace, {})
  assert.equal(status.openAiKeySource, 'missing')
})

test('server recovers app state from backup before mutating state', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codex-realtime-state-backup-'))
  t.after(() => rm(tempDir, { recursive: true, force: true }))
  const statePath = path.join(tempDir, 'state.json')
  const secretsPath = path.join(tempDir, 'secrets.json')
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'codex-realtime-state-backup-workspace-'))
  t.after(() => rm(workspacePath, { recursive: true, force: true }))

  await writeFile(statePath, '{"workspaces":')
  await writeFile(
    `${statePath}.bak`,
    JSON.stringify({
      workspaces: [{ id: workspacePath, path: workspacePath, name: 'Recovered workspace' }],
      conversationsByWorkspace: {
        [workspacePath]: [
          { id: 'keep-1', title: 'Keep 1', status: 'draft', source: 'local', prompt: '', response: '', traces: [], transcript: [] },
          { id: 'delete-me', title: 'Delete me', status: 'draft', source: 'local', prompt: '', response: '', traces: [], transcript: [] },
          { id: 'keep-2', title: 'Keep 2', status: 'ready', source: 'local', prompt: 'hello', response: '', traces: [], transcript: [] },
        ],
      },
    }),
  )

  const { baseUrl } = await startTestServer(t, {
    CODEX_REALTIME_STATE_PATH: statePath,
    CODEX_REALTIME_SECRETS_PATH: secretsPath,
  })

  const recoveredState = await (await fetch(`${baseUrl}/api/app-state`)).json()
  assert.deepEqual(
    recoveredState.conversationsByWorkspace[workspacePath].map((conversation) => conversation.id),
    ['keep-1', 'delete-me', 'keep-2'],
  )

  const response = await fetch(`${baseUrl}/api/app-state/conversations/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspacePath, conversationId: 'delete-me' }),
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(
    body.state.conversationsByWorkspace[workspacePath].map((conversation) => conversation.id),
    ['keep-1', 'keep-2'],
  )

  const rewrittenState = JSON.parse(await readFile(statePath, 'utf8'))
  assert.deepEqual(
    rewrittenState.conversationsByWorkspace[workspacePath].map((conversation) => conversation.id),
    ['keep-1', 'keep-2'],
  )
})

test('server ignores malformed persisted settings secrets', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codex-realtime-malformed-secrets-'))
  t.after(() => rm(tempDir, { recursive: true, force: true }))
  const statePath = path.join(tempDir, 'state.json')
  const secretsPath = path.join(tempDir, 'secrets.json')
  await writeFile(
    secretsPath,
    JSON.stringify({
      openaiApiKey: `sk-${'x'.repeat(1_100)}`,
      unexpectedSecret: 'should not be loaded',
    }),
  )

  const { baseUrl } = await startTestServer(t, {
    CODEX_REALTIME_STATE_PATH: statePath,
    CODEX_REALTIME_SECRETS_PATH: secretsPath,
    OPENAI_API_KEY: '',
  })
  const status = await (await fetch(`${baseUrl}/api/status`)).json()

  assert.equal(status.realtime, false)
  assert.equal(status.openAiKeySource, 'missing')
})

test('server ignores malformed OPENAI_API_KEY environment values', async (t) => {
  const { baseUrl } = await startTestServer(t, {
    OPENAI_API_KEY: 'not-a-key',
    CODEX_USE_OPENAI_API_KEY: 'true',
  })

  const status = await (await fetch(`${baseUrl}/api/status`)).json()
  assert.equal(status.realtime, false)
  assert.equal(status.openAiKeySource, 'missing')
  assert.equal(status.codexApiKey, false)

  const missingKey = await fetch(`${baseUrl}/api/realtime/token`, {
    method: 'POST',
  })
  assert.equal(missingKey.status, 503)
  assert.equal((await readJson(missingKey)).code, 'openai_api_key_required')
})

test('settings and app-state writes tighten existing directory and file permissions', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codex-realtime-secrets-mode-'))
  t.after(() => rm(tempDir, { recursive: true, force: true }))
  const stateDir = path.join(tempDir, 'permissive-state')
  const statePath = path.join(stateDir, 'state.json')
  const secretsDir = path.join(tempDir, 'permissive-secrets')
  const secretsPath = path.join(secretsDir, 'secrets.json')
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'codex-realtime-state-mode-workspace-'))
  t.after(() => rm(workspacePath, { recursive: true, force: true }))
  await mkdir(stateDir, { recursive: true, mode: 0o777 })
  await chmod(stateDir, 0o777)
  await mkdir(secretsDir, { recursive: true, mode: 0o777 })
  await chmod(secretsDir, 0o777)

  const { baseUrl } = await startTestServer(t, {
    CODEX_REALTIME_STATE_PATH: statePath,
    CODEX_REALTIME_SECRETS_PATH: secretsPath,
  })
  const stateResponse = await fetch(`${baseUrl}/api/app-state/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace: { path: workspacePath } }),
  })
  assert.equal(stateResponse.status, 200)

  const response = await fetch(`${baseUrl}/api/settings/openai-key`, { method: 'DELETE' })
  assert.equal(response.status, 200)

  assert.equal((await stat(stateDir)).mode & 0o777, 0o700)
  assert.equal((await stat(statePath)).mode & 0o777, 0o600)
  assert.equal((await stat(secretsDir)).mode & 0o777, 0o700)
  assert.equal((await stat(secretsPath)).mode & 0o777, 0o600)
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

  const nonObjectImage = await fetch(`${baseUrl}/api/vision/context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '[]',
  })
  assert.equal(nonObjectImage.status, 400)
  assert.equal((await readJson(nonObjectImage)).code, 'invalid_request')

  const invalidImage = await fetch(`${baseUrl}/api/vision/context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageDataUrl: 'not-an-image' }),
  })
  assert.equal(invalidImage.status, 400)
  assert.equal((await readJson(invalidImage)).code, 'invalid_visual_context')

  const unsupportedImage = await fetch(`${baseUrl}/api/vision/context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageDataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' }),
  })
  assert.equal(unsupportedImage.status, 400)
  assert.equal((await readJson(unsupportedImage)).code, 'invalid_visual_context')

  const malformedSupportedImage = await fetch(`${baseUrl}/api/vision/context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageDataUrl: 'data:image/png,not-base64-image-data' }),
  })
  assert.equal(malformedSupportedImage.status, 400)
  assert.equal((await readJson(malformedSupportedImage)).code, 'invalid_visual_context')

  const invalidBase64Image = await fetch(`${baseUrl}/api/vision/context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageDataUrl: 'data:image/png;base64,====' }),
  })
  assert.equal(invalidBase64Image.status, 400)
  assert.equal((await readJson(invalidBase64Image)).code, 'invalid_visual_context')

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

  const nonObjectKey = await fetch(`${baseUrl}/api/settings/openai-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '[]',
  })
  assert.equal(nonObjectKey.status, 400)
  assert.equal((await readJson(nonObjectKey)).code, 'invalid_request')

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

  const oversizedKey = await fetch(`${baseUrl}/api/settings/openai-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: `sk-${'x'.repeat(1_100)}` }),
  })
  assert.equal(oversizedKey.status, 400)
  assert.equal((await readJson(oversizedKey)).code, 'invalid_openai_api_key')
})

test('server returns json errors for unmatched API routes and unhandled route failures', async (t) => {
  const badSecretsPath = await mkdtemp(path.join(os.tmpdir(), 'codex-realtime-secrets-dir-'))
  const badStatePath = await mkdtemp(path.join(os.tmpdir(), 'codex-realtime-state-dir-'))
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'codex-realtime-state-error-workspace-'))
  t.after(() => rm(badSecretsPath, { recursive: true, force: true }))
  t.after(() => rm(badStatePath, { recursive: true, force: true }))
  t.after(() => rm(workspacePath, { recursive: true, force: true }))
  const { baseUrl } = await startTestServer(t, {
    CODEX_REALTIME_SECRETS_PATH: badSecretsPath,
    CODEX_REALTIME_STATE_PATH: badStatePath,
  })

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

  const failedStateWrite = await fetch(`${baseUrl}/api/app-state/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace: { path: workspacePath } }),
  })
  assert.equal(failedStateWrite.status, 500)
  assert.equal(failedStateWrite.headers.get('content-type')?.includes('application/json'), true)
  assert.equal((await readJson(failedStateWrite)).code, 'app_state_write_failed')
})
