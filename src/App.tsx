import {
  Activity,
  AudioLines,
  Bot,
  Captions,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDollarSign,
  Database,
  Folder,
  Gauge,
  ImagePlus,
  KeyRound,
  Lock,
  Mic,
  MonitorUp,
  Pause,
  Play,
  Plus,
  Radio,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Terminal,
  Trash2,
  UserRound,
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
  status: 'draft' | 'ready' | 'running'
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
      'Coordinate the Codex execution layer from live speech, keep every thread steerable, and treat screen or image context as explicit input.',
    traces: ['Workspace selected', 'Voice direction is primary', 'Codex agents ready behind the session'],
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
      'Usage belongs in the system context: visible when needed, but secondary to the realtime collaboration loop.',
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
    (title, titleIndex) => makeConversation(workspacePath, title, titleIndex === 0 ? 'now' : `${titleIndex}h`, 'ready'),
  )

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
  const [events, setEvents] = useState<EventRecord[]>([])
  const [voiceState, setVoiceState] = useState<'idle' | 'connecting' | 'live'>('idle')
  const [screenShared, setScreenShared] = useState(false)
  const [attachedImageName, setAttachedImageName] = useState<string | null>(null)
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [buildState, setBuildState] = useState<'idle' | 'starting' | 'running'>('idle')
  const [notice, setNotice] = useState<string | null>(null)
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

  const renderSystemScreen = () => {
    if (activeSystemScreen === 'settings') {
      return (
        <section className="system-screen system-settings">
          <header className="system-hero">
            <div className="system-hero-icon">
              <Settings size={28} />
            </div>
            <div>
              <span className="system-kicker">Voice operating system</span>
              <h2>Settings</h2>
              <p>Model routing, interaction defaults, and permission posture for voice-led Codex work.</p>
            </div>
            <strong className="system-status-pill">local demo</strong>
          </header>

          <div className="system-card-grid">
            <article className="system-stat-card">
              <AudioLines size={18} />
              <span>Realtime model</span>
              <strong>{status?.realtimeModel ?? 'gpt-realtime-2'}</strong>
            </article>
            <article className="system-stat-card">
              <Bot size={18} />
              <span>Codex model</span>
              <strong>{status?.codexModel ?? 'gpt-5.4'}</strong>
            </article>
            <article className="system-stat-card">
              <Captions size={18} />
              <span>Transcript</span>
              <strong>{transcriptOpen ? 'visible' : 'hidden'}</strong>
            </article>
          </div>

          <section className="system-detail-panel">
            <header>
              <SlidersHorizontal size={17} />
              <span>Interaction defaults</span>
            </header>
            <div className="system-row">
              <div>
                <strong>Conversation mode</strong>
                <span>Voice remains the primary input for every thread.</span>
              </div>
              <em>voice first</em>
            </div>
            <div className="system-row">
              <div>
                <strong>Transcript behavior</strong>
                <span>Hidden until the captions control is explicitly opened.</span>
              </div>
              <em>{transcriptOpen ? 'expanded' : 'collapsed'}</em>
            </div>
            <div className="system-row">
              <div>
                <strong>Agent approval posture</strong>
                <span>Codex actions should be confirmed before they affect the workspace.</span>
              </div>
              <em>ask first</em>
            </div>
          </section>
        </section>
      )
    }

    if (activeSystemScreen === 'usage') {
      const usagePeak = Math.max(totalSpend, ...spendBuckets.map((bucket) => bucket.value), 1)
      const primarySpendBucket = spendBuckets.reduce(
        (top, bucket) => (bucket.value > top.value ? bucket : top),
        { label: 'None', value: 0 },
      )

      return (
        <section className="system-screen system-usage">
          <header className="system-hero usage-hero">
            <div className="system-hero-icon">
              <CircleDollarSign size={28} />
            </div>
            <div>
              <span className="system-kicker">{spend?.source === 'admin' ? 'Live admin data' : 'Demo usage data'}</span>
              <h2>Usage</h2>
              <p>Spend should be visible, calm, and secondary to the voice collaboration loop.</p>
            </div>
            <strong className="usage-total">${totalSpend.toFixed(2)}</strong>
          </header>

          <div className="usage-breakdown">
            {spendBuckets.map((bucket) => (
              <article className="usage-row" key={bucket.label}>
                <div>
                  <span>{bucket.label}</span>
                  <strong>${bucket.value.toFixed(2)}</strong>
                </div>
                <div className="usage-meter" aria-hidden="true">
                  <span style={{ width: `${Math.max(5, (bucket.value / usagePeak) * 100)}%` }} />
                </div>
              </article>
            ))}
          </div>

          <div className="system-card-grid">
            <article className="system-stat-card">
              <Gauge size={18} />
              <span>Spend state</span>
              <strong>{totalSpend > 0 ? 'active' : 'quiet'}</strong>
            </article>
            <article className="system-stat-card">
              <Activity size={18} />
              <span>Primary cost driver</span>
              <strong>{primarySpendBucket.label}</strong>
            </article>
            <article className="system-stat-card">
              <Database size={18} />
              <span>Source</span>
              <strong>{spend?.source ?? 'fallback'}</strong>
            </article>
          </div>
        </section>
      )
    }

    return (
      <section className="system-screen system-account">
        <header className="system-hero">
          <div className="system-hero-icon">
            <UserRound size={28} />
          </div>
          <div>
            <span className="system-kicker">Identity and access</span>
            <h2>Account details</h2>
            <p>Connection readiness for realtime voice, Codex execution, and optional organization telemetry.</p>
          </div>
          <strong className={status?.realtime ? 'system-status-pill ready' : 'system-status-pill'}>
            {status?.realtime ? 'ready' : 'needs key'}
          </strong>
        </header>

        <div className="account-readiness">
          <article>
            <KeyRound size={18} />
            <span>Realtime API</span>
            <strong>{status?.realtime ? 'configured' : 'needs key'}</strong>
          </article>
          <article>
            <ShieldCheck size={18} />
            <span>Codex auth</span>
            <strong>{status?.codexApiKey ? 'API key' : 'local account'}</strong>
          </article>
          <article>
            <Database size={18} />
            <span>Admin API</span>
            <strong>{status?.adminApi ? 'configured' : 'not configured'}</strong>
          </article>
          <article>
            <Lock size={18} />
            <span>Mode</span>
            <strong>{status?.codexAuthPreference ?? 'demo'}</strong>
          </article>
        </div>

        <section className="system-detail-panel">
          <header>
            <ShieldCheck size={17} />
            <span>Trust posture</span>
          </header>
          <div className="system-row">
            <div>
              <strong>Voice session</strong>
              <span>{status?.realtime ? 'Realtime voice can start from the dock.' : 'Add an OpenAI API key before live voice starts.'}</span>
            </div>
            <em>{status?.realtime ? 'enabled' : 'blocked'}</em>
          </div>
          <div className="system-row">
            <div>
              <strong>Workspace execution</strong>
              <span>Codex tasks run from the selected workspace context.</span>
            </div>
            <em>scoped</em>
          </div>
          <div className="system-row">
            <div>
              <strong>Spend visibility</strong>
              <span>{status?.adminApi ? 'Organization spend is connected.' : 'Using fallback spend for the demo.'}</span>
            </div>
            <em>{status?.adminApi ? 'live' : 'demo'}</em>
          </div>
        </section>
      </section>
    )
  }

  return (
    <main className="codex-shell">
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
            onClick={() => showNotice('Say “find the thread about spending” to search by voice.')}
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
                        : 'Speak to create, steer, interrupt, and inspect Codex work'}
                  </small>
                </div>
              </div>

              <section className="voice-thread-board" aria-label="Voice thread state">
                <article className="spoken-goal">
                  <span>Current spoken goal</span>
                  <strong>{activeConversation.prompt}</strong>
                  <small>{voiceState === 'live' ? 'Listening for refinements' : 'Start voice to update this direction'}</small>
                </article>

                <article className="agent-brief">
                  <header>
                    <span>Agent brief</span>
                    <strong>{activeConversation.status}</strong>
                  </header>
                  <p>{activeConversation.response}</p>
                  <div className="trace-grid">
                    {activeConversation.traces.map((trace) => (
                      <div className="trace-item" key={trace}>
                        <span>{trace}</span>
                        <Check size={14} />
                      </div>
                    ))}
                  </div>
                </article>
              </section>

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

              <section className="runtime-strip" aria-label="Voice runtime state">
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

    </main>
  )
}

export default App
