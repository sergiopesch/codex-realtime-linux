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
    'placeholder="Berlin"',
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
  assert.match(serverSource, /if \(!isSafeArtifactName\(entry\.name\)\) continue/)
  assert.match(serverSource, /Invalid artifact name/)
  assert.match(serverSource, /\/workspace-artifacts/)
  assert.match(serverSource, /await requireWorkspaceDirectory\(workspaceFromToken\(token\), 'workspace token'\)/)
  assert.doesNotMatch(serverSource, /app\.use\('\/agent-files'/)
  assert.doesNotMatch(policySource, /url:\s*`\/agent-files/)
  assert.match(appSource, /const selectLatestArtifact = useCallback/)
  assert.match(appSource, /selectLatestArtifact\(artifactData\)/)
  assert.match(appSource, /const dismissedTime = dismissedArtifact \? Date\.parse\(dismissedArtifact\.updatedAt\) : null/)
  assert.match(appSource, /Date\.parse\(artifact\.updatedAt\) > dismissedTime/)
  assert.match(appSource, /const codexTurnInProgress = Boolean\(activeTurnId\)/)
  assert.match(appSource, /const showSubagentPreview = codexTurnInProgress/)
  assert.match(appSource, /const agentIsWorkingOnArtifact = Boolean\(pendingArtifact && codexTurnInProgress\)/)
  assert.doesNotMatch(appSource, /const showSubagentPreview = Boolean\(activeThreadId\)/)
  assert.doesNotMatch(appSource, /const agentIsWorkingOnArtifact = Boolean\(pendingArtifact && activeThreadId\)/)
  assert.match(appSource, /sandbox="allow-scripts"/)
  assert.doesNotMatch(appSource, /sandbox="allow-scripts allow-same-origin"/)
})

test('persisted workspaces and conversations require absolute workspace paths', async () => {
  const serverSource = await readFile(path.join(repoRoot, 'server', 'index.mjs'), 'utf8')

  assert.match(serverSource, /function httpError/)
  assert.match(serverSource, /function sendJsonError/)
  assert.match(serverSource, /const code = error\?\.statusCode && error\?\.code \? error\.code : fallbackCode/)
  assert.match(serverSource, /async function writeJsonFileAtomic/)
  assert.match(serverSource, /await rename\(tempPath, filePath\)/)
  assert.match(serverSource, /await rm\(tempPath, \{ force: true \}\)/)
  assert.match(serverSource, /writeJsonFileAtomic\(SECRETS_PATH, nextSecrets, \{ dirMode: 0o700, fileMode: 0o600 \}\)/)
  assert.match(serverSource, /writeJsonFileAtomic\(STATE_PATH, normalizeAppState\(state\), \{ fileMode: 0o600 \}\)/)
  assert.match(serverSource, /api_key_required/)
  assert.match(serverSource, /invalid_openai_api_key/)
  assert.match(serverSource, /fallbackCode: 'openai_key_save_failed'/)
  assert.match(serverSource, /fallbackCode: 'openai_key_remove_failed'/)
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
  assert.match(serverSource, /const cwd = await requireWorkspaceDirectory\(req\.body\?\.cwd, 'cwd'\)/)
  assert.match(serverSource, /const threadId = requireText\(req\.body\?\.threadId, 'threadId'/)
  assert.match(serverSource, /const instruction = requireText\(req\.body\?\.instruction, 'instruction'\)/)
  assert.match(serverSource, /const turnId = requireText\(req\.body\?\.turnId, 'turnId'/)
  assert.doesNotMatch(serverSource, /requireWorkspaceDirectory\(req\.body\?\.cwd \|\| REPO_ROOT/)
  assert.doesNotMatch(serverSource, /Inspect this project and summarize the next best implementation step/)
  assert.match(appSource, /const workspacePathFor = \(workspace: Workspace\) => workspace\.path \?\? workspace\.id/)
  assert.match(appSource, /const isAbsoluteLocalWorkspacePath = \(workspacePath: string\) => workspacePath\.startsWith\('\/'\)/)
  assert.match(appSource, /workspaceData\.data\.filter\(\(workspace\) => isAbsoluteLocalWorkspacePath\(workspacePathFor\(workspace\)\)\)/)
  assert.match(appSource, /appStateData\.workspaces \?\? \[\]\)\.filter\(\(workspace\) =>\s+isAbsoluteLocalWorkspacePath\(workspacePathFor\(workspace\)\)/)
  assert.match(appSource, /const refreshArtifacts = useCallback\(async \(workspacePath = selectedWorkspaceRef\.current\)/)
  assert.match(appSource, /const workspacePath = targetWorkspacePath \|\| selectedWorkspace \|\| workspaceRoots\[0\]\?\.workspacePath \|\| initialWorkspacePath/)
  assert.doesNotMatch(appSource, /fallbackWorkspaces/)
  assert.doesNotMatch(appSource, /runtimeFallbackWorkspaces/)
  assert.doesNotMatch(appSource, /selectedWorkspaceRef\.current \|\| status\?\.appRoot/)
  assert.doesNotMatch(appSource, /workspaceRoots\[0\]\?\.workspacePath \|\| status\?\.appRoot/)
  assert.match(appSource, /const selectedRoutableWorkspacePath = \(requestedCwd: unknown\) =>/)
  assert.match(appSource, /Realtime requested a workspace that is not currently selected/)
  assert.match(appSource, /const workspacePath = selectedRoutableWorkspacePath\(payload\.cwd\)/)
  assert.match(appSource, /A concrete Codex goal is required before routing work\./)
  assert.match(appSource, /Realtime function call did not include a call_id\./)
  assert.match(appSource, /Function call arguments were not valid JSON\./)
  assert.doesNotMatch(appSource, /Inspect this project and summarize the next best implementation step/)
})

test('local API rejects untrusted origins and non-json mutation bodies', async () => {
  const serverSource = await readFile(path.join(repoRoot, 'server', 'index.mjs'), 'utf8')

  assert.match(serverSource, /const ALLOWED_API_ORIGINS = new Set/)
  assert.match(serverSource, /CODEX_REALTIME_ALLOWED_ORIGINS/)
  assert.match(serverSource, /const JSON_BODY_LIMIT = process\.env\.CODEX_REALTIME_JSON_LIMIT \?\? '25mb'/)
  assert.match(serverSource, /function guardLocalApiRequests/)
  assert.match(serverSource, /function handleJsonBodyError/)
  assert.match(serverSource, /origin_not_allowed/)
  assert.match(serverSource, /Content-Type must be application\/json/)
  assert.match(serverSource, /json_required/)
  assert.match(serverSource, /payload_too_large/)
  assert.match(serverSource, /invalid_json/)
  assert.match(serverSource, /app\.use\(guardLocalApiRequests\)/)
  assert.match(serverSource, /app\.use\(handleJsonBodyError\)/)
  assert.match(serverSource, /app\.use\('\/api', \(_req, res\) =>/)
  assert.match(serverSource, /api_not_found/)
  assert.match(serverSource, /function handleApiError/)
  assert.match(serverSource, /const statusCode = error\?\.statusCode \|\| error\?\.status \|\| 500/)
  assert.match(serverSource, /code: statusCode >= 500 \? 'api_request_failed' : error\?\.code \|\| 'api_request_failed'/)
  assert.match(serverSource, /api_request_failed/)
  assert.match(serverSource, /app\.use\(handleApiError\)[\s\S]*app\.use\(express\.static\(DIST_DIR\)\)/)
})

test('Codex app-server RPC bridge has bounded requests and single-flight initialization', async () => {
  const serverSource = await readFile(path.join(repoRoot, 'server', 'index.mjs'), 'utf8')

  assert.match(serverSource, /const CODEX_BIN = process\.env\.CODEX_BIN \?\? 'codex'/)
  assert.match(serverSource, /spawn\(CODEX_BIN, \['app-server'\]/)
  assert.match(serverSource, /codexBin: CODEX_BIN/)
  assert.doesNotMatch(serverSource, /spawn\('codex', \['app-server'\]/)
  assert.match(serverSource, /const CODEX_RPC_TIMEOUT_MS =/)
  assert.match(serverSource, /initPromise = null/)
  assert.match(serverSource, /if \(this\.initPromise\) return this\.initPromise/)
  assert.match(serverSource, /codex app-server request timed out/)
  assert.match(serverSource, /codex app-server exited with \$\{reason\}/)
  assert.match(serverSource, /clearTimeout\(timeout\)/)
  assert.match(serverSource, /#resetProcessState\(error\)/)
  assert.match(serverSource, /if \(!this\.proc\?\.stdin\?\.writable\)/)
  assert.match(serverSource, /dispose\(reason = 'codex app-server stopped\.'\)/)
  assert.match(serverSource, /if \(proc && !proc\.killed\) proc\.kill\(\)/)
  assert.match(serverSource, /function shutdown\(exitCode, reason\)/)
  assert.match(serverSource, /codex\.dispose\(reason\)/)
  assert.match(serverSource, /shutdown\(143, 'Codex Realtime Linux server received SIGTERM\.'\)/)
})

test('renderer loads Codex thread history only for explicit saved workspaces', async () => {
  const appSource = await readFile(path.join(repoRoot, 'src', 'App.tsx'), 'utf8')

  assert.match(appSource, /const shouldLoadCodexHistory = Boolean\(/)
  assert.match(appSource, /visibleSavedWorkspaces\.some\(\(workspace\) => workspacePathFor\(workspace\) === preferredPath\)/)
  assert.match(appSource, /if \(shouldLoadCodexHistory\) \{/)
  assert.match(appSource, /\/api\/codex\/threads\?limit=40&cwd=\$\{encodeURIComponent\(preferredPath\)\}/)
  assert.doesNotMatch(appSource, /api<CodexThreadsResponse>\('\/api\/codex\/threads\?limit=40'\)/)
})

test('upstream OpenAI and usage fetches are timeout bounded', async () => {
  const serverSource = await readFile(path.join(repoRoot, 'server', 'index.mjs'), 'utf8')

  assert.match(serverSource, /const UPSTREAM_FETCH_TIMEOUT_MS =/)
  assert.match(serverSource, /const MAX_VISUAL_CONTEXT_DATA_URL_BYTES =/)
  assert.match(serverSource, /function upstreamSignal\(\)/)
  assert.match(serverSource, /AbortSignal\.timeout\(UPSTREAM_FETCH_TIMEOUT_MS\)/)
  assert.match(serverSource, /Buffer\.byteLength\(imageDataUrl, 'utf8'\) > MAX_VISUAL_CONTEXT_DATA_URL_BYTES/)
  assert.match(serverSource, /visual_context_too_large/)
  assert.match(serverSource, /client_secrets'[\s\S]*signal: upstreamSignal\(\)/)
  assert.match(serverSource, /\/v1\/responses'[\s\S]*signal: upstreamSignal\(\)/)
  assert.match(serverSource, /fetch\(GBP_RATE_API, \{ signal: upstreamSignal\(\) \}\)/)
  assert.match(serverSource, /fetch\(`https:\/\/api\.openai\.com\/v1\$\{path\}`,[\s\S]*signal: upstreamSignal\(\)/)
})

test('Arduino explicit-port uploads do not borrow unrelated detected board metadata', async () => {
  const arduinoSource = await readFile(path.join(repoRoot, 'server', 'arduino.mjs'), 'utf8')

  assert.match(arduinoSource, /const matchingBoard = request\.port \? boards\.find\(\(board\) => board\.address === request\.port\) : null/)
  assert.match(arduinoSource, /const autoDetectedBoard = request\.port \? null : boards\[0\]/)
  assert.match(arduinoSource, /const detectedBoard = matchingBoard \?\? autoDetectedBoard/)
  assert.doesNotMatch(arduinoSource, /boards\.find\(\(board\) => board\.address === request\.port\) \?\? boards\[0\]/)
})

test('electron shell keeps renderer isolation and external navigation guarded', async () => {
  const mainSource = await readFile(path.join(repoRoot, 'electron', 'main.cjs'), 'utf8')

  assert.match(mainSource, /require\('dotenv\/config'\)/)
  assert.match(mainSource, /contextIsolation:\s*true/)
  assert.match(mainSource, /nodeIntegration:\s*false/)
  assert.match(mainSource, /sandbox:\s*true/)
  assert.match(mainSource, /setWindowOpenHandler/)
  assert.match(mainSource, /openExternalIfAllowed/)
  assert.match(mainSource, /new URL\(url\)\.origin === appOrigin/)
  assert.match(mainSource, /const repoRoot = path\.join\(__dirname, '\.\.'\)/)
  assert.match(mainSource, /const stateDir = path\.join\(process\.env\.XDG_STATE_HOME/)
  assert.match(mainSource, /const apiLogPath = path\.join\(stateDir, 'api-server\.log'\)/)
  assert.match(mainSource, /const apiNodeBin = process\.env\.CODEX_REALTIME_NODE_BIN \|\| 'node'/)
  assert.match(mainSource, /const createApiLogFd = \(\) =>/)
  assert.match(mainSource, /openSync\(apiLogPath, 'a'\)/)
  assert.match(mainSource, /const writeApiLog = \(message\) =>/)
  assert.match(mainSource, /const closeApiLog = \(\) =>/)
  assert.match(mainSource, /Starting API server from Electron with \$\{apiNodeBin\}/)
  assert.match(mainSource, /const waitForAppServer = \(baseUrl/)
  assert.match(mainSource, /path\.resolve\(status\?\.appRoot \|\| ''\) === path\.resolve\(repoRoot\)/)
  assert.match(mainSource, /Refusing to load unrelated local server/)
  assert.match(mainSource, /spawn\(apiNodeBin, \['server\/index\.mjs'\]/)
  assert.doesNotMatch(mainSource, /spawn\('node', \['server\/index\.mjs'\]/)
  assert.match(mainSource, /stdio: \['ignore', apiLogFd, apiLogFd\]/)
  assert.match(mainSource, /API server failed to start/)
  assert.match(mainSource, /API server exited with/)
  assert.doesNotMatch(mainSource, /const waitForHttp =/)
})

test('realtime voice sessions reset transcript state and clean up media resources', async () => {
  const appSource = await readFile(path.join(repoRoot, 'src', 'App.tsx'), 'utf8')
  const serverSource = await readFile(path.join(repoRoot, 'server', 'index.mjs'), 'utf8')

  assert.match(appSource, /const DEFAULT_API_TIMEOUT_MS = 130_000/)
  assert.match(appSource, /const REALTIME_CONNECTION_TIMEOUT_MS = 30_000/)
  assert.match(appSource, /const fetchWithTimeout = async/)
  assert.match(appSource, /Request timed out after/)
  assert.match(appSource, /await api<Record<string, unknown>>\(/)
  assert.match(appSource, /fetchWithTimeout\(\s+'https:\/\/api\.openai\.com\/v1\/realtime\/calls'/)
  assert.match(serverSource, /openai_api_key_required/)
  assert.match(serverSource, /fallbackCode: 'realtime_token_failed'/)
  assert.match(appSource, /const cleanupVoiceSession = \(\) =>/)
  assert.match(appSource, /const microphoneStreamRef = useRef<MediaStream \| null>\(null\)/)
  assert.match(appSource, /microphoneStream\?\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/)
  assert.match(appSource, /peer\?\.getSenders\(\)\.forEach\(\(sender\) => sender\.track\?\.stop\(\)\)/)
  assert.match(appSource, /audioRef\.current\.srcObject = null/)
  assert.match(appSource, /setRealtimeTranscript\(\[\]\)/)
  assert.match(appSource, /connectionstatechange/)
  assert.match(appSource, /\['failed', 'disconnected', 'closed'\]\.includes\(pc\.connectionState\)/)
  assert.match(appSource, /No microphone audio track was available\./)
  assert.match(appSource, /Realtime voice data channel failed/)
  assert.match(serverSource, /acknowledge the device briefly before returning to the user/)
  assert.doesNotMatch(serverSource, /playful joke/)
  assert.match(appSource, /Acknowledge the device connection briefly, then return to the user\./)
  assert.doesNotMatch(appSource, /short funny spoken joke/)
  assert.doesNotMatch(appSource, /dry and playful/)
  assert.doesNotMatch(appSource, /Realtime joke/)
})

test('screen context capture stops display streams after a frame is analyzed', async () => {
  const appSource = await readFile(path.join(repoRoot, 'src', 'App.tsx'), 'utf8')

  assert.match(appSource, /const cleanupScreenShare = \(stream = screenStreamRef\.current\) =>/)
  assert.match(appSource, /stream\?\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/)
  assert.match(appSource, /video\.srcObject = null/)
  assert.match(appSource, /finally \{\s+cleanupScreenShare\(stream \?\? undefined\)/)
  assert.match(appSource, /stream = await navigator\.mediaDevices\.getDisplayMedia\(\{ video: true, audio: false \}\)/)
  assert.doesNotMatch(appSource, /screenStreamRef\.current \?\? await navigator\.mediaDevices\.getDisplayMedia/)
})
