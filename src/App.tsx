import {
  AudioLines,
  Bot,
  Captions,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDollarSign,
  Folder,
  ImagePlus,
  Mic,
  MonitorUp,
  Pause,
  Play,
  Plus,
  Radio,
  Search,
  Settings,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  UserRound,
  Wand2,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

type Status = {
  realtime: boolean
  adminApi: boolean
  codexApiKey: boolean
  codexAuthPreference: string
  realtimeModel: string
  codexModel: string
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
  status: 'draft' | 'ready' | 'running' | 'review'
  prompt: string
  response: string
  traces: string[]
  transcript: { speaker: 'user' | 'codex'; text: string }[]
}

type EventRecord = {
  method?: string
  receivedAt?: string
  params?: Record<string, unknown>
}

type SpendResponse = {
  source: string
  data: {
    total?: number
    currency?: string
    buckets?: { label: string; value: number }[]
  }
}

type RateLimitResponse = {
  rateLimits?: {
    primary?: {
      usedPercent?: number
      windowDurationMins?: number
      resetsAt?: number
    }
  }
}

type DiffLine = {
  kind: 'add' | 'remove' | 'plain'
  text: string
}

type SystemScreen = 'settings' | 'usage' | 'account'

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: () => Promise<{ name?: string }>
}

const initialWorkspacePath = '/home/sergiopesch/codex-realtime-linux'

const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, init)
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `${response.status} ${response.statusText}`)
  }
  return response.json()
}

const fallbackWorkspaces: Workspace[] = [
  { id: 'codex-realtime-linux', name: 'codex-realtime-linux', path: initialWorkspacePath },
]

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')

const conversationCopy: Record<string, Omit<AgentConversation, 'id' | 'age' | 'status'>> = {
  'Realtime Linux MVP': {
    title: 'Realtime Linux MVP',
    prompt: 'Build a voice-first Codex desktop demo for Linux. No text composer.',
    response:
      'I’ll coordinate the Codex execution layer from live speech, keep the review pane visible, and treat screen or image context as explicit inputs.',
    traces: ['Mapped workspace-first navigation', 'Kept voice as the primary command path', 'Separated review from realtime direction'],
    transcript: [
      { speaker: 'user', text: 'I want this to feel like Codex, but the main action is talking.' },
      { speaker: 'codex', text: 'I’ll keep the center surface voice-led and make transcript optional.' },
    ],
  },
  'Connect voice harness': {
    title: 'Connect voice harness',
    prompt: 'Wire realtime speech to Codex task creation, steering, and interruption.',
    response:
      'The voice layer starts Codex tasks, sends steering instructions, and can interrupt a running build without switching into a text composer.',
    traces: ['Realtime data channel receives tool calls', 'Codex app-server starts task turns', 'Interrupt stays available in the voice dock'],
    transcript: [
      { speaker: 'user', text: 'Start a task, but let me interrupt if the product direction changes.' },
      { speaker: 'codex', text: 'I’ll keep the build running behind the voice conversation and expose interrupt in the dock.' },
    ],
  },
  'Review spending widgets': {
    title: 'Review spending widgets',
    prompt: 'Show usage and cost clearly without making it the primary task surface.',
    response:
      'Usage belongs in the review/system context: visible when needed, but secondary to the realtime collaboration loop.',
    traces: ['Usage appears in right pane', 'System Usage screen has details', 'Voice dock remains persistent'],
    transcript: [
      { speaker: 'user', text: 'I need to know what I’m spending while building.' },
      { speaker: 'codex', text: 'I’ll keep spend visible and make deeper usage a system screen.' },
    ],
  },
  'Browser-use checkpoint': {
    title: 'Browser-use checkpoint',
    prompt: 'Reserve a browser/computer-use viewport for Codex QA and visual context.',
    response:
      'The browser panel stays inspectable while the voice conversation continues. Screen context can be attached explicitly from the dock.',
    traces: ['Computer-use viewport reserved', 'Screen context is explicit', 'Browser QA remains a background agent lane'],
    transcript: [
      { speaker: 'user', text: 'I want the agent to see what I’m seeing and keep building.' },
      { speaker: 'codex', text: 'Share screen from the voice dock, then steer the agent conversationally.' },
    ],
  },
}

const makeConversation = (
  workspacePath: string,
  title: string,
  age: string,
  status: AgentConversation['status'] = 'ready',
): AgentConversation => {
  const copy = conversationCopy[title] ?? {
    title,
    prompt: 'Describe the next build step out loud.',
    response: 'This agent conversation is ready for realtime voice direction.',
    traces: ['Workspace selected', 'Voice direction pending', 'Codex execution ready'],
    transcript: [
      { speaker: 'user' as const, text: 'Create a new agent conversation for this workspace.' },
      { speaker: 'codex' as const, text: 'Ready. Start voice and describe the build goal.' },
    ],
  }

  return {
    ...copy,
    id: `${workspacePath}::${slug(title)}`,
    age,
    status,
  }
}

const defaultConversationsForWorkspace = (workspacePath: string, index: number) =>
  ['Realtime Linux MVP', 'Connect voice harness', ...(index === 0 ? ['Review spending widgets', 'Browser-use checkpoint'] : [])].map(
    (title, titleIndex) => makeConversation(workspacePath, title, titleIndex === 0 ? 'now' : `${titleIndex}h`, titleIndex === 2 ? 'review' : 'ready'),
  )

const diffFiles: { path: string; plus: number; minus: number; lines: DiffLine[] }[] = [
  {
    path: 'src/App.tsx',
    plus: 3,
    minus: 2,
    lines: [
      { kind: 'remove', text: 'const composer = <TextInput />' },
      { kind: 'remove', text: 'placeholder="Ask Codex anything"' },
      { kind: 'add', text: 'const voiceDock = <RealtimeVoiceDock />' },
      { kind: 'add', text: 'mode="voice-first"' },
      { kind: 'add', text: 'onInterrupt={steerCodexAgents}' },
    ],
  },
  {
    path: 'electron/main.cjs',
    plus: 2,
    minus: 1,
    lines: [
      { kind: 'plain', text: 'const { app, BrowserWindow } = require("electron")' },
      { kind: 'remove', text: 'loadURL("http://localhost:5173")' },
      { kind: 'add', text: 'loadURL(process.env.VITE_DEV_SERVER_URL)' },
      { kind: 'add', text: 'backgroundColor: "#050505"' },
    ],
  },
]

function DiffCard({
  file,
  accepted,
  onAccept,
  onDismiss,
}: {
  file: (typeof diffFiles)[number]
  accepted: boolean
  onAccept: () => void
  onDismiss: () => void
}) {
  return (
    <article className={accepted ? 'diff-card accepted' : 'diff-card'}>
      <header className="diff-card-header">
        <span>{file.path}</span>
        <div>
          {accepted && <small>accepted</small>}
          <button type="button" aria-label={`Dismiss ${file.path}`} onClick={onDismiss}>
            <X size={13} />
          </button>
          <button type="button" aria-label={`Accept ${file.path}`} onClick={onAccept}>
            <Check size={13} />
          </button>
        </div>
      </header>
      <pre className="diff-lines">
        {file.lines.map((line, index) => (
          <code className={`diff-line ${line.kind}`} key={`${file.path}-${index}`}>
            {line.kind === 'add' ? '+ ' : line.kind === 'remove' ? '- ' : '  '}
            {line.text}
          </code>
        ))}
      </pre>
    </article>
  )
}

function App() {
  const [status, setStatus] = useState<Status | null>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [userWorkspaces, setUserWorkspaces] = useState<Workspace[]>([])
  const [conversationsByWorkspace, setConversationsByWorkspace] = useState<Record<string, AgentConversation[]>>({
    [initialWorkspacePath]: defaultConversationsForWorkspace(initialWorkspacePath, 0),
  })
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<string[]>([])
  const [selectedWorkspace, setSelectedWorkspace] = useState(initialWorkspacePath)
  const [selectedConversationId, setSelectedConversationId] = useState(`${initialWorkspacePath}::realtime-linux-mvp`)
  const [openConversationIds, setOpenConversationIds] = useState([`${initialWorkspacePath}::realtime-linux-mvp`])
  const [activeSystemScreen, setActiveSystemScreen] = useState<SystemScreen | null>(null)
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  const [spend, setSpend] = useState<SpendResponse | null>(null)
  const [rateLimits, setRateLimits] = useState<RateLimitResponse | null>(null)
  const [events, setEvents] = useState<EventRecord[]>([])
  const [voiceState, setVoiceState] = useState<'idle' | 'connecting' | 'live'>('idle')
  const [screenShared, setScreenShared] = useState(false)
  const [attachedImageName, setAttachedImageName] = useState<string | null>(null)
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [buildState, setBuildState] = useState<'idle' | 'starting' | 'running'>('idle')
  const [notice, setNotice] = useState<string | null>(null)
  const [reviewOpen, setReviewOpen] = useState(true)
  const [visibleDiffPaths, setVisibleDiffPaths] = useState(() => diffFiles.map((file) => file.path))
  const [acceptedDiffPaths, setAcceptedDiffPaths] = useState<string[]>([])
  const [lastError, setLastError] = useState<string | null>(null)
  const peerRef = useRef<RTCPeerConnection | null>(null)
  const dataChannelRef = useRef<RTCDataChannel | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const workspaceInputRef = useRef<HTMLInputElement | null>(null)

  const spendBuckets = useMemo(
    () =>
      spend?.data?.buckets ?? [
        { label: 'Realtime voice', value: 0 },
        { label: 'Codex agents', value: 0 },
        { label: 'Tools', value: 0 },
      ],
    [spend?.data?.buckets],
  )

  const totalSpend =
    typeof spend?.data?.total === 'number'
      ? spend.data.total
      : spendBuckets.reduce((total, bucket) => total + bucket.value, 0)

  const usagePercent = rateLimits?.rateLimits?.primary?.usedPercent ?? 0
  const workspaceSource = useMemo(() => {
    const discovered = workspaces.length > 0 ? workspaces : fallbackWorkspaces
    const seen = new Set<string>()

    return [...userWorkspaces, ...discovered].filter((workspace) => {
      const workspacePath = workspace.path ?? workspace.id
      if (seen.has(workspacePath)) return false
      seen.add(workspacePath)
      return true
    })
  }, [userWorkspaces, workspaces])
  const workspaceRoots = workspaceSource.slice(0, 8).map((workspace, index) => {
    const workspacePath = workspace.path ?? workspace.id
    const conversations =
      conversationsByWorkspace[workspacePath] ??
      (userWorkspaces.some((userWorkspace) => (userWorkspace.path ?? userWorkspace.id) === workspacePath)
        ? []
        : defaultConversationsForWorkspace(workspacePath, index))
    return { workspace, workspacePath, conversations }
  })
  const allConversations = workspaceRoots.flatMap(({ conversations }) => conversations)
  const selectedWorkspaceConversations =
    workspaceRoots.find(({ workspacePath }) => workspacePath === selectedWorkspace)?.conversations ?? []
  const activeConversation =
    selectedWorkspaceConversations.find((conversation) => conversation.id === selectedConversationId) ??
    selectedWorkspaceConversations[0]
  const openConversations = openConversationIds
    .map((id) => allConversations.find((conversation) => conversation.id === id))
    .filter((conversation): conversation is AgentConversation => Boolean(conversation))
  const latestEvents = events.slice(0, 5)
  const visibleDiffFiles = diffFiles.filter((file) => visibleDiffPaths.includes(file.path))
  const reviewTotals = visibleDiffFiles.reduce(
    (total, file) => ({ plus: total.plus + file.plus, minus: total.minus + file.minus }),
    { plus: 0, minus: 0 },
  )
  const reviewFileLabel = `${visibleDiffFiles.length} ${visibleDiffFiles.length === 1 ? 'file' : 'files'} changed`
  const voiceReady = status?.realtime ?? false
  const selectedWorkspaceName =
    workspaceRoots.find(({ workspacePath }) => workspacePath === selectedWorkspace)?.workspace.name ?? 'codex-realtime-linux'

  const appendEvent = (method: string, params?: Record<string, unknown>) => {
    setEvents((current) => [
      { method, receivedAt: new Date().toISOString(), params },
      ...current,
    ].slice(0, 160))
  }

  const showNotice = (message: string) => {
    setNotice(message)
    setLastError(null)
  }

  const openConversationWindow = (workspacePath: string, conversationId: string) => {
    setSelectedWorkspace(workspacePath)
    setSelectedConversationId(conversationId)
    setActiveSystemScreen(null)
    setNotice(null)
    setLastError(null)
    setOpenConversationIds((current) => (current.includes(conversationId) ? current : [...current, conversationId]).slice(-5))
  }

  const createConversation = (targetWorkspacePath?: string) => {
    const workspacePath = targetWorkspacePath || selectedWorkspace || workspaceRoots[0]?.workspacePath || initialWorkspacePath
    const existing = conversationsByWorkspace[workspacePath] ?? []
    const title = `Voice build ${existing.length + 1}`
    const conversation = makeConversation(workspacePath, title, 'draft', 'draft')

    setConversationsByWorkspace((current) => ({
      ...current,
      [workspacePath]: [conversation, ...(current[workspacePath] ?? existing)],
    }))
    openConversationWindow(workspacePath, conversation.id)
    showNotice(`${title} opened as a new agent conversation window. Start voice to describe the build goal.`)
  }

  const addWorkspaceFromFolderName = (folderName: string) => {
    const name = folderName.trim() || 'New workspace'
    const baseId = slug(name) || 'workspace'
    const workspacePath = `picked-folder://${baseId}-${Date.now()}`
    const workspace = { id: workspacePath, name, path: workspacePath }

    setUserWorkspaces((current) => [workspace, ...current])
    setConversationsByWorkspace((current) => ({ ...current, [workspacePath]: current[workspacePath] ?? [] }))
    setCollapsedWorkspaces((current) => current.filter((item) => item !== workspacePath))
    setSelectedWorkspace(workspacePath)
    setSelectedConversationId('')
    setOpenConversationIds([])
    setActiveSystemScreen(null)
    showNotice(`${name} added as a workspace. Create a new agent conversation when you are ready.`)
  }

  const addWorkspaceFromFiles = (files: FileList | null | undefined) => {
    const firstFile = files?.[0]
    if (!firstFile) return

    const relativePath = (firstFile as File & { webkitRelativePath?: string }).webkitRelativePath
    addWorkspaceFromFolderName(relativePath?.split('/')[0] || firstFile.name)
    if (workspaceInputRef.current) workspaceInputRef.current.value = ''
  }

  const pickWorkspaceFolder = async () => {
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker

    if (picker) {
      try {
        const handle = await picker.call(window)
        if (handle?.name) {
          addWorkspaceFromFolderName(handle.name)
          return
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return
      }
    }

    workspaceInputRef.current?.click()
  }

  const deleteConversation = (workspacePath: string, conversationId: string) => {
    const current = conversationsByWorkspace[workspacePath] ?? defaultConversationsForWorkspace(workspacePath, 0)
    const next = current.filter((conversation) => conversation.id !== conversationId)
    const fallback = next[0]

    setConversationsByWorkspace((state) => ({ ...state, [workspacePath]: next }))
    setOpenConversationIds((state) => state.filter((id) => id !== conversationId))

    if (selectedConversationId === conversationId) {
      if (fallback) {
        openConversationWindow(workspacePath, fallback.id)
      } else {
        setActiveSystemScreen('settings')
      }
    }

    showNotice('Agent conversation deleted from this workspace.')
  }

  const toggleWorkspace = (workspacePath: string) => {
    const firstConversation =
      conversationsByWorkspace[workspacePath]?.[0] ??
      workspaceRoots.find((root) => root.workspacePath === workspacePath)?.conversations[0]

    setSelectedWorkspace(workspacePath)
    setActiveSystemScreen(null)
    if (firstConversation) {
      setSelectedConversationId(firstConversation.id)
      setOpenConversationIds((current) => (current.includes(firstConversation.id) ? current : [firstConversation.id, ...current]).slice(0, 5))
    } else {
      setSelectedConversationId('')
      setOpenConversationIds([])
    }
    setCollapsedWorkspaces((current) =>
      current.includes(workspacePath) ? current.filter((item) => item !== workspacePath) : [...current, workspacePath],
    )
  }

  const openSystemScreen = (screen: SystemScreen) => {
    setActiveSystemScreen(screen)
    showNotice(`${screen === 'settings' ? 'Settings' : screen === 'usage' ? 'Usage' : 'Account details'} opened.`)
  }

  useEffect(() => {
    workspaceInputRef.current?.setAttribute('webkitdirectory', '')
    workspaceInputRef.current?.setAttribute('directory', '')
  }, [])

  useEffect(() => {
    const load = async () => {
      try {
        const [statusData, workspaceData, spendData] = await Promise.all([
          api<Status>('/api/status'),
          api<{ data: Workspace[] }>('/api/workspaces'),
          api<SpendResponse>('/api/spend'),
        ])
        const roots = (workspaceData.data.length > 0 ? workspaceData.data : fallbackWorkspaces).slice(0, 5)
        const firstPath = roots[0]?.path ?? roots[0]?.id ?? initialWorkspacePath
        const firstConversation = defaultConversationsForWorkspace(firstPath, 0)[0]

        setStatus(statusData)
        setWorkspaces(workspaceData.data)
        setSpend(spendData)
        setConversationsByWorkspace((current) => {
          const next = { ...current }
          roots.forEach((workspace, index) => {
            const workspacePath = workspace.path ?? workspace.id
            if (!next[workspacePath]) next[workspacePath] = defaultConversationsForWorkspace(workspacePath, index)
          })
          return next
        })
        setSelectedWorkspace(firstPath)
        setSelectedConversationId(firstConversation.id)
        setOpenConversationIds([firstConversation.id])
      } catch (error) {
        setLastError(error instanceof Error ? error.message : 'Failed to load app state')
      }
    }

    load()
  }, [])

  useEffect(() => {
    const loadRateLimits = async () => {
      try {
        setRateLimits(await api<RateLimitResponse>('/api/codex/rate-limits'))
      } catch {
        // Rate-limit data needs an initialized Codex account; keep the demo usable without it.
      }
    }

    loadRateLimits()
  }, [])

  useEffect(() => {
    const interval = window.setInterval(async () => {
      try {
        const data = await api<{ data: EventRecord[] }>('/api/codex/events')
        setEvents(data.data)
      } catch {
        // The app-server may not be started until the first Codex action.
      }
    }, 1800)

    return () => window.clearInterval(interval)
  }, [])

  const handleRealtimeToolCall = async (message: Record<string, unknown>) => {
    const item = message.item as { type?: string; name?: string; arguments?: string; call_id?: string } | undefined
    if (message.type !== 'response.output_item.done' || item?.type !== 'function_call') return

    let payload: Record<string, unknown>
    try {
      payload = item.arguments ? JSON.parse(item.arguments) : {}
    } catch {
      payload = {}
    }

    let result: unknown = { ignored: true }
    if (item.name === 'codex_start_task') {
      result = await api('/api/codex/task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cwd: payload.cwd || selectedWorkspace,
          goal: payload.goal,
        }),
      })
      const threadId = (result as { thread?: { id?: string } }).thread?.id
      if (threadId) setActiveThreadId(threadId)
    }

    if (item.name === 'codex_steer_task' && activeThreadId) {
      result = await api('/api/codex/steer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: activeThreadId, instruction: payload.instruction }),
      })
    }

    if (item.name === 'codex_interrupt_task' && activeThreadId) {
      result = await api('/api/codex/interrupt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: activeThreadId }),
      })
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
      showNotice('Add OPENAI_API_KEY in .env to start a live Realtime voice session.')
      return
    }

    setLastError(null)
    setVoiceState('connecting')

    try {
      const pc = new RTCPeerConnection()
      peerRef.current = pc

      audioRef.current = document.createElement('audio')
      audioRef.current.autoplay = true
      pc.ontrack = (event) => {
        if (audioRef.current) audioRef.current.srcObject = event.streams[0]
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      pc.addTrack(stream.getAudioTracks()[0], stream)

      const dataChannel = pc.createDataChannel('oai-events')
      dataChannelRef.current = dataChannel
      dataChannel.addEventListener('message', (event) => {
        const message = JSON.parse(event.data)
        setEvents((current) => [
          { method: message.type, receivedAt: new Date().toISOString(), params: message },
          ...current,
        ].slice(0, 160))
        handleRealtimeToolCall(message).catch((error: unknown) => {
          setLastError(error instanceof Error ? error.message : 'Realtime tool call failed')
        })
      })

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)

      const answerResponse = await fetch('/api/realtime/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: offer.sdp,
      })
      if (!answerResponse.ok) throw new Error(await answerResponse.text())

      await pc.setRemoteDescription({ type: 'answer', sdp: await answerResponse.text() })
      setVoiceState('live')
      showNotice('Voice is live. Speak naturally; the Codex task controls stay available.')
    } catch (error) {
      setVoiceState('idle')
      setLastError(error instanceof Error ? error.message : 'Voice session failed')
    }
  }

  const stopVoice = () => {
    peerRef.current?.getSenders().forEach((sender) => sender.track?.stop())
    peerRef.current?.close()
    peerRef.current = null
    dataChannelRef.current = null
    setVoiceState('idle')
    showNotice('Voice session stopped.')
  }

  const shareScreen = async () => {
    setLastError(null)
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      setScreenShared(true)
      showNotice('Screen context is attached for this session.')
      stream.getVideoTracks()[0]?.addEventListener('ended', () => setScreenShared(false))
    } catch (error) {
      setLastError(error instanceof Error ? error.message : 'Screen share failed')
    }
  }

  const attachImage = (file: File | undefined) => {
    if (!file) return
    setAttachedImageName(file.name)
    appendEvent('context/image-attached', { name: file.name, size: file.size, type: file.type })
    showNotice(`Image attached: ${file.name}`)
  }

  const startDemoBuild = async () => {
    setLastError(null)
    setBuildState('starting')
    try {
      const result = await api<{ thread: { id: string } }>('/api/codex/task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cwd: selectedWorkspace,
          goal: activeConversation?.prompt ?? 'Act as the Codex execution layer for a realtime voice-first Linux app.',
        }),
      })
      setActiveThreadId(result.thread.id)
      setBuildState('running')
      appendEvent('codex/task-started', { threadId: result.thread.id, cwd: selectedWorkspace })
      showNotice('Codex build started. Use voice or Interrupt to redirect it.')
    } catch (error) {
      setBuildState('idle')
      setLastError(error instanceof Error ? error.message : 'Codex task failed')
    }
  }

  const interruptBuild = async () => {
    if (!activeThreadId) return
    try {
      await api('/api/codex/interrupt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: activeThreadId }),
      })
      setBuildState('idle')
      appendEvent('codex/task-interrupted', { threadId: activeThreadId })
      showNotice('Codex task interrupted. Continue by voice to redirect the next step.')
    } catch (error) {
      setLastError(error instanceof Error ? error.message : 'Interrupt failed')
    }
  }

  const acceptDiff = (path: string) => {
    setAcceptedDiffPaths((current) => (current.includes(path) ? current : [...current, path]))
    appendEvent('review/file-accepted', { path })
    showNotice(`${path} marked accepted for this demo review.`)
  }

  const dismissDiff = (path: string) => {
    setVisibleDiffPaths((current) => current.filter((item) => item !== path))
    appendEvent('review/file-dismissed', { path })
    showNotice(`${path} dismissed from the review pane.`)
  }

  const acceptAllReview = () => {
    setAcceptedDiffPaths(visibleDiffFiles.map((file) => file.path))
    appendEvent('review/all-accepted', { files: visibleDiffFiles.map((file) => file.path) })
    showNotice('All visible review items marked accepted.')
  }

  const renderSystemScreen = () => {
    if (activeSystemScreen === 'settings') {
      return (
        <section className="system-screen">
          <header>
            <Settings size={18} />
            <div>
              <h2>Settings</h2>
              <p>Voice, model, approvals, and workspace permissions.</p>
            </div>
          </header>
          <div className="system-grid">
            <div><span>Voice model</span><strong>{status?.realtimeModel ?? 'gpt-realtime-2'}</strong></div>
            <div><span>Codex model</span><strong>{status?.codexModel ?? 'gpt-5.4'}</strong></div>
            <div><span>Transcript</span><strong>{transcriptOpen ? 'visible' : 'hidden by default'}</strong></div>
            <div><span>Approvals</span><strong>review before action</strong></div>
          </div>
        </section>
      )
    }

    if (activeSystemScreen === 'usage') {
      return (
        <section className="system-screen">
          <header>
            <CircleDollarSign size={18} />
            <div>
              <h2>Usage</h2>
              <p>Live spend when admin scope is configured, demo data otherwise.</p>
            </div>
          </header>
          <div className="usage-system-total">${totalSpend.toFixed(2)}</div>
          <div className="spend-list system-spend-list">
            {spendBuckets.map((bucket) => (
              <div key={bucket.label}>
                <span>{bucket.label}</span>
                <strong>${bucket.value.toFixed(2)}</strong>
              </div>
            ))}
          </div>
        </section>
      )
    }

    return (
      <section className="system-screen">
        <header>
          <UserRound size={18} />
          <div>
            <h2>Account details</h2>
            <p>Local demo auth and Codex account readiness.</p>
          </div>
        </header>
        <div className="system-grid">
          <div><span>Realtime API</span><strong>{status?.realtime ? 'configured' : 'needs key'}</strong></div>
          <div><span>Codex auth</span><strong>{status?.codexApiKey ? 'API key' : 'local account'}</strong></div>
          <div><span>Admin API</span><strong>{status?.adminApi ? 'configured' : 'not configured'}</strong></div>
          <div><span>Mode</span><strong>{status?.codexAuthPreference ?? 'demo'}</strong></div>
        </div>
      </section>
    )
  }

  return (
    <main className={reviewOpen ? 'codex-shell' : 'codex-shell review-collapsed'}>
      <aside className="thread-sidebar">
        <div className="app-rail-header">
          <div className="app-identity" aria-label="Codex Voice">
            <span className="app-mark">
              <AudioLines size={15} />
            </span>
            <span>Codex Voice</span>
          </div>
          <button
            type="button"
            aria-label="Search agent conversations"
            onClick={() => showNotice('Say “find the review conversation” to search by voice.')}
          >
            <Search size={15} />
          </button>
        </div>

        <nav className="sidebar-nav" aria-label="Primary">
          <button type="button" onClick={pickWorkspaceFolder}>
            <Folder size={16} />
            New workspace
          </button>
          <button type="button" onClick={() => createConversation()}>
            <Plus size={16} />
            New thread
          </button>
          <button type="button" onClick={() => showNotice('Automations will run recurring Codex tasks; this MVP keeps them in the roadmap.')}>
            <Wand2 size={16} />
            Automations
          </button>
          <button type="button" onClick={() => showNotice('Skills will expose reusable Codex workflows; this demo keeps voice as the primary path.')}>
            <Sparkles size={16} />
            Skills
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
                  <button
                    type="button"
                    className={selectedWorkspace === workspacePath ? 'workspace-folder-row active' : 'workspace-folder-row'}
                    onClick={() => toggleWorkspace(workspacePath)}
                  >
                    {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    <Folder size={14} />
                    <span>{workspace.name ?? workspace.id}</span>
                  </button>
                  {!collapsed && (
                    <div className="agent-thread-list">
                      {conversations.length === 0 ? (
                        <div className="empty-workspace">
                          <span>No threads yet</span>
                          <button type="button" onClick={() => createConversation(workspacePath)}>
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
                            >
                              <span>{conversation.title}</span>
                              <small>{conversation.age}</small>
                            </button>
                            <button
                              type="button"
                              className="agent-thread-delete"
                              aria-label={`Delete ${conversation.title}`}
                              onClick={() => deleteConversation(workspacePath, conversation.id)}
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
          <h2>System</h2>
          <button type="button" className={activeSystemScreen === 'settings' ? 'utility-row active' : 'utility-row'} onClick={() => openSystemScreen('settings')}>
            <Settings size={14} />
            <span>Settings</span>
          </button>
          <button type="button" className={activeSystemScreen === 'usage' ? 'utility-row active' : 'utility-row'} onClick={() => openSystemScreen('usage')}>
            <CircleDollarSign size={14} />
            <span>Usage</span>
          </button>
          <button type="button" className={activeSystemScreen === 'account' ? 'utility-row active' : 'utility-row'} onClick={() => openSystemScreen('account')}>
            <UserRound size={14} />
            <span>Account details</span>
          </button>
        </section>
      </aside>

      <section className="conversation-pane">
        <header className="pane-titlebar">
          <div>
            <h1>{activeSystemScreen ? 'System' : activeConversation?.title ?? 'Realtime Linux Codex'}</h1>
            <span>
              <Folder size={14} />
              {activeSystemScreen ? activeSystemScreen : selectedWorkspaceName}
            </span>
          </div>
          <div className="title-actions">
            {!reviewOpen && (
              <button type="button" onClick={() => setReviewOpen(true)}>
                Review
              </button>
            )}
            <button type="button" onClick={() => showNotice(`Active workspace: ${selectedWorkspace}`)}>
              Open
            </button>
            <button type="button" onClick={startDemoBuild} disabled={buildState === 'starting' || Boolean(activeSystemScreen)}>
              <Play size={14} />
              {buildState === 'starting' ? 'Starting' : buildState === 'running' ? 'Running' : 'Build'}
            </button>
          </div>
        </header>

        {!activeSystemScreen && (
          <div className="window-tabs" aria-label="Open agent conversation windows">
            {openConversations.map((conversation) => (
              <button
                type="button"
                className={selectedConversationId === conversation.id ? 'window-tab active' : 'window-tab'}
                key={conversation.id}
                onClick={() => {
                  setSelectedConversationId(conversation.id)
                  setActiveSystemScreen(null)
                }}
              >
                <span>{conversation.title}</span>
                <X
                  size={12}
                  onClick={(event) => {
                    event.stopPropagation()
                    setOpenConversationIds((current) => current.filter((id) => id !== conversation.id))
                  }}
                />
              </button>
            ))}
          </div>
        )}

        <div className="conversation-scroll">
          {activeSystemScreen ? (
            renderSystemScreen()
          ) : activeConversation ? (
            <section className="conversation-window">
              <div className="voice-hero" aria-label="Realtime voice conversation">
                <div className={voiceState === 'live' ? 'realtime-orb live' : 'realtime-orb'}>
                  <span />
                  <AudioLines size={44} />
                </div>
                <div>
                  <p>{voiceState === 'live' ? 'Listening to this agent conversation' : 'Realtime voice conversation'}</p>
                  <strong>{activeConversation.title}</strong>
                  <small>
                    {screenShared
                      ? 'Screen context attached'
                      : attachedImageName
                        ? `Image attached: ${attachedImageName}`
                        : 'Speak to create, steer, interrupt, and review Codex work'}
                  </small>
                </div>
              </div>

              <div className="user-bubble">{activeConversation.prompt}</div>

              <article className="assistant-turn">
                <p>{activeConversation.response}</p>
                <div className="thought-line">
                  <strong>Agent work</strong>
                  <span>{activeConversation.status}</span>
                </div>
                {activeConversation.traces.map((trace) => (
                  <div className="trace-item" key={trace}>
                    <span>{trace}</span>
                    <Check size={14} />
                  </div>
                ))}
              </article>

              {transcriptOpen && (
                <section className="transcript-panel" aria-label="Voice transcript">
                  <header>
                    <Captions size={15} />
                    <span>Transcript</span>
                  </header>
                  {activeConversation.transcript.map((line, index) => (
                    <div className={line.speaker === 'user' ? 'transcript-line user' : 'transcript-line'} key={`${line.speaker}-${index}`}>
                      <strong>{line.speaker === 'user' ? 'You' : 'Codex'}</strong>
                      <span>{line.text}</span>
                    </div>
                  ))}
                </section>
              )}

              <section className="runtime-strip" aria-label="Runtime state">
                <div>
                  <Radio size={16} />
                  <span>Realtime</span>
                  <strong>{status?.realtime ? 'ready' : 'needs key'}</strong>
                </div>
                <div>
                  <Bot size={16} />
                  <span>Codex</span>
                  <strong>{status?.codexApiKey ? 'api key' : status?.codexModel ?? 'local'}</strong>
                </div>
                <div>
                  <CircleDollarSign size={16} />
                  <span>Spend</span>
                  <strong>${totalSpend.toFixed(2)}</strong>
                </div>
              </section>

              <section className="activity-block">
                <header>
                  <Terminal size={16} />
                  <span>Agent activity</span>
                </header>
                {latestEvents.length === 0 ? (
                  <div className="empty-state">Waiting for voice, image, screen, or Codex events.</div>
                ) : (
                  latestEvents.map((event, index) => (
                    <div className="event-row" key={`${event.method}-${event.receivedAt}-${index}`}>
                      <Circle size={8} fill="currentColor" />
                      <span>{event.method ?? 'event'}</span>
                      <small>{event.receivedAt ? new Date(event.receivedAt).toLocaleTimeString() : 'now'}</small>
                    </div>
                  ))
                )}
              </section>
            </section>
          ) : (
            <section className="system-screen">
              <h2>No agent conversation selected</h2>
              <p>Create a new agent conversation from the workspace sidebar and start voice.</p>
            </section>
          )}
        </div>

        {lastError && <div className="error-strip">{lastError}</div>}
        {notice && <div className="notice-strip">{notice}</div>}

        <section className="voice-dock" aria-label="Voice-first command dock">
          <div className="voice-status">
            <div className={voiceState === 'live' ? 'voice-pulse live' : 'voice-pulse'}>
              <AudioLines size={22} />
            </div>
            <div>
              <span>
                {voiceState === 'live'
                  ? 'Listening. Interrupt whenever direction changes.'
                  : voiceState === 'connecting'
                    ? 'Opening realtime audio session'
                    : 'Ready for voice direction'}
              </span>
              <small>{activeSystemScreen ? 'System screen open; voice dock stays available' : activeConversation?.title ?? status?.realtimeModel}</small>
            </div>
          </div>
          <div className="voice-controls">
            <button type="button" onClick={() => setTranscriptOpen((current) => !current)} aria-label="Toggle transcript">
              <Captions size={18} />
            </button>
            <button type="button" onClick={shareScreen} aria-label="Share screen">
              <MonitorUp size={18} />
            </button>
            <button type="button" onClick={() => imageInputRef.current?.click()} aria-label="Attach image">
              <ImagePlus size={18} />
            </button>
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(event) => attachImage(event.target.files?.[0])}
            />
            {voiceState === 'idle' ? (
              <button className="primary-voice" type="button" onClick={startVoice} disabled={status !== null && !voiceReady}>
                <Mic size={18} />
                {status !== null && !voiceReady ? 'Needs key' : 'Start voice'}
              </button>
            ) : (
              <button className="danger-voice" type="button" onClick={stopVoice}>
                <Square size={16} />
                Stop
              </button>
            )}
            <button type="button" onClick={interruptBuild} disabled={!activeThreadId} aria-label="Interrupt build">
              <Pause size={18} />
            </button>
          </div>
        </section>
      </section>

      {reviewOpen && (
        <aside className="review-pane">
          <header className="review-header">
            <div>
              <strong>{reviewFileLabel}</strong>
              <span>+{reviewTotals.plus} -{reviewTotals.minus}</span>
            </div>
            <div>
              <button type="button" aria-label="Close review" onClick={() => setReviewOpen(false)}>
                <X size={14} />
              </button>
              <button type="button" aria-label="Accept review" onClick={acceptAllReview} disabled={visibleDiffFiles.length === 0}>
                <Check size={14} />
              </button>
            </div>
          </header>

          <div className="review-scroll">
            {visibleDiffFiles.length === 0 ? (
              <section className="review-empty">
                <Check size={18} />
                <span>No files left in review.</span>
              </section>
            ) : (
              visibleDiffFiles.map((file) => (
                <DiffCard
                  accepted={acceptedDiffPaths.includes(file.path)}
                  file={file}
                  key={file.path}
                  onAccept={() => acceptDiff(file.path)}
                  onDismiss={() => dismissDiff(file.path)}
                />
              ))
            )}

            <section className="usage-card">
              <header>
                <span>Usage and spend</span>
                <ChevronDown size={15} />
              </header>
              <div className="spend-total">${totalSpend.toFixed(2)}</div>
              <div className="meter">
                <span style={{ width: `${Math.max(4, usagePercent)}%` }} />
              </div>
              <div className="spend-list">
                {spendBuckets.slice(0, 3).map((bucket) => (
                  <div key={bucket.label}>
                    <span>{bucket.label}</span>
                    <strong>${bucket.value.toFixed(2)}</strong>
                  </div>
                ))}
              </div>
            </section>

            <section className="browser-card">
              <header>
                <MonitorUp size={15} />
                <span>Computer-use viewport</span>
              </header>
              <div className="browser-preview">
                <Sparkles size={24} />
                <span>{screenShared ? 'Screen is available to the voice layer' : 'Ready for browser and app context'}</span>
              </div>
            </section>
          </div>
        </aside>
      )}
    </main>
  )
}

export default App
