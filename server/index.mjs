import 'dotenv/config'
import express from 'express'
import { spawn } from 'node:child_process'
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
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
const PORT = Number(process.env.PORT ?? 3311)
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
const USAGE_PERIOD_DAYS = Number(process.env.OPENAI_USAGE_PERIOD_DAYS ?? 30)
const GBP_RATE_API = process.env.OPENAI_USAGE_GBP_RATE_API ?? 'https://api.frankfurter.app/latest?from=USD&to=GBP'
const CONFIGURED_UPSTREAM_FETCH_TIMEOUT_MS = Number(process.env.UPSTREAM_FETCH_TIMEOUT_MS)
const UPSTREAM_FETCH_TIMEOUT_MS =
  Number.isFinite(CONFIGURED_UPSTREAM_FETCH_TIMEOUT_MS) && CONFIGURED_UPSTREAM_FETCH_TIMEOUT_MS > 0
    ? CONFIGURED_UPSTREAM_FETCH_TIMEOUT_MS
    : 20_000
const JSON_BODY_LIMIT = process.env.CODEX_REALTIME_JSON_LIMIT ?? '25mb'
const CONFIGURED_CODEX_RPC_TIMEOUT_MS = Number(process.env.CODEX_RPC_TIMEOUT_MS)
const CODEX_RPC_TIMEOUT_MS =
  Number.isFinite(CONFIGURED_CODEX_RPC_TIMEOUT_MS) && CONFIGURED_CODEX_RPC_TIMEOUT_MS > 0
    ? CONFIGURED_CODEX_RPC_TIMEOUT_MS
    : 120_000
const STATE_PATH =
  process.env.CODEX_REALTIME_STATE_PATH ??
  path.join(os.homedir(), '.local', 'state', 'codex-realtime-linux', 'app-state.json')
const SECRETS_PATH =
  process.env.CODEX_REALTIME_SECRETS_PATH ??
  path.join(os.homedir(), '.config', 'codex-realtime-linux', 'secrets.json')

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
  return Buffer.from(token, 'base64url').toString('utf8')
}

function isPathInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

function isSafeArtifactName(value) {
  return /^[a-z0-9][a-z0-9-]*$/i.test(value)
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
    error: error instanceof Error ? error.message : fallbackMessage,
    ...(code ? { code } : {}),
  })
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
  let entries
  try {
    entries = await readdir(artifactsDir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }

  const artifacts = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!isSafeArtifactName(entry.name)) continue
    const indexPath = path.join(artifactsDir, entry.name, 'index.html')
    try {
      const details = await stat(indexPath)
      artifacts.push({
        id: entry.name,
        title: entry.name.replace(/^\d{8}t?\d{6}-?/i, '').replace(/-/g, ' ') || entry.name,
        url: `/workspace-artifacts/${token}/${entry.name}/index.html`,
        relativePath: `${GENERATED_ARTIFACT_DIR}/${entry.name}/index.html`,
        workspacePath: resolvedWorkspacePath,
        updatedAt: details.mtime.toISOString(),
        size: details.size,
      })
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }

  return artifacts.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
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
              description: 'The concrete engineering objective Codex should execute. Include relevant constraints from the conversation.',
            },
            cwd: {
              type: 'string',
              description: 'Absolute local workspace path. Omit this to use the currently selected workspace.',
            },
            title: {
              type: 'string',
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
              description: 'Serial port such as /dev/ttyACM0 or /dev/ttyUSB0. Omit to use the first detected Arduino serial port.',
            },
            fqbn: {
              type: 'string',
              description: 'Arduino fully-qualified board name, such as arduino:avr:uno. Omit for the default Uno-compatible board.',
            },
            sketch: {
              type: 'string',
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

  const data = await response.json().catch(() => ({ error: 'Realtime token response was not JSON.' }))
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

async function analyzeVisualContext({ imageDataUrl, source, prompt }) {
  const openAiApiKey = getOpenAiApiKey()
  if (!openAiApiKey) {
    throw httpError('OPENAI_API_KEY is required for visual context analysis.', {
      statusCode: 503,
      code: 'openai_key_missing',
    })
  }
  if (typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:image/')) {
    throw httpError('imageDataUrl must be a data:image URL.', {
      statusCode: 400,
      code: 'invalid_visual_context',
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
                `Source: ${source || 'attached image'}.`,
                prompt || 'Focus on UI state, visible errors, design issues, code clues, and what Codex should know before acting.',
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

  const data = await response.json().catch(() => ({ error: 'Vision response was not JSON.' }))
  if (!response.ok) {
    const message =
      typeof data?.error === 'string'
        ? data.error
        : typeof data?.error?.message === 'string'
          ? data.error.message
          : `Visual context analysis failed with ${response.status}`
    throw new Error(message)
  }

  return extractResponseText(data) || 'Visual context was attached, but no summary was returned.'
}

class CodexRpc {
  proc = null
  rl = null
  nextId = 1
  ready = false
  initPromise = null
  pending = new Map()
  notifications = []

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
        this.notifications.unshift({
          method: 'app-server/stderr',
          params: { message, at: new Date().toISOString() },
        })
        this.notifications = this.notifications.slice(0, 80)
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

    this.notifications.unshift({ ...message, receivedAt: new Date().toISOString() })
    this.notifications = this.notifications.slice(0, 160)
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
    name: normalizeString(input?.name, path.basename(pathValue) || pathValue),
    path: pathValue,
    status: normalizeString(input?.status, 'local'),
  }
}

function normalizeConversation(input, workspacePath) {
  const title = normalizeString(input?.title, 'Untitled conversation')
  const id = normalizeString(input?.id, `${workspacePath}::${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`)
  const status = ['draft', 'ready', 'running'].includes(input?.status) ? input.status : 'draft'

  return {
    id,
    title,
    age: normalizeString(input?.age, 'saved'),
    status,
    prompt: normalizeString(input?.prompt),
    response: normalizeString(input?.response),
    traces: Array.isArray(input?.traces) ? input.traces.filter((item) => typeof item === 'string') : [],
    transcript: Array.isArray(input?.transcript)
      ? input.transcript.filter((line) => line?.speaker === 'user' || line?.speaker === 'codex')
      : [],
    source: normalizeString(input?.source, 'local'),
    codexThreadId: typeof input?.codexThreadId === 'string' ? input.codexThreadId : null,
    createdAt: typeof input?.createdAt === 'string' ? input.createdAt : new Date().toISOString(),
    updatedAt: typeof input?.updatedAt === 'string' ? input.updatedAt : new Date().toISOString(),
  }
}

function normalizeAppState(input) {
  const state = emptyAppState()
  state.workspaces = Array.isArray(input?.workspaces) ? input.workspaces.map(normalizeWorkspace).filter(Boolean) : []
  state.hiddenWorkspacePaths = Array.isArray(input?.hiddenWorkspacePaths)
    ? input.hiddenWorkspacePaths.map(normalizeWorkspacePath).filter(Boolean)
    : []

  if (input?.conversationsByWorkspace && typeof input.conversationsByWorkspace === 'object') {
    for (const [workspacePath, conversations] of Object.entries(input.conversationsByWorkspace)) {
      const normalizedWorkspacePath = normalizeWorkspacePath(workspacePath)
      if (!normalizedWorkspacePath) continue
      if (Array.isArray(conversations)) {
        state.conversationsByWorkspace[normalizedWorkspacePath] = conversations.map((conversation) =>
          normalizeConversation(conversation, normalizedWorkspacePath),
        )
      }
    }
  }

  return state
}

async function readAppState() {
  try {
    return normalizeAppState(JSON.parse(await readFile(STATE_PATH, 'utf8')))
  } catch (error) {
    if (error.code !== 'ENOENT') {
      codex.notifications.unshift({
        method: 'app-state/read-error',
        receivedAt: new Date().toISOString(),
        params: { message: error.message },
      })
    }
    return emptyAppState()
  }
}

async function writeAppState(state) {
  await writeJsonFileAtomic(STATE_PATH, normalizeAppState(state), { fileMode: 0o600 })
}

async function mutateAppState(updater) {
  const mutation = appStateMutation.then(async () => {
    const state = await readAppState()
    const result = await updater(state)
    await writeAppState(state)
    return { state, result }
  })
  appStateMutation = mutation.catch(() => {})
  return mutation
}

function threadToConversation(thread) {
  const title = normalizeString(thread?.name, normalizeString(thread?.preview, 'Codex conversation'))
  const updatedAt = typeof thread?.updatedAt === 'number' ? new Date(thread.updatedAt * 1000).toISOString() : new Date().toISOString()
  const status = thread?.status?.type === 'active' ? 'running' : 'ready'

  return {
    id: thread.id,
    title: title.length > 54 ? `${title.slice(0, 51)}...` : title,
    age: 'codex',
    status,
    prompt: normalizeString(thread?.preview, 'Resume this Codex conversation.'),
    response: 'Persisted Codex app-server conversation. Build or voice controls can continue work from this workspace context.',
    traces: ['Loaded from Codex app-server', `Workspace: ${thread.cwd}`, `Status: ${thread?.status?.type ?? 'ready'}`],
    transcript: [
      { speaker: 'user', text: normalizeString(thread?.preview, 'Resume this Codex conversation.') },
      { speaker: 'codex', text: 'This thread is available from Codex app-server history.' },
    ],
    workspacePath: thread.cwd,
    source: 'codex',
    codexThreadId: thread.id,
    createdAt: updatedAt,
    updatedAt,
  }
}

function normalizeCosts(costs) {
  const buckets = Array.isArray(costs?.data) ? costs.data : []
  const totalsByLabel = new Map()
  let currency = 'usd'

  for (const bucket of buckets) {
    const results = Array.isArray(bucket?.results) ? bucket.results : []
    for (const result of results) {
      const label = result.line_item ?? result.object ?? result.model ?? 'OpenAI usage'
      if (typeof result.amount?.currency === 'string') currency = result.amount.currency
      const amount =
        result.amount?.value ??
        result.amount?.amount ??
        result.cost?.value ??
        result.cost ??
        0
      totalsByLabel.set(label, (totalsByLabel.get(label) ?? 0) + Number(amount))
    }
  }

  const normalizedBuckets = [...totalsByLabel.entries()].map(([label, value]) => ({ label, value }))
  const total = normalizedBuckets.reduce((sum, bucket) => sum + bucket.value, 0)

  return {
    total,
    currency,
    buckets: normalizedBuckets,
    raw: costs,
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
      const input = Number(result.input_tokens ?? 0)
      const output = Number(result.output_tokens ?? 0)
      const cached = Number(result.input_cached_tokens ?? 0)
      const audioInput = Number(result.input_audio_tokens ?? 0)
      const audioOutput = Number(result.output_audio_tokens ?? 0)
      const total = input + output
      const label = result.model ?? result.object ?? 'Completions'

      totals.input += input
      totals.output += output
      totals.cached += cached
      totals.audioInput += audioInput
      totals.audioOutput += audioOutput
      totals.total += total
      totals.requests += Number(result.num_model_requests ?? 0)
      totalsByLabel.set(label, (totalsByLabel.get(label) ?? 0) + total)
    }
  }

  return {
    totals,
    buckets: [...totalsByLabel.entries()].map(([label, value]) => ({ label, value })),
    raw: usage,
  }
}

async function getUsdToGbpRate() {
  const configuredRate = Number(process.env.OPENAI_USAGE_GBP_RATE)
  if (Number.isFinite(configuredRate) && configuredRate > 0) {
    return { rate: configuredRate, source: 'env' }
  }

  const response = await fetch(GBP_RATE_API, { signal: upstreamSignal() })
  if (!response.ok) throw new Error(`GBP conversion failed with ${response.status}`)
  const data = await response.json()
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
      conversionError = error.message
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
    raw: {
      costs: cost.raw,
      completions: tokenUsage.raw,
    },
  }
}

async function openaiGet(path, key = OPENAI_ADMIN_KEY) {
  if (!key) throw new Error('OPENAI_ADMIN_KEY is not configured')
  const response = await fetch(`https://api.openai.com/v1${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: upstreamSignal(),
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`${response.status} ${response.statusText}: ${body.slice(0, 300)}`)
  }
  return response.json()
}

async function handleCurrentWeather(req, res) {
  const location = req.method === 'GET' ? req.query.location : req.body?.location
  const units = req.method === 'GET' ? req.query.units : req.body?.units

  try {
    const weather = await getCurrentWeather(location, { units })
    res.json(weather)
  } catch (error) {
    if (error instanceof WeatherServiceError) {
      res.status(error.status).json({ error: error.message, code: error.code })
      return
    }

    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to fetch current weather.',
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
    res.status(503).json({ error: 'OPENAI_API_KEY is required for live Realtime voice sessions.' })
    return
  }

  try {
    res.json(await createRealtimeClientSecret(openAiApiKey))
  } catch (error) {
    res.status(502).json({ error: error.message })
  }
})

app.post('/api/vision/context', async (req, res) => {
  try {
    const summary = await analyzeVisualContext({
      imageDataUrl: req.body?.imageDataUrl,
      source: req.body?.source,
      prompt: req.body?.prompt,
    })
    res.json({
      model: VISION_MODEL,
      summary,
      source: req.body?.source ?? 'visual context',
    })
  } catch (error) {
    sendJsonError(res, error, { fallbackStatus: 502, fallbackMessage: 'Visual context analysis failed.' })
  }
})

app.get('/api/weather/current', handleCurrentWeather)
app.post('/api/weather/current', handleCurrentWeather)

app.get('/api/usb/events', async (req, res) => {
  const scan = req.query.scan === 'true'
  if (scan) await usbMonitor.scanSerialDevices()
  res.json({
    status: usbMonitor.status(),
    data: usbMonitor.events,
  })
})

app.get('/api/arduino/status', async (_req, res) => {
  res.json({
    cli: await getArduinoCliStatus(),
    boards: await listArduinoBoards(),
    ports: await listSerialPorts(),
  })
})

app.post('/api/arduino/upload', async (req, res) => {
  try {
    res.json(await uploadArduinoSketch(req.body ?? {}))
  } catch (error) {
    if (error instanceof ArduinoUploadError) {
      res.status(error.status).json({ error: error.message, code: error.code, details: error.details })
      return
    }

    res.status(500).json({
      error: error instanceof Error ? error.message : 'Arduino upload failed.',
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
    res.json(await codex.request('account/read', { refreshToken: false }))
  } catch (error) {
    res.status(502).json({ error: error.message })
  }
})

app.get('/api/codex/rate-limits', async (_req, res) => {
  try {
    await codex.ensure()
    res.json(await codex.request('account/rateLimits/read'))
  } catch (error) {
    res.status(502).json({ error: error.message })
  }
})

app.get('/api/codex/models', async (_req, res) => {
  try {
    await codex.ensure()
    res.json(await codex.request('model/list', { limit: 40, includeHidden: false }))
  } catch (error) {
    res.status(502).json({ error: error.message })
  }
})

app.get('/api/codex/apps', async (_req, res) => {
  try {
    await codex.ensure()
    res.json(await codex.request('app/list', { limit: 50, forceRefetch: false }))
  } catch (error) {
    res.status(502).json({ error: error.message })
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
    res.json(await codex.request('thread/archive', { threadId }))
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
    const threadId = threadResult.thread.id
    const turnResult = await codex.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: goalForWorkspace(cwd, goal, artifactPlan) }],
    })
    res.json({ thread: threadResult.thread, turn: turnResult.turn, artifact: artifactPlan })
  } catch (error) {
    sendJsonError(res, error, { fallbackStatus: 502, fallbackMessage: 'Failed to start Codex task.' })
  }
})

app.post('/api/codex/steer', async (req, res) => {
  try {
    const threadId = requireText(req.body?.threadId, 'threadId', { maxLength: 300 })
    const instruction = requireText(req.body?.instruction, 'instruction')
    await codex.ensure()
    res.json(await codex.request('turn/steer', {
      threadId,
      input: [{ type: 'text', text: instruction }],
    }))
  } catch (error) {
    sendJsonError(res, error, { fallbackStatus: 502, fallbackMessage: 'Failed to steer Codex task.' })
  }
})

app.post('/api/codex/interrupt', async (req, res) => {
  try {
    const threadId = requireText(req.body?.threadId, 'threadId', { maxLength: 300 })
    const turnId = requireText(req.body?.turnId, 'turnId', { maxLength: 300 })
    await codex.ensure()
    res.json(await codex.request('turn/interrupt', { threadId, turnId }))
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
    res.status(error.statusCode || 400).json({ error: error.message })
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
    res.status(400).json({ error: 'workspacePath must be an absolute local path' })
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
    res.status(400).json({ error: 'conversationId is required' })
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
    res.status(400).json({ error: 'absolute workspacePath and conversationId are required' })
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
    res.json({ source: 'admin-api', data: projects.data ?? projects })
  } catch (error) {
    res.json({ source: OPENAI_ADMIN_KEY ? 'admin-api-error' : 'missing-admin-key', error: error.message, data: [] })
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
      error: error.message,
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
    res.status(error.statusCode || 502).json({ error: error instanceof Error ? error.message : 'Failed to list generated artifacts.' })
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

    res.sendFile(requestedPath, (error) => {
      if (!error || res.headersSent) return
      res.status(error.statusCode || 404).send('Not found')
    })
  } catch (error) {
    res.status(error.statusCode || 400).send(error instanceof Error ? error.message : 'Invalid artifact path')
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
    error: error instanceof Error ? error.message : 'API request failed.',
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
