import 'dotenv/config'
import express from 'express'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, opendir, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { ArduinoUploadError, getArduinoCliStatus, listArduinoBoards, listSerialPorts, uploadArduinoSketch } from './arduino.mjs'
import { GENERATED_ARTIFACT_DIR, artifactPlanForGoal, buildWorkspaceGuard, goalWithWorkspaceGuard } from './codexPolicy.mjs'
import { UsbDeviceMonitor } from './usb.mjs'
import { getCurrentWeather, WeatherServiceError } from './weather.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST_DIR = path.join(REPO_ROOT, 'dist')
const DEFAULT_PORT = 3311
const PORT = configuredPort(process.env.PORT)
const ENV_OPENAI_API_KEY = normalizedOpenAiApiKey(process.env.OPENAI_API_KEY)
const OPENAI_ADMIN_KEY = process.env.OPENAI_ADMIN_KEY ?? process.env.OPENAI_API_ADMIN_KEY
const ENV_CODEX_API_KEY = process.env.CODEX_API_KEY
const CODEX_FORCE_API_KEY_AUTH = process.env.CODEX_FORCE_API_KEY_AUTH === 'true'
const DESKTOP_SERVER_TOKEN = process.env.CODEX_DESKTOP_SERVER_TOKEN ?? ''
const MAX_RUNTIME_CONFIG_STRING_LENGTH = 240
const MAX_RUNTIME_PERSONA_LENGTH = 2_000
const CODEX_BIN = configuredExecutable(process.env.CODEX_BIN, 'codex')
const DEFAULT_REALTIME_PERSONA = 'Speak naturally, stay technically sharp, keep replies concise, and route concrete work to Codex tools.'
const CODEX_MODEL = configuredRuntimeString(process.env.CODEX_MODEL, 'gpt-5.4')
const DEFAULT_CODEX_APPROVAL_POLICY = 'on-request'
const CODEX_APPROVAL_POLICIES = new Set(['untrusted', 'on-failure', 'on-request', 'never'])
const CODEX_APPROVAL_POLICY = configuredCodexApprovalPolicy(process.env.CODEX_APPROVAL_POLICY)
const CODEX_ALLOW_APP_SOURCE_TASKS = configuredBoolean(process.env.CODEX_ALLOW_APP_SOURCE_TASKS, false)
const REALTIME_MODEL = configuredRuntimeString(process.env.REALTIME_MODEL, 'gpt-realtime-2')
const REALTIME_VOICE = configuredRuntimeString(process.env.REALTIME_VOICE, 'cedar')
const REALTIME_TRANSCRIPTION_MODEL = configuredRuntimeString(process.env.REALTIME_TRANSCRIPTION_MODEL, 'gpt-4o-mini-transcribe')
const REALTIME_USER_NAME = configuredRuntimeString(process.env.REALTIME_USER_NAME, os.userInfo().username)
const REALTIME_USER_LOCATION = configuredRuntimeString(process.env.REALTIME_USER_LOCATION, '')
const REALTIME_PERSONA = configuredRuntimeString(process.env.REALTIME_PERSONA, DEFAULT_REALTIME_PERSONA, MAX_RUNTIME_PERSONA_LENGTH)
const VISION_MODEL = configuredRuntimeString(process.env.VISION_MODEL, CODEX_MODEL)
const DEFAULT_USAGE_PERIOD_DAYS = 30
const MAX_USAGE_PERIOD_DAYS = 90
const USAGE_PERIOD_DAYS = configuredInteger(process.env.OPENAI_USAGE_PERIOD_DAYS, {
  fallback: DEFAULT_USAGE_PERIOD_DAYS,
  min: 1,
  max: MAX_USAGE_PERIOD_DAYS,
})
const MAX_USD_TO_GBP_RATE = 10
const GBP_RATE_API = process.env.OPENAI_USAGE_GBP_RATE_API ?? 'https://api.frankfurter.app/latest?from=USD&to=GBP'
const DEFAULT_UPSTREAM_FETCH_TIMEOUT_MS = 20_000
const MAX_UPSTREAM_FETCH_TIMEOUT_MS = 120_000
const UPSTREAM_FETCH_TIMEOUT_MS = configuredInteger(process.env.UPSTREAM_FETCH_TIMEOUT_MS, {
  fallback: DEFAULT_UPSTREAM_FETCH_TIMEOUT_MS,
  min: 1_000,
  max: MAX_UPSTREAM_FETCH_TIMEOUT_MS,
})
const DEFAULT_JSON_BODY_LIMIT = '25mb'
const MAX_JSON_BODY_LIMIT_BYTES = 25 * 1024 * 1024
const JSON_BODY_LIMIT = configuredJsonBodyLimit(process.env.CODEX_REALTIME_JSON_LIMIT)
const MAX_VISUAL_CONTEXT_DATA_URL_BYTES = 12 * 1024 * 1024
const MAX_VISUAL_CONTEXT_SOURCE_LENGTH = 160
const MAX_VISUAL_CONTEXT_PROMPT_LENGTH = 1_500
const MAX_VISUAL_CONTEXT_SUMMARY_LENGTH = 4_000
const MAX_UPSTREAM_JSON_RESPONSE_BYTES = 1 * 1024 * 1024
const SUPPORTED_VISUAL_CONTEXT_DATA_URL_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const DEFAULT_VISUAL_CONTEXT_PROMPT =
  'Focus on UI state, visible errors, design issues, code clues, and what Codex should know before acting.'
const MAX_CONVERSATION_ID_LENGTH = 240
const MAX_CONVERSATION_TITLE_LENGTH = 180
const MAX_CONVERSATION_TEXT_LENGTH = 8_000
const MAX_CONVERSATION_TRACE_LENGTH = 500
const MAX_CONVERSATION_TRACES = 40
const MAX_CONVERSATION_TRANSCRIPT_LINES = 200
const MAX_CONVERSATION_TIMESTAMP_LENGTH = 80
const MAX_LOCAL_WORKSPACES = 40
const MAX_LOCAL_HIDDEN_WORKSPACES = 80
const MAX_LOCAL_WORKSPACE_BUCKETS = 40
const MAX_LOCAL_CONVERSATIONS_PER_WORKSPACE = 80
const MAX_HIDDEN_CODEX_THREADS_PER_WORKSPACE = 200
const LEGACY_DRAFT_PROMPT = 'Describe the next build step out loud.'
const LEGACY_DRAFT_RESPONSE = 'This agent conversation is ready for realtime voice direction.'
const LEGACY_DRAFT_TRACES = ['Workspace selected', 'Voice direction pending', 'Codex execution ready']
const LEGACY_DRAFT_TRANSCRIPT = [
  { speaker: 'user', text: 'Create a new agent conversation for this workspace.' },
  { speaker: 'codex', text: 'Ready. Start voice and describe the build goal.' },
]
const LEGACY_DRAFT_TITLE_PATTERN = /^Voice build (\d+)$/
const MAX_APP_STATE_FILE_BYTES = 2 * 1024 * 1024
const MAX_SECRETS_FILE_BYTES = 64 * 1024
const MAX_GENERATED_ARTIFACTS = 40
const MAX_ARTIFACT_DIRECTORY_SCAN_ENTRIES = 400
const MAX_ARTIFACT_NAME_LENGTH = 120
const MAX_ARTIFACT_TITLE_LENGTH = 180
const MAX_ARTIFACT_PREVIEW_PATH_LENGTH = 1024
const MAX_ARTIFACT_PREVIEW_FILE_BYTES = 25 * 1024 * 1024
const ARTIFACT_PREVIEW_CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.csv', 'text/csv; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.ogg', 'audio/ogg'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
])
const MAX_WORKSPACE_TOKEN_LENGTH = 8192
const MAX_USAGE_BUCKETS = 20
const MAX_USAGE_BUCKET_LABEL_LENGTH = 120
const MAX_USAGE_CURRENCY_LENGTH = 12
const MAX_IGNORED_USAGE_CURRENCIES = 5
const MAX_ADMIN_WORKSPACES = 20
const MAX_CODEX_THREADS = 100
const MAX_CODEX_NOTIFICATIONS = 160
const MAX_CODEX_METADATA_STRING_LENGTH = 1_000
const MAX_CODEX_METADATA_ARRAY_ITEMS = 50
const MAX_CODEX_METADATA_OBJECT_KEYS = 40
const MAX_CODEX_METADATA_DEPTH = 5
const MAX_EVENT_METHOD_LENGTH = 160
const MAX_EVENT_STRING_LENGTH = 2_000
const MAX_EVENT_ARRAY_ITEMS = 20
const MAX_EVENT_OBJECT_KEYS = 30
const MAX_EVENT_DEPTH = 4
const MAX_OPENAI_API_KEY_LENGTH = 1_000
const MAX_CODEX_RPC_LINE_LENGTH = 120_000
const MAX_ERROR_MESSAGE_LENGTH = 500
const MAX_OPENAI_SAFETY_IDENTIFIER_LENGTH = 128
const DEFAULT_CODEX_RPC_TIMEOUT_MS = 120_000
const MAX_CODEX_RPC_TIMEOUT_MS = 600_000
const CODEX_PROCESS_KILL_GRACE_MS = 2_000
const CODEX_RPC_TIMEOUT_MS = configuredInteger(process.env.CODEX_RPC_TIMEOUT_MS, {
  fallback: DEFAULT_CODEX_RPC_TIMEOUT_MS,
  min: 1_000,
  max: MAX_CODEX_RPC_TIMEOUT_MS,
})
const DEFAULT_STATE_PATH = path.join(os.homedir(), '.local', 'state', 'codex-realtime-linux', 'app-state.json')
const DEFAULT_SECRETS_PATH = path.join(os.homedir(), '.config', 'codex-realtime-linux', 'secrets.json')
const STATE_PATH = configuredAbsolutePath(process.env.CODEX_REALTIME_STATE_PATH, DEFAULT_STATE_PATH)
const SECRETS_PATH = configuredAbsolutePath(process.env.CODEX_REALTIME_SECRETS_PATH, DEFAULT_SECRETS_PATH)
const STATE_BACKUP_PATH = `${STATE_PATH}.bak`
const OPENAI_SAFETY_IDENTIFIER =
  normalizeOpenAiSafetyIdentifier(process.env.OPENAI_SAFETY_IDENTIFIER) || defaultOpenAiSafetyIdentifier()

let localSecrets = {}

const app = express()
app.disable('x-powered-by')
const usbMonitor = new UsbDeviceMonitor()
const localApiHostnames = new Set(['localhost', '127.0.0.1', '[::1]'])
const DEFAULT_API_ORIGINS = [
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
  `http://[::1]:${PORT}`,
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://[::1]:5173',
]
const ALLOWED_API_ORIGINS = new Set([
  ...DEFAULT_API_ORIGINS,
  ...configuredAllowedApiOrigins(process.env.CODEX_REALTIME_ALLOWED_ORIGINS),
])

function apiRouteRequiresJsonBody(req) {
  if (!req.path.startsWith('/api/')) return false
  if (!['POST', 'PATCH', 'PUT'].includes(req.method)) return false
  if (req.method === 'POST' && req.path === '/api/realtime/token') return false
  return true
}

function configuredPort(value, fallback = DEFAULT_PORT) {
  const port = Number(value ?? fallback)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback
}

function configuredInteger(value, { fallback, min, max }) {
  const number = Number(value ?? fallback)
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback
}

function configuredUsdToGbpRate(value) {
  const rate = Number(value)
  return Number.isFinite(rate) && rate > 0 && rate <= MAX_USD_TO_GBP_RATE ? rate : null
}

function configuredJsonBodyLimit(value, fallback = DEFAULT_JSON_BODY_LIMIT) {
  const text = typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : fallback
  const match = /^(\d+)\s*(b|kb|mb)$/.exec(text)
  if (!match) return fallback

  const amount = Number(match[1])
  const unit = match[2]
  const multiplier = unit === 'mb' ? 1024 * 1024 : unit === 'kb' ? 1024 : 1
  const bytes = amount * multiplier
  return Number.isInteger(amount) && amount > 0 && bytes <= MAX_JSON_BODY_LIMIT_BYTES ? `${amount}${unit}` : fallback
}

function configuredRuntimeString(value, fallback, maxLength = MAX_RUNTIME_CONFIG_STRING_LENGTH) {
  const text = typeof value === 'string' && value.trim() ? value.trim().replace(/\s+/g, ' ') : fallback
  if (typeof text !== 'string') return ''
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`
}

function configuredCodexApprovalPolicy(value, fallback = DEFAULT_CODEX_APPROVAL_POLICY) {
  const policy = typeof value === 'string' ? value.trim() : ''
  return CODEX_APPROVAL_POLICIES.has(policy) ? policy : fallback
}

function configuredBoolean(value, fallback = false) {
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

function configuredAbsolutePath(value, fallback) {
  const candidate = typeof value === 'string' && value.trim() ? value.trim() : fallback
  return path.isAbsolute(candidate) ? path.resolve(candidate) : fallback
}

function configuredExecutable(value, fallback) {
  const candidate = typeof value === 'string' && value.trim() ? value.trim() : fallback
  if (typeof candidate !== 'string' || !candidate || candidate.length > MAX_RUNTIME_CONFIG_STRING_LENGTH) return fallback
  if (/[\u0000-\u001f\u007f]/.test(candidate)) return fallback
  if (path.basename(candidate) !== candidate) return path.isAbsolute(candidate) ? path.resolve(candidate) : fallback
  return /^[A-Za-z0-9._+-]+$/.test(candidate) ? candidate : fallback
}

function configuredLocalApiOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return ''
  try {
    const parsed = new URL(value)
    const rootPath = parsed.pathname === '/' && !parsed.search && !parsed.hash
    const localHttp = parsed.protocol === 'http:' && localApiHostnames.has(parsed.hostname)
    if (!localHttp || !rootPath || parsed.username || parsed.password) return ''
    return parsed.origin
  } catch {
    return ''
  }
}

function configuredAllowedApiOrigins(value) {
  return normalizeString(value)
    .split(',')
    .map((origin) => configuredLocalApiOrigin(origin))
    .filter(Boolean)
}

function guardLocalApiRequests(req, res, next) {
  if (!req.path.startsWith('/api/')) {
    next()
    return
  }

  const origin = req.get('origin')
  if (origin && !ALLOWED_API_ORIGINS.has(origin)) {
    res.status(403).json({ error: 'Request origin is not allowed.', code: 'origin_not_allowed' })
    return
  }
  if (origin) {
    res.set({
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    })
  }

  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }

  if (apiRouteRequiresJsonBody(req) && !req.is('application/json')) {
    res.status(415).json({ error: 'Content-Type must be application/json.', code: 'json_required' })
    return
  }

  next()
}

app.use(guardLocalApiRequests)
app.use(express.json({ limit: JSON_BODY_LIMIT }))

function handleJsonBodyError(error, req, res, next) {
  if (!req.path.startsWith('/api/')) {
    next(error)
    return
  }

  if (error?.type === 'entity.too.large') {
    res.status(413).json({ error: 'JSON request body is too large.', code: 'payload_too_large' })
    return
  }

  if (error?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Request body must be valid JSON.', code: 'invalid_json' })
    return
  }

  next(error)
}

app.use(handleJsonBodyError)

async function loadLocalSecrets() {
  try {
    const details = await stat(SECRETS_PATH)
    if (details.size > MAX_SECRETS_FILE_BYTES) throw new Error('Saved secrets file is too large.')
    localSecrets = normalizeLocalSecrets(JSON.parse(await readFile(SECRETS_PATH, 'utf8')))
  } catch {
    localSecrets = {}
  }
}

function isPlausibleOpenAiApiKey(value) {
  const apiKey = typeof value === 'string' ? value.trim() : ''
  return apiKey.startsWith('sk-') && apiKey.length <= MAX_OPENAI_API_KEY_LENGTH
}

function normalizedOpenAiApiKey(value) {
  const apiKey = typeof value === 'string' ? value.trim() : ''
  return isPlausibleOpenAiApiKey(apiKey) ? apiKey : ''
}

function defaultOpenAiSafetyIdentifier() {
  const source = [
    'codex-realtime-linux',
    os.hostname(),
    os.userInfo().username,
    os.homedir(),
    SECRETS_PATH,
  ].join('\0')
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 32)
  return `codex-realtime-linux-${digest}`
}

function normalizeOpenAiSafetyIdentifier(value) {
  const text = normalizeString(value)
  if (!text) return ''
  return text
    .replace(/[^A-Za-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_OPENAI_SAFETY_IDENTIFIER_LENGTH)
}

function normalizeLocalSecrets(value) {
  const nextSecrets = {}
  const openaiApiKey = normalizedOpenAiApiKey(value?.openaiApiKey)
  if (openaiApiKey) nextSecrets.openaiApiKey = openaiApiKey
  return nextSecrets
}

async function writeJsonFileAtomic(filePath, value, { dirMode, fileMode } = {}) {
  const directoryPath = path.dirname(filePath)
  await mkdir(directoryPath, { recursive: true, ...(dirMode ? { mode: dirMode } : {}) })
  if (dirMode) await chmod(directoryPath, dirMode)
  const tempPath = path.join(
    directoryPath,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  )
  let fileHandle
  try {
    fileHandle = await open(tempPath, fileMode ? 'wx' : 'w', fileMode)
    await fileHandle.writeFile(`${JSON.stringify(value, null, 2)}\n`)
    await fileHandle.sync()
    await fileHandle.close()
    fileHandle = null
    if (fileMode) await chmod(tempPath, fileMode)
    await rename(tempPath, filePath)
    if (fileMode) await chmod(filePath, fileMode)
    await syncDirectoryBestEffort(directoryPath)
  } catch (error) {
    if (fileHandle) await fileHandle.close().catch(() => {})
    try {
      await rm(tempPath, { force: true })
    } catch {
      // Ignore cleanup errors; the original write failure is more useful.
    }
    throw error
  }
}

async function syncDirectoryBestEffort(directoryPath) {
  let directoryHandle
  try {
    directoryHandle = await open(directoryPath, 'r')
    await directoryHandle.sync()
  } catch {
    // Some filesystems do not support directory fsync; the file write and rename already succeeded.
  } finally {
    await directoryHandle?.close().catch(() => {})
  }
}

async function writeLocalSecrets(nextSecrets) {
  await writeJsonFileAtomic(SECRETS_PATH, nextSecrets, { dirMode: 0o700, fileMode: 0o600 })
  localSecrets = nextSecrets
}

async function mutateLocalSecrets(updater) {
  const mutation = localSecretsMutation.then(async () => {
    const nextSecrets = normalizeLocalSecrets(await updater(localSecrets))
    await writeLocalSecrets(nextSecrets)
    return nextSecrets
  })
  localSecretsMutation = mutation.catch(() => {})
  return mutation
}

function getOpenAiApiKey() {
  return ENV_OPENAI_API_KEY || localSecrets.openaiApiKey
}

function getOpenAiKeySource() {
  if (ENV_OPENAI_API_KEY) return 'env'
  if (localSecrets.openaiApiKey) return 'settings'
  return 'missing'
}

function getCodexApiKey() {
  if (ENV_CODEX_API_KEY) return ENV_CODEX_API_KEY
  if (process.env.CODEX_USE_OPENAI_API_KEY === 'true') return getOpenAiApiKey()
  return undefined
}

function workspaceToken(workspacePath) {
  return Buffer.from(path.resolve(workspacePath), 'utf8').toString('base64url')
}

function workspaceFromToken(token) {
  if (typeof token !== 'string' || token.length > MAX_WORKSPACE_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw httpError('Invalid workspace token.', { statusCode: 400, code: 'invalid_workspace_token' })
  }
  const workspacePath = Buffer.from(token, 'base64url').toString('utf8')
  if (workspaceToken(workspacePath) !== token) {
    throw httpError('Invalid workspace token.', { statusCode: 400, code: 'invalid_workspace_token' })
  }
  return workspacePath
}

function isPathInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

function isSafeArtifactName(value) {
  return typeof value === 'string' && value.length <= MAX_ARTIFACT_NAME_LENGTH && /^[a-z0-9][a-z0-9-]*$/i.test(value)
}

function isSafeArtifactPreviewPath(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_ARTIFACT_PREVIEW_PATH_LENGTH || value.includes('\0')) return false
  return value.split('/').every((segment) => segment && segment !== '.' && segment !== '..' && !segment.startsWith('.'))
}

function artifactPreviewContentType(filePath) {
  return ARTIFACT_PREVIEW_CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) ?? ''
}

function isIgnorableArtifactEntryError(error) {
  return ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(error?.code)
}

function setArtifactPreviewHeaders(res) {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self' data: blob:",
      "script-src 'self' 'unsafe-inline' data: blob:",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'self'",
    ].join('; '),
    'Permissions-Policy': 'camera=(), microphone=(), display-capture=(), geolocation=(), usb=(), serial=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  })
}

function setAppShellHeaders(res) {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' https://api.openai.com",
      "media-src 'self' blob:",
      "frame-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
    'Permissions-Policy': 'camera=(), microphone=(self), display-capture=(self), geolocation=(), usb=(), serial=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store',
  })
}

function httpError(message, { statusCode = 400, code = 'bad_request' } = {}) {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  return error
}

function sendJsonError(res, error, { fallbackStatus = 500, fallbackMessage = 'Request failed.', fallbackCode } = {}) {
  const code = error?.statusCode && error?.code ? error.code : fallbackCode
  res.status(error?.statusCode || fallbackStatus).json({
    error: responseErrorMessage(error, fallbackMessage),
    ...(code ? { code } : {}),
  })
}

function responseErrorMessage(error, fallbackMessage = 'Request failed.') {
  return normalizeBoundedString(
    error instanceof Error ? error.message : '',
    fallbackMessage,
    MAX_ERROR_MESSAGE_LENGTH,
  )
}

function requireText(value, label, { maxLength = 12_000 } = {}) {
  if (typeof value !== 'string' || !value.trim()) {
    throw httpError(`${label} is required.`, { statusCode: 400, code: 'invalid_request' })
  }

  const text = value.trim()
  if (text.length > maxLength) {
    throw httpError(`${label} is too long.`, { statusCode: 400, code: 'invalid_request' })
  }
  return text
}

function upstreamSignal() {
  return AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS)
}

async function readBoundedResponseText(response, maxBytes = MAX_UPSTREAM_JSON_RESPONSE_BYTES) {
  if (!response.body) return ''

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let totalBytes = 0
  let text = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new Error(`Upstream response exceeded ${maxBytes} bytes.`)
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    return text
  } finally {
    reader.releaseLock()
  }
}

async function readUpstreamJson(response, fallbackMessage = 'Upstream response was not JSON.') {
  const text = await readBoundedResponseText(response)
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    throw new Error(fallbackMessage)
  }
}

async function artifactPlanForWorkspace(cwd, goal) {
  const basePlan = artifactPlanForGoal(goal, new Date(), randomUUID().slice(0, 8))
  if (!basePlan) return null

  const workspacePath = path.resolve(cwd)
  if (!CODEX_ALLOW_APP_SOURCE_TASKS && (await isProtectedAppWorkspace(workspacePath))) {
    throw httpError('Generated artifacts must be created in a selected workspace outside this app source tree.', {
      statusCode: 400,
      code: 'protected_app_workspace',
    })
  }
  const token = workspaceToken(workspacePath)
  return {
    ...basePlan,
    workspacePath,
    absoluteDir: path.join(workspacePath, basePlan.relativeDir),
    absolutePath: path.join(workspacePath, basePlan.relativePath),
    url: `/workspace-artifacts/${token}/${basePlan.directoryName}/index.html`,
  }
}

async function isProtectedAppWorkspace(cwd) {
  const workspacePath = path.resolve(cwd)
  const [realRepoRoot, realWorkspacePath] = await Promise.all([realpath(REPO_ROOT), realpath(workspacePath)])
  return isPathInside(REPO_ROOT, workspacePath) || isPathInside(realRepoRoot, realWorkspacePath)
}

async function requireAllowedCodexTaskWorkspace(cwd) {
  if (CODEX_ALLOW_APP_SOURCE_TASKS) return
  if (await isProtectedAppWorkspace(cwd)) {
    throw httpError('Codex tasks cannot run inside this app source tree unless CODEX_ALLOW_APP_SOURCE_TASKS=true.', {
      statusCode: 400,
      code: 'protected_app_workspace',
    })
  }
}

function goalForWorkspace(cwd, goal, artifactPlan = null) {
  const workspacePath = path.resolve(cwd)
  if (artifactPlan && workspacePath !== REPO_ROOT) {
    return [
      'Artifact workflow: inspect this selected workspace before creating the result.',
      'Use local project files, documents, and images in this workspace as source data for the requested HTML presentation or page.',
      `Create the finished HTML presentation at ${artifactPlan.relativePath}.`,
      `Keep all supporting assets for this presentation inside ${artifactPlan.relativeDir}/.`,
      'Use relative asset paths from index.html so local images and assets load inside the app preview.',
      'Do not edit unrelated workspace source files unless the user explicitly asked for source changes.',
      'The result must be directly viewable in an iframe/browser preview from that index.html file.',
      '',
      `User goal:\n${goal}`,
    ].join('\n')
  }

  if (workspacePath !== REPO_ROOT) return goal
  return goalWithWorkspaceGuard(goal, artifactPlan)
}

function publicArtifactPlan(artifactPlan) {
  if (!artifactPlan) return null
  return {
    directoryName: artifactPlan.directoryName,
    relativeDir: artifactPlan.relativeDir,
    relativePath: artifactPlan.relativePath,
    workspacePath: artifactPlan.workspacePath,
    url: artifactPlan.url,
  }
}

async function listGeneratedArtifacts(workspacePath) {
  const resolvedWorkspacePath = path.resolve(workspacePath)
  const artifactsDir = path.join(resolvedWorkspacePath, GENERATED_ARTIFACT_DIR)
  const token = workspaceToken(resolvedWorkspacePath)
  let realWorkspacePath
  let realArtifactsDir
  try {
    const resolvedPaths = await Promise.all([realpath(resolvedWorkspacePath), realpath(artifactsDir)])
    realWorkspacePath = resolvedPaths[0]
    realArtifactsDir = resolvedPaths[1]
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  if (!isPathInside(realWorkspacePath, realArtifactsDir)) return []

  let directory
  try {
    directory = await opendir(artifactsDir)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }

  const artifacts = []
  let scannedEntries = 0
  try {
    for await (const entry of directory) {
      scannedEntries += 1
      if (scannedEntries > MAX_ARTIFACT_DIRECTORY_SCAN_ENTRIES) break
      if (!entry.isDirectory()) continue
      if (!isSafeArtifactName(entry.name)) continue
      const indexPath = path.join(artifactsDir, entry.name, 'index.html')
      try {
        const [realArtifactRoot, realIndexPath] = await Promise.all([
          realpath(path.join(artifactsDir, entry.name)),
          realpath(indexPath),
        ])
        if (!isPathInside(realArtifactsDir, realArtifactRoot)) continue
        if (!isPathInside(realArtifactRoot, realIndexPath)) continue
        const details = await stat(realIndexPath)
        if (!details.isFile()) continue
        if (details.size > MAX_ARTIFACT_PREVIEW_FILE_BYTES) continue
        const title = entry.name.replace(/^\d{8}t?\d{6}-?/i, '').replace(/-/g, ' ') || entry.name
        artifacts.push({
          id: entry.name,
          title: normalizeBoundedString(title, entry.name, MAX_ARTIFACT_TITLE_LENGTH),
          url: `/workspace-artifacts/${token}/${entry.name}/index.html`,
          relativePath: `${GENERATED_ARTIFACT_DIR}/${entry.name}/index.html`,
          workspacePath: resolvedWorkspacePath,
          updatedAt: details.mtime.toISOString(),
          size: finiteNumber(details.size),
        })
      } catch (error) {
        if (!isIgnorableArtifactEntryError(error)) throw error
      }
    }
  } finally {
    await directory.close().catch(() => {})
  }

  return artifacts
    .sort((a, b) => finiteTimestamp(b.updatedAt) - finiteTimestamp(a.updatedAt))
    .slice(0, MAX_GENERATED_ARTIFACTS)
}

function realtimeSessionConfig() {
  const userContextInstructions = [
    REALTIME_USER_NAME ? `The local user name is ${REALTIME_USER_NAME}.` : '',
    REALTIME_USER_LOCATION ? `The user location is ${REALTIME_USER_LOCATION}.` : '',
    'Use available context naturally when it helps, but do not force personal details into every reply.',
  ].filter(Boolean)

  return {
    type: 'realtime',
    model: REALTIME_MODEL,
    instructions: [
      'You are the conversational voice router for a Linux Codex desktop client.',
      'Your job is to understand the user through natural speech, clarify intent when needed, and route concrete coding work to the Codex app-server harness.',
      'Do not act like the coding agent and do not narrate long implementation plans. Codex does the execution through tools.',
      'Use codex_start_task when the user gives a concrete build, fix, review, refactor, test, or debugging goal.',
      'Use codex_steer_task when an active Codex task exists and the user changes priority, scope, style, or direction.',
      'Use codex_interrupt_task when the user asks to stop, pause, cancel, or abandon the active Codex turn.',
      `For this app, protect the app source by default. ${buildWorkspaceGuard('', null)}`,
      `For simple HTML, demo, presentation, slide, page, or generated-file requests, tell Codex to inspect the selected workspace, including images and documents, then create files under ${GENERATED_ARTIFACT_DIR}/ in that workspace unless the user explicitly asks to modify this app.`,
      'When the generated presentation is finished, it will appear in the app browser preview automatically.',
      'Use get_current_weather when the user asks for current weather conditions in a specific place.',
      'Use arduino_upload_sketch only when the user explicitly asks to upload code to a connected Arduino or to change the Arduino onboard LED behaviour.',
      'For simple requests like turning on the Arduino light, use action onboard_led_on. For blinking, use onboard_led_blink.',
      'Uploading code changes the connected board firmware; confirm the target behaviour conversationally if the request is ambiguous.',
      ...userContextInstructions,
      REALTIME_PERSONA,
      'When USB context says an Arduino was connected, acknowledge the device briefly before returning to the user.',
      'Stay conversational: acknowledge briefly, ask one focused question only when the request is ambiguous, and keep the user oriented while Codex works.',
    ].join(' '),
    audio: {
      input: {
        transcription: {
          model: REALTIME_TRANSCRIPTION_MODEL,
        },
      },
      output: { voice: REALTIME_VOICE },
    },
    tools: [
      {
        type: 'function',
        name: 'codex_start_task',
        description: 'Route concrete coding work to the Codex app-server harness by starting a new Codex thread and turn in the selected local workspace.',
        parameters: {
          type: 'object',
          properties: {
            goal: {
              type: 'string',
              maxLength: MAX_CONVERSATION_TEXT_LENGTH,
              description: 'The concrete engineering objective Codex should execute. Include relevant constraints from the conversation.',
            },
            cwd: {
              type: 'string',
              maxLength: MAX_CONVERSATION_TEXT_LENGTH,
              description: 'Absolute local workspace path. Omit this to use the currently selected workspace.',
            },
            title: {
              type: 'string',
              maxLength: MAX_CONVERSATION_TITLE_LENGTH,
              description: 'A short human-readable title for the routed work.',
            },
          },
          required: ['goal'],
        },
      },
      {
        type: 'function',
        name: 'codex_steer_task',
        description: 'Route changed direction to the active Codex thread without starting a new task.',
        parameters: {
          type: 'object',
          properties: {
            instruction: {
              type: 'string',
              maxLength: MAX_CONVERSATION_TEXT_LENGTH,
              description: 'The steering instruction Codex should apply to the active task.',
            },
          },
          required: ['instruction'],
        },
      },
      {
        type: 'function',
        name: 'codex_interrupt_task',
        description: 'Interrupt the active Codex turn when the user asks to stop or pause execution.',
        parameters: { type: 'object', properties: {} },
      },
      {
        type: 'function',
        name: 'get_current_weather',
        description: 'Fetch the current weather for a city or place name.',
        parameters: {
          type: 'object',
          properties: {
            location: {
              type: 'string',
              maxLength: 160,
              description: 'City or place name, such as "Berlin" or "Austin, Texas".',
            },
            units: {
              type: 'string',
              enum: ['metric', 'imperial'],
              description: 'Whether to return metric or imperial units.',
            },
          },
          required: ['location'],
        },
      },
      {
        type: 'function',
        name: 'arduino_upload_sketch',
        description: 'Compile and upload an Arduino sketch to a connected board through arduino-cli. Use only after the user explicitly asks to upload code or change the board LED.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['onboard_led_on', 'onboard_led_blink', 'custom_sketch'],
              description: 'Use onboard_led_on to turn the built-in LED on, onboard_led_blink to blink it, or custom_sketch for explicit custom code.',
            },
            port: {
              type: 'string',
              maxLength: 240,
              description: 'Serial port such as /dev/ttyACM0 or /dev/ttyUSB0. Omit to use the first detected Arduino serial port.',
            },
            fqbn: {
              type: 'string',
              maxLength: 240,
              description: 'Arduino fully-qualified board name, such as arduino:avr:uno. Omit for the default Uno-compatible board.',
            },
            sketch: {
              type: 'string',
              maxLength: 65536,
              description: 'Complete Arduino .ino code. Required only for custom_sketch. Must include setup() and loop().',
            },
          },
          required: ['action'],
        },
      },
    ],
    tool_choice: 'auto',
  }
}

async function createRealtimeClientSecret(openAiApiKey) {
  const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    signal: upstreamSignal(),
    headers: {
      Authorization: `Bearer ${openAiApiKey}`,
      'Content-Type': 'application/json',
      'OpenAI-Safety-Identifier': OPENAI_SAFETY_IDENTIFIER,
    },
    body: JSON.stringify({
      expires_after: { anchor: 'created_at', seconds: 600 },
      session: realtimeSessionConfig(),
    }),
  })

  const data = await readUpstreamJson(response, 'Realtime token response was not JSON.')
  if (!response.ok) {
    const message =
      typeof data?.error === 'string'
        ? data.error
        : typeof data?.error?.message === 'string'
          ? data.error.message
          : `Realtime client secret request failed with ${response.status}`
    throw new Error(message)
  }
  return data
}

function extractResponseText(response) {
  if (typeof response?.output_text === 'string') return response.output_text
  const output = Array.isArray(response?.output) ? response.output : []
  return output
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .map((part) => part?.text ?? part?.transcript ?? '')
    .filter(Boolean)
    .join('\n')
}

function normalizeEventValue(value, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return normalizeBoundedString(value, '', MAX_EVENT_STRING_LENGTH)
  if (depth >= MAX_EVENT_DEPTH) return '[truncated]'
  if (Array.isArray(value)) {
    return value.slice(0, MAX_EVENT_ARRAY_ITEMS).map((item) => normalizeEventValue(item, depth + 1, seen))
  }
  if (typeof value !== 'object') return undefined
  if (seen.has(value)) return '[circular]'
  seen.add(value)

  const normalized = {}
  for (const [key, entryValue] of Object.entries(value).slice(0, MAX_EVENT_OBJECT_KEYS)) {
    const normalizedKey = normalizeBoundedString(key, 'field', MAX_EVENT_METHOD_LENGTH)
    const normalizedValue = normalizeEventValue(entryValue, depth + 1, seen)
    if (normalizedKey && normalizedValue !== undefined) normalized[normalizedKey] = normalizedValue
  }
  return normalized
}

function normalizeEventRecord(event, fallbackMethod = 'app-server/event') {
  const source = event && typeof event === 'object' ? event : {}
  const { method, receivedAt, params, ...rest } = source
  const eventParams = params != null ? params : rest
  return {
    method: normalizeBoundedString(method, fallbackMethod, MAX_EVENT_METHOD_LENGTH),
    receivedAt: typeof receivedAt === 'string' ? receivedAt : new Date().toISOString(),
    params: normalizeEventValue(eventParams) ?? {},
  }
}

function codexRpcErrorMessage(error) {
  const message =
    error && typeof error === 'object' && !Array.isArray(error)
      ? error.message
      : typeof error === 'string'
        ? error
        : ''
  return normalizeBoundedString(message, 'Codex app-server request failed.', MAX_ERROR_MESSAGE_LENGTH)
}

function normalizeCodexMetadataValue(value, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return normalizeBoundedString(value, '', MAX_CODEX_METADATA_STRING_LENGTH)
  if (depth >= MAX_CODEX_METADATA_DEPTH) return '[truncated]'
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_CODEX_METADATA_ARRAY_ITEMS)
      .map((item) => normalizeCodexMetadataValue(item, depth + 1, seen))
  }
  if (typeof value !== 'object') return undefined
  if (seen.has(value)) return '[circular]'
  seen.add(value)

  const normalized = {}
  for (const [key, entryValue] of Object.entries(value).slice(0, MAX_CODEX_METADATA_OBJECT_KEYS)) {
    const normalizedKey = normalizeBoundedString(key, 'field', MAX_EVENT_METHOD_LENGTH)
    const normalizedValue = normalizeCodexMetadataValue(entryValue, depth + 1, seen)
    if (normalizedKey && normalizedValue !== undefined) normalized[normalizedKey] = normalizedValue
  }
  return normalized
}

function visualContextDataUrlParts(value) {
  if (typeof value !== 'string') return null
  const match = /^data:([^;,]+);base64,(.*)$/i.exec(value)
  if (!match) return null
  const payload = match[2]
  if (!payload || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return null
  return {
    type: match[1].toLowerCase(),
  }
}

function normalizeVisualContextSourceLabel(value) {
  const rawLabel = normalizeBoundedString(value, 'attached image', MAX_VISUAL_CONTEXT_SOURCE_LENGTH)
  const basename = rawLabel.split(/[\\/]+/).filter(Boolean).pop() ?? rawLabel
  const label = basename
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[^A-Za-z0-9._ -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!label || label === '.' || label === '..') return 'attached image'
  return normalizeBoundedString(label, 'attached image', MAX_VISUAL_CONTEXT_SOURCE_LENGTH)
}

async function analyzeVisualContext({ imageDataUrl, source, prompt }) {
  const sourceLabel = normalizeVisualContextSourceLabel(source)
  const promptText = normalizeBoundedString(prompt, DEFAULT_VISUAL_CONTEXT_PROMPT, MAX_VISUAL_CONTEXT_PROMPT_LENGTH)
  const imageDataUrlText = typeof imageDataUrl === 'string' ? imageDataUrl : ''

  if (Buffer.byteLength(imageDataUrlText, 'utf8') > MAX_VISUAL_CONTEXT_DATA_URL_BYTES) {
    throw httpError('Visual context image is too large.', {
      statusCode: 413,
      code: 'visual_context_too_large',
    })
  }

  const imageData = visualContextDataUrlParts(imageDataUrlText)
  if (!imageData || !SUPPORTED_VISUAL_CONTEXT_DATA_URL_TYPES.has(imageData.type)) {
    throw httpError('imageDataUrl must be a base64 JPEG, PNG, WebP, or GIF data URL.', {
      statusCode: 400,
      code: 'invalid_visual_context',
    })
  }

  const openAiApiKey = getOpenAiApiKey()
  if (!openAiApiKey) {
    throw httpError('OPENAI_API_KEY is required for visual context analysis.', {
      statusCode: 503,
      code: 'openai_key_missing',
    })
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    signal: upstreamSignal(),
    headers: {
      Authorization: `Bearer ${openAiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      max_output_tokens: 220,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: [
                'Analyze this visual context for a voice-first Codex coding session.',
                `Source: ${sourceLabel}.`,
                promptText,
                'Return a concise, factual summary in 1-3 sentences. Do not invent unseen details.',
              ].join(' '),
            },
            {
              type: 'input_image',
              image_url: imageDataUrl,
              detail: 'low',
            },
          ],
        },
      ],
    }),
  })

  const data = await readUpstreamJson(response, 'Vision response was not JSON.')
  if (!response.ok) {
    const message =
      typeof data?.error === 'string'
        ? data.error
        : typeof data?.error?.message === 'string'
          ? data.error.message
          : `Visual context analysis failed with ${response.status}`
    throw new Error(message)
  }

  return {
    source: sourceLabel,
    summary: normalizeBoundedString(
      extractResponseText(data),
      'Visual context was attached, but no summary was returned.',
      MAX_VISUAL_CONTEXT_SUMMARY_LENGTH,
    ),
  }
}

class CodexRpc {
  proc = null
  rl = null
  nextId = 1
  ready = false
  initPromise = null
  pending = new Map()
  notifications = []
  killTimer = null

  recordNotification(event, limit = MAX_CODEX_NOTIFICATIONS) {
    this.notifications.unshift(normalizeEventRecord(event))
    this.notifications = this.notifications.slice(0, limit)
  }

  async ensure() {
    if (this.ready) return
    if (this.initPromise) return this.initPromise

    this.initPromise = this.#initialize().catch((error) => {
      this.#terminateProcess()
      this.#resetProcessState(error, { keepKillTimer: true })
      throw error
    })
    return this.initPromise
  }

  async #initialize() {
    this.proc = spawn(CODEX_BIN, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    })

    this.proc.once('error', (error) => {
      this.#resetProcessState(error)
    })

    this.proc.stderr.on('data', (chunk) => {
      const chunkLength = typeof chunk?.length === 'number' ? chunk.length : String(chunk).length
      const rawMessage = Buffer.isBuffer(chunk)
        ? chunk.subarray(0, MAX_CODEX_RPC_LINE_LENGTH).toString()
        : String(chunk).slice(0, MAX_CODEX_RPC_LINE_LENGTH)
      const message = rawMessage.trim()
      if (message) {
        this.recordNotification({
          method: 'app-server/stderr',
          params: { message, truncated: chunkLength > MAX_CODEX_RPC_LINE_LENGTH, at: new Date().toISOString() },
        })
      }
    })

    this.proc.once('exit', (code, signal) => {
      const reason = signal ? `signal ${signal}` : `code ${code}`
      this.#resetProcessState(new Error(`codex app-server exited with ${reason}`))
    })

    this.rl = createInterface({ input: this.proc.stdout })
    this.rl.on('line', (line) => this.#handleLine(line))

    await this.request('initialize', {
      clientInfo: {
        name: 'codex_realtime_linux',
        title: 'Codex Realtime Linux',
        version: '0.1.0',
      },
      capabilities: { experimentalApi: true },
    })
    this.notify('initialized', {})
    this.ready = true

    const codexApiKey = getCodexApiKey()
    if (codexApiKey) {
      const account = await this.request('account/read', { refreshToken: false })
      if (CODEX_FORCE_API_KEY_AUTH || !account?.account) {
        await this.request('account/login/start', {
          type: 'apiKey',
          apiKey: codexApiKey,
        })
      }
    }
  }

  #clearKillTimer() {
    if (this.killTimer != null) clearTimeout(this.killTimer)
    this.killTimer = null
  }

  #terminateProcess() {
    const proc = this.proc
    if (!proc || proc.exitCode != null || proc.signalCode != null) return
    proc.kill('SIGTERM')
    this.#clearKillTimer()
    this.killTimer = setTimeout(() => {
      this.killTimer = null
      if (proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL')
    }, CODEX_PROCESS_KILL_GRACE_MS)
    this.killTimer.unref?.()
  }

  #resetProcessState(error, { keepKillTimer = false } = {}) {
    this.ready = false
    this.initPromise = null
    this.proc = null
    this.rl?.close()
    this.rl = null
    if (!keepKillTimer) this.#clearKillTimer()
    for (const { reject, timeout } of this.pending.values()) {
      clearTimeout(timeout)
      reject(error)
    }
    this.pending.clear()
  }

  #handleLine(line) {
    if (line.length > MAX_CODEX_RPC_LINE_LENGTH) {
      this.recordNotification({
        method: 'app-server/oversized-line',
        params: {
          length: line.length,
          maxLength: MAX_CODEX_RPC_LINE_LENGTH,
          at: new Date().toISOString(),
        },
      })
      return
    }

    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.recordNotification({
        method: 'app-server/malformed-line',
        params: { line, at: new Date().toISOString() },
      })
      return
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.recordNotification({
        method: 'app-server/unexpected-line',
        params: {
          type: Array.isArray(message) ? 'array' : typeof message,
          at: new Date().toISOString(),
        },
      })
      return
    }

    if (message.id != null && this.pending.has(message.id)) {
      const { resolve, reject, timeout } = this.pending.get(message.id)
      clearTimeout(timeout)
      this.pending.delete(message.id)
      if (message.error) reject(new Error(codexRpcErrorMessage(message.error)))
      else resolve(message.result)
      return
    }

    this.recordNotification({ ...message, receivedAt: new Date().toISOString() })
  }

  request(method, params = {}) {
    if (!this.proc?.stdin?.writable) {
      return Promise.reject(new Error('codex app-server is not connected.'))
    }

    const id = this.nextId++
    const payload = { method, id, params }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.has(id)) return
        const error = new Error(`codex app-server request timed out: ${method}`)
        this.recordNotification({
          method: 'app-server/request-timeout',
          params: { method, id, at: new Date().toISOString() },
        })
        this.#terminateProcess()
        this.#resetProcessState(error, { keepKillTimer: true })
      }, CODEX_RPC_TIMEOUT_MS)

      this.pending.set(id, { resolve, reject, timeout })
      try {
        this.proc.stdin.write(`${JSON.stringify(payload)}\n`)
      } catch (error) {
        clearTimeout(timeout)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  notify(method, params = {}) {
    if (!this.proc?.stdin?.writable) return
    try {
      this.proc.stdin.write(`${JSON.stringify({ method, params })}\n`)
    } catch (error) {
      this.recordNotification({
        method: 'app-server/notify-failed',
        params: { method, message: responseErrorMessage(error, 'Codex app-server notification failed.') },
      })
      this.#resetProcessState(error)
    }
  }

  dispose(reason = 'codex app-server stopped.') {
    this.#terminateProcess()
    this.#resetProcessState(new Error(reason), { keepKillTimer: true })
  }
}

const codex = new CodexRpc()
let appStateMutation = Promise.resolve()
let localSecretsMutation = Promise.resolve()

const emptyAppState = () => ({
  version: 1,
  workspaces: [],
  conversationsByWorkspace: {},
  hiddenWorkspacePaths: [],
  hiddenCodexThreadIdsByWorkspace: {},
})

function normalizeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function normalizeBoundedString(value, fallback = '', maxLength = 1_000) {
  const text = normalizeString(value, fallback).replace(/\s+/g, ' ')
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function requireObjectBody(value, label = 'JSON body') {
  if (value == null) return {}
  if (typeof value === 'object' && !Array.isArray(value)) return value
  throw httpError(`${label} must be a JSON object.`, { statusCode: 400, code: 'invalid_request' })
}

function requireObjectField(value, label) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  throw httpError(`${label} must be a JSON object.`, { statusCode: 400, code: 'invalid_request' })
}

function requireConversationInput(value) {
  const conversation = requireObjectField(value, 'conversation')
  if (!normalizeString(conversation.id)) {
    throw httpError('conversation.id is required.', { statusCode: 400, code: 'invalid_request' })
  }
  return conversation
}

function normalizeWorkspacePath(value) {
  const workspacePath = normalizeString(value)
  return workspacePath && path.isAbsolute(workspacePath) ? path.resolve(workspacePath) : ''
}

function normalizeIsoTimestamp(value, fallback) {
  const text = normalizeBoundedString(value, '', MAX_CONVERSATION_TIMESTAMP_LENGTH)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(text)) return fallback
  const timestamp = Date.parse(text)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback
}

async function requireWorkspaceDirectory(value, label = 'workspacePath') {
  const workspacePath = normalizeString(value)
  if (!workspacePath) {
    throw httpError(`${label} is required.`, { statusCode: 400, code: 'invalid_workspace_path' })
  }
  if (!path.isAbsolute(workspacePath)) {
    throw httpError(`${label} must be an absolute local path.`, { statusCode: 400, code: 'invalid_workspace_path' })
  }

  const resolvedPath = path.resolve(workspacePath)
  let details
  try {
    details = await stat(resolvedPath)
  } catch {
    throw httpError(`${label} does not exist.`, { statusCode: 404, code: 'workspace_not_found' })
  }
  if (!details.isDirectory()) {
    throw httpError(`${label} must be a directory.`, { statusCode: 400, code: 'invalid_workspace_path' })
  }
  return resolvedPath
}

function normalizeWorkspace(input) {
  const pathValue = normalizeWorkspacePath(input?.path || input?.id)
  if (!pathValue) return null
  return {
    id: pathValue,
    name: normalizeBoundedString(input?.name, path.basename(pathValue) || pathValue, MAX_CONVERSATION_TITLE_LENGTH),
    path: pathValue,
    status: normalizeBoundedString(input?.status, 'local', 40),
  }
}

function normalizeAdminWorkspace(input) {
  const id = normalizeBoundedString(input?.id, '', MAX_CONVERSATION_ID_LENGTH)
  if (!id) return null
  return {
    id,
    name: normalizeBoundedString(input?.name, id, MAX_CONVERSATION_TITLE_LENGTH),
    status: normalizeBoundedString(input?.status ?? input?.archived, 'admin-api', 40),
  }
}

function normalizeStringList(values, maxItems, maxLength) {
  if (!Array.isArray(values)) return []
  return values
    .filter((item) => typeof item === 'string')
    .map((item) => normalizeBoundedString(item, '', maxLength))
    .filter(Boolean)
    .slice(0, maxItems)
}

function normalizeWorkspacePathList(values, maxItems) {
  if (!Array.isArray(values)) return []
  return [...new Set(values.map(normalizeWorkspacePath).filter(Boolean))].slice(0, maxItems)
}

function normalizeUniqueStringList(values, maxItems, maxLength) {
  return [...new Set(normalizeStringList(values, maxItems, maxLength))].slice(0, maxItems)
}

function normalizeHiddenCodexThreadIdsByWorkspace(input, savedWorkspacePaths) {
  const groups = {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) return groups
  let normalizedWorkspaceBuckets = 0
  for (const [workspacePath, threadIds] of Object.entries(input)) {
    if (normalizedWorkspaceBuckets >= MAX_LOCAL_WORKSPACE_BUCKETS) break
    const normalizedWorkspacePath = normalizeWorkspacePath(workspacePath)
    if (!normalizedWorkspacePath || groups[normalizedWorkspacePath]) continue
    if (savedWorkspacePaths && !savedWorkspacePaths.has(normalizedWorkspacePath)) continue
    const normalizedThreadIds = normalizeUniqueStringList(
      threadIds,
      MAX_HIDDEN_CODEX_THREADS_PER_WORKSPACE,
      MAX_CONVERSATION_ID_LENGTH,
    )
    if (normalizedThreadIds.length === 0) continue
    groups[normalizedWorkspacePath] = normalizedThreadIds
    normalizedWorkspaceBuckets += 1
  }
  return groups
}

function firstUniqueBy(values, keyForValue) {
  const seen = new Set()
  return values.filter((value) => {
    const key = keyForValue(value)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function normalizeTranscript(input) {
  if (!Array.isArray(input)) return []
  return input
    .filter((line) => line?.speaker === 'user' || line?.speaker === 'codex')
    .map((line) => ({
      speaker: line.speaker,
      text: normalizeBoundedString(line.text, '', MAX_CONVERSATION_TEXT_LENGTH),
    }))
    .filter((line) => line.text)
    .slice(0, MAX_CONVERSATION_TRANSCRIPT_LINES)
}

function equalStringList(values, expected) {
  return values.length === expected.length && values.every((value, index) => value === expected[index])
}

function equalTranscript(values, expected) {
  return (
    values.length === expected.length &&
    values.every((value, index) => value.speaker === expected[index].speaker && value.text === expected[index].text)
  )
}

function stripLegacyDraftScaffolding(conversation) {
  if (
    conversation.source !== 'local' ||
    conversation.status !== 'draft' ||
    conversation.codexThreadId ||
    conversation.prompt !== LEGACY_DRAFT_PROMPT ||
    conversation.response !== LEGACY_DRAFT_RESPONSE ||
    !equalStringList(conversation.traces, LEGACY_DRAFT_TRACES) ||
    !equalTranscript(conversation.transcript, LEGACY_DRAFT_TRANSCRIPT)
  ) {
    return conversation
  }

  const legacyTitle = LEGACY_DRAFT_TITLE_PATTERN.exec(conversation.title)
  return {
    ...conversation,
    title: legacyTitle ? `Voice conversation ${legacyTitle[1]}` : conversation.title,
    prompt: '',
    response: '',
    traces: [],
    transcript: [],
  }
}

function isLegacyDraftScaffoldingInput(conversation) {
  return (
    conversation.source === 'local' &&
    conversation.status === 'draft' &&
    !conversation.codexThreadId &&
    LEGACY_DRAFT_TITLE_PATTERN.test(normalizeString(conversation.title)) &&
    conversation.prompt === LEGACY_DRAFT_PROMPT &&
    conversation.response === LEGACY_DRAFT_RESPONSE &&
    equalStringList(Array.isArray(conversation.traces) ? conversation.traces : [], LEGACY_DRAFT_TRACES) &&
    equalTranscript(Array.isArray(conversation.transcript) ? conversation.transcript : [], LEGACY_DRAFT_TRANSCRIPT)
  )
}

function normalizeConversation(input, workspacePath) {
  const now = new Date().toISOString()
  const title = normalizeBoundedString(input?.title, 'Untitled conversation', MAX_CONVERSATION_TITLE_LENGTH)
  const id = normalizeBoundedString(input?.id, '', MAX_CONVERSATION_ID_LENGTH)
  if (!id) return null
  const status = ['draft', 'ready', 'running'].includes(input?.status) ? input.status : 'draft'

  return stripLegacyDraftScaffolding({
    id,
    title,
    age: normalizeBoundedString(input?.age, 'saved', 40),
    status,
    prompt: normalizeBoundedString(input?.prompt, '', MAX_CONVERSATION_TEXT_LENGTH),
    response: normalizeBoundedString(input?.response, '', MAX_CONVERSATION_TEXT_LENGTH),
    traces: normalizeStringList(input?.traces, MAX_CONVERSATION_TRACES, MAX_CONVERSATION_TRACE_LENGTH),
    transcript: normalizeTranscript(input?.transcript),
    source: ['local', 'codex'].includes(input?.source) ? input.source : 'local',
    codexThreadId: normalizeBoundedString(input?.codexThreadId, '', MAX_CONVERSATION_ID_LENGTH) || null,
    workspacePath,
    createdAt: normalizeIsoTimestamp(input?.createdAt, now),
    updatedAt: normalizeIsoTimestamp(input?.updatedAt, now),
  })
}

function normalizeAppState(input) {
  const state = emptyAppState()
  state.workspaces = Array.isArray(input?.workspaces)
    ? firstUniqueBy(input.workspaces.map(normalizeWorkspace).filter(Boolean), (workspace) => workspace.path).slice(0, MAX_LOCAL_WORKSPACES)
    : []
  state.hiddenWorkspacePaths = normalizeWorkspacePathList(input?.hiddenWorkspacePaths, MAX_LOCAL_HIDDEN_WORKSPACES)
  const savedWorkspacePaths = new Set(state.workspaces.map((workspace) => workspace.path))
  state.hiddenCodexThreadIdsByWorkspace = normalizeHiddenCodexThreadIdsByWorkspace(
    input?.hiddenCodexThreadIdsByWorkspace,
    savedWorkspacePaths,
  )
  let normalizedWorkspaceBuckets = 0

  if (input?.conversationsByWorkspace && typeof input.conversationsByWorkspace === 'object') {
    for (const [workspacePath, conversations] of Object.entries(input.conversationsByWorkspace)) {
      if (normalizedWorkspaceBuckets >= MAX_LOCAL_WORKSPACE_BUCKETS) break
      const normalizedWorkspacePath = normalizeWorkspacePath(workspacePath)
      if (!normalizedWorkspacePath || state.conversationsByWorkspace[normalizedWorkspacePath]) continue
      if (Array.isArray(conversations)) {
        const normalizedConversations = firstUniqueBy(
          conversations
            .filter((conversation) => !isLegacyDraftScaffoldingInput(conversation))
            .map((conversation) => normalizeConversation(conversation, normalizedWorkspacePath))
            .filter(Boolean),
          (conversation) => conversation.id,
        ).slice(0, MAX_LOCAL_CONVERSATIONS_PER_WORKSPACE)
        if (normalizedConversations.length > 0 || savedWorkspacePaths.has(normalizedWorkspacePath)) {
          state.conversationsByWorkspace[normalizedWorkspacePath] = normalizedConversations
          normalizedWorkspaceBuckets += 1
        }
      }
    }
  }

  for (const workspacePath of savedWorkspacePaths) {
    if (normalizedWorkspaceBuckets >= MAX_LOCAL_WORKSPACE_BUCKETS) break
    if (!state.conversationsByWorkspace[workspacePath]) {
      state.conversationsByWorkspace[workspacePath] = []
      normalizedWorkspaceBuckets += 1
    }
  }

  return state
}

async function readNormalizedAppStateFile(filePath) {
  const details = await stat(filePath)
  if (details.size > MAX_APP_STATE_FILE_BYTES) throw new Error('Saved app state file is too large.')
  return normalizeAppState(JSON.parse(await readFile(filePath, 'utf8')))
}

async function backupReadableAppState() {
  try {
    const currentState = await readNormalizedAppStateFile(STATE_PATH)
    await writeJsonFileAtomic(STATE_BACKUP_PATH, currentState, { dirMode: 0o700, fileMode: 0o600 })
  } catch (error) {
    if (error.code !== 'ENOENT') {
      codex.recordNotification({
        method: 'app-state/backup-skipped',
        receivedAt: new Date().toISOString(),
        params: { message: error.message },
      })
    }
  }
}

async function readAppState() {
  try {
    return await readNormalizedAppStateFile(STATE_PATH)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      codex.recordNotification({
        method: 'app-state/read-error',
        receivedAt: new Date().toISOString(),
        params: { message: error.message },
      })
    }
    try {
      const backupState = await readNormalizedAppStateFile(STATE_BACKUP_PATH)
      codex.recordNotification({
        method: 'app-state/recovered-from-backup',
        receivedAt: new Date().toISOString(),
        params: { message: error.message },
      })
      return backupState
    } catch (backupError) {
      if (backupError.code !== 'ENOENT') {
        codex.recordNotification({
          method: 'app-state/backup-read-error',
          receivedAt: new Date().toISOString(),
          params: { message: backupError.message },
        })
      }
    }
    return emptyAppState()
  }
}

async function writeAppState(state) {
  const normalizedState = normalizeAppState(state)
  await backupReadableAppState()
  await writeJsonFileAtomic(STATE_PATH, normalizedState, { dirMode: 0o700, fileMode: 0o600 })
  return normalizedState
}

async function mutateAppState(updater) {
  const mutation = appStateMutation.then(async () => {
    const state = await readAppState()
    const result = await updater(state)
    const normalizedState = await writeAppState(state)
    return { state: normalizedState, result }
  })
  appStateMutation = mutation.catch(() => {})
  return mutation
}

function normalizeEpochSecondsTimestamp(value, fallback = new Date().toISOString()) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const timestamp = value * 1000
  if (!Number.isFinite(timestamp)) return fallback
  const date = new Date(timestamp)
  const dateTime = date.getTime()
  return Number.isFinite(dateTime) ? date.toISOString() : fallback
}

function threadToConversation(thread) {
  const threadId = normalizeBoundedString(thread?.id, '', MAX_CONVERSATION_ID_LENGTH)
  if (!threadId) return null
  const preview = normalizeBoundedString(thread?.preview, '', MAX_CONVERSATION_TEXT_LENGTH)
  const title = normalizeBoundedString(
    thread?.name,
    normalizeBoundedString(thread?.preview, 'Codex conversation', MAX_CONVERSATION_TITLE_LENGTH),
    MAX_CONVERSATION_TITLE_LENGTH,
  )
  const updatedAt = normalizeEpochSecondsTimestamp(thread?.updatedAt)
  const status = thread?.status?.type === 'active' ? 'running' : 'ready'
  const statusType = normalizeBoundedString(thread?.status?.type, 'ready', 40)
  const workspacePath = normalizeBoundedString(normalizeWorkspacePath(thread?.cwd), '', MAX_CONVERSATION_TEXT_LENGTH)
  const traces = [workspacePath ? `Workspace: ${workspacePath}` : '', statusType ? `Status: ${statusType}` : '']

  return {
    id: threadId,
    title: title.length > 54 ? `${title.slice(0, 51)}...` : title,
    age: 'codex',
    status,
    prompt: preview,
    response: '',
    traces: normalizeStringList(traces, MAX_CONVERSATION_TRACES, MAX_CONVERSATION_TRACE_LENGTH),
    transcript: [],
    workspacePath,
    source: 'codex',
    codexThreadId: threadId,
    createdAt: updatedAt,
    updatedAt,
  }
}

function normalizeCodexThreadListResponse(result) {
  const normalizedResult = normalizeCodexMetadataValue(result)
  const response = normalizedResult && typeof normalizedResult === 'object' && !Array.isArray(normalizedResult) ? normalizedResult : {}
  const threads = Array.isArray(result?.data) ? result.data.slice(0, MAX_CODEX_THREADS) : []
  return {
    ...response,
    data: Array.isArray(response.data) ? response.data : [],
    conversations: threads.map(threadToConversation).filter(Boolean),
  }
}

function filterHiddenCodexThreads(result, hiddenThreadIds) {
  if (!hiddenThreadIds || hiddenThreadIds.size === 0 || !Array.isArray(result?.data)) return result
  return {
    ...result,
    data: result.data.filter((thread) => !hiddenThreadIds.has(normalizeBoundedString(thread?.id, '', MAX_CONVERSATION_ID_LENGTH))),
  }
}

function normalizeCodexEntityId(entity, label) {
  const id = normalizeBoundedString(entity?.id, '', MAX_CONVERSATION_ID_LENGTH)
  if (!id) {
    throw httpError(`Codex app-server did not return a ${label} id.`, {
      statusCode: 502,
      code: 'codex_invalid_response',
    })
  }
  return id
}

async function archiveCodexThreadBestEffort(threadId, reason) {
  if (!threadId) return
  try {
    await codex.request('thread/archive', { threadId })
    codex.recordNotification({
      method: 'codex/thread-archive-cleanup',
      receivedAt: new Date().toISOString(),
      params: { threadId, reason },
    })
  } catch (error) {
    codex.recordNotification({
      method: 'codex/thread-archive-cleanup-failed',
      receivedAt: new Date().toISOString(),
      params: { threadId, reason, message: responseErrorMessage(error, 'Failed to archive failed Codex thread.') },
    })
  }
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function nonNegativeFiniteNumber(value, fallback = 0) {
  return Math.max(0, finiteNumber(value, fallback))
}

function finiteTimestamp(value, fallback = 0) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(timestamp) ? timestamp : fallback
}

function topUsageBuckets(totalsByLabel) {
  return [...totalsByLabel.entries()]
    .map(([label, value]) => ({ label, value }))
    .filter((bucket) => Number.isFinite(bucket.value) && bucket.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, MAX_USAGE_BUCKETS)
}

function normalizeUsageCurrency(value, fallback = 'usd') {
  const currency = normalizeString(value).toLowerCase()
  return currency && currency.length <= MAX_USAGE_CURRENCY_LENGTH && /^[a-z]{3,12}$/.test(currency) ? currency : fallback
}

function mixedCurrencyUsageWarning(count, currencies) {
  if (!count) return null
  const labels = currencies.length ? ` (${currencies.join(', ')})` : ''
  return `Ignored ${count} cost ${count === 1 ? 'row' : 'rows'} with mixed currencies${labels}.`
}

function normalizeCosts(costs) {
  const buckets = Array.isArray(costs?.data) ? costs.data : []
  const totalsByLabel = new Map()
  const ignoredCurrencies = new Set()
  let ignoredCurrencyCount = 0
  let currency = null

  for (const bucket of buckets) {
    const results = Array.isArray(bucket?.results) ? bucket.results : []
    for (const result of results) {
      const label = normalizeBoundedString(
        result.line_item ?? result.object ?? result.model,
        'OpenAI usage',
        MAX_USAGE_BUCKET_LABEL_LENGTH,
      )
      const amount =
        result.amount?.value ??
        result.amount?.amount ??
        result.cost?.value ??
        result.cost ??
        0
      const value = finiteNumber(amount, Number.NaN)
      if (!Number.isFinite(value) || value <= 0) continue

      const resultCurrency = normalizeUsageCurrency(result.amount?.currency, currency ?? 'usd')
      if (!currency) currency = resultCurrency
      if (resultCurrency !== currency) {
        ignoredCurrencyCount += 1
        ignoredCurrencies.add(resultCurrency.toUpperCase())
        continue
      }

      totalsByLabel.set(label, (totalsByLabel.get(label) ?? 0) + value)
    }
  }

  const total = [...totalsByLabel.values()].reduce(
    (sum, value) => (Number.isFinite(value) && value > 0 ? sum + value : sum),
    0,
  )

  return {
    total,
    currency: currency ?? 'usd',
    ignoredCurrencyCount,
    ignoredCurrencies: [...ignoredCurrencies].slice(0, MAX_IGNORED_USAGE_CURRENCIES),
    buckets: topUsageBuckets(totalsByLabel),
  }
}

function normalizeCompletionUsage(usage) {
  const buckets = Array.isArray(usage?.data) ? usage.data : []
  const totalsByLabel = new Map()
  const totals = {
    input: 0,
    output: 0,
    cached: 0,
    audioInput: 0,
    audioOutput: 0,
    total: 0,
    requests: 0,
  }

  for (const bucket of buckets) {
    const results = Array.isArray(bucket?.results) ? bucket.results : []
    for (const result of results) {
      const input = nonNegativeFiniteNumber(result.input_tokens)
      const output = nonNegativeFiniteNumber(result.output_tokens)
      const cached = nonNegativeFiniteNumber(result.input_cached_tokens)
      const audioInput = nonNegativeFiniteNumber(result.input_audio_tokens)
      const audioOutput = nonNegativeFiniteNumber(result.output_audio_tokens)
      const total = input + output
      const label = normalizeBoundedString(result.model ?? result.object, 'Completions', MAX_USAGE_BUCKET_LABEL_LENGTH)

      totals.input += input
      totals.output += output
      totals.cached += cached
      totals.audioInput += audioInput
      totals.audioOutput += audioOutput
      totals.total += total
      totals.requests += nonNegativeFiniteNumber(result.num_model_requests)
      totalsByLabel.set(label, (totalsByLabel.get(label) ?? 0) + total)
    }
  }

  return {
    totals,
    buckets: topUsageBuckets(totalsByLabel),
  }
}

async function getUsdToGbpRate() {
  const configuredRate = configuredUsdToGbpRate(process.env.OPENAI_USAGE_GBP_RATE)
  if (configuredRate != null) {
    return { rate: configuredRate, source: 'env' }
  }

  const response = await fetch(GBP_RATE_API, { signal: upstreamSignal() })
  if (!response.ok) throw new Error(`GBP conversion failed with ${response.status}`)
  const data = await readUpstreamJson(response, 'GBP conversion response was not JSON.')
  const rate = configuredUsdToGbpRate(data?.rates?.GBP)
  if (rate == null) throw new Error(`GBP conversion response did not include a USD to GBP rate from 0 to ${MAX_USD_TO_GBP_RATE}`)
  return { rate, source: 'frankfurter' }
}

async function normalizeUsage(costs, completionUsage) {
  const cost = normalizeCosts(costs)
  const tokenUsage = normalizeCompletionUsage(completionUsage)
  const nativeCurrency = cost.currency.toLowerCase()
  let totalCostGbp = null
  let costBucketsGbp = []
  let conversionRate = null
  let conversionSource = null
  let conversionError = null

  if (nativeCurrency === 'gbp') {
    totalCostGbp = cost.total
    costBucketsGbp = cost.buckets
    conversionRate = 1
    conversionSource = 'native'
  } else if (nativeCurrency === 'usd') {
    try {
      const conversion = await getUsdToGbpRate()
      conversionRate = conversion.rate
      conversionSource = conversion.source
      totalCostGbp = cost.total * conversion.rate
      costBucketsGbp = cost.buckets.map((bucket) => ({ ...bucket, value: bucket.value * conversion.rate }))
    } catch (error) {
      conversionError = responseErrorMessage(error, 'GBP conversion failed.')
    }
  } else {
    conversionError = `No GBP conversion is configured for ${nativeCurrency.toUpperCase()}`
  }

  const mixedCurrencyWarning = mixedCurrencyUsageWarning(cost.ignoredCurrencyCount, cost.ignoredCurrencies)
  conversionError = [conversionError, mixedCurrencyWarning].filter(Boolean).join(' ') || null

  return {
    periodDays: USAGE_PERIOD_DAYS,
    totalCostGbp,
    currency: 'gbp',
    nativeTotal: cost.total,
    nativeCurrency,
    conversionRate,
    conversionSource,
    conversionError,
    tokenTotals: tokenUsage.totals,
    costBuckets: costBucketsGbp,
    tokenBuckets: tokenUsage.buckets,
  }
}

async function openaiGet(path, key = OPENAI_ADMIN_KEY) {
  if (!key) throw new Error('OPENAI_ADMIN_KEY is not configured')
  const response = await fetch(`https://api.openai.com/v1${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: upstreamSignal(),
  })
  if (!response.ok) {
    const body = await readBoundedResponseText(response)
    throw new Error(`${response.status} ${response.statusText}: ${body.slice(0, 300)}`)
  }
  return readUpstreamJson(response)
}

async function handleCurrentWeather(req, res) {
  try {
    const body = req.method === 'GET' ? null : requireObjectBody(req.body, 'Weather request')
    const location = req.method === 'GET' ? req.query.location : body.location
    const units = req.method === 'GET' ? req.query.units : body.units
    const weather = await getCurrentWeather(location, { units })
    res.json(weather)
  } catch (error) {
    if (error instanceof WeatherServiceError) {
      res.status(error.status).json({ error: responseErrorMessage(error, 'Weather request failed.'), code: error.code })
      return
    }

    sendJsonError(res, error, {
      fallbackStatus: 500,
      fallbackMessage: 'Failed to fetch current weather.',
      fallbackCode: 'weather_request_failed',
    })
  }
}

app.get('/api/status', async (_req, res) => {
  try {
    const openAiApiKey = getOpenAiApiKey()
    const codexApiKey = getCodexApiKey()
    const arduino = await getArduinoCliStatus()
    res.json({
      realtime: Boolean(openAiApiKey),
      openAiKeySource: getOpenAiKeySource(),
      adminApi: Boolean(OPENAI_ADMIN_KEY),
      codexApiKey: Boolean(codexApiKey),
      codexAuthPreference: codexApiKey ? 'api-key' : 'existing-codex-auth',
      codexBin: CODEX_BIN,
      realtimeModel: REALTIME_MODEL,
      realtimeTranscriptionModel: REALTIME_TRANSCRIPTION_MODEL,
      codexModel: CODEX_MODEL,
      codexApprovalPolicy: CODEX_APPROVAL_POLICY,
      codexAppSourceTasksAllowed: CODEX_ALLOW_APP_SOURCE_TASKS,
      visionModel: VISION_MODEL,
      realtimeVoice: REALTIME_VOICE,
      appRoot: REPO_ROOT,
      appName: path.basename(REPO_ROOT),
      desktopServer: {
        pid: process.pid,
        token: DESKTOP_SERVER_TOKEN || null,
      },
      defaultWeatherLocation: REALTIME_USER_LOCATION,
      realtimeUser: {
        name: REALTIME_USER_NAME,
        location: REALTIME_USER_LOCATION,
      },
      arduino,
      usb: usbMonitor.status(),
    })
  } catch (error) {
    sendJsonError(res, error, {
      fallbackStatus: 500,
      fallbackMessage: 'Failed to read application status.',
      fallbackCode: 'status_failed',
    })
  }
})

app.post('/api/realtime/token', async (_req, res) => {
  const openAiApiKey = getOpenAiApiKey()
  if (!openAiApiKey) {
    sendJsonError(
      res,
      httpError('OPENAI_API_KEY is required for live Realtime voice sessions.', {
        statusCode: 503,
        code: 'openai_api_key_required',
      }),
      { fallbackStatus: 503, fallbackCode: 'openai_api_key_required' },
    )
    return
  }

  try {
    res.json(await createRealtimeClientSecret(openAiApiKey))
  } catch (error) {
    sendJsonError(res, error, {
      fallbackStatus: 502,
      fallbackMessage: 'Realtime client secret request failed.',
      fallbackCode: 'realtime_token_failed',
    })
  }
})

app.post('/api/vision/context', async (req, res) => {
  try {
    const body = requireObjectBody(req.body, 'Visual context request')
    const context = await analyzeVisualContext({
      imageDataUrl: body.imageDataUrl,
      source: body.source,
      prompt: body.prompt,
    })
    res.json({
      model: VISION_MODEL,
      summary: context.summary,
      source: context.source,
    })
  } catch (error) {
    sendJsonError(res, error, { fallbackStatus: 502, fallbackMessage: 'Visual context analysis failed.' })
  }
})

app.get('/api/weather/current', handleCurrentWeather)
app.post('/api/weather/current', handleCurrentWeather)

app.get('/api/usb/events', async (req, res) => {
  try {
    const scan = req.query.scan === 'true'
    if (scan) await usbMonitor.scanSerialDevices()
    res.json({
      status: usbMonitor.status(),
      data: usbMonitor.events,
    })
  } catch (error) {
    sendJsonError(res, error, {
      fallbackStatus: 502,
      fallbackMessage: 'Failed to read USB events.',
      fallbackCode: 'usb_events_failed',
    })
  }
})

app.get('/api/arduino/status', async (_req, res) => {
  try {
    const [cli, boards, ports] = await Promise.all([getArduinoCliStatus(), listArduinoBoards(), listSerialPorts()])
    res.json({ cli, boards, ports })
  } catch (error) {
    sendJsonError(res, error, {
      fallbackStatus: 502,
      fallbackMessage: 'Failed to read Arduino status.',
      fallbackCode: 'arduino_status_failed',
    })
  }
})

app.post('/api/arduino/upload', async (req, res) => {
  try {
    res.json(await uploadArduinoSketch(requireObjectBody(req.body, 'Arduino upload request')))
  } catch (error) {
    if (error instanceof ArduinoUploadError) {
      res.status(error.status).json({ error: responseErrorMessage(error, 'Arduino upload failed.'), code: error.code, details: error.details })
      return
    }

    sendJsonError(res, error, {
      fallbackStatus: 500,
      fallbackMessage: 'Arduino upload failed.',
      fallbackCode: 'arduino_upload_failed',
    })
  }
})

app.post('/api/settings/openai-key', async (req, res) => {
  try {
    const body = requireObjectBody(req.body, 'OpenAI key settings request')
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
    if (!apiKey) {
      throw httpError('apiKey is required', { statusCode: 400, code: 'api_key_required' })
    }
    if (!isPlausibleOpenAiApiKey(apiKey)) {
      throw httpError('This does not look like an OpenAI API key.', { statusCode: 400, code: 'invalid_openai_api_key' })
    }

    await createRealtimeClientSecret(apiKey)
    await mutateLocalSecrets((secrets) => ({ ...secrets, openaiApiKey: apiKey }))
    res.json({
      realtime: true,
      openAiKeySource: getOpenAiKeySource(),
    })
  } catch (error) {
    sendJsonError(res, error, { fallbackStatus: 502, fallbackMessage: 'Failed to save OpenAI API key.', fallbackCode: 'openai_key_save_failed' })
  }
})

app.delete('/api/settings/openai-key', async (_req, res) => {
  try {
    await mutateLocalSecrets((secrets) => {
      const { openaiApiKey: _removed, ...nextSecrets } = secrets
      return nextSecrets
    })
    res.json({
      realtime: Boolean(getOpenAiApiKey()),
      openAiKeySource: getOpenAiKeySource(),
    })
  } catch (error) {
    sendJsonError(res, error, { fallbackStatus: 500, fallbackMessage: 'Failed to remove saved OpenAI API key.', fallbackCode: 'openai_key_remove_failed' })
  }
})

app.get('/api/codex/account', async (_req, res) => {
  try {
    await codex.ensure()
    res.json(normalizeCodexMetadataValue(await codex.request('account/read', { refreshToken: false })))
  } catch (error) {
    sendJsonError(res, error, {
      fallbackStatus: 502,
      fallbackMessage: 'Failed to read Codex account.',
      fallbackCode: 'codex_account_failed',
    })
  }
})

app.get('/api/codex/rate-limits', async (_req, res) => {
  try {
    await codex.ensure()
    res.json(normalizeCodexMetadataValue(await codex.request('account/rateLimits/read')))
  } catch (error) {
    sendJsonError(res, error, {
      fallbackStatus: 502,
      fallbackMessage: 'Failed to read Codex rate limits.',
      fallbackCode: 'codex_rate_limits_failed',
    })
  }
})

app.get('/api/codex/models', async (_req, res) => {
  try {
    await codex.ensure()
    res.json(normalizeCodexMetadataValue(await codex.request('model/list', { limit: 40, includeHidden: false })))
  } catch (error) {
    sendJsonError(res, error, {
      fallbackStatus: 502,
      fallbackMessage: 'Failed to list Codex models.',
      fallbackCode: 'codex_models_failed',
    })
  }
})

app.get('/api/codex/apps', async (_req, res) => {
  try {
    await codex.ensure()
    res.json(normalizeCodexMetadataValue(await codex.request('app/list', { limit: 50, forceRefetch: false })))
  } catch (error) {
    sendJsonError(res, error, {
      fallbackStatus: 502,
      fallbackMessage: 'Failed to list Codex apps.',
      fallbackCode: 'codex_apps_failed',
    })
  }
})

app.get('/api/codex/events', async (_req, res) => {
  res.json({ data: codex.notifications })
})

app.get('/api/codex/threads', async (req, res) => {
  try {
    const cwd = await requireWorkspaceDirectory(req.query.cwd, 'cwd')
    const requestedLimit = Number(req.query.limit ?? 40)
    const params = {
      limit: Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.floor(requestedLimit), 1), 100) : 40,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      archived: false,
      cwd,
    }

    await codex.ensure()
    const result = await codex.request('thread/list', params)
    const appState = await readAppState()
    const hiddenThreadIds = new Set(appState.hiddenCodexThreadIdsByWorkspace[cwd] ?? [])
    res.json(normalizeCodexThreadListResponse(filterHiddenCodexThreads(result, hiddenThreadIds)))
  } catch (error) {
    sendJsonError(res, error, { fallbackStatus: 502, fallbackMessage: 'Failed to list Codex threads.' })
  }
})

app.post('/api/codex/thread/archive', async (req, res) => {
  try {
    const body = requireObjectBody(req.body, 'Codex thread archive request')
    const threadId = requireText(body.threadId, 'threadId', { maxLength: 300 })
    await codex.ensure()
    await codex.request('thread/archive', { threadId })
    res.json({ ok: true, thread: { id: normalizeBoundedString(threadId, '', MAX_CONVERSATION_ID_LENGTH) } })
  } catch (error) {
    sendJsonError(res, error, { fallbackStatus: 502, fallbackMessage: 'Failed to archive Codex thread.' })
  }
})

app.post('/api/codex/task', async (req, res) => {
  let threadId = ''
  try {
    const body = requireObjectBody(req.body, 'Codex task request')
    const goal = requireText(body.goal, 'goal')
    const cwd = await requireWorkspaceDirectory(body.cwd, 'cwd')
    await requireAllowedCodexTaskWorkspace(cwd)
    const artifactPlan = await artifactPlanForWorkspace(cwd, goal)
    if (artifactPlan) await mkdir(artifactPlan.absoluteDir, { recursive: true })
    await codex.ensure()
    const threadResult = await codex.request('thread/start', {
      model: CODEX_MODEL,
      cwd,
      sandbox: 'workspace-write',
      approvalPolicy: CODEX_APPROVAL_POLICY,
      serviceName: 'codex_realtime_linux',
    })
    threadId = normalizeCodexEntityId(threadResult.thread, 'thread')
    const turnResult = await codex.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: goalForWorkspace(cwd, goal, artifactPlan) }],
    })
    const turnId = normalizeCodexEntityId(turnResult.turn, 'turn')
    res.json({ thread: { id: threadId }, turn: { id: turnId }, artifact: publicArtifactPlan(artifactPlan) })
  } catch (error) {
    await archiveCodexThreadBestEffort(threadId, 'codex task startup failed')
    sendJsonError(res, error, { fallbackStatus: 502, fallbackMessage: 'Failed to start Codex task.' })
  }
})

app.post('/api/codex/steer', async (req, res) => {
  try {
    const body = requireObjectBody(req.body, 'Codex steer request')
    const threadId = requireText(body.threadId, 'threadId', { maxLength: 300 })
    const instruction = requireText(body.instruction, 'instruction')
    await codex.ensure()
    await codex.request('turn/steer', {
      threadId,
      input: [{ type: 'text', text: instruction }],
    })
    res.json({ ok: true, thread: { id: normalizeBoundedString(threadId, '', MAX_CONVERSATION_ID_LENGTH) } })
  } catch (error) {
    sendJsonError(res, error, { fallbackStatus: 502, fallbackMessage: 'Failed to steer Codex task.' })
  }
})

app.post('/api/codex/interrupt', async (req, res) => {
  try {
    const body = requireObjectBody(req.body, 'Codex interrupt request')
    const threadId = requireText(body.threadId, 'threadId', { maxLength: 300 })
    const turnId = requireText(body.turnId, 'turnId', { maxLength: 300 })
    await codex.ensure()
    await codex.request('turn/interrupt', { threadId, turnId })
    res.json({
      ok: true,
      thread: { id: normalizeBoundedString(threadId, '', MAX_CONVERSATION_ID_LENGTH) },
      turn: { id: normalizeBoundedString(turnId, '', MAX_CONVERSATION_ID_LENGTH) },
    })
  } catch (error) {
    sendJsonError(res, error, { fallbackStatus: 502, fallbackMessage: 'Failed to interrupt Codex task.' })
  }
})

app.get('/api/app-state', async (_req, res) => {
  res.json(await readAppState())
})

app.post('/api/app-state/workspaces', async (req, res) => {
  let body
  let workspaceInput
  try {
    body = requireObjectBody(req.body, 'App-state workspace request')
    workspaceInput = body.workspace == null ? body : requireObjectField(body.workspace, 'workspace')
  } catch (error) {
    sendJsonError(res, error, { fallbackStatus: 400, fallbackCode: 'invalid_request' })
    return
  }
  let workspacePath
  try {
    workspacePath = await requireWorkspaceDirectory(workspaceInput.path || workspaceInput.id, 'workspacePath')
  } catch (error) {
    sendJsonError(res, error, { fallbackStatus: 400, fallbackMessage: 'Invalid workspace path.' })
    return
  }
  const workspace = normalizeWorkspace({ ...workspaceInput, id: workspacePath, path: workspacePath })

  try {
    const { state } = await mutateAppState(async (state) => {
      state.workspaces = [workspace, ...state.workspaces.filter((item) => (item.path ?? item.id) !== workspacePath)]
      state.hiddenWorkspacePaths = state.hiddenWorkspacePaths.filter((item) => item !== workspacePath)
      state.conversationsByWorkspace[workspacePath] = state.conversationsByWorkspace[workspacePath] ?? []
    })
    res.json({ workspace, state })
  } catch (error) {
    sendJsonError(res, error, {
      fallbackStatus: 500,
      fallbackMessage: 'Failed to update saved app state.',
      fallbackCode: 'app_state_write_failed',
    })
  }
})

app.post('/api/app-state/workspaces/delete', async (req, res) => {
  let body
  try {
    body = requireObjectBody(req.body, 'App-state workspace delete request')
  } catch (error) {
    sendJsonError(res, error, { fallbackStatus: 400, fallbackCode: 'invalid_request' })
    return
  }
  const workspacePath = normalizeWorkspacePath(body.workspacePath)
  if (!workspacePath) {
    sendJsonError(
      res,
      httpError('workspacePath must be an absolute local path', {
        statusCode: 400,
        code: 'invalid_workspace_path',
      }),
      { fallbackStatus: 400, fallbackCode: 'invalid_workspace_path' },
    )
    return
  }

  try {
    const { state } = await mutateAppState(async (state) => {
      state.workspaces = state.workspaces.filter((item) => (item.path ?? item.id) !== workspacePath)
      state.hiddenWorkspacePaths = [...new Set([...(state.hiddenWorkspacePaths ?? []), workspacePath])]
      delete state.conversationsByWorkspace[workspacePath]
      delete state.hiddenCodexThreadIdsByWorkspace[workspacePath]
    })
    res.json({ state })
  } catch (error) {
    sendJsonError(res, error, {
      fallbackStatus: 500,
      fallbackMessage: 'Failed to update saved app state.',
      fallbackCode: 'app_state_write_failed',
    })
  }
})

app.post('/api/app-state/codex-threads/hide', async (req, res) => {
  let body
  try {
    body = requireObjectBody(req.body, 'App-state Codex thread hide request')
  } catch (error) {
    sendJsonError(res, error, { fallbackStatus: 400, fallbackCode: 'invalid_request' })
    return
  }

  const threadId = normalizeBoundedString(body.threadId, '', MAX_CONVERSATION_ID_LENGTH)
  if (!threadId) {
    sendJsonError(
      res,
      httpError('threadId is required', {
        statusCode: 400,
        code: 'invalid_request',
      }),
      { fallbackStatus: 400, fallbackCode: 'invalid_request' },
    )
    return
  }

  let workspacePath
  try {
    workspacePath = await requireWorkspaceDirectory(body.workspacePath, 'workspacePath')
  } catch (error) {
    sendJsonError(res, error, { fallbackStatus: 400, fallbackMessage: 'Invalid workspace path.' })
    return
  }

  try {
    const { state } = await mutateAppState(async (state) => {
      const current = state.hiddenCodexThreadIdsByWorkspace[workspacePath] ?? []
      state.hiddenCodexThreadIdsByWorkspace[workspacePath] = [threadId, ...current.filter((item) => item !== threadId)]
        .slice(0, MAX_HIDDEN_CODEX_THREADS_PER_WORKSPACE)
    })
    res.json({ state })
  } catch (error) {
    sendJsonError(res, error, {
      fallbackStatus: 500,
      fallbackMessage: 'Failed to update saved app state.',
      fallbackCode: 'app_state_write_failed',
    })
  }
})

app.post('/api/app-state/conversations', async (req, res) => {
  let body
  let conversationInput
  try {
    body = requireObjectBody(req.body, 'App-state conversation request')
    conversationInput = requireConversationInput(body.conversation)
  } catch (error) {
    sendJsonError(res, error, { fallbackStatus: 400, fallbackCode: 'invalid_request' })
    return
  }
  let workspacePath
  try {
    workspacePath = await requireWorkspaceDirectory(body.workspacePath || conversationInput.workspacePath, 'workspacePath')
  } catch (error) {
    sendJsonError(res, error, { fallbackStatus: 400, fallbackMessage: 'Invalid workspace path.' })
    return
  }

  const conversation = normalizeConversation(conversationInput, workspacePath)
  try {
    const { state } = await mutateAppState(async (state) => {
      const current = state.conversationsByWorkspace[workspacePath] ?? []
      state.conversationsByWorkspace[workspacePath] = [conversation, ...current.filter((item) => item.id !== conversation.id)]
    })
    res.json({ conversation, state })
  } catch (error) {
    sendJsonError(res, error, {
      fallbackStatus: 500,
      fallbackMessage: 'Failed to update saved app state.',
      fallbackCode: 'app_state_write_failed',
    })
  }
})

app.patch('/api/app-state/conversations', async (req, res) => {
  let body
  let patch
  try {
    body = requireObjectBody(req.body, 'App-state conversation patch request')
    patch = body.patch == null ? {} : requireObjectField(body.patch, 'patch')
  } catch (error) {
    sendJsonError(res, error, { fallbackStatus: 400, fallbackCode: 'invalid_request' })
    return
  }
  const conversationId = normalizeString(body.conversationId)
  if (!conversationId) {
    sendJsonError(
      res,
      httpError('conversationId is required', {
        statusCode: 400,
        code: 'invalid_request',
      }),
      { fallbackStatus: 400, fallbackCode: 'invalid_request' },
    )
    return
  }

  let workspacePath
  try {
    workspacePath = await requireWorkspaceDirectory(body.workspacePath, 'workspacePath')
  } catch (error) {
    sendJsonError(res, error, { fallbackStatus: 400, fallbackMessage: 'Invalid workspace path.' })
    return
  }

  let mutation
  try {
    mutation = await mutateAppState(async (state) => {
      const conversations = state.conversationsByWorkspace[workspacePath] ?? []
      const index = conversations.findIndex((conversation) => conversation.id === conversationId)
      if (index === -1) {
        throw httpError('conversationId was not found in this workspace', {
          statusCode: 404,
          code: 'conversation_not_found',
        })
      }

      const next = [...conversations]
      next[index] = normalizeConversation({
        ...conversations[index],
        ...patch,
        id: conversations[index].id,
        workspacePath,
        updatedAt: new Date().toISOString(),
      }, workspacePath)
      state.conversationsByWorkspace[workspacePath] = next
      return next[index]
    })
  } catch (error) {
    sendJsonError(res, error, {
      fallbackStatus: 500,
      fallbackMessage: 'Failed to update saved app state.',
      fallbackCode: 'app_state_write_failed',
    })
    return
  }
  res.json({ conversation: mutation.result, state: mutation.state })
})

app.post('/api/app-state/conversations/delete', async (req, res) => {
  let body
  try {
    body = requireObjectBody(req.body, 'App-state conversation delete request')
  } catch (error) {
    sendJsonError(res, error, { fallbackStatus: 400, fallbackCode: 'invalid_request' })
    return
  }
  const conversationId = normalizeString(body.conversationId)
  if (!conversationId) {
    sendJsonError(
      res,
      httpError('conversationId is required', {
        statusCode: 400,
        code: 'invalid_request',
      }),
      { fallbackStatus: 400, fallbackCode: 'invalid_request' },
    )
    return
  }

  let workspacePath
  try {
    workspacePath = await requireWorkspaceDirectory(body.workspacePath, 'workspacePath')
  } catch (error) {
    sendJsonError(res, error, { fallbackStatus: 400, fallbackMessage: 'Invalid workspace path.' })
    return
  }

  try {
    const { state } = await mutateAppState(async (state) => {
      const conversations = state.conversationsByWorkspace[workspacePath] ?? []
      const index = conversations.findIndex((conversation) => conversation.id === conversationId)
      if (index === -1) {
        throw httpError('conversationId was not found in this workspace', {
          statusCode: 404,
          code: 'conversation_not_found',
        })
      }
      const next = [...conversations.slice(0, index), ...conversations.slice(index + 1)]
      if (next.length > 0) {
        state.conversationsByWorkspace[workspacePath] = next
      } else {
        state.conversationsByWorkspace[workspacePath] = []
      }
    })
    res.json({ state })
  } catch (error) {
    sendJsonError(res, error, {
      fallbackStatus: 500,
      fallbackMessage: 'Failed to update saved app state.',
      fallbackCode: 'app_state_write_failed',
    })
  }
})

app.get('/api/workspaces', async (_req, res) => {
  try {
    const projects = await openaiGet('/organization/projects?limit=20')
    const data = (Array.isArray(projects.data) ? projects.data : [])
      .map(normalizeAdminWorkspace)
      .filter(Boolean)
      .slice(0, MAX_ADMIN_WORKSPACES)
    res.json({ source: 'admin-api', data })
  } catch (error) {
    res.json({
      source: OPENAI_ADMIN_KEY ? 'admin-api-error' : 'missing-admin-key',
      error: responseErrorMessage(error, 'OpenAI admin project data is unavailable.'),
      data: [],
    })
  }
})

app.get('/api/spend', async (_req, res) => {
  const now = Math.floor(Date.now() / 1000)
  const startTime = now - 60 * 60 * 24 * USAGE_PERIOD_DAYS

  try {
    const [costs, completionUsage] = await Promise.all([
      openaiGet(`/organization/costs?start_time=${startTime}&bucket_width=1d&limit=${USAGE_PERIOD_DAYS}&group_by=line_item`),
      openaiGet(`/organization/usage/completions?start_time=${startTime}&bucket_width=1d&limit=${USAGE_PERIOD_DAYS}&group_by=model`),
    ])
    res.json({ source: 'admin-api', data: await normalizeUsage(costs, completionUsage) })
  } catch (error) {
    res.json({
      source: OPENAI_ADMIN_KEY ? 'admin-api-error' : 'missing-admin-key',
      error: responseErrorMessage(error, 'OpenAI usage data is unavailable.'),
      data: {
        periodDays: USAGE_PERIOD_DAYS,
        totalCostGbp: null,
        currency: 'gbp',
        nativeTotal: null,
        nativeCurrency: null,
        conversionRate: null,
        conversionSource: null,
        conversionError: null,
        tokenTotals: { input: 0, output: 0, cached: 0, audioInput: 0, audioOutput: 0, total: 0, requests: 0 },
        costBuckets: [],
        tokenBuckets: [],
      },
    })
  }
})

app.get('/api/artifacts', async (req, res) => {
  try {
    const workspacePath = await requireWorkspaceDirectory(req.query.workspacePath, 'workspacePath')
    res.json({ data: await listGeneratedArtifacts(workspacePath) })
  } catch (error) {
    sendJsonError(res, error, { fallbackStatus: 502, fallbackMessage: 'Failed to list generated artifacts.' })
  }
})

app.use('/workspace-artifacts', (_req, res, next) => {
  setArtifactPreviewHeaders(res)
  next()
})

app.get(/^\/workspace-artifacts\/([^/]+)\/([^/]+)\/(.+)$/, async (req, res) => {
  try {
    const token = req.params[0]
    const artifactName = req.params[1]
    const filePath = req.params[2]
    if (!isSafeArtifactName(artifactName)) {
      res.status(400).send('Invalid artifact name')
      return
    }
    if (!isSafeArtifactPreviewPath(filePath)) {
      res.status(404).send('Not found')
      return
    }
    const contentType = artifactPreviewContentType(filePath)
    if (!contentType) {
      res.status(415).send('Unsupported artifact preview file type')
      return
    }
    const workspacePath = await requireWorkspaceDirectory(workspaceFromToken(token), 'workspace token')
    const artifactsDir = path.join(workspacePath, GENERATED_ARTIFACT_DIR)
    const artifactRoot = path.join(workspacePath, GENERATED_ARTIFACT_DIR, artifactName)
    const artifactIndexPath = path.join(artifactRoot, 'index.html')
    const requestedPath = path.resolve(artifactRoot, filePath)

    if (!isPathInside(artifactRoot, requestedPath)) {
      res.status(403).send('Forbidden')
      return
    }

    let realWorkspacePath
    let realArtifactRoot
    let realArtifactsDir
    let realArtifactIndexPath
    let realRequestedPath
    try {
      const resolvedPaths = await Promise.all([
        realpath(workspacePath),
        realpath(artifactsDir),
        realpath(artifactRoot),
        realpath(artifactIndexPath),
        realpath(requestedPath),
      ])
      realWorkspacePath = resolvedPaths[0]
      realArtifactsDir = resolvedPaths[1]
      realArtifactRoot = resolvedPaths[2]
      realArtifactIndexPath = resolvedPaths[3]
      realRequestedPath = resolvedPaths[4]
    } catch {
      res.status(404).send('Not found')
      return
    }

    if (!isPathInside(realWorkspacePath, realArtifactsDir)) {
      res.status(403).send('Forbidden')
      return
    }
    if (!isPathInside(realArtifactsDir, realArtifactRoot)) {
      res.status(403).send('Forbidden')
      return
    }
    if (!isPathInside(realArtifactRoot, realRequestedPath)) {
      res.status(403).send('Forbidden')
      return
    }
    if (!isPathInside(realArtifactRoot, realArtifactIndexPath)) {
      res.status(403).send('Forbidden')
      return
    }
    let requestedDetails
    let artifactIndexDetails
    try {
      const details = await Promise.all([
        stat(realRequestedPath),
        stat(realArtifactIndexPath),
      ])
      requestedDetails = details[0]
      artifactIndexDetails = details[1]
    } catch (error) {
      if (isIgnorableArtifactEntryError(error)) {
        res.status(404).send('Not found')
        return
      }
      throw error
    }
    if (!requestedDetails.isFile()) {
      res.status(404).send('Not found')
      return
    }
    if (!artifactIndexDetails.isFile()) {
      res.status(404).send('Not found')
      return
    }
    if (requestedDetails.size > MAX_ARTIFACT_PREVIEW_FILE_BYTES) {
      res.status(413).send('Artifact preview file is too large')
      return
    }

    setArtifactPreviewHeaders(res)
    res.set('Content-Type', contentType)
    res.sendFile(realRequestedPath, (error) => {
      if (!error || res.headersSent) return
      res.status(error.statusCode || 404).send('Not found')
    })
  } catch (error) {
    res.status(error.statusCode || 400).send(responseErrorMessage(error, 'Invalid artifact path'))
  }
})

app.use('/workspace-artifacts', (_req, res) => {
  res.status(404).send('Artifact not found')
})

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API route not found.', code: 'api_not_found' })
})

function handleApiError(error, req, res, next) {
  if (!req.path.startsWith('/api/')) {
    next(error)
    return
  }

  if (res.headersSent) {
    next(error)
    return
  }

  const statusCode = error?.statusCode || error?.status || 500
  res.status(statusCode).json({
    error: responseErrorMessage(error, 'API request failed.'),
    code: statusCode >= 500 ? 'api_request_failed' : error?.code || 'api_request_failed',
  })
}

app.use(handleApiError)

app.use(express.static(DIST_DIR, { setHeaders: setAppShellHeaders }))
app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => {
  setAppShellHeaders(res)
  res.sendFile(path.join(DIST_DIR, 'index.html'))
})

await loadLocalSecrets()
usbMonitor.start()

function shutdown(exitCode, reason) {
  usbMonitor.stop()
  codex.dispose(reason)
  process.exit(exitCode)
}

process.once('SIGINT', () => {
  shutdown(130, 'Codex Realtime Linux server received SIGINT.')
})

process.once('SIGTERM', () => {
  shutdown(143, 'Codex Realtime Linux server received SIGTERM.')
})

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Codex Realtime Linux API listening on http://127.0.0.1:${PORT}`)
})
