import {
  Bot,
  Check,
  ChevronDown,
  Circle,
  CircleDollarSign,
  Code2,
  Folder,
  ImagePlus,
  Mic,
  MonitorUp,
  Pause,
  Play,
  Plus,
  Radio,
  Search,
  Sparkles,
  Square,
  Terminal,
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

const defaultThreads = [
  { group: 'Codex', title: 'Realtime Linux MVP', age: 'now', active: true },
  { group: 'Codex', title: 'Connect voice harness', age: '1h' },
  { group: 'ChatGPT', title: 'Review spending widgets', age: '2h' },
  { group: 'Sora', title: 'Capture product demo', age: '5h' },
  { group: 'Atlas', title: 'Browser-use checkpoint', age: '7h' },
]

const diffFiles: { path: string; plus: number; minus: number; lines: DiffLine[] }[] = [
  {
    path: 'src/App.tsx',
    plus: 8,
    minus: 5,
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
    plus: 6,
    minus: 1,
    lines: [
      { kind: 'plain', text: 'const { app, BrowserWindow } = require("electron")' },
      { kind: 'remove', text: 'loadURL("http://localhost:5173")' },
      { kind: 'add', text: 'loadURL(process.env.VITE_DEV_SERVER_URL)' },
      { kind: 'add', text: 'backgroundColor: "#050505"' },
    ],
  },
]

function DiffCard({ file }: { file: (typeof diffFiles)[number] }) {
  return (
    <article className="diff-card">
      <header className="diff-card-header">
        <span>{file.path}</span>
        <div>
          <button type="button" aria-label={`Dismiss ${file.path}`}>
            <X size={13} />
          </button>
          <button type="button" aria-label={`Accept ${file.path}`}>
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
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
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
  const selectedWorkspaceName =
    workspaces.find((workspace) => workspace.path === selectedWorkspace)?.name ?? 'codex-realtime-linux'

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
  }

  const shareScreen = async () => {
    setLastError(null)
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      setScreenShared(true)
      stream.getVideoTracks()[0]?.addEventListener('ended', () => setScreenShared(false))
    } catch (error) {
      setLastError(error instanceof Error ? error.message : 'Screen share failed')
    }
  }

  const attachImage = (file: File | undefined) => {
    if (!file) return
    setAttachedImageName(file.name)
    setEvents((current) => [
      {
        method: 'context/image-attached',
        receivedAt: new Date().toISOString(),
        params: { name: file.name, size: file.size, type: file.type },
      },
      ...current,
    ].slice(0, 160))
  }

  const startDemoBuild = async () => {
    setLastError(null)
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
    } catch (error) {
      setLastError(error instanceof Error ? error.message : 'Codex task failed')
    }
  }

  const interruptBuild = async () => {
    if (!activeThreadId) return
    await api('/api/codex/interrupt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: activeThreadId }),
    })
  }

  return (
    <main className="codex-shell">
      <aside className="thread-sidebar">
        <div className="window-bar">
          <span className="dot red" />
          <span className="dot yellow" />
          <span className="dot green" />
          <button type="button" aria-label="Search threads">
            <Search size={15} />
          </button>
        </div>

        <nav className="sidebar-nav" aria-label="Primary">
          <button type="button">
            <Plus size={16} />
            New thread
          </button>
          <button type="button">
            <Wand2 size={16} />
            Automations
          </button>
          <button type="button">
            <Sparkles size={16} />
            Skills
          </button>
        </nav>

        <section className="sidebar-section">
          <h2>Threads</h2>
          <div className="thread-groups">
            {defaultThreads.map((thread) => (
              <button
                type="button"
                className={thread.active ? 'thread-row active' : 'thread-row'}
                key={`${thread.group}-${thread.title}`}
              >
                <span className="thread-group-name">
                  <Folder size={14} />
                  {thread.group}
                </span>
                <span className="thread-title">{thread.title}</span>
                <small>{thread.age}</small>
              </button>
            ))}
          </div>
        </section>

        <section className="sidebar-section workspace-section">
          <h2>Workspaces</h2>
          {workspaces.slice(0, 5).map((workspace) => (
            <button
              className={selectedWorkspace === workspace.path ? 'workspace-row active' : 'workspace-row'}
              key={workspace.id}
              type="button"
              onClick={() => setSelectedWorkspace(workspace.path ?? selectedWorkspace)}
            >
              <Code2 size={14} />
              <span>{workspace.name ?? workspace.id}</span>
            </button>
          ))}
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
            <button type="button">Open</button>
            <button type="button" onClick={startDemoBuild}>
              <Play size={14} />
              Build
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
              The MVP surface is now a three-pane command center: threads and workspaces on the left, realtime
              voice collaboration in the center, and diff/review plus usage context on the right.
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
              <button className="primary-voice" type="button" onClick={startVoice}>
                <Mic size={18} />
                Start voice
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

      <aside className="review-pane">
        <header className="review-header">
          <div>
            <strong>2 files changed</strong>
            <span>+9 -6</span>
          </div>
          <div>
            <button type="button" aria-label="Close review">
              <X size={14} />
            </button>
            <button type="button" aria-label="Accept review">
              <Check size={14} />
            </button>
          </div>
        </header>

        <div className="review-scroll">
          {diffFiles.map((file) => (
            <DiffCard file={file} key={file.path} />
          ))}

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
    </main>
  )
}

export default App
