import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

const repoRoot = path.resolve(import.meta.dirname, '..')

test('root index.html remains a minimal Vite React shell', async () => {
  const html = await readFile(path.join(repoRoot, 'index.html'), 'utf8')

  assert.match(html, /<div id="root"><\/div>/)
  assert.match(html, /<script type="module" src="\/src\/main\.tsx"><\/script>/)
  assert.doesNotMatch(html, /<style[\s>]/i)
  assert.doesNotMatch(html, /<main[\s>]/i)
})

test('renderer does not seed hardcoded demo conversations', async () => {
  const appSource = await readFile(path.join(repoRoot, 'src', 'App.tsx'), 'utf8')

  for (const text of [
    'Realtime Linux MVP',
    'Connect voice harness',
    'Review spending widgets',
    'Browser-use checkpoint',
    'defaultConversationsForWorkspace',
    'picked-folder://',
    "source?: 'demo'",
    "source: 'demo'",
  ]) {
    assert.doesNotMatch(appSource, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('public assets do not include fixed demo presentation routes', async () => {
  const publicEntries = await readdir(path.join(repoRoot, 'public'), { recursive: true })
  const publicPaths = publicEntries.map((entry) => entry.toString())

  assert.equal(publicPaths.some((entry) => entry.includes('demo-presentation')), false)
  assert.equal(publicPaths.some((entry) => entry.includes('presentations')), false)
  assert.equal(publicPaths.some((entry) => entry.endsWith('.html')), false)
})

test('artifact previews are served through workspace-scoped routes only', async () => {
  const serverSource = await readFile(path.join(repoRoot, 'server', 'index.mjs'), 'utf8')
  const policySource = await readFile(path.join(repoRoot, 'server', 'codexPolicy.mjs'), 'utf8')
  const appSource = await readFile(path.join(repoRoot, 'src', 'App.tsx'), 'utf8')

  assert.match(serverSource, /async function requireWorkspaceDirectory/)
  assert.match(serverSource, /must be an absolute local path/)
  assert.match(serverSource, /function isSafeArtifactName/)
  assert.match(serverSource, /Invalid artifact name/)
  assert.match(serverSource, /\/workspace-artifacts/)
  assert.match(serverSource, /await requireWorkspaceDirectory\(workspaceFromToken\(token\), 'workspace token'\)/)
  assert.doesNotMatch(serverSource, /app\.use\('\/agent-files'/)
  assert.doesNotMatch(policySource, /url:\s*`\/agent-files/)
  assert.match(appSource, /const selectLatestArtifact = useCallback/)
  assert.match(appSource, /selectLatestArtifact\(artifactData\)/)
  assert.match(appSource, /const dismissedTime = dismissedArtifact \? Date\.parse\(dismissedArtifact\.updatedAt\) : null/)
  assert.match(appSource, /Date\.parse\(artifact\.updatedAt\) > dismissedTime/)
  assert.match(appSource, /sandbox="allow-scripts"/)
  assert.doesNotMatch(appSource, /sandbox="allow-scripts allow-same-origin"/)
})

test('persisted workspaces and conversations require absolute workspace paths', async () => {
  const serverSource = await readFile(path.join(repoRoot, 'server', 'index.mjs'), 'utf8')

  assert.match(serverSource, /function httpError/)
  assert.match(serverSource, /function sendJsonError/)
  assert.match(serverSource, /function normalizeWorkspacePath/)
  assert.match(serverSource, /path\.isAbsolute\(workspacePath\)/)
  assert.match(serverSource, /input\.workspaces\.map\(normalizeWorkspace\)\.filter\(Boolean\)/)
  assert.match(serverSource, /hiddenWorkspacePaths\.map\(normalizeWorkspacePath\)\.filter\(Boolean\)/)
  assert.match(serverSource, /workspacePath = await requireWorkspaceDirectory\(req\.body\.workspacePath \|\| req\.body\.conversation\?\.workspacePath, 'workspacePath'\)/)
  assert.match(serverSource, /workspacePath = await requireWorkspaceDirectory\(req\.body\.workspacePath, 'workspacePath'\)/)
  assert.match(serverSource, /workspacePath must be an absolute local path/)
  assert.doesNotMatch(serverSource, /workspace-\$\{Date\.now\(\)\}/)
})

test('Codex task routes require explicit user goals and IDs before app-server calls', async () => {
  const serverSource = await readFile(path.join(repoRoot, 'server', 'index.mjs'), 'utf8')
  const appSource = await readFile(path.join(repoRoot, 'src', 'App.tsx'), 'utf8')

  assert.match(serverSource, /function requireText/)
  assert.match(serverSource, /const goal = requireText\(req\.body\?\.goal, 'goal'\)/)
  assert.match(serverSource, /const threadId = requireText\(req\.body\?\.threadId, 'threadId'/)
  assert.match(serverSource, /const instruction = requireText\(req\.body\?\.instruction, 'instruction'\)/)
  assert.match(serverSource, /const turnId = requireText\(req\.body\?\.turnId, 'turnId'/)
  assert.doesNotMatch(serverSource, /Inspect this project and summarize the next best implementation step/)
  assert.match(appSource, /A concrete Codex goal is required before routing work\./)
  assert.match(appSource, /Realtime function call did not include a call_id\./)
  assert.match(appSource, /Function call arguments were not valid JSON\./)
  assert.doesNotMatch(appSource, /Inspect this project and summarize the next best implementation step/)
})

test('Codex app-server RPC bridge has bounded requests and single-flight initialization', async () => {
  const serverSource = await readFile(path.join(repoRoot, 'server', 'index.mjs'), 'utf8')

  assert.match(serverSource, /const CODEX_RPC_TIMEOUT_MS =/)
  assert.match(serverSource, /initPromise = null/)
  assert.match(serverSource, /if \(this\.initPromise\) return this\.initPromise/)
  assert.match(serverSource, /codex app-server request timed out/)
  assert.match(serverSource, /clearTimeout\(timeout\)/)
  assert.match(serverSource, /#resetProcessState\(error\)/)
  assert.match(serverSource, /if \(!this\.proc\?\.stdin\?\.writable\)/)
})

test('electron shell keeps renderer isolation and external navigation guarded', async () => {
  const mainSource = await readFile(path.join(repoRoot, 'electron', 'main.cjs'), 'utf8')

  assert.match(mainSource, /contextIsolation:\s*true/)
  assert.match(mainSource, /nodeIntegration:\s*false/)
  assert.match(mainSource, /sandbox:\s*true/)
  assert.match(mainSource, /setWindowOpenHandler/)
  assert.match(mainSource, /openExternalIfAllowed/)
  assert.match(mainSource, /new URL\(url\)\.origin === appOrigin/)
})

test('realtime voice sessions reset transcript state and clean up media resources', async () => {
  const appSource = await readFile(path.join(repoRoot, 'src', 'App.tsx'), 'utf8')

  assert.match(appSource, /const cleanupVoiceSession = \(\) =>/)
  assert.match(appSource, /peer\?\.getSenders\(\)\.forEach\(\(sender\) => sender\.track\?\.stop\(\)\)/)
  assert.match(appSource, /audioRef\.current\.srcObject = null/)
  assert.match(appSource, /setRealtimeTranscript\(\[\]\)/)
  assert.match(appSource, /connectionstatechange/)
  assert.match(appSource, /Realtime voice data channel failed/)
})
