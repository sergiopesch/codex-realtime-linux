import 'dotenv/config'
import express from 'express'
import { spawn } from 'node:child_process'
import { chmod, mkdir, opendir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
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
const ENV_OPENAI_API_KEY = process.env.OPENAI_API_KEY
const OPENAI_ADMIN_KEY = process.env.OPENAI_ADMIN_KEY ?? process.env.OPENAI_API_ADMIN_KEY
const ENV_CODEX_API_KEY = process.env.CODEX_API_KEY
const CODEX_FORCE_API_KEY_AUTH = process.env.CODEX_FORCE_API_KEY_AUTH === 'true'
const CODEX_BIN = process.env.CODEX_BIN ?? 'codex'
const CODEX_MODEL = process.env.CODEX_MODEL ?? 'gpt-5.4'
const REALTIME_MODEL = process.env.REALTIME_MODEL ?? 'gpt-realtime-2'
const REALTIME_VOICE = process.env.REALTIME_VOICE ?? 'cedar'
const REALTIME_USER_NAME = process.env.REALTIME_USER_NAME ?? os.userInfo().username
const REALTIME_USER_LOCATION = process.env.REALTIME_USER_LOCATION ?? ''
const REALTIME_PERSONA =
  process.env.REALTIME_PERSONA ??
  'Speak naturally, stay technically sharp, keep replies concise, and route concrete work to Codex tools.'
const VISION_MODEL = process.env.VISION_MODEL ?? CODEX_MODEL
const DEFAULT_USAGE_PERIOD_DAYS = 30
const MAX_USAGE_PERIOD_DAYS = 90
const USAGE_PERIOD_DAYS = configuredInteger(process.env.OPENAI_USAGE_PERIOD_DAYS, {
  fallback: DEFAULT_USAGE_PERIOD_DAYS,
  min: 1,
  max: MAX_USAGE_PERIOD_DAYS,
})
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
const DEFAULT_VISUAL_CONTEXT_PROMPT =
  'Focus on UI state, visible errors, design issues, code clues, and what Codex should know before acting.'
const MAX_CONVERSATION_ID_LENGTH = 240
const MAX_CONVERSATION_TITLE_LENGTH = 180
const MAX_CONVERSATION_TEXT_LENGTH = 8_000
const MAX_CONVERSATION_TRACE_LENGTH = 500
const MAX_CONVERSATION_TRACES = 40
const MAX_CONVERSATION_TRANSCRIPT_LINES = 200
const MAX_LOCAL_WORKSPACES = 40
const MAX_LOCAL_HIDDEN_WORKSPACES = 80
const MAX_LOCAL_WORKSPACE_BUCKETS = 40
const MAX_LOCAL_CONVERSATIONS_PER_WORKSPACE = 80
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
const MAX_USAGE_BUCKETS = 20
const MAX_USAGE_BUCKET_LABEL_LENGTH = 120
const MAX_ADMIN_WORKSPACES = 20
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
const MAX_CODEX_RPC_LINE_LENGTH = 120_000
const MAX_ERROR_MESSAGE_LENGTH = 500
const DEFAULT_CODEX_RPC_TIMEOUT_MS = 120_000
const MAX_CODEX_RPC_TIMEOUT_MS = 600_000
const CODEX_RPC_TIMEOUT_MS = configuredInteger(process.env.CODEX_RPC_TIMEOUT_MS, {
  fallback: DEFAULT_CODEX_RPC_TIMEOUT_MS,
  min: 1_000,
  max: MAX_CODEX_RPC_TIMEOUT_MS,
})
const DEFAULT_STATE_PATH = path.join(os.homedir(), '.local', 'state', 'codex-realtime-linux', 'app-state.json')
const DEFAULT_SECRETS_PATH = path.join(os.homedir(), '.config', 'codex-realtime-linux', 'secrets.json')
const STATE_PATH = configuredAbsolutePath(process.env.CODEX_REALTIME_STATE_PATH, DEFAULT_STATE_PATH)
const SECRETS_PATH = configuredAbsolutePath(process.env.CODEX_REALTIME_SECRETS_PATH, DEFAULT_SECRETS_PATH)

let localSecrets = {}

const app = express()
const usbMonitor = new UsbDeviceMonitor()
const ALLOWED_API_ORIGINS = new Set([
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  ...normalizeString(process.env.CODEX_REALTIME_ALLOWED_ORIGINS)
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
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

function configuredAbsolutePath(value, fallback) {
  const candidate = typeof value === 'string' && value.trim() ? value.trim() : fallback
  return path.isAbsolute(candidate) ? path.resolve(candidate) : fallback
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
    localSecrets = JSON.parse(await readFile(SECRETS_PATH, 'utf8'))
  } catch {
    localSecrets = {}
  }
}

async function writeJsonFileAtomic(filePath, value, { dirMode, fileMode } = {}) {
  await mkdir(path.dirname(filePath), { recursive: true, ...(dirMode ? { mode: dirMode } : {}) })
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  )
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, fileMode ? { mode: fileMode } : undefined)
    if (fileMode) await chmod(tempPath, fileMode)
    await rename(tempPath, filePath)
    if (fileMode) await chmod(filePath, fileMode)
  } catch (error) {
    try {
      await rm(tempPath, { force: true })
    } catch {
      // Ignore cleanup errors; the original write failure is more useful.
    }
    throw error
  }
}

async function writeLocalSecrets(nextSecrets) {
  await writeJsonFileAtomic(SECRETS_PATH, nextSecrets, { dirMode: 0o700, fileMode: 0o600 })
  localSecrets = nextSecrets
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
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]+$/.test(token)) {
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
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=(), serial=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
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
    return { error: fallbackMessage }
  }
}

function artifactPlanForWorkspace(cwd, goal) {
  const basePlan = artifactPlanForGoal(goal)
  if (!basePlan) return null

  const workspacePath = path.resolve(cwd)
  const token = workspaceToken(workspacePath)
  return {
    ...basePlan,
    workspacePath,
    absoluteDir: path.join(workspacePath, basePlan.relativeDir),
    absolutePath: path.join(workspacePath, basePlan.relativePath),
    url: `/workspace-artifacts/${token}/${basePlan.directoryName}/index.html`,
  }
}

function goalForWorkspace(cwd, goal, artifactPlan = artifactPlanForWorkspace(cwd, goal)) {
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

async function listGeneratedArtifacts(workspacePath = REPO_ROOT) {
  const resolvedWorkspacePath = path.resolve(workspacePath)
  const artifactsDir = path.join(resolvedWorkspacePath, GENERATED_ARTIFACT_DIR)
  const token = workspaceToken(resolvedWorkspacePath)
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
        const details = await stat(indexPath)
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
        if (error?.code !== 'ENOENT') throw error
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
      `For this app, protect the app source by default. ${buildWorkspaceGuard('create an html file')}`,
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
          model: process.env.REALTIME_TRANSCRIPTION_MODEL ?? 'gpt-4o-mini-transcribe',
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
      'OpenAI-Safety-Identifier': process.env.OPENAI_SAFETY_IDENTIFIER ?? 'local-codex-realtime-user',
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

async function analyzeVisualContext({ imageDataUrl, source, prompt }) {
  const sourceLabel = normalizeBoundedString(source, 'attached image', MAX_VISUAL_CONTEXT_SOURCE_LENGTH)
  const promptText = normalizeBoundedString(prompt, DEFAULT_VISUAL_CONTEXT_PROMPT, MAX_VISUAL_CONTEXT_PROMPT_LENGTH)

  if (typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:image/')) {
    throw httpError('imageDataUrl must be a data:image URL.', {
      statusCode: 400,
      code: 'invalid_visual_context',
    })
  }
  if (Buffer.byteLength(imageDataUrl, 'utf8') > MAX_VISUAL_CONTEXT_DATA_URL_BYTES) {
    throw httpError('Visual context image is too large.', {
      statusCode: 413,
      code: 'visual_context_too_large',
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

  recordNotification(event, limit = MAX_CODEX_NOTIFICATIONS) {
    this.notifications.unshift(normalizeEventRecord(event))
    this.notifications = this.notifications.slice(0, limit)
  }

  async ensure() {
    if (this.ready) return
    if (this.initPromise) return this.initPromise

    this.initPromise = this.#initialize().catch((error) => {
      if (this.proc && !this.proc.killed) this.proc.kill()
      this.#resetProcessState(error)
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
      const message = chunk.toString().trim()
      if (message) {
        this.recordNotification({
          method: 'app-server/stderr',
          params: { message, at: new Date().toISOString() },
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

  #resetProcessState(error) {
    this.ready = false
    this.initPromise = null
    this.proc = null
    this.rl?.close()
    this.rl = null
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
      return
    }

    if (message.id != null && this.pending.has(message.id)) {
      const { resolve, reject, timeout } = this.pending.get(message.id)
      clearTimeout(timeout)
      this.pending.delete(message.id)
      if (message.error) reject(new Error(message.error.message ?? 'Codex app-server request failed'))
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
        this.pending.delete(id)
        reject(new Error(`codex app-server request timed out: ${method}`))
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
    this.proc.stdin.write(`${JSON.stringify({ method, params })}\n`)
  }

  dispose(reason = 'codex app-server stopped.') {
    const proc = this.proc
    if (proc && !proc.killed) proc.kill()
    this.#resetProcessState(new Error(reason))
  }
}

const codex = new CodexRpc()
let appStateMutation = Promise.resolve()

const emptyAppState = () => ({
  version: 1,
  workspaces: [],
  conversationsByWorkspace: {},
  hiddenWorkspacePaths: [],
})

function normalizeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function normalizeBoundedString(value, fallback = '', maxLength = 1_000) {
  const text = normalizeString(value, fallback).replace(/\s+/g, ' ')
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`
}

function normalizeWorkspacePath(value) {
  const workspacePath = normalizeString(value)
  return workspacePath && path.isAbsolute(workspacePath) ? path.resolve(workspacePath) : ''
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

function isEmptyGeneratedVoiceDraft(conversation) {
  return (
    conversation.source === 'local' &&
    conversation.status === 'draft' &&
    !conversation.codexThreadId &&
    /^Voice conversation \d+$/i.test(conversation.title) &&
    !conversation.prompt &&
    !conversation.response &&
    conversation.traces.length === 0 &&
    conversation.transcript.length === 0
  )
}

function normalizeConversation(input, workspacePath) {
  const title = normalizeBoundedString(input?.title, 'Untitled conversation', MAX_CONVERSATION_TITLE_LENGTH)
  const id = normalizeBoundedString(
    input?.id,
    `${workspacePath}::${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    MAX_CONVERSATION_ID_LENGTH,
  )
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
    createdAt: typeof input?.createdAt === 'string' ? input.createdAt : new Date().toISOString(),
    updatedAt: typeof input?.updatedAt === 'string' ? input.updatedAt : new Date().toISOString(),
  })
}

function normalizeAppState(input) {
  const state = emptyAppState()
  state.workspaces = Array.isArray(input?.workspaces)
    ? input.workspaces.map(normalizeWorkspace).filter(Boolean).slice(0, MAX_LOCAL_WORKSPACES)
    : []
  state.hiddenWorkspacePaths = Array.isArray(input?.hiddenWorkspacePaths)
    ? input.hiddenWorkspacePaths.map(normalizeWorkspacePath).filter(Boolean).slice(0, MAX_LOCAL_HIDDEN_WORKSPACES)
    : []

  if (input?.conversationsByWorkspace && typeof input.conversationsByWorkspace === 'object') {
    for (const [workspacePath, conversations] of Object.entries(input.conversationsByWorkspace).slice(0, MAX_LOCAL_WORKSPACE_BUCKETS)) {
      const normalizedWorkspacePath = normalizeWorkspacePath(workspacePath)
      if (!normalizedWorkspacePath) continue
      if (Array.isArray(conversations)) {
        const normalizedConversations = conversations
          .map((conversation) => normalizeConversation(conversation, normalizedWorkspacePath))
          .filter((conversation) => !isEmptyGeneratedVoiceDraft(conversation))
          .slice(0, MAX_LOCAL_CONVERSATIONS_PER_WORKSPACE)
        if (normalizedConversations.length > 0) {
          state.conversationsByWorkspace[normalizedWorkspacePath] = normalizedConversations
        }
      }
    }
  }

  return state
}

async function readAppState() {
  try {
    const details = await stat(STATE_PATH)
    if (details.size > MAX_APP_STATE_FILE_BYTES) throw new Error('Saved app state file is too large.')
    return normalizeAppState(JSON.parse(await readFile(STATE_PATH, 'utf8')))
  } catch (error) {
    if (error.code !== 'ENOENT') {
      codex.recordNotification({
        method: 'app-state/read-error',
        receivedAt: new Date().toISOString(),
        params: { message: error.message },
      })
    }
    return emptyAppState()
  }
}

async function writeAppState(state) {
  const normalizedState = normalizeAppState(state)
  await writeJsonFileAtomic(STATE_PATH, normalizedState, { fileMode: 0o600 })
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

function threadToConversation(thread) {
  const fallbackPreview = 'Resume this Codex conversation.'
  const preview = normalizeBoundedString(thread?.preview, fallbackPreview, MAX_CONVERSATION_TEXT_LENGTH)
  const title = normalizeBoundedString(
    thread?.name,
    normalizeBoundedString(thread?.preview, 'Codex conversation', MAX_CONVERSATION_TITLE_LENGTH),
    MAX_CONVERSATION_TITLE_LENGTH,
  )
  const updatedAt = typeof thread?.updatedAt === 'number' ? new Date(thread.updatedAt * 1000).toISOString() : new Date().toISOString()
  const status = thread?.status?.type === 'active' ? 'running' : 'ready'
  const statusType = normalizeBoundedString(thread?.status?.type, 'ready', 40)
  const threadId = normalizeBoundedString(thread?.id, `codex-${updatedAt}`, MAX_CONVERSATION_ID_LENGTH)
  const workspacePath = normalizeBoundedString(normalizeWorkspacePath(thread?.cwd), '', MAX_CONVERSATION_TEXT_LENGTH)

  return {
    id: threadId,
    title: title.length > 54 ? `${title.slice(0, 51)}...` : title,
    age: 'codex',
    status,
    prompt: preview,
    response: 'Persisted Codex app-server conversation. Build or voice controls can continue work from this workspace context.',
    traces: normalizeStringList(
      ['Loaded from Codex app-server', workspacePath ? `Workspace: ${workspacePath}` : 'Workspace: unavailable', `Status: ${statusType}`],
      MAX_CONVERSATION_TRACES,
      MAX_CONVERSATION_TRACE_LENGTH,
    ),
    transcript: [
      { speaker: 'user', text: preview },
      { speaker: 'codex', text: 'This thread is available from Codex app-server history.' },
    ],
    workspacePath,
    source: 'codex',
    codexThreadId: threadId,
    createdAt: updatedAt,
    updatedAt,
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

function finiteNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
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

function normalizeCosts(costs) {
  const buckets = Array.isArray(costs?.data) ? costs.data : []
  const totalsByLabel = new Map()
  let currency = 'usd'

  for (const bucket of buckets) {
    const results = Array.isArray(bucket?.results) ? bucket.results : []
    for (const result of results) {
      const label = normalizeBoundedString(
        result.line_item ?? result.object ?? result.model,
        'OpenAI usage',
        MAX_USAGE_BUCKET_LABEL_LENGTH,
      )
      if (typeof result.amount?.currency === 'string') currency = result.amount.currency
      const amount =
        result.amount?.value ??
        result.amount?.amount ??
        result.cost?.value ??
        result.cost ??
        0
      totalsByLabel.set(label, (totalsByLabel.get(label) ?? 0) + finiteNumber(amount))
    }
  }

  const total = [...totalsByLabel.values()].reduce(
    (sum, value) => (Number.isFinite(value) && value > 0 ? sum + value : sum),
    0,
  )

  return {
    total,
    currency,
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
      const input = finiteNumber(result.input_tokens)
      const output = finiteNumber(result.output_tokens)
      const cached = finiteNumber(result.input_cached_tokens)
      const audioInput = finiteNumber(result.input_audio_tokens)
      const audioOutput = finiteNumber(result.output_audio_tokens)
      const total = input + output
      const label = normalizeBoundedString(result.model ?? result.object, 'Completions', MAX_USAGE_BUCKET_LABEL_LENGTH)

      totals.input += input
      totals.output += output
      totals.cached += cached
      totals.audioInput += audioInput
      totals.audioOutput += audioOutput
      totals.total += total
      totals.requests += finiteNumber(result.num_model_requests)
      totalsByLabel.set(label, (totalsByLabel.get(label) ?? 0) + total)
    }
  }

  return {
    totals,
    buckets: topUsageBuckets(totalsByLabel),
  }
}

async function getUsdToGbpRate() {
  const configuredRate = Number(process.env.OPENAI_USAGE_GBP_RATE)
  if (Number.isFinite(configuredRate) && configuredRate > 0) {
    return { rate: configuredRate, source: 'env' }
  }

  const response = await fetch(GBP_RATE_API, { signal: upstreamSignal() })
  if (!response.ok) throw new Error(`GBP conversion failed with ${response.status}`)
  const data = await readUpstreamJson(response, 'GBP conversion response was not JSON.')
  const rate = Number(data?.rates?.GBP)
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('GBP conversion response did not include a USD to GBP rate')
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
  const location = req.method === 'GET' ? req.query.location : req.body?.location
  const units = req.method === 'GET' ? req.query.units : req.body?.units

  try {
    const weather = await getCurrentWeather(location, { units })
    res.json(weather)
  } catch (error) {
    if (error instanceof WeatherServiceError) {
      res.status(error.status).json({ error: responseErrorMessage(error, 'Weather request failed.'), code: error.code })
      return
    }

    res.status(500).json({
      error: responseErrorMessage(error, 'Failed to fetch current weather.'),
      code: 'weather_request_failed',
    })
  }
}

app.get('/api/status', async (_req, res) => {
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
    codexModel: CODEX_MODEL,
    visionModel: VISION_MODEL,
    realtimeVoice: REALTIME_VOICE,
    appRoot: REPO_ROOT,
    appName: path.basename(REPO_ROOT),
    defaultWeatherLocation: REALTIME_USER_LOCATION,
    realtimeUser: {
      name: REALTIME_USER_NAME,
      location: REALTIME_USER_LOCATION,
    },
    arduino,
    usb: usbMonitor.status(),
  })
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
    const context = await analyzeVisualContext({
      imageDataUrl: req.body?.imageDataUrl,
      source: req.body?.source,
      prompt: req.body?.prompt,
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
    res.json(await uploadArduinoSketch(req.body ?? {}))
  } catch (error) {
    if (error instanceof ArduinoUploadError) {
      res.status(error.status).json({ error: responseErrorMessage(error, 'Arduino upload failed.'), code: error.code, details: error.details })
      return
    }

    res.status(500).json({
      error: responseErrorMessage(error, 'Arduino upload failed.'),
      code: 'arduino_upload_failed',
    })
  }
})

app.post('/api/settings/openai-key', async (req, res) => {
  try {
    const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : ''
    if (!apiKey) {
      throw httpError('apiKey is required', { statusCode: 400, code: 'api_key_required' })
    }
    if (!apiKey.startsWith('sk-')) {
      throw httpError('This does not look like an OpenAI API key.', { statusCode: 400, code: 'invalid_openai_api_key' })
    }

    await createRealtimeClientSecret(apiKey)
    await writeLocalSecrets({ ...localSecrets, openaiApiKey: apiKey })
    res.json({
      realtime: true,
      openAiKeySource: getOpenAiKeySource(),
      secretsPath: SECRETS_PATH,
    })
  } catch (error) {
    sendJsonError(res, error, { fallbackStatus: 502, fallbackMessage: 'Failed to save OpenAI API key.', fallbackCode: 'openai_key_save_failed' })
  }
})

app.delete('/api/settings/openai-key', async (_req, res) => {
  try {
    const { openaiApiKey: _removed, ...nextSecrets } = localSecrets
    await writeLocalSecrets(nextSecrets)
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
    await codex.ensure()
    const requestedLimit = Number(req.query.limit ?? 40)
    const params = {
      limit: Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.floor(requestedLimit), 1), 100) : 40,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      archived: false,
    }
    if (typeof req.query.cwd === 'string' && req.query.cwd) params.cwd = await requireWorkspaceDirectory(req.query.cwd, 'cwd')

    const result = await codex.request('thread/list', params)
    res.json({
      ...result,
      conversations: (result.data ?? []).map(threadToConversation),
    })
  } catch (error) {
    sendJsonError(res, error, { fallbackStatus: 502, fallbackMessage: 'Failed to list Codex threads.' })
  }
})

app.post('/api/codex/thread/archive', async (req, res) => {
  try {
    const threadId = requireText(req.body?.threadId, 'threadId', { maxLength: 300 })
    await codex.ensure()
    await codex.request('thread/archive', { threadId })
    res.json({ ok: true, thread: { id: normalizeBoundedString(threadId, '', MAX_CONVERSATION_ID_LENGTH) } })
  } catch (error) {
    sendJsonError(res, error, { fallbackStatus: 502, fallbackMessage: 'Failed to archive Codex thread.' })
  }
})

app.post('/api/codex/task', async (req, res) => {
  try {
    const goal = requireText(req.body?.goal, 'goal')
    const cwd = await requireWorkspaceDirectory(req.body?.cwd, 'cwd')
    const artifactPlan = artifactPlanForWorkspace(cwd, goal)
    if (artifactPlan) await mkdir(artifactPlan.absoluteDir, { recursive: true })
    await codex.ensure()
    const threadResult = await codex.request('thread/start', {
      model: CODEX_MODEL,
      cwd,
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      serviceName: 'codex_realtime_linux',
    })
    const threadId = normalizeCodexEntityId(threadResult.thread, 'thread')
    const turnResult = await codex.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: goalForWorkspace(cwd, goal, artifactPlan) }],
    })
    const turnId = normalizeCodexEntityId(turnResult.turn, 'turn')
    res.json({ thread: { id: threadId }, turn: { id: turnId }, artifact: artifactPlan })
  } catch (error) {
    sendJsonError(res, error, { fallbackStatus: 502, fallbackMessage: 'Failed to start Codex task.' })
  }
})

app.post('/api/codex/steer', async (req, res) => {
  try {
    const threadId = requireText(req.body?.threadId, 'threadId', { maxLength: 300 })
    const instruction = requireText(req.body?.instruction, 'instruction')
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
    const threadId = requireText(req.body?.threadId, 'threadId', { maxLength: 300 })
    const turnId = requireText(req.body?.turnId, 'turnId', { maxLength: 300 })
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
  let workspacePath
  try {
    workspacePath = await requireWorkspaceDirectory((req.body.workspace ?? req.body)?.path || (req.body.workspace ?? req.body)?.id, 'workspacePath')
  } catch (error) {
    sendJsonError(res, error, { fallbackStatus: 400, fallbackMessage: 'Invalid workspace path.' })
    return
  }
  const workspace = normalizeWorkspace({ ...(req.body.workspace ?? req.body), id: workspacePath, path: workspacePath })

  const { state } = await mutateAppState(async (state) => {
    state.workspaces = [workspace, ...state.workspaces.filter((item) => (item.path ?? item.id) !== workspacePath)]
    state.hiddenWorkspacePaths = state.hiddenWorkspacePaths.filter((item) => item !== workspacePath)
    state.conversationsByWorkspace[workspacePath] = state.conversationsByWorkspace[workspacePath] ?? []
  })
  res.json({ workspace, state })
})

app.post('/api/app-state/workspaces/delete', async (req, res) => {
  const workspacePath = normalizeWorkspacePath(req.body.workspacePath)
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

  const { state } = await mutateAppState(async (state) => {
    state.workspaces = state.workspaces.filter((item) => (item.path ?? item.id) !== workspacePath)
    state.hiddenWorkspacePaths = [...new Set([...(state.hiddenWorkspacePaths ?? []), workspacePath])]
  })
  res.json({ state })
})

app.post('/api/app-state/conversations', async (req, res) => {
  let workspacePath
  try {
    workspacePath = await requireWorkspaceDirectory(req.body.workspacePath || req.body.conversation?.workspacePath, 'workspacePath')
  } catch (error) {
    sendJsonError(res, error, { fallbackStatus: 400, fallbackMessage: 'Invalid workspace path.' })
    return
  }

  const conversation = normalizeConversation(req.body.conversation, workspacePath)
  const { state } = await mutateAppState(async (state) => {
    const current = state.conversationsByWorkspace[workspacePath] ?? []
    state.conversationsByWorkspace[workspacePath] = [conversation, ...current.filter((item) => item.id !== conversation.id)]
  })
  res.json({ conversation, state })
})

app.patch('/api/app-state/conversations', async (req, res) => {
  const conversationId = normalizeString(req.body.conversationId)
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
    workspacePath = await requireWorkspaceDirectory(req.body.workspacePath, 'workspacePath')
  } catch (error) {
    sendJsonError(res, error, { fallbackStatus: 400, fallbackMessage: 'Invalid workspace path.' })
    return
  }

  const { state, result } = await mutateAppState(async (state) => {
    const conversations = state.conversationsByWorkspace[workspacePath] ?? []
    const next = conversations.map((conversation) =>
      conversation.id === conversationId
        ? normalizeConversation({ ...conversation, ...req.body.patch, updatedAt: new Date().toISOString() }, workspacePath)
        : conversation,
    )
    state.conversationsByWorkspace[workspacePath] = next
    return next.find((conversation) => conversation.id === conversationId) ?? null
  })
  res.json({ conversation: result, state })
})

app.post('/api/app-state/conversations/delete', async (req, res) => {
  const workspacePath = normalizeWorkspacePath(req.body.workspacePath)
  const conversationId = normalizeString(req.body.conversationId)
  if (!workspacePath || !conversationId) {
    sendJsonError(
      res,
      httpError('absolute workspacePath and conversationId are required', {
        statusCode: 400,
        code: 'invalid_request',
      }),
      { fallbackStatus: 400, fallbackCode: 'invalid_request' },
    )
    return
  }

  const { state } = await mutateAppState(async (state) => {
    state.conversationsByWorkspace[workspacePath] = (state.conversationsByWorkspace[workspacePath] ?? []).filter(
      (conversation) => conversation.id !== conversationId,
    )
  })
  res.json({ state })
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

app.get(/^\/workspace-artifacts\/([^/]+)\/([^/]+)\/(.+)$/, async (req, res) => {
  try {
    const token = req.params[0]
    const artifactName = req.params[1]
    const filePath = req.params[2]
    if (!isSafeArtifactName(artifactName)) {
      res.status(400).send('Invalid artifact name')
      return
    }
    const workspacePath = await requireWorkspaceDirectory(workspaceFromToken(token), 'workspace token')
    const artifactRoot = path.join(workspacePath, GENERATED_ARTIFACT_DIR, artifactName)
    const requestedPath = path.resolve(artifactRoot, filePath)

    if (!isPathInside(artifactRoot, requestedPath)) {
      res.status(403).send('Forbidden')
      return
    }

    let realArtifactRoot
    let realRequestedPath
    try {
      const resolvedPaths = await Promise.all([realpath(artifactRoot), realpath(requestedPath)])
      realArtifactRoot = resolvedPaths[0]
      realRequestedPath = resolvedPaths[1]
    } catch {
      res.status(404).send('Not found')
      return
    }

    if (!isPathInside(realArtifactRoot, realRequestedPath)) {
      res.status(403).send('Forbidden')
      return
    }

    setArtifactPreviewHeaders(res)
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

app.use(express.static(DIST_DIR))
app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => {
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
