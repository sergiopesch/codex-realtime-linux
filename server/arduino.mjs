import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, opendir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FQBN_PATTERN = /^[a-zA-Z0-9_.-]+:[a-zA-Z0-9_.-]+:[a-zA-Z0-9_.-]+(?::[a-zA-Z0-9_.=,-]+)?$/
const CONFIGURED_DEFAULT_FQBN = process.env.ARDUINO_DEFAULT_FQBN ?? 'arduino:avr:uno'
const DEFAULT_FQBN = FQBN_PATTERN.test(CONFIGURED_DEFAULT_FQBN) ? CONFIGURED_DEFAULT_FQBN : 'arduino:avr:uno'
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ARDUINO_CLI_PATH = process.env.ARDUINO_CLI_PATH || path.join(REPO_ROOT, 'bin', 'arduino-cli')
const DEFAULT_SKETCH_NAME = 'CodexRealtimeSketch'
const MAX_SKETCH_BYTES = 64 * 1024
const MAX_COMMAND_CAPTURE_CHARS = 16_000
const MAX_COMMAND_OUTPUT_CHARS = 4_000
const MAX_STATUS_FIELD_CHARS = 500
const MAX_SERIAL_PORT_SCAN_ENTRIES = 400
const MAX_SERIAL_PORTS = 80
const SERIAL_PORT_PATTERN = /^tty(?:ACM|USB)\d+$/
const SERIAL_PORT_PATH_PATTERN = /^\/dev\/tty(?:ACM|USB)\d+$/
const SERIAL_BY_ID_PATTERN = /^\/dev\/serial\/by-id\/[a-zA-Z0-9._:-]+$/

export class ArduinoUploadError extends Error {
  constructor(message, { code = 'arduino_error', status = 500, details } = {}) {
    super(message)
    this.name = 'ArduinoUploadError'
    this.code = code
    this.status = status
    this.details = sanitizeDiagnosticDetails(details)
  }
}

function limitDiagnosticString(value) {
  if (value.length <= MAX_COMMAND_OUTPUT_CHARS) return value
  return `${value.slice(0, MAX_COMMAND_OUTPUT_CHARS)}... [truncated]`
}

function appendCommandOutput(current, chunk) {
  const marker = '[truncated output]\n'
  const next = `${current}${chunk.toString()}`
  if (next.length <= MAX_COMMAND_CAPTURE_CHARS) return next
  return `${marker}${next.slice(-(MAX_COMMAND_CAPTURE_CHARS - marker.length))}`
}

function limitStatusString(value) {
  const text = typeof value === 'string' && value.trim() ? value.trim() : ''
  if (text.length <= MAX_STATUS_FIELD_CHARS) return text
  return `${text.slice(0, MAX_STATUS_FIELD_CHARS - 3)}...`
}

function sanitizeDiagnosticDetails(value, depth = 0) {
  if (typeof value === 'string') return limitDiagnosticString(value)
  if (value == null || typeof value !== 'object') return value
  if (depth >= 4) return '[truncated]'
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeDiagnosticDetails(item, depth + 1))
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 50)
      .map(([key, item]) => [key, sanitizeDiagnosticDetails(item, depth + 1)]),
  )
}

export function sketchForAction(action) {
  if (action === 'onboard_led_on') {
    return `void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, HIGH);
}

void loop() {
}
`
  }

  if (action === 'onboard_led_blink') {
    return `void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  delay(500);
}
`
  }

  return null
}

export function normalizeUploadRequest(input = {}) {
  const action = typeof input.action === 'string' && input.action.trim() ? input.action.trim() : 'onboard_led_on'
  const port = typeof input.port === 'string' && input.port.trim() ? input.port.trim() : null
  const fqbn = typeof input.fqbn === 'string' && input.fqbn.trim() ? input.fqbn.trim() : null
  const sketchName =
    typeof input.sketchName === 'string' && /^[a-zA-Z][a-zA-Z0-9_]{0,48}$/.test(input.sketchName)
      ? input.sketchName
      : DEFAULT_SKETCH_NAME
  const sketch = action === 'custom_sketch' ? input.sketch : sketchForAction(action)

  if (!['onboard_led_on', 'onboard_led_blink', 'custom_sketch'].includes(action)) {
    throw new ArduinoUploadError('Unsupported Arduino action.', {
      code: 'arduino_invalid_action',
      status: 400,
    })
  }

  if (typeof sketch !== 'string' || !sketch.trim()) {
    throw new ArduinoUploadError('A sketch is required for this Arduino upload.', {
      code: 'arduino_missing_sketch',
      status: 400,
    })
  }

  if (Buffer.byteLength(sketch, 'utf8') > MAX_SKETCH_BYTES) {
    throw new ArduinoUploadError('The Arduino sketch is too large for this upload path.', {
      code: 'arduino_sketch_too_large',
      status: 400,
    })
  }

  if (!/\bsetup\s*\(\s*\)/.test(sketch) || !/\bloop\s*\(\s*\)/.test(sketch)) {
    throw new ArduinoUploadError('Arduino sketches must include setup() and loop().', {
      code: 'arduino_invalid_sketch',
      status: 400,
    })
  }

  if (port && !isSupportedSerialPort(port)) {
    throw new ArduinoUploadError('Arduino serial ports must be /dev/ttyACM*, /dev/ttyUSB*, or /dev/serial/by-id/*.', {
      code: 'arduino_invalid_port',
      status: 400,
    })
  }

  if (fqbn && !FQBN_PATTERN.test(fqbn)) {
    throw new ArduinoUploadError('Arduino FQBN values must use package:architecture:board format.', {
      code: 'arduino_invalid_fqbn',
      status: 400,
    })
  }

  return { action, port, fqbn, sketch, sketchName }
}

export async function listSerialPorts({ devDir = '/dev' } = {}) {
  let directory
  try {
    directory = await opendir(devDir)
  } catch {
    return []
  }

  const ports = []
  let scannedEntries = 0
  try {
    for await (const entry of directory) {
      scannedEntries += 1
      if (scannedEntries > MAX_SERIAL_PORT_SCAN_ENTRIES || ports.length >= MAX_SERIAL_PORTS) break
      if (SERIAL_PORT_PATTERN.test(entry.name)) ports.push(path.join(devDir, entry.name))
    }
  } finally {
    await directory.close().catch(() => {})
  }

  return ports.sort()
}

function isSupportedSerialPort(port) {
  return SERIAL_PORT_PATH_PATTERN.test(port) || SERIAL_BY_ID_PATTERN.test(port)
}

function normalizeDetectedBoard(entry) {
  if (!entry || typeof entry !== 'object') return null
  const candidateFqbn = limitStatusString(entry.fqbn)
  const address = limitStatusString(entry.address)
  if (!address) return null

  return {
    address,
    label: limitStatusString(entry.label) || null,
    protocol: limitStatusString(entry.protocol) || null,
    boardName: limitStatusString(entry.boardName) || null,
    fqbn: candidateFqbn && FQBN_PATTERN.test(candidateFqbn) ? candidateFqbn : null,
  }
}

function summarizeCommandOutput(stdout, stderr) {
  return `${stderr || stdout || ''}`
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-6)
    .join(' ')
    .slice(0, 700)
}

function runCommand(command, args, { spawnImpl = spawn, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawnImpl(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      proc.kill?.('SIGTERM')
      reject(new ArduinoUploadError(`${command} timed out.`, { code: 'arduino_cli_timeout', status: 504 }))
    }, timeoutMs)

    proc.stdout?.on('data', (chunk) => {
      stdout = appendCommandOutput(stdout, chunk)
    })
    proc.stderr?.on('data', (chunk) => {
      stderr = appendCommandOutput(stderr, chunk)
    })
    proc.once('error', (error) => {
      clearTimeout(timeout)
      reject(
        new ArduinoUploadError('arduino-cli is not available. Install it before uploading sketches.', {
          code: 'arduino_cli_missing',
          status: 503,
          details: error.message,
        }),
      )
    })
    proc.once('exit', (exitCode) => {
      clearTimeout(timeout)
      if (exitCode === 0) {
        resolve({ stdout, stderr })
        return
      }
      reject(
        new ArduinoUploadError(
          [`${command} failed with exit code ${exitCode}.`, summarizeCommandOutput(stdout, stderr)]
            .filter(Boolean)
            .join(' '),
          {
            code: 'arduino_cli_failed',
            status: 502,
            details: { stdout, stderr, exitCode },
          },
        ),
      )
    })
  })
}

async function runArduinoCli(args, options = {}) {
  try {
    return await runCommand(ARDUINO_CLI_PATH, args, options)
  } catch (error) {
    if (process.env.ARDUINO_CLI_PATH || error?.code !== 'arduino_cli_missing') throw error
    return runCommand('arduino-cli', args, options)
  }
}

function parseBoardListJson(value) {
  let data
  try {
    data = JSON.parse(value || '{}')
  } catch {
    return []
  }

  const detectedPorts = Array.isArray(data?.detected_ports) ? data.detected_ports : []
  return detectedPorts
    .map((entry) => {
      const matchingBoards = Array.isArray(entry?.matching_boards) ? entry.matching_boards : []
      const matchingBoard = matchingBoards.find((board) => typeof board?.fqbn === 'string') ?? matchingBoards[0]
      const port = entry?.port ?? {}
      return normalizeDetectedBoard({
        address: typeof port?.address === 'string' ? port.address : null,
        label: typeof port?.label === 'string' ? port.label : null,
        protocol: typeof port?.protocol === 'string' ? port.protocol : null,
        boardName: typeof matchingBoard?.name === 'string' ? matchingBoard.name : null,
        fqbn: typeof matchingBoard?.fqbn === 'string' ? matchingBoard.fqbn : null,
      })
    })
    .filter(Boolean)
}

export async function listArduinoBoards({ run = runArduinoCli } = {}) {
  try {
    const result = await run(['board', 'list', '--format', 'json'], { timeoutMs: 10_000 })
    return parseBoardListJson(result.stdout || result.stderr)
  } catch {
    return []
  }
}

export async function getArduinoCliStatus({ run = runArduinoCli } = {}) {
  try {
    const version = await run(['version'], { timeoutMs: 10_000 })
    return {
      available: true,
      version: limitStatusString(version.stdout) || limitStatusString(version.stderr),
      defaultFqbn: DEFAULT_FQBN,
      command: limitStatusString(ARDUINO_CLI_PATH),
    }
  } catch (error) {
    return {
      available: false,
      version: null,
      defaultFqbn: DEFAULT_FQBN,
      command: limitStatusString(ARDUINO_CLI_PATH),
      error: limitStatusString(error instanceof Error ? error.message : 'arduino-cli is not available.'),
    }
  }
}

export async function uploadArduinoSketch(
  input = {},
  { run = runArduinoCli, listPorts = listSerialPorts, listBoards = listArduinoBoards } = {},
) {
  const request = normalizeUploadRequest(input)
  const [rawPorts, rawBoards] = await Promise.all([listPorts(), listBoards({ run })])
  const ports = (Array.isArray(rawPorts) ? rawPorts : []).filter((port) => typeof port === 'string' && isSupportedSerialPort(port))
  const boards = (Array.isArray(rawBoards) ? rawBoards : []).map(normalizeDetectedBoard).filter(Boolean)
  const matchingBoard = request.port ? boards.find((board) => board.address === request.port) : null
  const autoDetectedBoard = request.port ? null : boards[0]
  const detectedBoard = matchingBoard ?? autoDetectedBoard
  const detectedPort = detectedBoard?.address && isSupportedSerialPort(detectedBoard.address) ? detectedBoard.address : null
  const port = request.port ?? detectedPort ?? ports[0]
  if (!port) {
    throw new ArduinoUploadError('No Arduino serial port was found. Plug in the board and try again.', {
      code: 'arduino_port_not_found',
      status: 404,
      details: {
        serialPorts: ports,
        detectedBoards: boards,
        hint: 'If the board is connected but missing here, unplug/replug it and check Linux serial permissions. The user may need to be in the dialout group.',
      },
    })
  }
  const fqbn = request.fqbn ?? detectedBoard?.fqbn ?? DEFAULT_FQBN
  const targetLabel = detectedBoard?.boardName ?? fqbn

  const sketchRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-arduino-'))
  const sketchDir = path.join(sketchRoot, request.sketchName)
  const sketchPath = path.join(sketchDir, `${request.sketchName}.ino`)

  try {
    await mkdir(sketchDir, { recursive: true })
    await writeFile(sketchPath, request.sketch, { flag: 'wx' })

    const compile = await run(['compile', '--fqbn', fqbn, sketchDir])
    const upload = await run(['upload', '-p', port, '--fqbn', fqbn, sketchDir])

    return {
      action: request.action,
      fqbn,
      port,
      boardName: detectedBoard?.boardName ?? null,
      sketchName: request.sketchName,
      compile: {
        stdout: limitDiagnosticString(compile.stdout),
        stderr: limitDiagnosticString(compile.stderr),
      },
      upload: {
        stdout: limitDiagnosticString(upload.stdout),
        stderr: limitDiagnosticString(upload.stderr),
      },
      summary:
        request.action === 'onboard_led_on'
          ? `Uploaded onboard LED on sketch to ${targetLabel} on ${port}.`
          : request.action === 'onboard_led_blink'
            ? `Uploaded onboard LED blink sketch to ${targetLabel} on ${port}.`
            : `Uploaded custom sketch to ${targetLabel} on ${port}.`,
    }
  } finally {
    await rm(sketchRoot, { recursive: true, force: true })
  }
}
