import { spawn } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultOutputPath = path.join(repoRoot, 'docs', 'mvp-live-probe-result.md')
const defaultApiBaseUrl = 'http://127.0.0.1:3311'
const appId = 'codex-realtime-linux'
const serviceName = 'codex-realtime-linux-app.service'

function configuredAbsoluteDir(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback
  const candidate = value.trim()
  if (!path.isAbsolute(candidate) || /[\u0000-\u001f\u007f]/.test(candidate)) return fallback
  return path.resolve(candidate)
}

function parseArgs(argv) {
  const options = {
    apiBaseUrl: defaultApiBaseUrl,
    outputPath: defaultOutputPath,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--api') {
      const value = argv[index + 1]
      if (!value) throw new Error('--api requires a URL.')
      options.apiBaseUrl = value
      index += 1
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

function usage() {
  return `Usage:
  npm run verify:live
  npm run verify:live -- --output docs/mvp-live-probe-result.md
  npm run verify:live -- --api http://127.0.0.1:3311
`
}

function boundedText(value, fallback = '', maxLength = 1_500) {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() : ''
  if (!text) return fallback
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const proc = spawn(command, args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    proc.once('error', (error) => {
      resolve({ ok: false, code: null, stdout, stderr: error.message })
    })
    proc.once('exit', (code) => {
      resolve({ ok: code === 0, code, stdout, stderr })
    })
  })
}

async function readJsonResponse(url, options = {}) {
  const response = await fetch(url, options)
  const text = await response.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  return { response, body, text }
}

function tableRow(check, status, evidence) {
  return {
    check,
    status,
    evidence: boundedText(evidence, 'No evidence recorded.', 2_000).replace(/\|/g, '\\|'),
  }
}

async function fileEvidence(filePath, label) {
  try {
    const details = await stat(filePath)
    if (!details.isFile()) return tableRow(label, 'fail', `${filePath} exists but is not a file.`)
    return tableRow(label, 'pass', `${filePath}; mode ${(details.mode & 0o777).toString(8)}; size ${details.size} bytes.`)
  } catch (error) {
    return tableRow(label, 'fail', `${filePath} not found: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function probeDesktopFiles() {
  const xdgDataHome = configuredAbsoluteDir(process.env.XDG_DATA_HOME, path.join(os.homedir(), '.local', 'share'))
  const xdgStateHome = configuredAbsoluteDir(process.env.XDG_STATE_HOME, path.join(os.homedir(), '.local', 'state'))
  const desktopEntryPath = path.join(xdgDataHome, 'applications', `${appId}.desktop`)
  const iconPath = path.join(xdgDataHome, 'icons', 'hicolor', '512x512', 'apps', `${appId}.png`)
  const desktopLogPath = path.join(xdgStateHome, appId, 'desktop-launch.log')
  const apiLogPath = path.join(xdgStateHome, appId, 'api-server.log')
  const rows = [
    await fileEvidence(desktopEntryPath, 'Desktop entry'),
    await fileEvidence(iconPath, 'Desktop icon'),
    await fileEvidence(desktopLogPath, 'Desktop launch log'),
    await fileEvidence(apiLogPath, 'API server log'),
  ]

  try {
    const desktopEntry = await readFile(desktopEntryPath, 'utf8')
    const hasExpectedLauncher = desktopEntry.includes('Name=Codex') && desktopEntry.includes('Terminal=false') && desktopEntry.includes(path.join(repoRoot, 'scripts', 'launch-desktop.sh'))
    rows.push(tableRow('Desktop entry contents', hasExpectedLauncher ? 'pass' : 'fail', hasExpectedLauncher ? 'Name, launcher, and terminal mode are correct.' : 'Desktop entry is missing expected Name, Terminal, or launcher path.'))
  } catch (error) {
    rows.push(tableRow('Desktop entry contents', 'fail', error instanceof Error ? error.message : String(error)))
  }

  return rows
}

async function probeService() {
  const active = await run('systemctl', ['--user', 'is-active', serviceName])
  if (!active.ok) return tableRow('Desktop service', 'warn', `Service not active or systemd unavailable: ${boundedText(active.stderr || active.stdout || String(active.code))}`)
  return tableRow('Desktop service', 'pass', `${serviceName} is ${boundedText(active.stdout, 'active')}.`)
}

async function probeApi(apiBaseUrl) {
  try {
    const { response, body } = await readJsonResponse(`${apiBaseUrl}/api/status`)
    if (!response.ok || !body) return tableRow('API status', 'fail', `/api/status returned HTTP ${response.status}.`)
    const ok = body.appRoot === repoRoot && body.appName === appId
    return tableRow('API status', ok ? 'pass' : 'fail', `HTTP ${response.status}; appRoot=${body.appRoot}; realtime=${body.realtime}; openAiKeySource=${body.openAiKeySource}; usb.active=${body.usb?.active}; arduino.available=${body.arduino?.available}.`)
  } catch (error) {
    return tableRow('API status', 'fail', error instanceof Error ? error.message : String(error))
  }
}

async function probeRealtimeToken(apiBaseUrl) {
  try {
    const { response, body, text } = await readJsonResponse(`${apiBaseUrl}/api/realtime/token`, { method: 'POST' })
    if (response.ok) return tableRow('Realtime token endpoint', 'pass', `HTTP ${response.status}; response bytes ${Buffer.byteLength(text, 'utf8')}; token body intentionally not recorded.`)
    return tableRow('Realtime token endpoint', 'warn', `HTTP ${response.status}; code=${body?.code ?? 'unknown'}; error=${body?.error ?? 'unavailable'}.`)
  } catch (error) {
    return tableRow('Realtime token endpoint', 'fail', error instanceof Error ? error.message : String(error))
  }
}

async function probeUsbAndArduino(apiBaseUrl) {
  const rows = []
  try {
    const { response, body } = await readJsonResponse(`${apiBaseUrl}/api/usb/events?scan=true`)
    const active = body?.status?.active === true
    const devices = Array.isArray(body?.data) ? body.data.length : 0
    rows.push(tableRow('USB watcher', response.ok && active ? 'pass' : 'warn', `HTTP ${response.status}; active=${active}; detected events=${devices}.`))
  } catch (error) {
    rows.push(tableRow('USB watcher', 'warn', error instanceof Error ? error.message : String(error)))
  }

  try {
    const { response, body } = await readJsonResponse(`${apiBaseUrl}/api/arduino/status`)
    const available = body?.cli?.available === true
    const boards = Array.isArray(body?.boards) ? body.boards.length : 0
    const ports = Array.isArray(body?.ports) ? body.ports.length : 0
    rows.push(tableRow('Arduino status', response.ok && available ? (boards > 0 || ports > 0 ? 'pass' : 'warn') : 'fail', `HTTP ${response.status}; cli.available=${available}; boards=${boards}; ports=${ports}; command=${body?.cli?.command ?? 'unknown'}.`))
  } catch (error) {
    rows.push(tableRow('Arduino status', 'fail', error instanceof Error ? error.message : String(error)))
  }

  return rows
}

async function probeWeather(apiBaseUrl) {
  try {
    const { response, body } = await readJsonResponse(`${apiBaseUrl}/api/weather/current?location=London&units=metric`)
    if (response.ok) return tableRow('Weather route', 'pass', `HTTP ${response.status}; summary=${body?.summary ?? 'missing summary'}.`)
    return tableRow('Weather route', 'warn', `HTTP ${response.status}; code=${body?.code ?? 'unknown'}; error=${body?.error ?? 'unavailable'}.`)
  } catch (error) {
    return tableRow('Weather route', 'warn', error instanceof Error ? error.message : String(error))
  }
}

async function probeMediaDevices() {
  const rows = []
  const pactlSources = await run('pactl', ['list', 'short', 'sources'])
  const wpctl = await run('wpctl', ['status'])
  const sourceCount = pactlSources.ok ? pactlSources.stdout.split('\n').filter((line) => line.trim()).length : 0
  const wpctlText = wpctl.stdout || ''
  const hasSink = /Sinks:[\s\S]*\*/.test(wpctlText)
  const hasSource = /Sources:[\s\S]*\*/.test(wpctlText)
  const hasVideo = /Video[\s\S]*Sources:[\s\S]*\*/.test(wpctlText)
  rows.push(tableRow('Audio devices', sourceCount > 0 || hasSource || hasSink ? 'pass' : 'warn', `pactl sources=${sourceCount}; wpctl default source=${hasSource}; wpctl default sink=${hasSink}.`))
  rows.push(tableRow('Video devices', hasVideo ? 'pass' : 'warn', `wpctl video source detected=${hasVideo}. This does not prove Electron screen-capture permission.`))
  return rows
}

async function probeGit() {
  const branch = await run('git', ['branch', '--show-current'])
  const commit = await run('git', ['rev-parse', '--short', 'HEAD'])
  const status = await run('git', ['status', '--short'])
  return tableRow('Git state', status.ok && !status.stdout.trim() ? 'pass' : 'warn', `branch=${boundedText(branch.stdout, 'unknown')}; commit=${boundedText(commit.stdout, 'unknown')}; dirty=${Boolean(status.stdout.trim())}.`)
}

function renderReport({ generatedAt, apiBaseUrl, rows }) {
  const pass = rows.filter((row) => row.status === 'pass').length
  const warn = rows.filter((row) => row.status === 'warn').length
  const fail = rows.filter((row) => row.status === 'fail').length
  return `# MVP Live Environment Probe

Generated: ${generatedAt}
API: ${apiBaseUrl}
Status: ${fail === 0 ? 'usable' : 'attention-required'}

Summary: ${pass} passed, ${warn} warnings, ${fail} failed.

| Probe | Status | Evidence |
| --- | --- | --- |
${rows.map((row) => `| ${row.check} | ${row.status} | ${row.evidence} |`).join('\n')}

## Scope

This probe records machine-observable state only. It does not prove microphone permission acceptance, speaker audibility, screen-share permission UX, realtime conversation quality, generated-workspace artifact correctness, or physical Arduino LED behavior. Those checks still require \`npm run verify:manual\`.
`
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }

  const rows = [
    await probeGit(),
    await probeService(),
    ...(await probeDesktopFiles()),
    await probeApi(options.apiBaseUrl),
    await probeRealtimeToken(options.apiBaseUrl),
    ...(await probeUsbAndArduino(options.apiBaseUrl)),
    await probeWeather(options.apiBaseUrl),
    ...(await probeMediaDevices()),
  ]
  const report = renderReport({ generatedAt: new Date().toISOString(), apiBaseUrl: options.apiBaseUrl, rows })
  await mkdir(path.dirname(options.outputPath), { recursive: true })
  await writeFile(options.outputPath, report)
  console.log(`Wrote ${path.relative(repoRoot, options.outputPath)}`)
  const failed = rows.filter((row) => row.status === 'fail')
  if (failed.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error)
  process.exit(1)
})
