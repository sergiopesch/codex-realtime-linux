import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultOutputPath = path.join(repoRoot, 'docs', 'mvp-live-checklist-result.md')
const validStatuses = new Set(['pass', 'fail', 'blocked', 'unverified'])

const checks = [
  {
    id: 'desktop-launch',
    title: 'App menu launch',
    prompt: 'Launch Codex by clicking the desktop/app-menu icon and confirm it opens without a terminal.',
  },
  {
    id: 'microphone-permission',
    title: 'Microphone permission',
    prompt: 'Start voice and confirm both permission grant and denied-permission behavior.',
  },
  {
    id: 'speaker-output',
    title: 'Speaker output',
    prompt: 'Confirm Codex audio is audible during a live Realtime session.',
  },
  {
    id: 'voice-transcript',
    title: 'Realtime voice and transcript',
    prompt: 'Confirm start, cancel, mute/unmute, stop, transcript save, and reopened-thread transcript review.',
  },
  {
    id: 'live-webrtc-failure',
    title: 'Live WebRTC failure behavior',
    prompt: 'Confirm live Realtime connection setup failures show bounded, actionable UI feedback.',
  },
  {
    id: 'screen-capture',
    title: 'Screen capture and visual context',
    prompt: 'Share a screen frame while voice is active and confirm visual context is injected and capture stops cleanly.',
  },
  {
    id: 'voice-routed-codex-task',
    title: 'Voice-routed Codex task',
    prompt: 'Use voice to route Codex work against a real external workspace.',
  },
  {
    id: 'generated-html-preview',
    title: 'Generated HTML preview',
    prompt: 'Confirm generated HTML lands under the selected workspace and opens in the temporary closeable browser view.',
  },
  {
    id: 'subtle-agent-activity',
    title: 'Subtle agent activity',
    prompt: 'Confirm Codex activity stays local to the relevant surface and does not take over the window.',
  },
  {
    id: 'weather-live-ui',
    title: 'Weather UI and voice path',
    prompt: 'Confirm Settings weather and voice weather update the shared result card with live data or a clear error.',
  },
  {
    id: 'usb-board-detection',
    title: 'USB board detection',
    prompt: 'Connect the target Arduino-style board and confirm USB detection does not invent unsupported details.',
  },
  {
    id: 'physical-arduino-upload',
    title: 'Physical Arduino upload',
    prompt: 'Upload a safe onboard LED sketch with an explicit detected port and confirm the physical LED behavior.',
  },
]

function usage() {
  return `Usage:
  npm run verify:manual
  npm run verify:manual -- --output docs/mvp-live-checklist-result.md
  npm run verify:manual -- --print-template

Statuses: pass, fail, blocked, unverified
`
}

function normalizeStatus(value) {
  const text = value.trim().toLowerCase()
  if (text === 'p') return 'pass'
  if (text === 'f') return 'fail'
  if (text === 'b') return 'blocked'
  if (text === 'u' || text === 'skip' || text === '') return 'unverified'
  return validStatuses.has(text) ? text : ''
}

function boundedText(value, fallback = '', maxLength = 2_000) {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() : ''
  if (!text) return fallback
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`
}

function parseArgs(argv) {
  const options = {
    outputPath: defaultOutputPath,
    printTemplate: false,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--print-template') {
      options.printTemplate = true
    } else if (arg === '--output') {
      const value = argv[index + 1]
      if (!value) throw new Error('--output requires a path.')
      options.outputPath = path.resolve(repoRoot, value)
      index += 1
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return options
}

function renderRecord({ generatedAt, operator, commit, entries }) {
  const passed = entries.filter((entry) => entry.status === 'pass').length
  const failed = entries.filter((entry) => entry.status === 'fail').length
  const blocked = entries.filter((entry) => entry.status === 'blocked').length
  const unverified = entries.filter((entry) => entry.status === 'unverified').length
  const complete = failed === 0 && blocked === 0 && unverified === 0

  return `# MVP Live Checklist Result

Generated: ${generatedAt}
Operator: ${operator || 'Unrecorded'}
Commit: ${commit || 'Unrecorded'}
Status: ${complete ? 'complete' : 'incomplete'}

Summary: ${passed} passed, ${failed} failed, ${blocked} blocked, ${unverified} unverified.

| Check | Status | Evidence |
| --- | --- | --- |
${entries.map((entry) => `| ${entry.title} | ${entry.status} | ${entry.evidence || 'No evidence recorded.'} |`).join('\n')}

## Completion Rule

This checklist is complete only when every row is marked \`pass\` with concrete evidence from the target Linux desktop.
`
}

async function promptForEntries() {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const operator = boundedText(await rl.question('Operator name or initials: '), 'Unrecorded', 120)
    const commit = boundedText(await rl.question('Commit SHA under test: '), 'Unrecorded', 80)
    const entries = []

    for (const check of checks) {
      console.log(`\n${check.title}`)
      console.log(check.prompt)
      let status = ''
      while (!status) {
        status = normalizeStatus(await rl.question('Status [pass/fail/blocked/unverified]: '))
        if (!status) console.log('Enter pass, fail, blocked, or unverified.')
      }
      const evidence = boundedText(await rl.question('Evidence or note: '), 'No evidence recorded.')
      entries.push({ ...check, status, evidence })
    }

    return { operator, commit, entries }
  } finally {
    rl.close()
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }

  const generatedAt = new Date().toISOString()
  if (options.printTemplate) {
    console.log(renderRecord({
      generatedAt,
      operator: '',
      commit: '',
      entries: checks.map((check) => ({ ...check, status: 'unverified', evidence: check.prompt })),
    }))
    return
  }

  if (!process.stdin.isTTY) {
    throw new Error('Manual checklist recording requires an interactive terminal. Use --print-template for a non-interactive template.')
  }

  const result = await promptForEntries()
  const markdown = renderRecord({ generatedAt, ...result })
  await mkdir(path.dirname(options.outputPath), { recursive: true })
  await writeFile(options.outputPath, markdown)
  console.log(`\nWrote ${path.relative(repoRoot, options.outputPath)}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
