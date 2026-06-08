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

const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, init)
  if (!response.ok) {
    const text = await response.text()
    let message: string
    try {
      const body = JSON.parse(text)
      message = typeof body?.error === 'string' ? body.error : text
    } catch {
      message = text
    }
    throw new Error(message || `${response.status} ${response.statusText}`)
  }
  return response.json()
}

const fetchGeneratedArtifacts = (workspacePath: string) =>
  api<{ data: GeneratedArtifact[] }>(`/api/artifacts?workspacePath=${encodeURIComponent(workspacePath)}`)

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')

const briefThreadTitle = (value: string) => value.trim().split(/\s+/).slice(0, 4).join(' ') || 'Untitled'

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
}

const savedConversationPayload = (conversation: AgentConversation) => ({
  ...conversation,
  source: conversation.source === 'codex' ? 'codex' : 'local',
  updatedAt: new Date().toISOString(),
})

const eventKey = (event: EventRecord) => `${event.method ?? 'event'}::${event.receivedAt ?? ''}`

const mergeEvents = (current: EventRecord[], incoming: EventRecord[]) => {
  const seen = new Set<string>()
  return [...incoming, ...current].filter((event) => {
    const key = eventKey(event)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 160)
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
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
  const [dismissedArtifact, setDismissedArtifact] = useState<{ url: string; updatedAt: string } | null>(null)
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
  const microphoneStreamRef = useRef<MediaStream | null>(null)
  const screenStreamRef = useRef<MediaStream | null>(null)
  const pendingVisualContextRef = useRef<{ source: string; summary: string }[]>([])
  const activeThreadIdRef = useRef<string | null>(null)
  const activeTurnIdRef = useRef<string | null>(null)
  const selectedWorkspaceRef = useRef(initialWorkspacePath)
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

  const accountHandle = selectedWorkspace.split('/').filter(Boolean)[1] ?? status?.realtimeUser?.name ?? 'local'
  const accountInitials = accountHandle.slice(0, 2).toUpperCase()
  const hasDesktopWindowControls = Boolean((window as DesktopWindow).desktopWindow)
  const defaultWorkspacePath = status?.appRoot ?? initialWorkspacePath
  const fallbackWorkspaces = useMemo<Workspace[]>(() => {
    if (!defaultWorkspacePath) return []
    return [{
      id: defaultWorkspacePath,
      name: status?.appName ?? defaultWorkspacePath.split('/').filter(Boolean).pop() ?? 'Local workspace',
      path: defaultWorkspacePath,
    }]
  }, [defaultWorkspacePath, status?.appName])

  const workspaceSource = useMemo(() => {
    const discovered = workspaces.length > 0 ? workspaces : fallbackWorkspaces
    const seen = new Set<string>()

    return [...userWorkspaces, ...discovered].filter((workspace) => {
      const workspacePath = workspace.path ?? workspace.id
      if (hiddenWorkspacePaths.includes(workspacePath)) return false
      if (seen.has(workspacePath)) return false
      seen.add(workspacePath)
      return true
    })
  }, [fallbackWorkspaces, hiddenWorkspacePaths, userWorkspaces, workspaces])
  const workspaceRoots = workspaceSource.slice(0, 8).map((workspace) => {
    const workspacePath = workspace.path ?? workspace.id
    const conversations = conversationsByWorkspace[workspacePath] ?? []
    return { workspace, workspacePath, conversations }
  })
  const selectedWorkspaceConversations =
    workspaceRoots.find(({ workspacePath }) => workspacePath === selectedWorkspace)?.conversations ?? []
  const activeConversation =
    selectedWorkspaceConversations.find((conversation) => conversation.id === selectedConversationId) ??
    selectedWorkspaceConversations[0]
  const transcriptLines = realtimeTranscript
  const voiceReady = status?.realtime ?? false
  const selectedWorkspaceName =
    workspaceRoots.find(({ workspacePath }) => workspacePath === selectedWorkspace)?.workspace.name ??
    workspaceRoots[0]?.workspace.name ??
    'No workspace'
  const voiceHeadline =
    voiceState === 'live'
      ? activeThreadId
        ? 'Steer Codex by voice'
        : 'Tell Codex what to build'
      : `What should we build in ${selectedWorkspaceName}?`
  const primaryActivity = [routingActivity[0] ?? 'Voice router idle', visualContextLabel].filter(Boolean).join(' · ')
  const showSubagentPreview = Boolean(activeThreadId)
  const artifactPreview = selectedArtifact && selectedArtifact.url !== dismissedArtifact?.url ? selectedArtifact : null
  const agentIsWorkingOnArtifact = Boolean(pendingArtifact && activeThreadId)
  const subagentTitle = activeConversation?.title ? briefThreadTitle(activeConversation.title) : 'Codex'
  const subagentHint =
    activeConversation?.prompt || activeConversation?.response || 'Working through the active Codex turn.'

  const appendEvent = (method: string, params?: Record<string, unknown>) => {
    setEvents((current) => mergeEvents(current, [{ method, receivedAt: new Date().toISOString(), params }]))
  }

  const showNotice = (message: string) => {
    setNotice(message)
    setLastError(null)
  }

  const setActivity = (...items: string[]) => {
    setRoutingActivity(items.length > 0 ? items.slice(0, 4) : ['Voice router idle'])
  }

  const setActiveCodexTurn = (threadId: string | null, turnId: string | null) => {
    activeThreadIdRef.current = threadId
    activeTurnIdRef.current = turnId
    setActiveThreadId(threadId)
    setActiveTurnId(turnId)
  }

  const updateTranscriptLine = (
    id: string,
    speaker: TranscriptLine['speaker'],
    text: string,
    mode: 'append' | 'replace',
    status: TranscriptLine['status'],
  ) => {
    if (!text) return
    setRealtimeTranscript((current) => {
      const index = current.findIndex((line) => line.id === id)
      if (index === -1) {
        return [...current, { id, speaker, text, status, createdAt: Date.now() }].slice(-80)
      }

      const next = [...current]
      const existing = next[index]
      next[index] = {
        ...existing,
        speaker,
        text: mode === 'append' ? `${existing.text}${text}` : text,
        status,
      }
      return next
    })
  }

  const recordRealtimeTranscript = (message: Record<string, unknown>) => {
    const type = typeof message.type === 'string' ? message.type : ''
    const itemId = typeof message.item_id === 'string'
      ? message.item_id
      : typeof message.response_id === 'string'
        ? message.response_id
        : typeof message.event_id === 'string'
          ? message.event_id
          : `${type}-${Date.now()}`

    if (type === 'conversation.item.input_audio_transcription.delta') {
      updateTranscriptLine(`user-${itemId}`, 'user', typeof message.delta === 'string' ? message.delta : '', 'append', 'streaming')
      return
    }

    if (type === 'conversation.item.input_audio_transcription.completed') {
      updateTranscriptLine(`user-${itemId}`, 'user', typeof message.transcript === 'string' ? message.transcript : '', 'replace', 'done')
      return
    }

    if (type === 'conversation.item.input_audio_transcription.segment') {
      updateTranscriptLine(`user-${itemId}`, 'user', typeof message.text === 'string' ? message.text : '', 'replace', 'done')
      return
    }

    if (type === 'response.output_audio_transcript.delta' || type === 'response.output_text.delta') {
      updateTranscriptLine(`codex-${itemId}`, 'codex', typeof message.delta === 'string' ? message.delta : '', 'append', 'streaming')
      return
    }

    if (type === 'response.output_audio_transcript.done') {
      updateTranscriptLine(`codex-${itemId}`, 'codex', typeof message.transcript === 'string' ? message.transcript : '', 'replace', 'done')
      return
    }

    if (type === 'response.output_text.done') {
      updateTranscriptLine(`codex-${itemId}`, 'codex', typeof message.text === 'string' ? message.text : '', 'replace', 'done')
    }
  }

  const stopWaveform = () => {
    if (waveformFrameRef.current) window.cancelAnimationFrame(waveformFrameRef.current)
    waveformFrameRef.current = null
    analyserRef.current = null
    audioContextRef.current?.close().catch(() => {})
    audioContextRef.current = null
    setWaveLevels(Array.from({ length: 18 }, () => 0.18))
  }

  const cleanupVoiceSession = () => {
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
  }

  const cleanupScreenShare = (stream = screenStreamRef.current) => {
    stream?.getTracks().forEach((track) => track.stop())
    if (!stream || screenStreamRef.current === stream) {
      screenStreamRef.current = null
      setScreenShared(false)
    }
  }

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

  const fileToDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read image'))
      reader.readAsDataURL(file)
    })

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
    const rawDataUrl = await fileToDataUrl(file)
    const image = new Image()
    image.src = rawDataUrl
    await image.decode()
    return imageToJpegDataUrl(image, image.naturalWidth, image.naturalHeight)
  }

  const dataUrlFromVideoFrame = async (stream: MediaStream) => {
    const video = document.createElement('video')
    video.srcObject = stream
    video.muted = true
    try {
      await new Promise<void>((resolve) => {
        if (video.videoWidth > 0) resolve()
        else video.onloadedmetadata = () => resolve()
      })
      await video.play()
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
                'Interrupt now with one short funny spoken joke using the current realtime persona.',
                'Keep it under 18 words, dry and playful, then stop.',
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

  const refreshArtifacts = useCallback(async (workspacePath = selectedWorkspaceRef.current || status?.appRoot || initialWorkspacePath) => {
    if (!workspacePath) {
      setArtifacts([])
      return []
    }
    const data = await fetchGeneratedArtifacts(workspacePath)
    setArtifacts(data.data)
    return data.data
  }, [status?.appRoot])

  const selectLatestArtifact = useCallback((artifactData: GeneratedArtifact[]) => {
    setSelectedArtifact((current) => {
      if (current && artifactData.some((artifact) => artifact.url === current.url)) return current
      const dismissedTime = dismissedArtifact ? Date.parse(dismissedArtifact.updatedAt) : null
      return artifactData.find((artifact) => {
        if (artifact.url === dismissedArtifact?.url) return false
        if (dismissedTime != null) return Date.parse(artifact.updatedAt) > dismissedTime
        return true
      }) ?? null
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
      const message = error instanceof Error ? error.message : 'Weather lookup failed'
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
      setLastError(error instanceof Error ? error.message : 'Failed to save OpenAI API key')
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
      setLastError(error instanceof Error ? error.message : 'Failed to remove OpenAI API key')
    } finally {
      setSavingOpenAiKey(false)
    }
  }

  const openConversationWindow = (workspacePath: string, conversationId: string) => {
    setSelectedWorkspace(workspacePath)
    setSelectedConversationId(conversationId)
    setActiveSystemScreen(null)
    setNotice(null)
    setLastError(null)
  }

  const createConversation = async (targetWorkspacePath?: string) => {
    const workspacePath = targetWorkspacePath || selectedWorkspace || workspaceRoots[0]?.workspacePath || status?.appRoot || initialWorkspacePath
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
      [workspacePath]: [conversation, ...(current[workspacePath] ?? existing)],
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
      setLastError(error instanceof Error ? error.message : 'Failed to save agent conversation')
    }
  }

  const addWorkspaceFromFolder = async ({ name: rawName, path: rawPath }: { name: string; path?: string }) => {
    const name = rawName.trim() || 'New workspace'
    const workspacePath = rawPath?.trim() ?? ''
    if (!workspacePath) {
      setLastError('A real local folder path is required. Launch the desktop app and use Add workspace from there.')
      return
    }
    const workspace = { id: workspacePath, name, path: workspacePath }

    setUserWorkspaces((current) => [workspace, ...current])
    setConversationsByWorkspace((current) => ({ ...current, [workspacePath]: current[workspacePath] ?? [] }))
    setCollapsedWorkspaces((current) => current.filter((item) => item !== workspacePath))
    setSelectedWorkspace(workspacePath)
    setSelectedConversationId('')
    setActiveSystemScreen(null)
    showNotice(`${name} added as a workspace. Create a new agent conversation when you are ready.`)

    try {
      await api('/api/app-state/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace }),
      })
    } catch (error) {
      setLastError(error instanceof Error ? error.message : 'Failed to save workspace')
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
      setLastError(error instanceof Error ? error.message : 'Failed to open folder picker')
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
      setLastError(error instanceof Error ? error.message : 'Failed to delete agent conversation')
    }
  }

  const removeWorkspaceFromApp = async (workspacePath: string) => {
    const nextWorkspace = workspaceRoots.find((root) => root.workspacePath !== workspacePath)

    setHiddenWorkspacePaths((current) => [...new Set([...current, workspacePath])])
    setUserWorkspaces((current) => current.filter((workspace) => (workspace.path ?? workspace.id) !== workspacePath))
    setCollapsedWorkspaces((current) => current.filter((item) => item !== workspacePath))

    if (selectedWorkspace === workspacePath) {
      if (nextWorkspace) {
        setSelectedWorkspace(nextWorkspace.workspacePath)
        setSelectedConversationId(nextWorkspace.conversations[0]?.id ?? '')
        setActiveSystemScreen(null)
      } else {
        setSelectedWorkspace('')
        setSelectedConversationId('')
        setActiveSystemScreen('settings')
      }
    }

    showNotice('Workspace removed from this app. The local folder was not deleted.')

    try {
      await api('/api/app-state/workspaces/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacePath }),
      })
    } catch (error) {
      setLastError(error instanceof Error ? error.message : 'Failed to remove workspace')
    }
  }

  const toggleWorkspace = (workspacePath: string) => {
    const firstConversation =
      conversationsByWorkspace[workspacePath]?.[0] ??
      workspaceRoots.find((root) => root.workspacePath === workspacePath)?.conversations[0]

    setSelectedWorkspace(workspacePath)
    setActiveSystemScreen(null)
    if (firstConversation) {
      setSelectedConversationId(firstConversation.id)
    } else {
      setSelectedConversationId('')
    }
    setCollapsedWorkspaces((current) =>
      current.includes(workspacePath) ? current.filter((item) => item !== workspacePath) : [...current, workspacePath],
    )
  }

  const openSystemScreen = (screen: SystemScreen) => {
    setActiveSystemScreen(screen)
    setNotice(null)
    setLastError(null)
  }

  const controlWindow = (action: 'minimize' | 'maximize' | 'close') => {
    const desktopWindow = (window as DesktopWindow).desktopWindow
    if (action === 'minimize') desktopWindow?.minimize()
    if (action === 'maximize') desktopWindow?.maximize()
    if (action === 'close') desktopWindow?.close()
  }

  useEffect(() => {
    workspaceInputRef.current?.setAttribute('webkitdirectory', '')
    workspaceInputRef.current?.setAttribute('directory', '')
  }, [])

  useEffect(() => {
    selectedWorkspaceRef.current = selectedWorkspace
    refreshArtifacts(selectedWorkspace)
      .then(selectLatestArtifact)
      .catch(() => undefined)
  }, [refreshArtifacts, selectLatestArtifact, selectedWorkspace])

  useEffect(() => {
    activeThreadIdRef.current = activeThreadId
  }, [activeThreadId])

  useEffect(() => {
    activeTurnIdRef.current = activeTurnId
  }, [activeTurnId])

  useEffect(() => {
    if (!notice) return undefined
    const timeout = window.setTimeout(() => setNotice(null), 3600)
    return () => window.clearTimeout(timeout)
  }, [notice])

  useEffect(() => {
    const load = async () => {
      try {
        const [statusData, workspaceData, spendData, appStateData] = await Promise.all([
          api<Status>('/api/status'),
          api<{ data: Workspace[] }>('/api/workspaces'),
          api<SpendResponse>('/api/spend'),
          api<AppStateResponse>('/api/app-state'),
        ])
        const runtimeFallbackWorkspaces = statusData.appRoot
          ? [{
              id: statusData.appRoot,
              name: statusData.appName ?? statusData.appRoot.split('/').filter(Boolean).pop() ?? 'Local workspace',
              path: statusData.appRoot,
            }]
          : []
        const roots = (workspaceData.data.length > 0 ? workspaceData.data : runtimeFallbackWorkspaces).slice(0, 5)
        const savedWorkspaces = appStateData.workspaces ?? []
        const hiddenPaths = appStateData.hiddenWorkspacePaths ?? []
        const savedConversationState = appStateData.conversationsByWorkspace ?? {}
        const visibleRoots = roots.filter((workspace) => !hiddenPaths.includes(workspace.path ?? workspace.id))
        const visibleSavedWorkspaces = savedWorkspaces.filter((workspace) => !hiddenPaths.includes(workspace.path ?? workspace.id))
        const firstPath = visibleRoots[0]?.path ?? visibleRoots[0]?.id ?? ''
        const preferredPath = visibleSavedWorkspaces[0]?.path ?? visibleSavedWorkspaces[0]?.id ?? firstPath
        const firstConversation = preferredPath ? savedConversationState[preferredPath]?.[0] ?? null : null

        setStatus(statusData)
        setWorkspaces(workspaceData.data)
        setUserWorkspaces(savedWorkspaces)
        setHiddenWorkspacePaths(appStateData.hiddenWorkspacePaths ?? [])
        setSpend(spendData)
        setWeatherLocationInput((current) =>
          current.trim() || !statusData.defaultWeatherLocation ? current : statusData.defaultWeatherLocation ?? '',
        )
        if (preferredPath) {
          fetchGeneratedArtifacts(preferredPath)
            .then((artifactData) => {
              setArtifacts(artifactData.data)
              setSelectedArtifact((current) => current ?? artifactData.data[0] ?? null)
            })
            .catch(() => undefined)
        }
        setConversationsByWorkspace(() => {
          const next = { ...savedConversationState }
          roots.forEach((workspace) => {
            const workspacePath = workspace.path ?? workspace.id
            if (!next[workspacePath]) next[workspacePath] = []
          })
          return next
        })
        setSelectedWorkspace(preferredPath)
        setSelectedConversationId(firstConversation?.id ?? '')

        api<CodexThreadsResponse>('/api/codex/threads?limit=40')
          .then((threadData) => {
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
            setEvents((current) =>
              mergeEvents(current, [{
                method: 'codex/thread-list-unavailable',
                receivedAt: new Date().toISOString(),
                params: { message: error instanceof Error ? error.message : 'Codex app-server thread list failed' },
              }]),
            )
          })
      } catch (error) {
        setLastError(error instanceof Error ? error.message : 'Failed to load app state')
      }
    }

    load()
  }, [])

  useEffect(() => {
    const interval = window.setInterval(async () => {
      try {
        const data = await api<{ data: EventRecord[] }>('/api/codex/events')
        setEvents((current) => mergeEvents(current, data.data))
      } catch {
        // The app-server may not be started until the first Codex action.
      }
    }, 1800)

    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    const pollArtifacts = async () => {
      try {
        const artifactData = await refreshArtifacts(pendingArtifact?.workspacePath ?? selectedWorkspaceRef.current)
        if (!pendingArtifact) {
          selectLatestArtifact(artifactData)
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
        // Artifact polling should not interrupt voice or Codex work.
      }
    }

    void pollArtifacts()
    const interval = window.setInterval(() => void pollArtifacts(), pendingArtifact ? 1500 : 5000)
    return () => window.clearInterval(interval)
  }, [pendingArtifact, refreshArtifacts, selectLatestArtifact])

  useEffect(() => {
    const pollUsbEvents = async () => {
      try {
        const data = await api<UsbEventsResponse>(`/api/usb/events${usbInitializedRef.current ? '' : '?scan=true'}`)
        setStatus((current) => current ? { ...current, usb: data.status } : current)

        const unseen = data.data
          .filter((event) => !seenUsbEventIdsRef.current.has(event.id))
          .sort((a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime())

        for (const event of unseen) {
          seenUsbEventIdsRef.current.add(event.id)
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
            setActivity('USB noticed', injected ? 'Realtime joke' : 'Arduino connected')
            showNotice(
              injected
                ? `Arduino noticed: ${event.summary}`
                : `Arduino noticed: ${event.summary}. Start voice to hear Codex react.`,
            )
          }
        }
      } catch (error) {
        setStatus((current) =>
          current
            ? {
                ...current,
                usb: {
                  active: false,
                  startedAt: current.usb?.startedAt ?? null,
                  error: error instanceof Error ? error.message : 'USB monitor unavailable',
                },
              }
            : current,
        )
      }
    }

    void pollUsbEvents()
    const interval = window.setInterval(() => void pollUsbEvents(), 1200)
    return () => window.clearInterval(interval)
  }, [])

  const handleRealtimeToolCall = async (message: Record<string, unknown>) => {
    const item = message.item as { type?: string; name?: string; arguments?: string; call_id?: string } | undefined
    if (message.type !== 'response.output_item.done' || item?.type !== 'function_call') return

    if (typeof item.call_id !== 'string' || !item.call_id.trim()) {
      const error = 'Realtime function call did not include a call_id.'
      setLastError(error)
      appendEvent('realtime/function-call-invalid', { error, name: item.name })
      return
    }

    setActivity('Voice router', item.name ?? 'Tool call')

    let payload: Record<string, unknown>
    try {
      payload = item.arguments ? JSON.parse(item.arguments) : {}
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
        if (typeof payload.goal !== 'string' || !payload.goal.trim()) {
          throw new Error('A concrete Codex goal is required before routing work.')
        }
        const goal = payload.goal.trim()
        const workspacePath =
          typeof payload.cwd === 'string' && payload.cwd.trim()
            ? payload.cwd.trim()
                          : selectedWorkspaceRef.current || status?.appRoot || initialWorkspacePath
        if (!workspacePath) {
          throw new Error('Select a workspace before routing work to Codex.')
        }
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
              ? payload.title.trim()
              : titleFromGoal(goal)
          const routedConversation: AgentConversation = {
            id: threadId,
            title,
            age: 'now',
            status: 'running',
            prompt: goal,
            response: 'Codex harness is working on this through app-server.',
            traces: ['Routed by Realtime voice', 'Codex app-server thread started', `Workspace: ${workspacePath}`],
            transcript: [
              { speaker: 'user', text: goal },
              { speaker: 'codex', text: 'Routed to Codex app-server.' },
            ],
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
        if (typeof payload.instruction !== 'string' || !payload.instruction.trim()) {
          throw new Error('A steering instruction is required.')
        }
        result = await api('/api/codex/steer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threadId: activeThreadIdRef.current, instruction: payload.instruction.trim() }),
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
        const units = payload.units === 'imperial' ? 'imperial' : 'metric'
        result = await fetchWeather(location, units)
        const weather = result as WeatherResponse
        showNotice(weather.summary)
      }

      if (item.name === 'arduino_upload_sketch') {
        setActivity('Arduino upload', 'Compiling sketch')
        const action =
          payload.action === 'onboard_led_blink' || payload.action === 'custom_sketch'
            ? payload.action
            : 'onboard_led_on'
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
      const message = error instanceof Error ? error.message : 'Realtime tool call failed'
      setLastError(message)
      result = { error: message }
    }

    dataChannelRef.current?.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: item.call_id,
          output: JSON.stringify(result),
        },
      }),
    )
    dataChannelRef.current?.send(JSON.stringify({ type: 'response.create' }))
  }

  const startVoice = async () => {
    if (!voiceReady) {
      showNotice('Add an OpenAI API key in Settings to start a live Realtime voice session.')
      return
    }

    setLastError(null)
    setVoiceState('connecting')
    setVoiceMuted(false)
    setRealtimeTranscript([])
    setActivity('Voice router', 'Connecting')

    try {
      const pc = new RTCPeerConnection()
      peerRef.current = pc

      audioRef.current = document.createElement('audio')
      audioRef.current.autoplay = true
      pc.ontrack = (event) => {
        if (audioRef.current) audioRef.current.srcObject = event.streams[0]
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
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
        setVoiceState('idle')
        setActivity('Voice router idle')
        setLastError(message)
      }
      pc.addEventListener('connectionstatechange', () => {
        if (peerRef.current === pc && ['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
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
        let message: Record<string, unknown>
        try {
          message = JSON.parse(event.data)
        } catch {
          appendEvent('realtime/message-unreadable')
          return
        }
        recordRealtimeTranscript(message)
        if (typeof message?.type === 'string' && message.type.startsWith('response.output_item')) {
          const item = message.item as { type?: string; name?: string } | undefined
          if (item?.type === 'function_call') setActivity('Voice router', item.name ?? 'Tool call')
        }
        setEvents((current) =>
          mergeEvents(current, [{
            method: typeof message.type === 'string' ? message.type : 'realtime/event',
            receivedAt: new Date().toISOString(),
            params: message,
          }]),
        )
        handleRealtimeToolCall(message).catch((error: unknown) => {
          setLastError(error instanceof Error ? error.message : 'Realtime tool call failed')
        })
      })

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)

      const tokenResponse = await fetch('/api/realtime/token', { method: 'POST' })
      const tokenData = await tokenResponse.json().catch(() => ({}))
      if (!tokenResponse.ok) {
        throw new Error(
          typeof tokenData?.error === 'string'
            ? tokenData.error
            : 'Failed to create Realtime client secret.',
        )
      }
      const ephemeralKey =
        typeof tokenData?.value === 'string'
          ? tokenData.value
          : typeof tokenData?.client_secret?.value === 'string'
            ? tokenData.client_secret.value
            : ''
      if (!ephemeralKey) throw new Error('Realtime client secret response did not include a token.')

      const answerResponse = await fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ephemeralKey}`,
          'Content-Type': 'application/sdp',
        },
        body: offer.sdp,
      })
      if (!answerResponse.ok) throw new Error(await answerResponse.text())

      await pc.setRemoteDescription({ type: 'answer', sdp: await answerResponse.text() })
      setVoiceState('live')
      setActivity('Voice router', 'Listening')
      showNotice('Voice is live.')
    } catch (error) {
      cleanupVoiceSession()
      setVoiceState('idle')
      setActivity('Voice router idle')
      setLastError(error instanceof Error ? error.message : 'Voice session failed')
    }
  }

  const stopVoice = () => {
    cleanupVoiceSession()
    setVoiceState('idle')
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
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        cleanupScreenShare(stream ?? undefined)
      })
      appendEvent('context/screen-attached', { tracks: stream.getVideoTracks().length })
      const imageDataUrl = await dataUrlFromVideoFrame(stream)
      await analyzeAndAttachVisualContext(imageDataUrl, 'screen')
    } catch (error) {
      setLastError(error instanceof Error ? error.message : 'Screen share failed')
    } finally {
      cleanupScreenShare(stream ?? undefined)
    }
  }

  const attachImage = async (file: File | undefined) => {
    if (!file) return
    setLastError(null)
    try {
      setAttachedImageName(file.name)
      appendEvent('context/image-attached', { name: file.name, size: file.size, type: file.type })
      const imageDataUrl = await dataUrlFromFile(file)
      await analyzeAndAttachVisualContext(imageDataUrl, file.name)
    } catch (error) {
      setLastError(error instanceof Error ? error.message : 'Image analysis failed')
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
                placeholder="Berlin"
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
                          setDismissedArtifact({ url: artifactPreview.url, updatedAt: artifactPreview.updatedAt })
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
