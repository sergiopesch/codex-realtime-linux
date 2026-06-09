import {
  AudioLines,
  Bot,
  Captions,
  ChevronDown,
  ChevronRight,
  CirclePoundSterling,
  Database,
  Folder,
  ImagePlus,
  Mic,
  MicOff,
  MonitorUp,
  PanelLeft,
  Plus,
  Settings,
  ShieldCheck,
  Trash2,
  UserRound,
  X,
} from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

type Status = {
  realtime: boolean
  adminApi: boolean
  codexApiKey: boolean
  codexAuthPreference: string
  openAiKeySource?: 'env' | 'settings' | 'missing'
  realtimeModel: string
  realtimeVoice?: string
  appRoot?: string
  appName?: string
  desktopServer?: {
    pid: number
    token: string | null
  }
  defaultWeatherLocation?: string
  realtimeUser?: {
    name?: string
    location?: string
  }
  arduino?: {
    available: boolean
    version: string | null
    defaultFqbn: string
    error?: string
  }
  codexModel: string
  visionModel?: string
  usb?: {
    active: boolean
    startedAt: string | null
    error: string | null
  }
}

type Workspace = {
  id: string
  name?: string
  path?: string
  status?: string
}

type AgentConversation = {
  id: string
  title: string
  age: string
  status: 'draft' | 'ready' | 'running'
  prompt: string
  response: string
  traces: string[]
  transcript: { speaker: 'user' | 'codex'; text: string }[]
  source?: 'local' | 'codex'
  codexThreadId?: string | null
  workspacePath?: string
  createdAt?: string
  updatedAt?: string
}

type EventRecord = {
  method?: string
  receivedAt?: string
  params?: Record<string, unknown>
}

type UnknownRecord = Record<string, unknown>

type SpendResponse = {
  source: string
  error?: string
  data: {
    periodDays?: number
    totalCostGbp?: number | null
    currency?: string
    nativeTotal?: number | null
    nativeCurrency?: string | null
    conversionRate?: number | null
    conversionSource?: string | null
    conversionError?: string | null
    tokenTotals?: {
      input: number
      output: number
      cached: number
      audioInput: number
      audioOutput: number
      total: number
      requests: number
    }
    costBuckets?: { label: string; value: number }[]
    tokenBuckets?: { label: string; value: number }[]
  }
}

type SystemScreen = 'settings' | 'usage' | 'account'

type TranscriptLine = {
  id: string
  speaker: 'user' | 'codex'
  text: string
  status: 'streaming' | 'done'
  createdAt: number
}

type RealtimeFunctionCallItem = {
  type?: string
  name?: string
  arguments?: string
  call_id?: string
}

type AppStateResponse = {
  workspaces: Workspace[]
  conversationsByWorkspace: Record<string, AgentConversation[]>
  hiddenWorkspacePaths?: string[]
}

type CodexThreadsResponse = {
  conversations?: AgentConversation[]
}

type VisualContextResponse = {
  model: string
  summary: string
  source: string
}

type WeatherResponse = {
  source: string
  query: string
  summary: string
  location: {
    name: string
    admin1?: string
    country?: string
    latitude: number
    longitude: number
    timezone?: string
  }
  units: {
    mode: 'metric' | 'imperial'
    temperature: string
    windSpeed: string
  }
  current: {
    time: string
    temperature: number
    apparentTemperature: number | null
    relativeHumidity: number | null
    windSpeed: number | null
    weatherCode: number | null
    condition: string
    isDay: boolean | null
  }
}

type UsbDeviceEvent = {
  id: string
  receivedAt: string
  summary: string
  device: {
    action: 'add' | 'remove' | string
    subsystem: string
    devname: string | null
    vendor: string | null
    model: string | null
    vendorId: string | null
    modelId: string | null
    serial: string | null
    driver: string | null
    isSerialTty: boolean
    isArduinoLike: boolean
  }
}

type UsbEventsResponse = {
  status: NonNullable<Status['usb']>
  data: UsbDeviceEvent[]
}

type ArduinoUploadResponse = {
  action: 'onboard_led_on' | 'onboard_led_blink' | 'custom_sketch'
  fqbn: string
  port: string
  boardName: string | null
  sketchName: string
  summary: string
}

type ArduinoUploadAction = ArduinoUploadResponse['action']

type GeneratedArtifact = {
  id: string
  title: string
  url: string
  relativePath: string
  workspacePath: string
  updatedAt: string
  size: number
}

type ArtifactPlan = {
  directoryName: string
  relativeDir: string
  relativePath: string
  url: string
  workspacePath: string
}

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: () => Promise<{ name?: string }>
}

type DesktopWindow = Window & {
  desktopWindow?: {
    minimize: () => void
    maximize: () => void
    close: () => void
    selectWorkspaceFolder?: () => Promise<{ name: string; path: string } | null>
  }
}

const initialWorkspacePath = ''
const DEFAULT_API_TIMEOUT_MS = 130_000
const MAX_API_RESPONSE_TEXT_LENGTH = 1_000_000
const MAX_API_ERROR_RESPONSE_TEXT_LENGTH = 4_000
const REALTIME_CONNECTION_TIMEOUT_MS = 30_000
const MAX_REALTIME_SDP_RESPONSE_LENGTH = 120_000
const MAX_REALTIME_EVENT_MESSAGE_LENGTH = 120_000
const MAX_REALTIME_FUNCTION_ARGUMENTS_LENGTH = 80_000
const MAX_REALTIME_TOOL_TEXT_LENGTH = 8_000
const MAX_REALTIME_TRANSCRIPT_LINES = 80
const MAX_REALTIME_TRANSCRIPT_ID_LENGTH = 240
const MAX_REALTIME_TRANSCRIPT_TEXT_LENGTH = 8_000
const MAX_UI_CONVERSATIONS_PER_WORKSPACE = 80
const MAX_UI_CONVERSATION_TITLE_LENGTH = 180
const MAX_UI_ERROR_MESSAGE_LENGTH = 500
const MAX_UI_NOTICE_LENGTH = 320
const MAX_UI_ACTIVITY_LENGTH = 120
const MAX_UI_EVENT_STRING_LENGTH = 2_000
const MAX_UI_EVENT_ARRAY_ITEMS = 20
const MAX_UI_EVENT_OBJECT_KEYS = 30
const MAX_UI_EVENT_DEPTH = 6
const MAX_SEEN_USB_EVENT_IDS = 240
const MAX_VISUAL_CONTEXT_IMAGE_FILE_BYTES = 12 * 1024 * 1024
const VISUAL_CONTEXT_CAPTURE_TIMEOUT_MS = 10_000
const SUPPORTED_VISUAL_CONTEXT_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const ARDUINO_UPLOAD_ACTIONS = new Set<ArduinoUploadAction>([
  'onboard_led_on',
  'onboard_led_blink',
  'custom_sketch',
])

const isArduinoUploadAction = (value: string): value is ArduinoUploadAction =>
  ARDUINO_UPLOAD_ACTIONS.has(value as ArduinoUploadAction)

const boundedApiErrorText = (value: unknown, fallback = '') => {
  const text = typeof value === 'string' && value ? value : fallback
  return text.length > MAX_API_ERROR_RESPONSE_TEXT_LENGTH
    ? `${text.slice(0, MAX_API_ERROR_RESPONSE_TEXT_LENGTH - 3)}...`
    : text
}

const readBoundedApiText = async (response: Response, maxLength = MAX_API_RESPONSE_TEXT_LENGTH) => {
  const text = await response.text()
  if (text.length > maxLength) {
    throw new Error(`API response was too large. Maximum response length is ${maxLength} characters.`)
  }
  return text
}

const fetchWithTimeout = async (input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = DEFAULT_API_TIMEOUT_MS) => {
  const controller = new AbortController()
  const externalSignal = init.signal
  let timedOut = false
  const abortFromExternalSignal = () => controller.abort(externalSignal?.reason)
  const timeout = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  if (externalSignal?.aborted) {
    abortFromExternalSignal()
  } else {
    externalSignal?.addEventListener('abort', abortFromExternalSignal, { once: true })
  }

  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } catch (error) {
    if (timedOut) {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)} seconds.`, { cause: error })
    }
    throw error
  } finally {
    window.clearTimeout(timeout)
    externalSignal?.removeEventListener('abort', abortFromExternalSignal)
  }
}

const getUserMediaWithTimeout = async (constraints: MediaStreamConstraints, timeoutMs = REALTIME_CONNECTION_TIMEOUT_MS) => {
  let timedOut = false
  let timeoutId: number | null = null
  const mediaPromise = navigator.mediaDevices.getUserMedia(constraints)
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      timedOut = true
      reject(new Error(`Microphone permission timed out after ${Math.round(timeoutMs / 1000)} seconds.`))
    }, timeoutMs)
  })

  try {
    return await Promise.race([mediaPromise, timeoutPromise])
  } catch (error) {
    if (timedOut) {
      mediaPromise
        .then((stream) => stream.getTracks().forEach((track) => track.stop()))
        .catch(() => {})
    }
    throw error
  } finally {
    if (timeoutId != null) window.clearTimeout(timeoutId)
  }
}

const waitForVisualContextStep = async <T,>(promise: Promise<T>, label: string) => {
  let timeoutId: number | null = null
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error(`${label} timed out while preparing visual context.`))
    }, VISUAL_CONTEXT_CAPTURE_TIMEOUT_MS)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeoutId != null) window.clearTimeout(timeoutId)
  }
}

const validateVisualContextImageFile = (file: File) => {
  if (file.size > MAX_VISUAL_CONTEXT_IMAGE_FILE_BYTES) {
    throw new Error('Image is too large for visual context.')
  }
  if (!SUPPORTED_VISUAL_CONTEXT_IMAGE_TYPES.has(file.type.toLowerCase())) {
    throw new Error('Use a JPEG, PNG, WebP, or GIF image for visual context.')
  }
}

const api = async <T,>(path: string, init?: RequestInit, options?: { timeoutMs?: number }): Promise<T> => {
  const response = await fetchWithTimeout(path, init, options?.timeoutMs)
  if (!response.ok) {
    const rawText = await readBoundedApiText(response, MAX_API_ERROR_RESPONSE_TEXT_LENGTH)
    const text = boundedApiErrorText(rawText)
    let message: string
    try {
      const body = rawText.length <= MAX_API_ERROR_RESPONSE_TEXT_LENGTH ? JSON.parse(rawText) : null
      message = boundedApiErrorText(body?.error, text)
    } catch {
      message = text
    }
    throw new Error(message || boundedApiErrorText(`${response.status} ${response.statusText}`))
  }

  const text = await readBoundedApiText(response)
  try {
    return (text ? JSON.parse(text) : {}) as T
  } catch (error) {
    throw new Error('API response was not valid JSON.', { cause: error })
  }
}

const fetchGeneratedArtifacts = (workspacePath: string, init?: RequestInit) =>
  api<{ data: GeneratedArtifact[] }>(`/api/artifacts?workspacePath=${encodeURIComponent(workspacePath)}`, init)

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')

const briefThreadTitle = (value: string) => value.trim().split(/\s+/).slice(0, 4).join(' ') || 'Untitled'

const finiteTimestamp = (value: string | null | undefined) => {
  const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(timestamp) ? timestamp : null
}

const artifactMatchesDismissal = (
  artifact: GeneratedArtifact,
  dismissedArtifact: { url: string; updatedAt: string; workspacePath: string } | null,
) => {
  if (!dismissedArtifact) return false
  if (artifact.workspacePath !== dismissedArtifact.workspacePath || artifact.url !== dismissedArtifact.url) return false
  const dismissedTime = finiteTimestamp(dismissedArtifact.updatedAt)
  const artifactTime = finiteTimestamp(artifact.updatedAt)
  return dismissedTime == null || artifactTime == null || artifactTime <= dismissedTime
}

const titleFromGoal = (goal: string) => {
  const brief = briefThreadTitle(goal.replace(/[.?!]+$/g, ''))
  return brief === 'Untitled' ? 'Voice routed work' : brief
}

const formatGbp = (value: number | null | undefined) =>
  typeof value === 'number'
    ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 2 }).format(value)
    : 'No cost data'

const formatTokens = (value: number | null | undefined) =>
  new Intl.NumberFormat('en-GB', { notation: 'compact', maximumFractionDigits: 1 }).format(value ?? 0)

const makeDraftConversation = (
  workspacePath: string,
  title: string,
  age: string,
  status: AgentConversation['status'] = 'ready',
): AgentConversation => {
  const conversation = {
    title,
    prompt: '',
    response: '',
    traces: [],
    transcript: [],
  }

  return {
    ...conversation,
    id: `${workspacePath}::${slug(title)}`,
    age,
    status,
    source: 'local',
  }
}

const mergeConversations = (current: AgentConversation[], incoming: AgentConversation[]) => {
  const seen = new Set<string>()
  return [...incoming, ...current]
    .filter((conversation) => {
      if (seen.has(conversation.id)) return false
      seen.add(conversation.id)
      return true
    })
    .slice(0, MAX_UI_CONVERSATIONS_PER_WORKSPACE)
}

const savedConversationPayload = (conversation: AgentConversation) => ({
  ...conversation,
  source: conversation.source === 'codex' ? 'codex' : 'local',
  updatedAt: new Date().toISOString(),
})

const boundedPlainString = (value: unknown, fallback = '', maxLength = 1_000) => {
  const text = typeof value === 'string' && value ? value : fallback
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 3))}...` : text
}

const requireRealtimeToolText = (value: unknown, label: string, maxLength = MAX_REALTIME_TOOL_TEXT_LENGTH) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  const text = value.trim()
  if (text.length > maxLength) throw new Error(`${label} is too long.`)
  return text
}

const boundedRealtimeTranscriptId = (value: unknown) =>
  boundedPlainString(value, 'transcript-line', MAX_REALTIME_TRANSCRIPT_ID_LENGTH)

const boundedRealtimeTranscriptText = (value: unknown) =>
  boundedPlainString(value, '', MAX_REALTIME_TRANSCRIPT_TEXT_LENGTH)

const realtimeTranscriptKeyPart = (value: unknown) => {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

const realtimeErrorMessage = (value: unknown, fallback: string) => {
  if (!value || typeof value !== 'object') return fallback
  const message = (value as UnknownRecord).message
  return boundedRealtimeTranscriptText(typeof message === 'string' && message.trim() ? `${fallback}: ${message.trim()}` : fallback)
}

const displayErrorMessage = (error: unknown, fallback: string) => {
  const rawMessage = error instanceof Error ? error.message : ''
  return boundedPlainString(rawMessage, fallback, MAX_UI_ERROR_MESSAGE_LENGTH)
}

const displayNoticeMessage = (message: unknown) =>
  boundedPlainString(message, '', MAX_UI_NOTICE_LENGTH)

const displayActivityLabel = (message: unknown, fallback = 'Voice router idle') =>
  boundedPlainString(message, fallback, MAX_UI_ACTIVITY_LENGTH)

const boundedEventString = (value: unknown, fallback = '') => {
  const text = typeof value === 'string' && value.trim() ? value.trim() : fallback
  return text.length > MAX_UI_EVENT_STRING_LENGTH ? `${text.slice(0, MAX_UI_EVENT_STRING_LENGTH - 3)}...` : text
}

const normalizeUiEventValue = (value: unknown, depth = 0, seen = new WeakSet<object>()): unknown => {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return boundedEventString(value)
  if (depth >= MAX_UI_EVENT_DEPTH) return '[truncated]'
  if (Array.isArray(value)) {
    return value.slice(0, MAX_UI_EVENT_ARRAY_ITEMS).map((item) => normalizeUiEventValue(item, depth + 1, seen))
  }
  if (typeof value !== 'object') return undefined
  if (seen.has(value)) return '[circular]'
  seen.add(value)

  const normalized: UnknownRecord = {}
  for (const [key, item] of Object.entries(value).slice(0, MAX_UI_EVENT_OBJECT_KEYS)) {
    const normalizedKey = boundedEventString(key, 'field')
    const normalizedValue = normalizeUiEventValue(item, depth + 1, seen)
    if (normalizedKey && normalizedValue !== undefined) normalized[normalizedKey] = normalizedValue
  }
  return normalized
}

const normalizeUiEventRecord = (event: EventRecord): EventRecord => ({
  method: boundedEventString(event.method, 'event'),
  receivedAt: typeof event.receivedAt === 'string' ? event.receivedAt : new Date().toISOString(),
  params: (normalizeUiEventValue(event.params) as Record<string, unknown> | undefined) ?? {},
})

const eventKey = (event: EventRecord) => `${event.method ?? 'event'}::${event.receivedAt ?? ''}`
const completedCodexTurnWords = new Set(['complete', 'completed', 'done', 'finished', 'failed', 'failure', 'cancelled', 'canceled'])
const normalizeAbsoluteLocalWorkspacePath = (workspacePath: string) => {
  const trimmed = workspacePath.trim()
  if (!trimmed.startsWith('/')) return trimmed
  return trimmed.replace(/\/+$/g, '') || '/'
}
const basenameFromWorkspacePath = (workspacePath: string) =>
  normalizeAbsoluteLocalWorkspacePath(workspacePath).split('/').filter(Boolean).at(-1) ?? ''
const workspacePathFor = (workspace: Workspace) => normalizeAbsoluteLocalWorkspacePath(workspace.path ?? workspace.id)
const isAbsoluteLocalWorkspacePath = (workspacePath: string) => normalizeAbsoluteLocalWorkspacePath(workspacePath).startsWith('/')
const mobileSidebarShouldCollapse = () =>
  typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches

const realtimeFunctionCallItem = (message: Record<string, unknown>): RealtimeFunctionCallItem | null => {
  const eventType = typeof message.type === 'string' ? message.type : ''
  const item = message.item && typeof message.item === 'object'
    ? message.item as RealtimeFunctionCallItem
    : null

  if (eventType === 'response.output_item.done' && item?.type === 'function_call') {
    return item
  }

  if (eventType !== 'response.function_call_arguments.done') return null
  if (item?.type === 'function_call') return item

  const name = typeof message.name === 'string' ? message.name : ''
  if (!name) return null

  return {
    type: 'function_call',
    name,
    call_id: typeof message.call_id === 'string' ? message.call_id : undefined,
    arguments: typeof message.arguments === 'string' ? message.arguments : undefined,
  }
}

const mergeEvents = (current: EventRecord[], incoming: EventRecord[]) => {
  const seen = new Set<string>()
  return [...incoming.map(normalizeUiEventRecord), ...current.map(normalizeUiEventRecord)].filter((event) => {
    const key = eventKey(event)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 160)
}

const valueContainsString = (value: unknown, needle: string): boolean => {
  if (!needle) return false
  if (typeof value === 'string') return value === needle
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some((item) => valueContainsString(item, needle))
  return Object.values(value as UnknownRecord).some((item) => valueContainsString(item, needle))
}

const valueContainsCompletedCodexStatus = (value: unknown, statusContext = false): boolean => {
  if (typeof value === 'string') return statusContext && completedCodexTurnWords.has(value.toLowerCase())
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return statusContext && value.some((item) => valueContainsCompletedCodexStatus(item, true))

  return Object.entries(value as UnknownRecord).some(([key, item]) => {
    const statusKey = /status|state|type|outcome|phase/i.test(key)
    if (statusKey && typeof item === 'string' && completedCodexTurnWords.has(item.toLowerCase())) return true
    return valueContainsCompletedCodexStatus(item, statusContext || statusKey)
  })
}

const eventCompletesActiveCodexTurn = (event: EventRecord, turnId: string | null) => {
  if (!turnId || !valueContainsString(event.params, turnId)) return false
  const methodLooksComplete =
    typeof event.method === 'string' &&
    /turn/i.test(event.method) &&
    /(complete|done|finish|fail|cancel)/i.test(event.method)
  return methodLooksComplete || valueContainsCompletedCodexStatus(event.params)
}

function App() {
  const [status, setStatus] = useState<Status | null>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [userWorkspaces, setUserWorkspaces] = useState<Workspace[]>([])
  const [conversationsByWorkspace, setConversationsByWorkspace] = useState<Record<string, AgentConversation[]>>({})
  const [hiddenWorkspacePaths, setHiddenWorkspacePaths] = useState<string[]>([])
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<string[]>([])
  const [selectedWorkspace, setSelectedWorkspace] = useState(initialWorkspacePath)
  const [selectedConversationId, setSelectedConversationId] = useState('')
  const [activeSystemScreen, setActiveSystemScreen] = useState<SystemScreen | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => mobileSidebarShouldCollapse())
  const [openAiApiKeyInput, setOpenAiApiKeyInput] = useState('')
  const [savingOpenAiKey, setSavingOpenAiKey] = useState(false)
  const [weatherLocationInput, setWeatherLocationInput] = useState('')
  const [weatherUnits, setWeatherUnits] = useState<'metric' | 'imperial'>('metric')
  const [weatherLoading, setWeatherLoading] = useState(false)
  const [weatherResult, setWeatherResult] = useState<WeatherResponse | null>(null)
  const [weatherError, setWeatherError] = useState<string | null>(null)
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  const [spend, setSpend] = useState<SpendResponse | null>(null)
  const [, setEvents] = useState<EventRecord[]>([])
  const [voiceState, setVoiceState] = useState<'idle' | 'connecting' | 'live'>('idle')
  const [voiceMuted, setVoiceMuted] = useState(false)
  const [realtimeTranscript, setRealtimeTranscript] = useState<TranscriptLine[]>([])
  const [screenShared, setScreenShared] = useState(false)
  const [attachedImageName, setAttachedImageName] = useState<string | null>(null)
  const [visualContextLabel, setVisualContextLabel] = useState<string | null>(null)
  const [, setArtifacts] = useState<GeneratedArtifact[]>([])
  const [selectedArtifact, setSelectedArtifact] = useState<GeneratedArtifact | null>(null)
  const [dismissedArtifact, setDismissedArtifact] = useState<{ url: string; updatedAt: string; workspacePath: string } | null>(null)
  const [pendingArtifact, setPendingArtifact] = useState<ArtifactPlan | null>(null)
  const [routingActivity, setRoutingActivity] = useState<string[]>(['Voice router idle'])
  const [waveLevels, setWaveLevels] = useState<number[]>(() => Array.from({ length: 18 }, () => 0.18))
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)
  const peerRef = useRef<RTCPeerConnection | null>(null)
  const dataChannelRef = useRef<RTCDataChannel | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const workspaceInputRef = useRef<HTMLInputElement | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const waveformFrameRef = useRef<number | null>(null)
  const voiceStateRef = useRef<'idle' | 'connecting' | 'live'>('idle')
  const voiceSessionIdRef = useRef(0)
  const microphoneStreamRef = useRef<MediaStream | null>(null)
  const screenStreamRef = useRef<MediaStream | null>(null)
  const screenEndedTrackRef = useRef<MediaStreamTrack | null>(null)
  const screenEndedHandlerRef = useRef<(() => void) | null>(null)
  const pendingVisualContextRef = useRef<{ source: string; summary: string }[]>([])
  const pendingArtifactRef = useRef<ArtifactPlan | null>(null)
  const activeThreadIdRef = useRef<string | null>(null)
  const activeTurnIdRef = useRef<string | null>(null)
  const handledRealtimeFunctionCallIdsRef = useRef<Set<string>>(new Set())
  const selectedWorkspaceRef = useRef(initialWorkspacePath)
  const routableWorkspacePathsRef = useRef<Set<string>>(new Set())
  const seenUsbEventIdsRef = useRef<Set<string>>(new Set())
  const usbInitializedRef = useRef(false)

  const costBuckets = useMemo(() => spend?.data?.costBuckets ?? [], [spend?.data?.costBuckets])
  const tokenBuckets = useMemo(() => spend?.data?.tokenBuckets ?? [], [spend?.data?.tokenBuckets])
  const tokenTotals = spend?.data?.tokenTotals ?? {
    input: 0,
    output: 0,
    cached: 0,
    audioInput: 0,
    audioOutput: 0,
    total: 0,
    requests: 0,
  }

  const hasDesktopWindowControls = Boolean((window as DesktopWindow).desktopWindow)
  const workspaceSource = useMemo(() => {
    const seen = new Set<string>()
    const hiddenPaths = new Set(hiddenWorkspacePaths.map(normalizeAbsoluteLocalWorkspacePath))

    return [...userWorkspaces, ...workspaces].filter((workspace) => {
      const workspacePath = workspacePathFor(workspace)
      if (!isAbsoluteLocalWorkspacePath(workspacePath)) return false
      if (hiddenPaths.has(workspacePath)) return false
      if (seen.has(workspacePath)) return false
      seen.add(workspacePath)
      return true
    })
  }, [hiddenWorkspacePaths, userWorkspaces, workspaces])
  const routableWorkspacePaths = useMemo(
    () => workspaceSource.map(workspacePathFor).filter(Boolean),
    [workspaceSource],
  )
  const workspaceRoots = workspaceSource.slice(0, 8).map((workspace) => {
    const workspacePath = workspacePathFor(workspace)
    const conversations = conversationsByWorkspace[workspacePath] ?? []
    return { workspace, workspacePath, conversations }
  })
  const selectedWorkspaceRoot = workspaceRoots.find(({ workspacePath }) => workspacePath === selectedWorkspace)
  const selectedWorkspaceConversations = selectedWorkspaceRoot?.conversations ?? []
  const activeConversation =
    selectedWorkspaceConversations.find((conversation) => conversation.id === selectedConversationId) ??
    selectedWorkspaceConversations[0]
  const transcriptLines = realtimeTranscript
  const voiceReady = status?.realtime ?? false
  const selectedWorkspaceLabel = selectedWorkspaceRoot?.workspace.name ?? basenameFromWorkspacePath(selectedWorkspace)
  const selectedWorkspaceName = selectedWorkspaceLabel || 'No workspace'
  const accountHandle = status?.realtimeUser?.name || basenameFromWorkspacePath(selectedWorkspace) || 'local'
  const accountInitials = accountHandle.slice(0, 2).toUpperCase()
  const voiceHeadline =
    voiceState === 'live'
      ? activeThreadId
        ? 'Steer Codex by voice'
        : 'Tell Codex what to build'
      : `What should we build in ${selectedWorkspaceName}?`
  const primaryActivity = [routingActivity[0] ?? 'Voice router idle', visualContextLabel].filter(Boolean).join(' · ')
  const codexTurnInProgress = Boolean(activeTurnId)
  const artifactPreview =
    selectedArtifact &&
    selectedArtifact.workspacePath === selectedWorkspace &&
    !artifactMatchesDismissal(selectedArtifact, dismissedArtifact)
      ? selectedArtifact
      : null
  const agentIsWorkingOnArtifact = Boolean(pendingArtifact && codexTurnInProgress)
  const showSubagentPreview = codexTurnInProgress && !agentIsWorkingOnArtifact
  const subagentTitle = activeConversation?.title ? briefThreadTitle(activeConversation.title) : 'Codex'
  const subagentHint =
    activeConversation?.prompt || activeConversation?.response || 'Working through the active Codex turn.'

  const appendEvent = (method: string, params?: Record<string, unknown>) => {
    setEvents((current) => mergeEvents(current, [{ method, receivedAt: new Date().toISOString(), params }]))
  }

  const showNotice = (message: string) => {
    setNotice(displayNoticeMessage(message))
    setLastError(null)
  }

  const setVoiceLifecycleState = (next: 'idle' | 'connecting' | 'live') => {
    voiceStateRef.current = next
    setVoiceState(next)
  }

  const setActivity = (...items: string[]) => {
    const labels = items.slice(0, 4).map((item) => displayActivityLabel(item)).filter(Boolean)
    setRoutingActivity(
      labels.length > 0 ? labels : ['Voice router idle'],
    )
  }

  const setActiveCodexTurn = (threadId: string | null, turnId: string | null) => {
    activeThreadIdRef.current = threadId
    activeTurnIdRef.current = turnId
    setActiveThreadId(threadId)
    setActiveTurnId(turnId)
  }

  const selectedRoutableWorkspacePath = (requestedCwd: unknown) => {
    const selected = selectedWorkspaceRef.current
    const normalizedSelected = normalizeAbsoluteLocalWorkspacePath(selected)
    if (!normalizedSelected) {
      throw new Error('Select a workspace before routing work to Codex.')
    }
    if (!routableWorkspacePathsRef.current.has(normalizedSelected)) {
      throw new Error('The selected workspace is not available for Codex routing.')
    }
    const normalizedRequestedCwd =
      typeof requestedCwd === 'string' && requestedCwd.trim()
        ? normalizeAbsoluteLocalWorkspacePath(requestedCwd)
        : ''
    if (normalizedRequestedCwd && normalizedRequestedCwd !== normalizedSelected) {
      throw new Error('Realtime requested a workspace that is not currently selected. Select that workspace first.')
    }
    return normalizedSelected
  }

  const updateTranscriptLine = (
    id: string,
    speaker: TranscriptLine['speaker'],
    text: string,
    mode: 'append' | 'replace',
    status: TranscriptLine['status'],
  ) => {
    const lineId = boundedRealtimeTranscriptId(id)
    const nextText = boundedRealtimeTranscriptText(text)

    if (!nextText) {
      setRealtimeTranscript((current) =>
        current.map((line) => line.id === lineId ? { ...line, speaker, status } : line),
      )
      return
    }
    setRealtimeTranscript((current) => {
      const index = current.findIndex((line) => line.id === lineId)
      if (index === -1) {
        return [...current, { id: lineId, speaker, text: nextText, status, createdAt: Date.now() }]
          .slice(-MAX_REALTIME_TRANSCRIPT_LINES)
      }

      const next = [...current]
      const existing = next[index]
      next[index] = {
        ...existing,
        speaker,
        text: boundedRealtimeTranscriptText(mode === 'append' ? `${existing.text}${nextText}` : nextText),
        status,
      }
      return next
    })
  }

  const recordRealtimeTranscript = (message: Record<string, unknown>) => {
    const type = typeof message.type === 'string' ? message.type : ''
    const item = message.item && typeof message.item === 'object' ? message.item as Record<string, unknown> : null
    const itemId =
      realtimeTranscriptKeyPart(message.item_id) ||
      realtimeTranscriptKeyPart(item?.id) ||
      realtimeTranscriptKeyPart(message.response_id) ||
      realtimeTranscriptKeyPart(message.event_id) ||
      `${type}-${Date.now()}`
    const outputIndex = realtimeTranscriptKeyPart(message.output_index)
    const contentIndex = realtimeTranscriptKeyPart(message.content_index)
    const transcriptId = [itemId, outputIndex ? `output-${outputIndex}` : '', contentIndex ? `content-${contentIndex}` : '']
      .filter(Boolean)
      .join(':')

    if (type === 'conversation.item.input_audio_transcription.delta') {
      updateTranscriptLine(`user-${transcriptId}`, 'user', typeof message.delta === 'string' ? message.delta : '', 'append', 'streaming')
      return
    }

    if (type === 'conversation.item.input_audio_transcription.completed') {
      updateTranscriptLine(`user-${transcriptId}`, 'user', typeof message.transcript === 'string' ? message.transcript : '', 'replace', 'done')
      return
    }

    if (type === 'conversation.item.input_audio_transcription.failed') {
      updateTranscriptLine(`user-${transcriptId}`, 'user', realtimeErrorMessage(message.error, 'Input transcription failed'), 'replace', 'done')
      return
    }

    if (type === 'conversation.item.input_audio_transcription.segment') {
      updateTranscriptLine(`user-${transcriptId}`, 'user', typeof message.text === 'string' ? message.text : '', 'replace', 'done')
      return
    }

    if (type === 'response.output_audio_transcript.delta' || type === 'response.output_text.delta') {
      updateTranscriptLine(`codex-${transcriptId}`, 'codex', typeof message.delta === 'string' ? message.delta : '', 'append', 'streaming')
      return
    }

    if (type === 'response.output_audio_transcript.done') {
      updateTranscriptLine(`codex-${transcriptId}`, 'codex', typeof message.transcript === 'string' ? message.transcript : '', 'replace', 'done')
      return
    }

    if (type === 'response.output_text.done') {
      updateTranscriptLine(`codex-${transcriptId}`, 'codex', typeof message.text === 'string' ? message.text : '', 'replace', 'done')
    }
  }

  const stopWaveform = useCallback(() => {
    if (waveformFrameRef.current) window.cancelAnimationFrame(waveformFrameRef.current)
    waveformFrameRef.current = null
    analyserRef.current = null
    audioContextRef.current?.close().catch(() => {})
    audioContextRef.current = null
    setWaveLevels(Array.from({ length: 18 }, () => 0.18))
  }, [])

  const cleanupVoiceSession = useCallback((invalidateSession = true) => {
    if (invalidateSession) voiceSessionIdRef.current += 1
    const peer = peerRef.current
    const microphoneStream = microphoneStreamRef.current
    peerRef.current = null
    dataChannelRef.current = null
    microphoneStreamRef.current = null

    peer?.getSenders().forEach((sender) => sender.track?.stop())
    peer?.close()
    microphoneStream?.getTracks().forEach((track) => track.stop())

    if (audioRef.current) {
      audioRef.current.srcObject = null
      audioRef.current.remove()
      audioRef.current = null
    }

    stopWaveform()
    setVoiceMuted(false)
  }, [stopWaveform])

  const cleanupScreenShare = useCallback((stream = screenStreamRef.current) => {
    if (screenEndedTrackRef.current && screenEndedHandlerRef.current) {
      screenEndedTrackRef.current.removeEventListener('ended', screenEndedHandlerRef.current)
      screenEndedTrackRef.current = null
      screenEndedHandlerRef.current = null
    }
    stream?.getTracks().forEach((track) => track.stop())
    if (!stream || screenStreamRef.current === stream) {
      screenStreamRef.current = null
      setScreenShared(false)
    }
  }, [])

  const startWaveform = (stream: MediaStream) => {
    stopWaveform()
    const audioContext = new AudioContext()
    const analyser = audioContext.createAnalyser()
    analyser.fftSize = 64
    analyser.smoothingTimeConstant = 0.72
    audioContext.createMediaStreamSource(stream).connect(analyser)
    audioContextRef.current = audioContext
    analyserRef.current = analyser

    const data = new Uint8Array(analyser.frequencyBinCount)
    const tick = () => {
      analyser.getByteFrequencyData(data)
      const next = Array.from({ length: 18 }, (_, index) => {
        const value = data[Math.min(data.length - 1, index + 2)] ?? 0
        return Math.max(0.12, Math.min(1, value / 210))
      })
      setWaveLevels(next)
      waveformFrameRef.current = window.requestAnimationFrame(tick)
    }
    tick()
  }

  const imageToJpegDataUrl = (image: CanvasImageSource, width: number, height: number, maxSide = 960) => {
    const scale = Math.min(1, maxSide / Math.max(width, height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas is not available')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.82)
  }

  const dataUrlFromFile = async (file: File) => {
    validateVisualContextImageFile(file)
    const objectUrl = URL.createObjectURL(file)
    const image = new Image()
    try {
      image.src = objectUrl
      await waitForVisualContextStep(image.decode(), 'Image decoding')
      return imageToJpegDataUrl(image, image.naturalWidth, image.naturalHeight)
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  }

  const dataUrlFromVideoFrame = async (stream: MediaStream) => {
    const video = document.createElement('video')
    video.srcObject = stream
    video.muted = true
    try {
      await waitForVisualContextStep(
        new Promise<void>((resolve) => {
          if (video.videoWidth > 0) resolve()
          else video.onloadedmetadata = () => resolve()
        }),
        'Screen metadata',
      )
      await waitForVisualContextStep(video.play(), 'Screen playback')
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
      return imageToJpegDataUrl(video, video.videoWidth, video.videoHeight, 1280)
    } finally {
      video.pause()
      video.srcObject = null
    }
  }

  const injectVisualContextIntoRealtime = (source: string, summary: string, respond = true) => {
    const dataChannel = dataChannelRef.current
    if (!dataChannel || dataChannel.readyState !== 'open') return false
    dataChannel.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `[Visual context attached: ${source}] ${summary}`,
            },
          ],
        },
      }),
    )
    if (respond) dataChannel.send(JSON.stringify({ type: 'response.create' }))
    return true
  }

  const injectUsbEventIntoRealtime = (event: UsbDeviceEvent) => {
    const dataChannel = dataChannelRef.current
    if (!dataChannel || dataChannel.readyState !== 'open') return false

    dataChannel.send(JSON.stringify({ type: 'response.cancel' }))
    dataChannel.send(JSON.stringify({ type: 'output_audio_buffer.clear' }))
    dataChannel.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: [
                `[Realtime interruption: USB device connected: ${event.summary}]`,
                'The user just connected an Arduino or Arduino-like USB serial board while speaking.',
                'Acknowledge the device connection briefly, then return to the user.',
                'Do not claim you can read the board sketch or serial data yet; only react to the USB connection.',
              ].join(' '),
            },
          ],
        },
      }),
    )
    dataChannel.send(JSON.stringify({ type: 'response.create' }))
    return true
  }

  const flushPendingVisualContext = () => {
    const pending = pendingVisualContextRef.current.splice(0)
    if (pending.length === 0) return
    const injected = pending.filter(({ source, summary }) => injectVisualContextIntoRealtime(source, summary, false))
    if (injected.length > 0) {
      appendEvent('context/visual-flushed', { count: injected.length })
      setActivity('Voice router', 'Vision context', 'Realtime ready')
    }
  }

  const analyzeAndAttachVisualContext = async (imageDataUrl: string, source: string) => {
    setActivity('Voice router', 'Vision context')
    const context = await api<VisualContextResponse>('/api/vision/context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageDataUrl, source }),
    })
    setVisualContextLabel(source)
    const injected = injectVisualContextIntoRealtime(context.source, context.summary)
    if (!injected) {
      pendingVisualContextRef.current = [
        ...pendingVisualContextRef.current.filter((item) => item.source !== context.source),
        { source: context.source, summary: context.summary },
      ].slice(-4)
    }
    appendEvent('context/visual-attached', { source: context.source, model: context.model, injected })
    setActivity('Voice router', 'Vision context', injected ? 'Realtime updated' : 'Ready for voice')
    showNotice(injected ? `${source} attached to Realtime.` : `${source} analyzed. Start voice to use it live.`)
    return context
  }

  const refreshStatus = async () => {
    setStatus(await api<Status>('/api/status'))
  }

  const fetchWeather = async (location: string, units: 'metric' | 'imperial' = weatherUnits) =>
    api<WeatherResponse>('/api/weather/current', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location, units }),
    })

  const uploadArduinoSketch = async (payload: Record<string, unknown>) =>
    api<ArduinoUploadResponse>('/api/arduino/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

  const refreshArtifacts = useCallback(async (workspacePath = selectedWorkspaceRef.current, init?: RequestInit) => {
    if (!workspacePath) {
      setArtifacts([])
      return []
    }
    const data = await fetchGeneratedArtifacts(workspacePath, init)
    setArtifacts(data.data)
    return data.data
  }, [])

  const refreshOpenArtifact = useCallback((artifactData: GeneratedArtifact[]) => {
    setSelectedArtifact((current) => {
      if (!current) return null
      const refreshedCurrent = current
        ? artifactData.find((artifact) => artifact.workspacePath === current.workspacePath && artifact.url === current.url)
        : null
      if (refreshedCurrent && !artifactMatchesDismissal(refreshedCurrent, dismissedArtifact)) return refreshedCurrent
      return null
    })
  }, [dismissedArtifact])

  const requestWeather = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault()
    setWeatherLoading(true)
    setWeatherError(null)
    setLastError(null)

    try {
      const weather = await fetchWeather(weatherLocationInput, weatherUnits)
      setWeatherResult(weather)
      showNotice(`Weather updated for ${weather.location.name}.`)
    } catch (error) {
      const message = displayErrorMessage(error, 'Weather lookup failed')
      setWeatherError(message)
      setWeatherResult(null)
    } finally {
      setWeatherLoading(false)
    }
  }

  const saveOpenAiApiKey = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const apiKey = openAiApiKeyInput.trim()
    if (!apiKey) return

    setSavingOpenAiKey(true)
    setLastError(null)
    try {
      await api('/api/settings/openai-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey }),
      })
      setOpenAiApiKeyInput('')
      await refreshStatus()
      showNotice('OpenAI API key saved locally. Voice is ready.')
    } catch (error) {
      setLastError(displayErrorMessage(error, 'Failed to save OpenAI API key'))
    } finally {
      setSavingOpenAiKey(false)
    }
  }

  const removeOpenAiApiKey = async () => {
    setSavingOpenAiKey(true)
    setLastError(null)
    try {
      await api('/api/settings/openai-key', { method: 'DELETE' })
      await refreshStatus()
      showNotice('Saved OpenAI API key removed.')
    } catch (error) {
      setLastError(displayErrorMessage(error, 'Failed to remove OpenAI API key'))
    } finally {
      setSavingOpenAiKey(false)
    }
  }

  const openConversationWindow = (workspacePath: string, conversationId: string) => {
    setSelectedWorkspace(workspacePath)
    setSelectedConversationId(conversationId)
    setActiveSystemScreen(null)
    setSelectedArtifact(null)
    setNotice(null)
    setLastError(null)
    if (mobileSidebarShouldCollapse()) setSidebarCollapsed(true)
  }

  const createConversation = async (targetWorkspacePath?: string) => {
    const requestedWorkspacePath = normalizeAbsoluteLocalWorkspacePath(targetWorkspacePath ?? selectedWorkspace)
    const workspacePath = workspaceRoots.some((root) => root.workspacePath === requestedWorkspacePath) ? requestedWorkspacePath : ''
    if (!workspacePath) {
      showNotice('Add or select a workspace before starting a voice build.')
      return
    }
    const existing = conversationsByWorkspace[workspacePath] ?? []
    const title = `Voice conversation ${existing.length + 1}`
    const conversation = {
      ...makeDraftConversation(workspacePath, title, 'draft', 'draft'),
      source: 'local' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    setConversationsByWorkspace((current) => ({
      ...current,
      [workspacePath]: mergeConversations(current[workspacePath] ?? existing, [conversation]),
    }))
    openConversationWindow(workspacePath, conversation.id)
    showNotice(`${title} opened as a new agent conversation window. Start voice to describe the build goal.`)

    try {
      await api('/api/app-state/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacePath, conversation: savedConversationPayload(conversation) }),
      })
    } catch (error) {
      setLastError(displayErrorMessage(error, 'Failed to save agent conversation'))
    }
  }

  const addWorkspaceFromFolder = async ({ name: rawName, path: rawPath }: { name: string; path?: string }) => {
    const name = rawName.trim() || 'New workspace'
    const workspacePath = normalizeAbsoluteLocalWorkspacePath(rawPath ?? '')
    if (!isAbsoluteLocalWorkspacePath(workspacePath)) {
      setLastError('A real local folder path is required. Launch the desktop app and use Add workspace from there.')
      return
    }
    const workspace = { id: workspacePath, name, path: workspacePath }

    setUserWorkspaces((current) => [workspace, ...current.filter((item) => workspacePathFor(item) !== workspacePath)])
    setConversationsByWorkspace((current) => ({ ...current, [workspacePath]: current[workspacePath] ?? [] }))
    setCollapsedWorkspaces((current) => current.filter((item) => item !== workspacePath))
    setSelectedWorkspace(workspacePath)
    setSelectedConversationId('')
    setActiveSystemScreen(null)
    setSelectedArtifact(null)
    showNotice(`${name} added as a workspace. Create a new agent conversation when you are ready.`)

    try {
      await api('/api/app-state/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace }),
      })
    } catch (error) {
      setLastError(displayErrorMessage(error, 'Failed to save workspace'))
    }
  }

  const addWorkspaceFromFiles = (files: FileList | null | undefined) => {
    const firstFile = files?.[0]
    if (!firstFile) return

    const relativePath = (firstFile as File & { webkitRelativePath?: string }).webkitRelativePath
    void addWorkspaceFromFolder({ name: relativePath?.split('/')[0] || firstFile.name })
    if (workspaceInputRef.current) workspaceInputRef.current.value = ''
  }

  const pickWorkspaceFolder = async () => {
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker

    try {
      const desktopFolder = await (window as DesktopWindow).desktopWindow?.selectWorkspaceFolder?.()
      if (desktopFolder?.path) {
        await addWorkspaceFromFolder(desktopFolder)
        return
      }
    } catch (error) {
      setLastError(displayErrorMessage(error, 'Failed to open folder picker'))
      return
    }

    if (picker) {
      try {
        const handle = await picker.call(window)
        if (handle?.name) {
          setLastError('Browser folder handles do not expose local paths. Use the desktop app to add a workspace folder.')
          return
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return
      }
    }

    workspaceInputRef.current?.click()
  }

  const deleteConversation = async (workspacePath: string, conversationId: string) => {
    const current = conversationsByWorkspace[workspacePath] ?? []
    const deleted = current.find((conversation) => conversation.id === conversationId)
    const next = current.filter((conversation) => conversation.id !== conversationId)
    const fallback = next[0]

    setConversationsByWorkspace((state) => ({ ...state, [workspacePath]: next }))

    if (selectedConversationId === conversationId) {
      if (fallback) {
        openConversationWindow(workspacePath, fallback.id)
      } else {
        setActiveSystemScreen('settings')
      }
    }

    showNotice('Agent conversation deleted from this workspace.')

    try {
      if (deleted?.source === 'codex' && deleted.codexThreadId) {
        await api('/api/codex/thread/archive', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threadId: deleted.codexThreadId }),
        })
      } else if (deleted?.source === 'local') {
        await api('/api/app-state/conversations/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspacePath, conversationId }),
        })
      }
    } catch (error) {
      setLastError(displayErrorMessage(error, 'Failed to delete agent conversation'))
    }
  }

  const removeWorkspaceFromApp = async (workspacePath: string) => {
    const targetWorkspacePath = normalizeAbsoluteLocalWorkspacePath(workspacePath)
    const nextWorkspace = workspaceRoots.find((root) => root.workspacePath !== targetWorkspacePath)

    setHiddenWorkspacePaths((current) => [...new Set([...current.map(normalizeAbsoluteLocalWorkspacePath), targetWorkspacePath])])
    setUserWorkspaces((current) => current.filter((workspace) => workspacePathFor(workspace) !== targetWorkspacePath))
    setCollapsedWorkspaces((current) => current.filter((item) => normalizeAbsoluteLocalWorkspacePath(item) !== targetWorkspacePath))
    setConversationsByWorkspace((current) => {
      const next = { ...current }
      delete next[targetWorkspacePath]
      return next
    })

    if (normalizeAbsoluteLocalWorkspacePath(selectedWorkspace) === targetWorkspacePath) {
      if (nextWorkspace) {
        setSelectedWorkspace(nextWorkspace.workspacePath)
        setSelectedConversationId(nextWorkspace.conversations[0]?.id ?? '')
        setActiveSystemScreen(null)
      } else {
        setSelectedWorkspace('')
        setSelectedConversationId('')
        setActiveSystemScreen('settings')
      }
      setSelectedArtifact(null)
    }

    showNotice('Workspace removed from this app. The local folder was not deleted.')

    try {
      await api('/api/app-state/workspaces/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacePath: targetWorkspacePath }),
      })
    } catch (error) {
      setLastError(displayErrorMessage(error, 'Failed to remove workspace'))
    }
  }

  const toggleWorkspace = (workspacePath: string) => {
    const firstConversation =
      conversationsByWorkspace[workspacePath]?.[0] ??
      workspaceRoots.find((root) => root.workspacePath === workspacePath)?.conversations[0]

    setSelectedWorkspace(workspacePath)
    setActiveSystemScreen(null)
    setSelectedArtifact(null)
    if (firstConversation) {
      setSelectedConversationId(firstConversation.id)
    } else {
      setSelectedConversationId('')
    }
    if (mobileSidebarShouldCollapse()) setSidebarCollapsed(true)
    setCollapsedWorkspaces((current) =>
      current.includes(workspacePath) ? current.filter((item) => item !== workspacePath) : [...current, workspacePath],
    )
  }

  const openSystemScreen = (screen: SystemScreen) => {
    setActiveSystemScreen(screen)
    setSelectedArtifact(null)
    setNotice(null)
    setLastError(null)
    if (mobileSidebarShouldCollapse()) setSidebarCollapsed(true)
  }

  const controlWindow = (action: 'minimize' | 'maximize' | 'close') => {
    const desktopWindow = (window as DesktopWindow).desktopWindow
    if (action === 'minimize') desktopWindow?.minimize()
    if (action === 'maximize') desktopWindow?.maximize()
    if (action === 'close') desktopWindow?.close()
  }

  useEffect(() => {
    return () => {
      cleanupVoiceSession()
      cleanupScreenShare()
    }
  }, [cleanupScreenShare, cleanupVoiceSession])

  useEffect(() => {
    workspaceInputRef.current?.setAttribute('webkitdirectory', '')
    workspaceInputRef.current?.setAttribute('directory', '')
  }, [])

  useEffect(() => {
    selectedWorkspaceRef.current = selectedWorkspace
    refreshArtifacts(selectedWorkspace)
      .then(refreshOpenArtifact)
      .catch(() => undefined)
  }, [refreshArtifacts, refreshOpenArtifact, selectedWorkspace])

  useEffect(() => {
    routableWorkspacePathsRef.current = new Set(routableWorkspacePaths)
  }, [routableWorkspacePaths])

  useEffect(() => {
    activeThreadIdRef.current = activeThreadId
  }, [activeThreadId])

  useEffect(() => {
    activeTurnIdRef.current = activeTurnId
  }, [activeTurnId])

  useEffect(() => {
    pendingArtifactRef.current = pendingArtifact
  }, [pendingArtifact])

  useEffect(() => {
    if (!notice) return undefined
    const timeout = window.setTimeout(() => setNotice(null), 3600)
    return () => window.clearTimeout(timeout)
  }, [notice])

  useEffect(() => {
    const controller = new AbortController()
    let effectActive = true
    const load = async () => {
      try {
        const [statusData, workspaceData, spendData, appStateData] = await Promise.all([
          api<Status>('/api/status', { signal: controller.signal }),
          api<{ data: Workspace[] }>('/api/workspaces', { signal: controller.signal }),
          api<SpendResponse>('/api/spend', { signal: controller.signal }),
          api<AppStateResponse>('/api/app-state', { signal: controller.signal }),
        ])
        if (!effectActive) return
        const localWorkspaceData = workspaceData.data.filter((workspace) => isAbsoluteLocalWorkspacePath(workspacePathFor(workspace)))
        const roots = localWorkspaceData.slice(0, 5)
        const savedWorkspaces = (appStateData.workspaces ?? []).filter((workspace) =>
          isAbsoluteLocalWorkspacePath(workspacePathFor(workspace)),
        )
        const hiddenPaths = (appStateData.hiddenWorkspacePaths ?? []).map(normalizeAbsoluteLocalWorkspacePath)
        const savedConversationState = appStateData.conversationsByWorkspace ?? {}
        const visibleRoots = roots.filter((workspace) => !hiddenPaths.includes(workspacePathFor(workspace)))
        const visibleSavedWorkspaces = savedWorkspaces.filter((workspace) => !hiddenPaths.includes(workspacePathFor(workspace)))
        const firstPath = visibleRoots[0] ? workspacePathFor(visibleRoots[0]) : ''
        const preferredPath = visibleSavedWorkspaces[0] ? workspacePathFor(visibleSavedWorkspaces[0]) : firstPath
        const shouldLoadCodexHistory = Boolean(
          preferredPath && visibleSavedWorkspaces.some((workspace) => workspacePathFor(workspace) === preferredPath),
        )
        const firstConversation = preferredPath ? savedConversationState[preferredPath]?.[0] ?? null : null

        setStatus(statusData)
        setWorkspaces(localWorkspaceData)
        setUserWorkspaces(savedWorkspaces)
        setHiddenWorkspacePaths(hiddenPaths)
        setSpend(spendData)
        setWeatherLocationInput((current) =>
          current.trim() || !statusData.defaultWeatherLocation ? current : statusData.defaultWeatherLocation ?? '',
        )
        if (preferredPath) {
          fetchGeneratedArtifacts(preferredPath, { signal: controller.signal })
            .then((artifactData) => {
              if (!effectActive) return
              setArtifacts(artifactData.data)
              setSelectedArtifact(null)
            })
            .catch(() => undefined)
        }
        setConversationsByWorkspace(() => {
          const next = { ...savedConversationState }
          roots.forEach((workspace) => {
            const workspacePath = workspacePathFor(workspace)
            if (!next[workspacePath]) next[workspacePath] = []
          })
          return next
        })
        setSelectedWorkspace(preferredPath)
        setSelectedConversationId(firstConversation?.id ?? '')

        if (shouldLoadCodexHistory) {
          api<CodexThreadsResponse>(
            `/api/codex/threads?limit=40&cwd=${encodeURIComponent(preferredPath)}`,
            { signal: controller.signal },
          )
            .then((threadData) => {
              if (!effectActive) return
              const codexConversationsByWorkspace = (threadData.conversations ?? []).reduce<Record<string, AgentConversation[]>>(
                (groups, conversation) => {
                  const workspacePath = conversation.workspacePath
                  if (!workspacePath) return groups
                  groups[workspacePath] = groups[workspacePath] ?? []
                  groups[workspacePath].push(conversation)
                  return groups
                },
                {},
              )

              setConversationsByWorkspace((current) => {
                const next = { ...current }
                Object.entries(codexConversationsByWorkspace).forEach(([workspacePath, codexConversations]) => {
                  next[workspacePath] = mergeConversations(
                    (next[workspacePath] ?? []).filter((conversation) => conversation.source !== 'codex'),
                    codexConversations,
                  )
                })
                return next
              })
            })
            .catch((error: unknown) => {
              if (!effectActive || controller.signal.aborted) return
              setEvents((current) =>
                mergeEvents(current, [{
                  method: 'codex/thread-list-unavailable',
                  receivedAt: new Date().toISOString(),
                  params: { message: displayErrorMessage(error, 'Codex app-server thread list failed') },
                }]),
              )
            })
        }
      } catch (error) {
        if (!effectActive || controller.signal.aborted) return
        setLastError(displayErrorMessage(error, 'Failed to load app state'))
      }
    }

    load()
    return () => {
      effectActive = false
      controller.abort()
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    let effectActive = true
    let pollInFlight = false
    const pollCodexEvents = async () => {
      if (pollInFlight) return
      pollInFlight = true
      try {
        const data = await api<{ data: EventRecord[] }>('/api/codex/events', { signal: controller.signal })
        if (!effectActive) return
        setEvents((current) => mergeEvents(current, data.data))
        if (activeTurnIdRef.current && data.data.some((event) => eventCompletesActiveCodexTurn(event, activeTurnIdRef.current))) {
          const completedThreadId = activeThreadIdRef.current
          const pendingArtifactForTurn = pendingArtifactRef.current

          if (pendingArtifactForTurn) {
            const artifactData = await refreshArtifacts(pendingArtifactForTurn.workspacePath, {
              signal: controller.signal,
            })
            if (!effectActive) return
            const completedArtifact = artifactData.find((artifact) => artifact.url === pendingArtifactForTurn.url)
            if (completedArtifact) {
              setSelectedArtifact(completedArtifact)
              setDismissedArtifact(null)
              setActivity('Artifact ready', completedArtifact.title)
              showNotice(`Preview ready: ${completedArtifact.relativePath}`)
            } else {
              setActivity('Codex work complete')
              showNotice(`Codex finished without creating ${pendingArtifactForTurn.relativePath}.`)
            }
            setPendingArtifact(null)
          } else {
            setActivity('Codex work complete')
          }

          setActiveCodexTurn(completedThreadId, null)
          setConversationsByWorkspace((current) => {
            if (!completedThreadId) return current
            const next = { ...current }
            for (const [workspacePath, conversations] of Object.entries(next)) {
              next[workspacePath] = conversations.map((conversation) =>
                conversation.id === completedThreadId
                  ? { ...conversation, status: 'ready', updatedAt: new Date().toISOString() }
                  : conversation,
              )
            }
            return next
          })
        }
      } catch {
        if (!effectActive || controller.signal.aborted) return
        // The app-server may not be started until the first Codex action.
      } finally {
        pollInFlight = false
      }
    }

    void pollCodexEvents()
    const interval = window.setInterval(() => void pollCodexEvents(), 1800)
    return () => {
      effectActive = false
      controller.abort()
      window.clearInterval(interval)
    }
  }, [refreshArtifacts])

  useEffect(() => {
    const controller = new AbortController()
    let effectActive = true
    let pollInFlight = false
    const pollArtifacts = async () => {
      if (pollInFlight) return
      pollInFlight = true
      try {
        const artifactData = await refreshArtifacts(pendingArtifact?.workspacePath ?? selectedWorkspaceRef.current, {
          signal: controller.signal,
        })
        if (!effectActive) return
        if (!pendingArtifact) {
          refreshOpenArtifact(artifactData)
          return
        }
        const completed = artifactData.find((artifact) => artifact.url === pendingArtifact.url)
        if (!completed) return

        setSelectedArtifact(completed)
        setDismissedArtifact(null)
        setPendingArtifact(null)
        setActiveCodexTurn(activeThreadIdRef.current, null)
        setActivity('Artifact ready', completed.title)
        showNotice(`Preview ready: ${completed.relativePath}`)
      } catch {
        if (!effectActive || controller.signal.aborted) return
        // Artifact polling should not interrupt voice or Codex work.
      } finally {
        pollInFlight = false
      }
    }

    void pollArtifacts()
    const interval = window.setInterval(() => void pollArtifacts(), pendingArtifact ? 1500 : 5000)
    return () => {
      effectActive = false
      controller.abort()
      window.clearInterval(interval)
    }
  }, [pendingArtifact, refreshArtifacts, refreshOpenArtifact])

  useEffect(() => {
    const controller = new AbortController()
    let effectActive = true
    let pollInFlight = false
    const pollUsbEvents = async () => {
      if (pollInFlight) return
      pollInFlight = true
      try {
        const data = await api<UsbEventsResponse>(
          `/api/usb/events${usbInitializedRef.current ? '' : '?scan=true'}`,
          { signal: controller.signal },
        )
        if (!effectActive) return
        setStatus((current) => current ? { ...current, usb: data.status } : current)

        const unseen = data.data
          .filter((event) => !seenUsbEventIdsRef.current.has(event.id))
          .sort((a, b) => (finiteTimestamp(a.receivedAt) ?? 0) - (finiteTimestamp(b.receivedAt) ?? 0))

        for (const event of unseen) {
          seenUsbEventIdsRef.current.add(event.id)
        }

        if (seenUsbEventIdsRef.current.size > MAX_SEEN_USB_EVENT_IDS) {
          const retainedIds = new Set(data.data.map((event) => event.id).slice(0, MAX_SEEN_USB_EVENT_IDS))
          for (const eventId of [...seenUsbEventIdsRef.current].reverse()) {
            if (retainedIds.size >= MAX_SEEN_USB_EVENT_IDS) break
            retainedIds.add(eventId)
          }
          seenUsbEventIdsRef.current = retainedIds
        }

        if (!usbInitializedRef.current) {
          usbInitializedRef.current = true
          return
        }

        for (const event of unseen) {
          appendEvent('usb/device-event', {
            summary: event.summary,
            action: event.device.action,
            devname: event.device.devname,
            isArduinoLike: event.device.isArduinoLike,
          })

          if (event.device.action === 'add' && event.device.isArduinoLike) {
            const injected = injectUsbEventIntoRealtime(event)
            appendEvent('usb/arduino-connected', { summary: event.summary, injected })
            setActivity('USB noticed', injected ? 'Realtime updated' : 'Arduino connected')
            showNotice(
              injected
                ? `Arduino noticed: ${event.summary}`
                : `Arduino noticed: ${event.summary}. Start voice to hear Codex react.`,
            )
          }
        }
      } catch (error) {
        if (!effectActive || controller.signal.aborted) return
        setStatus((current) =>
          current
            ? {
                ...current,
                usb: {
                  active: false,
                  startedAt: current.usb?.startedAt ?? null,
                  error: displayErrorMessage(error, 'USB monitor unavailable'),
                },
              }
            : current,
        )
      } finally {
        pollInFlight = false
      }
    }

    void pollUsbEvents()
    const interval = window.setInterval(() => void pollUsbEvents(), 1200)
    return () => {
      effectActive = false
      controller.abort()
      window.clearInterval(interval)
    }
  }, [])

  const handleRealtimeToolCall = async (message: Record<string, unknown>) => {
    const item = realtimeFunctionCallItem(message)
    if (!item) return
    const responseChannel = dataChannelRef.current

    if (typeof item.call_id !== 'string' || !item.call_id.trim()) {
      const error = 'Realtime function call did not include a call_id.'
      setLastError(error)
      appendEvent('realtime/function-call-invalid', { error, name: item.name })
      return
    }
    const callId = item.call_id.trim()
    if (handledRealtimeFunctionCallIdsRef.current.has(callId)) {
      appendEvent('realtime/function-call-duplicate-ignored', { name: item.name, callId })
      return
    }
    handledRealtimeFunctionCallIdsRef.current.add(callId)

    setActivity('Voice router', item.name ?? 'Tool call')

    let payload: Record<string, unknown>
    try {
      if (item.arguments && item.arguments.length > MAX_REALTIME_FUNCTION_ARGUMENTS_LENGTH) {
        payload = { error: 'Function call arguments were too large.' }
      } else {
        payload = item.arguments ? JSON.parse(item.arguments) : {}
      }
    } catch {
      payload = { error: 'Function call arguments were not valid JSON.' }
    }

    let result: unknown = { ignored: true }
    try {
      if (typeof payload.error === 'string') {
        throw new Error(payload.error)
      }

      if (item.name === 'codex_start_task') {
        setActivity('Voice router', 'Codex starting')
        const goal = requireRealtimeToolText(payload.goal, 'A concrete Codex goal')
        const workspacePath = selectedRoutableWorkspacePath(payload.cwd)
        setDismissedArtifact(null)
        result = await api('/api/codex/task', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cwd: workspacePath,
            goal,
          }),
        })
        const threadId = (result as { thread?: { id?: string } }).thread?.id
        const turnId = (result as { turn?: { id?: string } }).turn?.id
        const artifact = (result as { artifact?: ArtifactPlan | null }).artifact
        setActiveCodexTurn(threadId ?? null, turnId ?? null)
        setPendingArtifact(artifact ?? null)

        if (threadId) {
          const title =
            typeof payload.title === 'string' && payload.title.trim()
              ? boundedPlainString(payload.title.trim(), '', MAX_UI_CONVERSATION_TITLE_LENGTH)
              : titleFromGoal(goal)
          const routedConversation: AgentConversation = {
            id: threadId,
            title,
            age: 'now',
            status: 'running',
            prompt: goal,
            response: '',
            traces: [],
            transcript: [],
            source: 'codex',
            codexThreadId: threadId,
            workspacePath,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }

          setConversationsByWorkspace((current) => ({
            ...current,
            [workspacePath]: mergeConversations(current[workspacePath] ?? [], [routedConversation]),
          }))
          openConversationWindow(workspacePath, routedConversation.id)
          showNotice(artifact ? `Codex is building a preview at ${artifact.relativePath}.` : 'Realtime routed this work to Codex.')
        }
      }

      if (item.name === 'codex_steer_task' && activeThreadIdRef.current) {
        setActivity('Voice router', 'Codex steering')
        const instruction = requireRealtimeToolText(payload.instruction, 'A steering instruction')
        result = await api('/api/codex/steer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threadId: activeThreadIdRef.current, instruction }),
        })
      } else if (item.name === 'codex_steer_task') {
        result = { error: 'No active Codex task is available to steer. Start a task first.' }
      }

      if (item.name === 'codex_interrupt_task' && activeThreadIdRef.current && activeTurnIdRef.current) {
        setActivity('Voice router', 'Codex interrupting')
        result = await api('/api/codex/interrupt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threadId: activeThreadIdRef.current, turnId: activeTurnIdRef.current }),
        })
        setActiveCodexTurn(activeThreadIdRef.current, null)
      } else if (item.name === 'codex_interrupt_task') {
        result = { error: 'No active Codex turn is available to interrupt.' }
      }

      if (item.name === 'get_current_weather') {
        setActivity('Voice router', 'Weather lookup')
        const location = typeof payload.location === 'string' ? payload.location : ''
        const units = payload.units === 'imperial' || payload.units === 'metric' ? payload.units : weatherUnits
        result = await fetchWeather(location, units)
        const weather = result as WeatherResponse
        showNotice(weather.summary)
      }

      if (item.name === 'arduino_upload_sketch') {
        setActivity('Arduino upload', 'Compiling sketch')
        const action = typeof payload.action === 'string' ? payload.action.trim() : ''
        if (!isArduinoUploadAction(action)) {
          throw new Error('A supported Arduino action is required before uploading a sketch.')
        }
        result = await uploadArduinoSketch({
          action,
          port: typeof payload.port === 'string' ? payload.port : undefined,
          fqbn: typeof payload.fqbn === 'string' ? payload.fqbn : undefined,
          sketch: typeof payload.sketch === 'string' ? payload.sketch : undefined,
        })
        const upload = result as ArduinoUploadResponse
        appendEvent('arduino/upload-completed', { action: upload.action, port: upload.port, fqbn: upload.fqbn })
        setActivity('Arduino upload', 'Sketch uploaded')
        showNotice(upload.summary)
      }
    } catch (error) {
      const message = displayErrorMessage(error, 'Realtime tool call failed')
      setLastError(message)
      result = { error: message }
    }

    if (!responseChannel || responseChannel !== dataChannelRef.current || responseChannel.readyState !== 'open') {
      appendEvent('realtime/function-call-output-dropped', { name: item.name, callId: item.call_id })
      return
    }

    responseChannel.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify(result),
        },
      }),
    )
    responseChannel.send(JSON.stringify({ type: 'response.create' }))
  }

  const startVoice = async () => {
    if (voiceStateRef.current !== 'idle') return

    if (!voiceReady) {
      showNotice('Add an OpenAI API key in Settings to start a live Realtime voice session.')
      return
    }

    setLastError(null)
    setVoiceLifecycleState('connecting')
    setVoiceMuted(false)
    setRealtimeTranscript([])
    handledRealtimeFunctionCallIdsRef.current.clear()
    setActivity('Voice router', 'Connecting')
    const sessionId = voiceSessionIdRef.current + 1
    voiceSessionIdRef.current = sessionId
    let pc: RTCPeerConnection | null = null
    const isCurrentVoiceSession = () => voiceSessionIdRef.current === sessionId && peerRef.current === pc

    try {
      pc = new RTCPeerConnection()
      peerRef.current = pc

      audioRef.current = document.createElement('audio')
      audioRef.current.autoplay = true
      pc.ontrack = (event) => {
        if (peerRef.current === pc && audioRef.current) audioRef.current.srcObject = event.streams[0]
      }

      const stream = await getUserMediaWithTimeout({ audio: true })
      if (!isCurrentVoiceSession()) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      microphoneStreamRef.current = stream
      const audioTrack = stream.getAudioTracks()[0]
      if (!audioTrack) {
        throw new Error('No microphone audio track was available.')
      }
      pc.addTrack(audioTrack, stream)
      startWaveform(stream)

      const dataChannel = pc.createDataChannel('oai-events')
      dataChannelRef.current = dataChannel
      const handleRealtimeDisconnect = (message: string) => {
        if (dataChannelRef.current !== dataChannel) return
        cleanupVoiceSession()
        setVoiceLifecycleState('idle')
        setActivity('Voice router idle')
        setLastError(message)
      }
      const activePeer = pc
      pc.addEventListener('connectionstatechange', () => {
        if (peerRef.current === activePeer && ['failed', 'disconnected', 'closed'].includes(activePeer.connectionState)) {
          handleRealtimeDisconnect('Realtime voice connection failed.')
        }
      })
      dataChannel.addEventListener('open', () => {
        setActivity('Voice router', 'Realtime ready')
        flushPendingVisualContext()
      })
      dataChannel.addEventListener('close', () => {
        handleRealtimeDisconnect('Realtime voice session closed.')
      })
      dataChannel.addEventListener('error', () => {
        handleRealtimeDisconnect('Realtime voice data channel failed.')
      })
      dataChannel.addEventListener('message', (event) => {
        if (dataChannelRef.current !== dataChannel) return
        let message: Record<string, unknown>
        try {
          if (typeof event.data !== 'string' || event.data.length > MAX_REALTIME_EVENT_MESSAGE_LENGTH) {
            appendEvent('realtime/message-dropped', {
              reason: typeof event.data === 'string' ? 'too-large' : 'non-string',
              size: typeof event.data === 'string' ? event.data.length : null,
            })
            return
          }
          message = JSON.parse(event.data)
        } catch {
          appendEvent('realtime/message-unreadable')
          return
        }
        recordRealtimeTranscript(message)
        const functionCallItem = realtimeFunctionCallItem(message)
        if (functionCallItem) setActivity('Voice router', functionCallItem.name ?? 'Tool call')
        appendEvent(typeof message.type === 'string' ? message.type : 'realtime/event', message)
        handleRealtimeToolCall(message).catch((error: unknown) => {
          setLastError(displayErrorMessage(error, 'Realtime tool call failed'))
        })
      })

      const offer = await pc.createOffer()
      if (!isCurrentVoiceSession()) return
      await pc.setLocalDescription(offer)
      if (!isCurrentVoiceSession()) return

      const tokenData = await api<Record<string, unknown>>(
        '/api/realtime/token',
        { method: 'POST' },
        { timeoutMs: REALTIME_CONNECTION_TIMEOUT_MS },
      )
      if (!isCurrentVoiceSession()) return
      const ephemeralKey =
        typeof tokenData?.value === 'string'
          ? tokenData.value
          : typeof (tokenData?.client_secret as { value?: unknown } | undefined)?.value === 'string'
            ? (tokenData.client_secret as { value: string }).value
            : ''
      if (!ephemeralKey) throw new Error('Realtime client secret response did not include a token.')

      const answerResponse = await fetchWithTimeout(
        'https://api.openai.com/v1/realtime/calls',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${ephemeralKey}`,
            'Content-Type': 'application/sdp',
          },
          body: offer.sdp,
        },
        REALTIME_CONNECTION_TIMEOUT_MS,
      )
      const answerText = await readBoundedApiText(
        answerResponse,
        answerResponse.ok ? MAX_REALTIME_SDP_RESPONSE_LENGTH : MAX_API_ERROR_RESPONSE_TEXT_LENGTH,
      )
      if (!isCurrentVoiceSession()) return
      if (!answerResponse.ok) throw new Error(boundedApiErrorText(answerText, 'Realtime call failed.'))

      await pc.setRemoteDescription({ type: 'answer', sdp: answerText })
      if (!isCurrentVoiceSession()) return
      setVoiceLifecycleState('live')
      setActivity('Voice router', 'Listening')
      showNotice('Voice is live.')
    } catch (error) {
      const sessionStillCurrent = voiceSessionIdRef.current === sessionId
      cleanupVoiceSession(false)
      if (sessionStillCurrent) {
        setVoiceLifecycleState('idle')
        setActivity('Voice router idle')
        setLastError(displayErrorMessage(error, 'Voice session failed'))
      }
    }
  }

  const stopVoice = () => {
    cleanupVoiceSession()
    setVoiceLifecycleState('idle')
    setActivity('Voice router idle')
    showNotice('Voice session stopped.')
  }

  const toggleVoiceMute = () => {
    const nextMuted = !voiceMuted
    peerRef.current?.getSenders().forEach((sender) => {
      if (sender.track?.kind === 'audio') sender.track.enabled = !nextMuted
    })
    setVoiceMuted(nextMuted)
    setActivity('Voice router', nextMuted ? 'Muted' : 'Listening')
  }

  const shareScreen = async () => {
    setLastError(null)
    let stream: MediaStream | null = null
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      screenStreamRef.current = stream
      setScreenShared(true)
      const videoTrack = stream.getVideoTracks()[0] ?? null
      const handleScreenEnded = () => cleanupScreenShare(stream ?? undefined)
      if (videoTrack) {
        screenEndedTrackRef.current = videoTrack
        screenEndedHandlerRef.current = handleScreenEnded
        videoTrack.addEventListener('ended', handleScreenEnded)
      }
      appendEvent('context/screen-attached', { tracks: stream.getVideoTracks().length })
      const imageDataUrl = await dataUrlFromVideoFrame(stream)
      await analyzeAndAttachVisualContext(imageDataUrl, 'screen')
    } catch (error) {
      setLastError(displayErrorMessage(error, 'Screen share failed'))
    } finally {
      cleanupScreenShare(stream ?? undefined)
    }
  }

  const attachImage = async (file: File | undefined) => {
    if (!file) return
    setLastError(null)
    try {
      validateVisualContextImageFile(file)
      appendEvent('context/image-attached', { name: file.name, size: file.size, type: file.type })
      const imageDataUrl = await dataUrlFromFile(file)
      await analyzeAndAttachVisualContext(imageDataUrl, file.name)
      setAttachedImageName(file.name)
    } catch (error) {
      setLastError(displayErrorMessage(error, 'Image analysis failed'))
    } finally {
      if (imageInputRef.current) imageInputRef.current.value = ''
    }
  }

  const renderVoiceComposerControls = (compact = false) => (
    <section
      className={[
        'voice-composer',
        compact ? 'compact' : '',
        voiceState === 'live' ? 'live' : '',
      ].filter(Boolean).join(' ')}
      aria-label="Voice command composer"
    >
      <div className="voice-composer-controls">
        {voiceState === 'live' ? (
          <>
            <button
              className={transcriptOpen ? 'voice-action active' : 'voice-action'}
              type="button"
              onClick={() => setTranscriptOpen((current) => !current)}
              aria-label="Toggle transcript"
              title="Transcript"
            >
              <Captions size={18} />
            </button>
            <button
              className={voiceMuted ? 'voice-action active' : 'voice-action'}
              type="button"
              onClick={toggleVoiceMute}
              aria-label={voiceMuted ? 'Unmute microphone' : 'Mute microphone'}
              title={voiceMuted ? 'Unmute' : 'Mute'}
            >
              {voiceMuted ? <MicOff size={compact ? 17 : 20} /> : <Mic size={compact ? 17 : 20} />}
            </button>
            <button className="voice-action danger" type="button" onClick={stopVoice} aria-label="Stop voice" title="Stop voice">
              <X size={compact ? 18 : 21} />
            </button>
          </>
        ) : (
          <>
            <button
              className="voice-action primary"
              type="button"
              onClick={startVoice}
              disabled={voiceState === 'connecting' || (status !== null && !voiceReady)}
              aria-label={voiceState === 'connecting' ? 'Connecting voice' : 'Start voice'}
              title={status !== null && !voiceReady ? 'Add OPENAI_API_KEY to start voice' : 'Start voice'}
            >
              <Mic size={compact ? 19 : 24} />
            </button>
            <button
              className={transcriptOpen ? 'voice-action active' : 'voice-action'}
              type="button"
              onClick={() => setTranscriptOpen((current) => !current)}
              aria-label="Toggle transcript"
              title="Transcript"
            >
              <Captions size={18} />
            </button>
            <button
              className={screenShared ? 'voice-action active' : 'voice-action'}
              type="button"
              onClick={() => void shareScreen()}
              aria-label="Share screen"
              title="Share screen"
            >
              <MonitorUp size={18} />
            </button>
            <button
              className={attachedImageName ? 'voice-action active' : 'voice-action'}
              type="button"
              onClick={() => imageInputRef.current?.click()}
              aria-label="Attach image"
              title="Attach image"
            >
              <ImagePlus size={18} />
            </button>
          </>
        )}
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => void attachImage(event.target.files?.[0])}
        />
      </div>
    </section>
  )

  const renderTranscriptPanel = () => (
    <section className="transcript-panel" aria-label="Voice transcript">
      <header>
        <Captions size={15} />
        <span>Transcript</span>
      </header>
      {transcriptLines.length > 0 ? (
        transcriptLines.map((line) => (
          <div className={line.speaker === 'user' ? 'transcript-line user' : 'transcript-line'} key={line.id}>
            <strong>{line.speaker === 'user' ? 'You' : 'Codex'}</strong>
            <span>{line.text}</span>
          </div>
        ))
      ) : (
        <div className="transcript-empty">
          <strong>No transcript yet</strong>
          <span>Start voice and speak. Your words and Codex replies will appear here as the session emits transcript events.</span>
        </div>
      )}
    </section>
  )

  const renderSystemScreen = () => {
    if (activeSystemScreen === 'settings') {
      return (
        <section className="system-screen system-settings">
          <header className="system-page-header">
            <h2>Settings</h2>
          </header>

          <form className="settings-key-form" onSubmit={saveOpenAiApiKey}>
            <label htmlFor="openai-api-key">OpenAI API key</label>
            <div>
              <input
                id="openai-api-key"
                type="password"
                value={openAiApiKeyInput}
                placeholder={
                  status?.realtime
                    ? status.openAiKeySource === 'env'
                      ? 'Configured from .env'
                      : 'Saved locally'
                    : 'sk-...'
                }
                autoComplete="off"
                spellCheck={false}
                disabled={savingOpenAiKey || status?.openAiKeySource === 'env'}
                onChange={(event) => setOpenAiApiKeyInput(event.target.value)}
              />
              <button type="submit" disabled={savingOpenAiKey || !openAiApiKeyInput.trim() || status?.openAiKeySource === 'env'}>
                {savingOpenAiKey ? 'Saving' : 'Save'}
              </button>
              {status?.openAiKeySource === 'settings' && (
                <button type="button" className="secondary" disabled={savingOpenAiKey} onClick={() => void removeOpenAiApiKey()}>
                  Remove
                </button>
              )}
            </div>
            <span>
              {status?.openAiKeySource === 'env'
                ? 'Loaded from .env'
                : status?.openAiKeySource === 'settings'
                  ? 'Saved on this machine'
                  : 'Required for live voice'}
            </span>
          </form>

          <form className="settings-key-form weather-request-form" onSubmit={(event) => void requestWeather(event)}>
            <label htmlFor="weather-location">Current weather</label>
            <div className="weather-request-row">
              <input
                id="weather-location"
                type="text"
                value={weatherLocationInput}
                placeholder={status?.defaultWeatherLocation || 'City or place'}
                autoComplete="off"
                spellCheck={false}
                disabled={weatherLoading}
                onChange={(event) => setWeatherLocationInput(event.target.value)}
              />
              <select value={weatherUnits} disabled={weatherLoading} onChange={(event) => setWeatherUnits(event.target.value as 'metric' | 'imperial')}>
                <option value="metric">Metric</option>
                <option value="imperial">Imperial</option>
              </select>
              <button type="submit" disabled={weatherLoading || weatherLocationInput.trim().length < 2}>
                {weatherLoading ? 'Loading' : 'Get weather'}
              </button>
            </div>
            <span>Uses Open-Meteo for place lookup and current conditions. Voice can use the same weather tool in live sessions.</span>
            {weatherError && <p className="weather-feedback error">{weatherError}</p>}
            {weatherResult && (
              <article className="weather-result-card">
                <strong>{weatherResult.location.name}</strong>
                <span>{weatherResult.summary}</span>
                <small>
                  {weatherResult.current.time}
                  {weatherResult.location.timezone ? ` · ${weatherResult.location.timezone}` : ''}
                </small>
              </article>
            )}
          </form>

          <section className="system-list-panel">
            <article>
              <AudioLines size={18} />
              <div>
                <strong>Voice model</strong>
                <span>
                  {status?.realtime
                    ? [status.realtimeModel, status.realtimeVoice].filter(Boolean).join(' · ')
                    : 'Add OPENAI_API_KEY'}
                </span>
              </div>
            </article>
            <article>
              <Bot size={18} />
              <div>
                <strong>Codex model</strong>
                <span>{status?.codexModel ?? 'Loading'}</span>
              </div>
            </article>
            <article>
              <ImagePlus size={18} />
              <div>
                <strong>Vision context</strong>
                <span>{status?.visionModel ?? status?.codexModel ?? 'Loading'}</span>
              </div>
            </article>
            <article>
              <ShieldCheck size={18} />
              <div>
                <strong>Codex auth</strong>
                <span>{status?.codexApiKey ? 'API key' : 'local account'}</span>
              </div>
            </article>
            <article>
              <Database size={18} />
              <div>
                <strong>USB monitor</strong>
                <span>{status?.usb?.active ? 'Watching Arduino devices' : status?.usb?.error ?? 'Starting watcher'}</span>
              </div>
            </article>
            <article>
              <Bot size={18} />
              <div>
                <strong>Arduino upload</strong>
                <span>
                  {status?.arduino?.available
                    ? `arduino-cli ready · ${status.arduino.defaultFqbn}`
                    : status?.arduino?.error ?? 'Install arduino-cli'}
                </span>
              </div>
            </article>
            <article>
              <UserRound size={18} />
              <div>
                <strong>Voice context</strong>
                <span>
                  {status?.realtimeUser?.name || status?.realtimeUser?.location
                    ? [status.realtimeUser.name, status.realtimeUser.location].filter(Boolean).join(' · ')
                    : 'Runtime context'}
                </span>
              </div>
            </article>
          </section>
        </section>
      )
    }

    if (activeSystemScreen === 'usage') {
      const hasLiveUsage = spend?.source === 'admin-api'
      const costPeak = Math.max(...costBuckets.map((bucket) => bucket.value), spend?.data?.totalCostGbp ?? 0, 1)
      const tokenPeak = Math.max(...tokenBuckets.map((bucket) => bucket.value), tokenTotals.total, 1)

      return (
        <section className="system-screen system-usage">
          <header className="system-page-header usage-header">
            <h2>{hasLiveUsage ? formatGbp(spend?.data?.totalCostGbp) : 'Usage'}</h2>
            <small>
              {hasLiveUsage
                ? `${formatTokens(tokenTotals.total)} tokens over ${spend?.data?.periodDays ?? 30} days`
                : 'Add OPENAI_ADMIN_KEY for live organization usage'}
            </small>
          </header>

          {!hasLiveUsage ? (
            <section className="empty-system-state">
              <Database size={20} />
              <span>{spend?.error ?? 'Admin usage is not configured.'}</span>
            </section>
          ) : (
            <>
              <section className="usage-summary-grid">
                <article>
                  <span>Input</span>
                  <strong>{formatTokens(tokenTotals.input)}</strong>
                </article>
                <article>
                  <span>Output</span>
                  <strong>{formatTokens(tokenTotals.output)}</strong>
                </article>
                <article>
                  <span>Cached</span>
                  <strong>{formatTokens(tokenTotals.cached)}</strong>
                </article>
                <article>
                  <span>Requests</span>
                  <strong>{new Intl.NumberFormat('en-GB').format(tokenTotals.requests)}</strong>
                </article>
              </section>

              {spend?.data?.conversionError && (
                <section className="empty-system-state">
                  <CirclePoundSterling size={20} />
                  <span>{spend.data.conversionError}</span>
                </section>
              )}

              {costBuckets.length > 0 && (
                <div className="usage-breakdown">
                  {costBuckets.map((bucket) => (
                    <article className="usage-row" key={bucket.label}>
                      <div>
                        <span>{bucket.label}</span>
                        <strong>{formatGbp(bucket.value)}</strong>
                      </div>
                      <div className="usage-meter" aria-hidden="true">
                        <span style={{ width: `${Math.max(5, (bucket.value / costPeak) * 100)}%` }} />
                      </div>
                    </article>
                  ))}
                </div>
              )}

              {tokenBuckets.length > 0 && (
                <div className="usage-breakdown token-breakdown">
                  {tokenBuckets.map((bucket) => (
                    <article className="usage-row" key={bucket.label}>
                      <div>
                        <span>{bucket.label}</span>
                        <strong>{formatTokens(bucket.value)} tokens</strong>
                      </div>
                      <div className="usage-meter" aria-hidden="true">
                        <span style={{ width: `${Math.max(5, (bucket.value / tokenPeak) * 100)}%` }} />
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      )
    }

    return (
      <section className="system-screen system-account">
        <header className="profile-summary">
          <div className="profile-avatar">{accountInitials}</div>
          <h2>{accountHandle}</h2>
          <span>{selectedWorkspaceName}</span>
        </header>

        <div className="profile-stats">
          <div>
            <strong>{status?.realtime ? 'Ready' : 'Needs key'}</strong>
            <span>Realtime</span>
          </div>
          <div>
            <strong>{status?.codexApiKey ? 'API key' : 'Local'}</strong>
            <span>Codex</span>
          </div>
          <div>
            <strong>{status?.adminApi ? 'Ready' : 'Off'}</strong>
            <span>Usage</span>
          </div>
        </div>
      </section>
    )
  }

  return (
    <main className={sidebarCollapsed ? 'codex-shell sidebar-collapsed' : 'codex-shell'}>
      <aside className="thread-sidebar">
        <nav className="sidebar-nav" aria-label="Primary">
          <button type="button" onClick={() => void createConversation()}>
            <Plus size={16} />
            New chat
          </button>
          <button type="button" onClick={pickWorkspaceFolder}>
            <Folder size={16} />
            Add workspace
          </button>
          <input
            ref={workspaceInputRef}
            type="file"
            hidden
            multiple
            onChange={(event) => addWorkspaceFromFiles(event.target.files)}
          />
        </nav>

        <section className="sidebar-section workspace-list-section">
          <h2>Workspaces</h2>
          <div className="workspace-tree">
            {workspaceRoots.map(({ workspace, workspacePath, conversations }) => {
              const collapsed = collapsedWorkspaces.includes(workspacePath)
              return (
                <div className="workspace-folder" key={workspace.id}>
                  <div className={selectedWorkspace === workspacePath ? 'workspace-folder-header active' : 'workspace-folder-header'}>
                    <button
                      type="button"
                      className="workspace-folder-row"
                      onClick={() => toggleWorkspace(workspacePath)}
                    >
                      {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                      <Folder size={14} />
                      <span>{workspace.name ?? workspace.id}</span>
                    </button>
                    <button
                      type="button"
                      className="workspace-delete"
                      aria-label={`Remove ${workspace.name ?? workspace.id} from app`}
                      title="Remove from app only"
                      onClick={() => void removeWorkspaceFromApp(workspacePath)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                  {!collapsed && (
                    <div className="agent-thread-list">
                      {conversations.length === 0 ? (
                        <div className="empty-workspace">
                          <span>No threads yet</span>
                          <button type="button" onClick={() => void createConversation(workspacePath)}>
                            Create thread
                          </button>
                        </div>
                      ) : (
                        conversations.map((conversation) => (
                          <div
                            className={
                              selectedConversationId === conversation.id && !activeSystemScreen
                                ? 'agent-thread-row active'
                                : 'agent-thread-row'
                            }
                            key={conversation.id}
                          >
                            <button
                              type="button"
                              className="agent-thread-open"
                              onClick={() => openConversationWindow(workspacePath, conversation.id)}
                              title={conversation.title}
                            >
                              <span>{briefThreadTitle(conversation.title)}</span>
                              <small>{conversation.age}</small>
                            </button>
                            <button
                              type="button"
                              className="agent-thread-delete"
                              aria-label={`Delete ${conversation.title}`}
                              onClick={() => void deleteConversation(workspacePath, conversation.id)}
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </section>

        <section className="sidebar-section account-section">
          <button type="button" className={activeSystemScreen === 'settings' ? 'utility-row active' : 'utility-row'} onClick={() => openSystemScreen('settings')}>
            <Settings size={14} />
            <span>Settings</span>
          </button>
          <button type="button" className={activeSystemScreen === 'usage' ? 'utility-row active' : 'utility-row'} onClick={() => openSystemScreen('usage')}>
            <CirclePoundSterling size={14} />
            <span>Usage</span>
          </button>
          <button type="button" className={activeSystemScreen === 'account' ? 'utility-row active' : 'utility-row'} onClick={() => openSystemScreen('account')}>
            <UserRound size={14} />
            <span>Profile</span>
          </button>
        </section>
      </aside>

      <section className="conversation-pane">
        <header className="pane-titlebar">
          <button
            type="button"
            className="sidebar-toggle"
            aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
            title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
            onClick={() => setSidebarCollapsed((current) => !current)}
          >
            <PanelLeft size={16} />
          </button>
          <div className="pane-context">
            <span>{selectedWorkspaceName}</span>
          </div>
          <div className="titlebar-actions">
            <div className="app-icon-pill" aria-label="Codex">
              <img src="/codex-app-icon.png" alt="" />
            </div>
            {hasDesktopWindowControls && (
              <div className="traffic-controls" aria-label="Window controls">
                <button type="button" className="traffic minimize" aria-label="Minimize window" onClick={() => controlWindow('minimize')} />
                <button type="button" className="traffic maximize" aria-label="Maximize window" onClick={() => controlWindow('maximize')} />
                <button type="button" className="traffic close" aria-label="Close window" onClick={() => controlWindow('close')} />
              </div>
            )}
          </div>
        </header>

        <div className="conversation-scroll">
          {activeSystemScreen ? (
            <>
              {renderSystemScreen()}
              <section className="system-voice-strip" aria-label="Realtime voice controls">
                <div className="system-voice-copy">
                  <strong>{primaryActivity}</strong>
                  <span>{activeThreadId ? 'Steering active Codex work' : 'Ready for voice, screen, or image context'}</span>
                </div>
                {renderVoiceComposerControls(true)}
              </section>
              {transcriptOpen && renderTranscriptPanel()}
            </>
          ) : (
            <section className="voice-home">
              <h1>{voiceHeadline}</h1>

              {renderVoiceComposerControls()}

              <div className="voice-waveform" aria-hidden="true">
                {waveLevels.map((level, index) => (
                  <span key={index} style={{ height: `${8 + level * 38}px`, opacity: 0.3 + level * 0.7 }} />
                ))}
              </div>

              <div className="routing-strip" aria-live="polite">
                <span>{primaryActivity}</span>
              </div>

              {(agentIsWorkingOnArtifact || artifactPreview) && (
                <section
                  className={agentIsWorkingOnArtifact ? 'artifact-stage artifact-stage-building' : 'artifact-stage'}
                  aria-label="Generated artifact preview"
                >
                  <header>
                    <div>
                      <strong>{agentIsWorkingOnArtifact ? 'Codex agents are building' : artifactPreview?.title}</strong>
                      <span>
                        {agentIsWorkingOnArtifact
                          ? pendingArtifact?.relativePath
                          : artifactPreview?.relativePath}
                      </span>
                    </div>
                    {artifactPreview && (
                      <button
                        type="button"
                        aria-label="Close preview"
                        title="Close preview"
                        onClick={() => {
                          setDismissedArtifact({
                            url: artifactPreview.url,
                            updatedAt: artifactPreview.updatedAt,
                            workspacePath: artifactPreview.workspacePath,
                          })
                          setSelectedArtifact(null)
                        }}
                      >
                        <X size={14} />
                      </button>
                    )}
                  </header>

                  {agentIsWorkingOnArtifact ? (
                    <div className="artifact-agents" aria-live="polite">
                      <span />
                      <span />
                      <span />
                    </div>
                  ) : artifactPreview ? (
                    <iframe
                      key={artifactPreview.url}
                      src={artifactPreview.url}
                      title={artifactPreview.title}
                      sandbox="allow-scripts"
                    />
                  ) : null}
                </section>
              )}

              {showSubagentPreview && (
                <section className="preview-shell" aria-label="Sub-agent preview">
                  <span aria-hidden="true" />
                  <strong>{subagentTitle}</strong>
                  <small>{subagentHint}</small>
                </section>
              )}

              {transcriptOpen && renderTranscriptPanel()}
            </section>
          )}
        </div>

        {lastError && <div className="error-strip">{lastError}</div>}
        {notice && <div className="notice-strip">{notice}</div>}

      </section>

    </main>
  )
}

export default App
