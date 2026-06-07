import {
  Bot,
  Check,
  ChevronDown,
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

const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, init)
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `${response.status} ${response.statusText}`)
  }
  return response.json()
}

const fallbackWorkspaces: Workspace[] = [
  { id: 'codex-realtime-linux', name: 'codex-realtime-linux', path: '/home/sergiopesch/codex-realtime-linux' },
]

const agentConversationTemplates = [
  { title: 'Realtime Linux MVP', age: 'now' },
  { title: 'Connect voice harness', age: '1h' },
  { title: 'Review spending widgets', age: '2h' },
  { title: 'Browser-use checkpoint', age: '7h' },
]

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
  const [spend, setSpend] = useState<SpendResponse | null>(null)
  const [rateLimits, setRateLimits] = useState<RateLimitResponse | null>(null)
  const [events, setEvents] = useState<EventRecord[]>([])
  const [voiceState, setVoiceState] = useState<'idle' | 'connecting' | 'live'>('idle')
  const [screenShared, setScreenShared] = useState(false)
  const [attachedImageName, setAttachedImageName] = useState<string | null>(null)
  const [selectedWorkspace, setSelectedWorkspace] = useState('/home/sergiopesch/codex-realtime-linux')
  const [selectedThreadTitle, setSelectedThreadTitle] = useState('Realtime Linux MVP')
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
  const latestEvents = events.slice(0, 5)
  const sidebarWorkspaces = (workspaces.length > 0 ? workspaces : fallbackWorkspaces).slice(0, 5).map((workspace, index) => {
    const workspacePath = workspace.path ?? workspace.id
    const baseConversations = agentConversationTemplates.slice(0, index === 0 ? 4 : 2)
    const conversations =
      selectedThreadTitle === 'New agent conversation' && selectedWorkspace === workspacePath
        ? [{ title: 'New agent conversation', age: 'draft' }, ...baseConversations]
        : baseConversations

    return { workspace, workspacePath, conversations }
  })
  const visibleDiffFiles = diffFiles.filter((file) => visibleDiffPaths.includes(file.path))
  const reviewTotals = visibleDiffFiles.reduce(
    (total, file) => ({ plus: total.plus + file.plus, minus: total.minus + file.minus }),
    { plus: 0, minus: 0 },
  )
  const reviewFileLabel = `${visibleDiffFiles.length} ${visibleDiffFiles.length === 1 ? 'file' : 'files'} changed`
  const voiceReady = status?.realtime ?? false
  const selectedWorkspaceName =
    workspaces.find((workspace) => workspace.path === selectedWorkspace)?.name ?? 'codex-realtime-linux'

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

  useEffect(() => {
    const load = async () => {
      try {
        const [statusData, workspaceData, spendData] = await Promise.all([
          api<Status>('/api/status'),
          api<{ data: Workspace[] }>('/api/workspaces'),
          api<SpendResponse>('/api/spend'),
        ])
        setStatus(statusData)
        setWorkspaces(workspaceData.data)
        setSpend(spendData)
        setSelectedWorkspace((current) => workspaceData.data[0]?.path ?? current)
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
          goal:
            'Act as the Codex execution layer for a realtime voice-first Linux app. Inspect the workspace, propose the next implementation step, and wait before making broad product changes.',
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
      showNotice('Codex task interrupted. Start voice to redirect the next step.')
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

  return (
    <main className={reviewOpen ? 'codex-shell' : 'codex-shell review-collapsed'}>
      <aside className="thread-sidebar">
        <div className="window-bar">
          <span className="dot red" />
          <span className="dot yellow" />
          <span className="dot green" />
          <button
            type="button"
            aria-label="Search agent conversations"
            onClick={() => showNotice('Say “find the review conversation” to search by voice.')}
          >
            <Search size={15} />
          </button>
        </div>

        <nav className="sidebar-nav" aria-label="Primary">
          <button
            type="button"
            onClick={() => {
              setSelectedThreadTitle('New agent conversation')
              if (!selectedWorkspace && sidebarWorkspaces[0]) setSelectedWorkspace(sidebarWorkspaces[0].workspacePath)
              showNotice('New agent conversation staged. Start voice to describe the work.')
            }}
          >
            <Plus size={16} />
            New agent conversation
          </button>
          <button type="button" onClick={() => showNotice('Automations will run recurring Codex tasks; this MVP keeps them in the roadmap.')}>
            <Wand2 size={16} />
            Automations
          </button>
          <button type="button" onClick={() => showNotice('Skills will expose reusable Codex workflows; this demo keeps voice as the primary path.')}>
            <Sparkles size={16} />
            Skills
          </button>
        </nav>

        <section className="sidebar-section">
          <h2>Workspaces</h2>
          <div className="workspace-tree">
            {sidebarWorkspaces.map(({ workspace, workspacePath, conversations }) => (
              <div className="workspace-folder" key={workspace.id}>
                <button
                  type="button"
                  className={selectedWorkspace === workspacePath ? 'workspace-folder-row active' : 'workspace-folder-row'}
                  onClick={() => {
                    setSelectedWorkspace(workspacePath)
                    showNotice(`${workspace.name ?? workspace.id} selected. Speak to start or steer an agent conversation.`)
                  }}
                >
                  <Folder size={14} />
                  <span>{workspace.name ?? workspace.id}</span>
                </button>
                <div className="agent-thread-list">
                  {conversations.map((thread) => (
                    <button
                      type="button"
                      className={
                        selectedWorkspace === workspacePath && selectedThreadTitle === thread.title
                          ? 'agent-thread-row active'
                          : 'agent-thread-row'
                      }
                      key={`${workspace.id}-${thread.title}`}
                      onClick={() => {
                        setSelectedWorkspace(workspacePath)
                        setSelectedThreadTitle(thread.title)
                        showNotice(`${thread.title} selected inside ${workspace.name ?? workspace.id}.`)
                      }}
                    >
                      <Bot size={13} />
                      <span>{thread.title}</span>
                      <small>{thread.age}</small>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="sidebar-section account-section">
          <h2>System</h2>
          <button type="button" className="utility-row" onClick={() => showNotice('Settings: voice, model, approvals, and workspace permissions.')}>
            <Settings size={14} />
            <span>Settings</span>
          </button>
          <button type="button" className="utility-row" onClick={() => showNotice(`Usage: $${totalSpend.toFixed(2)} shown from ${spend?.source ?? 'demo data'}.`)}>
            <CircleDollarSign size={14} />
            <span>Usage</span>
          </button>
          <button type="button" className="utility-row" onClick={() => showNotice(status?.codexApiKey ? 'Account: Codex API-key mode is configured.' : 'Account: configure API keys in .env.')}>
            <UserRound size={14} />
            <span>Account details</span>
          </button>
        </section>
      </aside>

      <section className="conversation-pane">
        <header className="pane-titlebar">
          <div>
            <h1>Realtime Linux Codex</h1>
            <span>
              <Folder size={14} />
              {selectedWorkspaceName}
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
            <button type="button" onClick={startDemoBuild} disabled={buildState === 'starting'}>
              <Play size={14} />
              {buildState === 'starting' ? 'Starting' : buildState === 'running' ? 'Running' : 'Build'}
            </button>
          </div>
        </header>

        <div className="conversation-scroll">
          <div className="user-bubble">
            Build a voice-first Codex desktop demo for Linux. No text composer: I want to talk, share my screen,
            attach images, see spend, workspaces, and review what agents are changing.
          </div>

          <article className="assistant-turn">
            <p>
              I’ll run this like a lead developer for a small team of Codex agents: voice handles direction,
              Codex handles scoped work, and the review pane keeps every change inspectable before it lands.
            </p>

            <div className="thought-line">
              <strong>Thought</strong>
              <span>7s</span>
            </div>
            <div className="trace-item">
              <span>Mapped desktop layout from screenshot</span>
              <Check size={14} />
            </div>
            <div className="trace-item">
              <span>Kept Codex app-server harness behind voice tools</span>
              <Check size={14} />
            </div>
            <div className="trace-item">
              <span>Removed typed composer from the primary workflow</span>
              <Check size={14} />
            </div>

            <p>
              The MVP surface is now a three-pane command center: workspaces with nested agent conversations on
              the left, realtime voice collaboration in the center, and diff/review plus usage context on the right.
            </p>
          </article>

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
        </div>

        {lastError && <div className="error-strip">{lastError}</div>}
        {notice && <div className="notice-strip">{notice}</div>}

        <section className="voice-dock" aria-label="Voice-first command dock">
          <div className="voice-status">
            <div className={voiceState === 'live' ? 'voice-pulse live' : 'voice-pulse'}>
              <Mic size={20} />
            </div>
            <div>
              <span>
                {voiceState === 'live'
                  ? 'Listening. Interrupt whenever direction changes.'
                  : voiceState === 'connecting'
                    ? 'Opening realtime audio session'
                    : 'Ready for voice direction'}
              </span>
              <small>
                {screenShared
                  ? 'Screen attached'
                  : attachedImageName
                    ? `Image attached: ${attachedImageName}`
                    : status?.realtimeModel ?? 'gpt-realtime-2'}
              </small>
            </div>
          </div>
          <div className="voice-controls">
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
