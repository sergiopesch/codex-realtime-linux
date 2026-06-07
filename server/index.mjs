import 'dotenv/config'
import express from 'express'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const PORT = Number(process.env.PORT ?? 3311)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const OPENAI_ADMIN_KEY = process.env.OPENAI_ADMIN_KEY ?? process.env.OPENAI_API_ADMIN_KEY
const CODEX_API_KEY = process.env.CODEX_API_KEY ?? (process.env.CODEX_USE_OPENAI_API_KEY === 'true' ? OPENAI_API_KEY : undefined)
const CODEX_FORCE_API_KEY_AUTH = process.env.CODEX_FORCE_API_KEY_AUTH === 'true'
const CODEX_MODEL = process.env.CODEX_MODEL ?? 'gpt-5.4'
const REALTIME_MODEL = process.env.REALTIME_MODEL ?? 'gpt-realtime-2'

const app = express()

app.use('/api/realtime/session', express.text({ type: ['application/sdp', 'text/plain'], limit: '2mb' }))
app.use(express.json({ limit: '25mb' }))

class CodexRpc {
  proc = null
  rl = null
  nextId = 1
  ready = false
  pending = new Map()
  notifications = []

  async ensure() {
    if (this.ready) return

    this.proc = spawn('codex', ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
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

    this.proc.once('exit', (code) => {
      this.ready = false
      this.proc = null
      for (const { reject } of this.pending.values()) {
        reject(new Error(`codex app-server exited with code ${code}`))
      }
      this.pending.clear()
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

    if (CODEX_API_KEY) {
      const account = await this.request('account/read', { refreshToken: false })
      if (CODEX_FORCE_API_KEY_AUTH || !account?.account) {
        await this.request('account/login/start', {
          type: 'apiKey',
          apiKey: CODEX_API_KEY,
        })
      }
    }
  }

  #handleLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }

    if (message.id != null && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) reject(new Error(message.error.message ?? 'Codex app-server request failed'))
      else resolve(message.result)
      return
    }

    this.notifications.unshift({ ...message, receivedAt: new Date().toISOString() })
    this.notifications = this.notifications.slice(0, 160)
  }

  request(method, params = {}) {
    const id = this.nextId++
    const payload = { method, id, params }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.proc.stdin.write(`${JSON.stringify(payload)}\n`)
    })
  }

  notify(method, params = {}) {
    this.proc.stdin.write(`${JSON.stringify({ method, params })}\n`)
  }
}

const codex = new CodexRpc()

function demoProjects() {
  return [
    { id: 'local-openclaw', name: 'openclaw', path: '/home/sergiopesch/openclaw', status: 'local' },
    { id: 'local-voco', name: 'voco', path: '/home/sergiopesch/voco', status: 'local' },
    { id: 'local-demo', name: 'codex-realtime-linux', path: '/home/sergiopesch/codex-realtime-linux', status: 'active' },
  ]
}

function normalizeCosts(costs) {
  const buckets = Array.isArray(costs?.data) ? costs.data : []
  const totalsByLabel = new Map()

  for (const bucket of buckets) {
    const results = Array.isArray(bucket?.results) ? bucket.results : []
    for (const result of results) {
      const label = result.line_item ?? result.object ?? result.model ?? 'OpenAI usage'
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
    currency: buckets[0]?.results?.[0]?.amount?.currency ?? 'usd',
    buckets: normalizedBuckets.length > 0 ? normalizedBuckets : [{ label: 'OpenAI usage', value: total }],
    raw: costs,
  }
}

async function openaiGet(path, key = OPENAI_ADMIN_KEY) {
  if (!key) throw new Error('OPENAI_ADMIN_KEY is not configured')
  const response = await fetch(`https://api.openai.com/v1${path}`, {
    headers: { Authorization: `Bearer ${key}` },
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`${response.status} ${response.statusText}: ${body.slice(0, 300)}`)
  }
  return response.json()
}

app.get('/api/status', async (_req, res) => {
  res.json({
    realtime: Boolean(OPENAI_API_KEY),
    adminApi: Boolean(OPENAI_ADMIN_KEY),
    codexApiKey: Boolean(CODEX_API_KEY),
    codexAuthPreference: CODEX_API_KEY ? 'api-key' : 'existing-codex-auth',
    codexBin: 'codex',
    realtimeModel: REALTIME_MODEL,
    codexModel: CODEX_MODEL,
  })
})

app.post('/api/realtime/session', async (req, res) => {
  if (!OPENAI_API_KEY) {
    res.status(503).json({ error: 'OPENAI_API_KEY is required for live Realtime voice sessions.' })
    return
  }

  const session = {
    type: 'realtime',
    model: REALTIME_MODEL,
    instructions: [
      'You are the voice director for a Linux Codex client.',
      'You collaborate through speech, keep the user oriented, and turn product intent into Codex tasks.',
      'Do not claim to directly edit files. Use tools to start, steer, or interrupt Codex execution.',
      'Be concise while work is running. Invite interruption when the product direction is ambiguous.',
    ].join(' '),
    audio: {
      output: { voice: process.env.REALTIME_VOICE ?? 'marin' },
    },
    tools: [
      {
        type: 'function',
        name: 'codex_start_task',
        description: 'Start a Codex coding task in the selected local workspace.',
        parameters: {
          type: 'object',
          properties: {
            goal: { type: 'string' },
            cwd: { type: 'string' },
          },
          required: ['goal'],
        },
      },
      {
        type: 'function',
        name: 'codex_steer_task',
        description: 'Steer the active Codex task after the user changes direction.',
        parameters: {
          type: 'object',
          properties: {
            instruction: { type: 'string' },
          },
          required: ['instruction'],
        },
      },
      {
        type: 'function',
        name: 'codex_interrupt_task',
        description: 'Interrupt the active Codex task.',
        parameters: { type: 'object', properties: {} },
      },
    ],
  }

  const form = new FormData()
  form.set('sdp', req.body)
  form.set('session', JSON.stringify(session))

  const response = await fetch('https://api.openai.com/v1/realtime/calls', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Safety-Identifier': process.env.OPENAI_SAFETY_IDENTIFIER ?? 'local-demo-user',
    },
    body: form,
  })

  const answer = await response.text()
  res.status(response.status).type('application/sdp').send(answer)
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

app.post('/api/codex/task', async (req, res) => {
  const cwd = req.body.cwd || '/home/sergiopesch/codex-realtime-linux'
  const goal = req.body.goal || 'Inspect this project and summarize the next best implementation step.'

  try {
    await codex.ensure()
    const threadResult = await codex.request('thread/start', {
      model: CODEX_MODEL,
      cwd,
      sandbox: 'workspaceWrite',
      approvalPolicy: 'onRequest',
      serviceName: 'codex_realtime_linux',
    })
    const threadId = threadResult.thread.id
    const turnResult = await codex.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: goal }],
    })
    res.json({ thread: threadResult.thread, turn: turnResult.turn })
  } catch (error) {
    res.status(502).json({ error: error.message })
  }
})

app.post('/api/codex/steer', async (req, res) => {
  try {
    await codex.ensure()
    res.json(await codex.request('turn/steer', {
      threadId: req.body.threadId,
      input: [{ type: 'text', text: req.body.instruction }],
    }))
  } catch (error) {
    res.status(502).json({ error: error.message })
  }
})

app.post('/api/codex/interrupt', async (req, res) => {
  try {
    await codex.ensure()
    res.json(await codex.request('turn/interrupt', { threadId: req.body.threadId }))
  } catch (error) {
    res.status(502).json({ error: error.message })
  }
})

app.get('/api/workspaces', async (_req, res) => {
  try {
    const projects = await openaiGet('/organization/projects?limit=20')
    res.json({ source: 'admin-api', data: projects.data ?? projects })
  } catch (error) {
    res.json({ source: OPENAI_ADMIN_KEY ? 'admin-api-error' : 'local-demo', error: error.message, data: demoProjects() })
  }
})

app.get('/api/spend', async (_req, res) => {
  const now = Math.floor(Date.now() / 1000)
  const thirtyDaysAgo = now - 60 * 60 * 24 * 30

  try {
    const costs = await openaiGet(`/organization/costs?start_time=${thirtyDaysAgo}&limit=30`)
    res.json({ source: 'admin-api', data: normalizeCosts(costs) })
  } catch (error) {
    res.json({
      source: OPENAI_ADMIN_KEY ? 'admin-api-error' : 'demo',
      error: error.message,
      data: {
        total: 42.8,
        currency: 'usd',
        buckets: [
          { label: 'Realtime voice', value: 12.4 },
          { label: 'Codex agents', value: 21.9 },
          { label: 'Tools', value: 8.5 },
        ],
      },
    })
  }
})

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Codex Realtime Linux API listening on http://127.0.0.1:${PORT}`)
})
