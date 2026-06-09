import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { opendir, readlink, stat } from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_EVENT_LIMIT = 80
const DEFAULT_SERIAL_BY_ID_DIR = '/dev/serial/by-id'
const MAX_USB_FIELD_LENGTH = 240
const MAX_USB_SUMMARY_LENGTH = 320
const MAX_USB_RAW_PROPERTIES = 40
const MAX_USB_RAW_KEY_LENGTH = 80
const MAX_USB_RAW_VALUE_LENGTH = 500
const MAX_USB_STATUS_ERROR_LENGTH = 500
const MAX_USB_EVENT_BUFFER_LENGTH = 64 * 1024
const MAX_SERIAL_BY_ID_SCAN_ENTRIES = 400
const MAX_SERIAL_BY_ID_DEVICES = 80
const SERIAL_TTY_PATTERN = /^\/dev\/tty(?:ACM|USB)\d+$/
const SERIAL_BY_ID_NAME_PATTERN = /^[a-zA-Z0-9._:+-]+$/
const ARDUINO_VENDOR_IDS = new Set(['2341', '2a03', '1b4f'])
const SERIAL_ADAPTER_VENDOR_IDS = new Set(['1a86', '10c4', '0403'])
const ARDUINO_TEXT_PATTERNS = [
  /arduino/i,
  /genuino/i,
  /uno\b/i,
  /mega\s*2560/i,
  /nano\b/i,
  /leonardo/i,
  /micro\b/i,
  /sparkfun/i,
  /seeeduino/i,
]
const SERIAL_ADAPTER_TEXT_PATTERNS = [
  /wch|ch340|ch341/i,
  /cp210|silicon labs/i,
  /ftdi|ft232/i,
  /usb.?serial/i,
]

export function parseUdevProperties(rawEvent) {
  return rawEvent
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce((properties, line) => {
      const separator = line.indexOf('=')
      if (separator <= 0) return properties
      properties[line.slice(0, separator)] = line.slice(separator + 1)
      return properties
    }, {})
}

function boundedString(value, maxLength) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`
}

function normalizeString(value) {
  return boundedString(value, MAX_USB_FIELD_LENGTH)
}

function boundedStatusError(value, fallback = 'USB monitor unavailable.') {
  return boundedString(typeof value === 'string' && value.trim() ? value : fallback, MAX_USB_STATUS_ERROR_LENGTH)
}

function sanitizeUsbProperties(properties) {
  return Object.fromEntries(
    Object.entries(properties)
      .slice(0, MAX_USB_RAW_PROPERTIES)
      .map(([key, value]) => [
        boundedString(key, MAX_USB_RAW_KEY_LENGTH),
        boundedString(value, MAX_USB_RAW_VALUE_LENGTH),
      ])
      .filter(([key]) => key),
  )
}

function textMatchesArduinoHints(text) {
  return ARDUINO_TEXT_PATTERNS.some((pattern) => pattern.test(text))
}

function textMatchesSerialAdapterHints(text) {
  return SERIAL_ADAPTER_TEXT_PATTERNS.some((pattern) => pattern.test(text))
}

export function classifyUsbDevice(properties) {
  const action = normalizeString(properties.ACTION || properties.action || 'unknown')
  const subsystem = normalizeString(properties.SUBSYSTEM || properties.subsystem)
  const devname = normalizeString(properties.DEVNAME || properties.devname)
  const vendorId = normalizeString(properties.ID_VENDOR_ID || properties.vendorId).toLowerCase()
  const modelId = normalizeString(properties.ID_MODEL_ID || properties.modelId).toLowerCase()
  const vendor = normalizeString(properties.ID_VENDOR_FROM_DATABASE || properties.ID_VENDOR || properties.vendor)
  const model = normalizeString(properties.ID_MODEL_FROM_DATABASE || properties.ID_MODEL || properties.model)
  const serial = normalizeString(properties.ID_SERIAL_SHORT || properties.ID_SERIAL || properties.serial)
  const driver = normalizeString(properties.ID_USB_DRIVER || properties.DRIVER || properties.driver)
  const text = [vendor, model, serial, driver, devname, properties.ID_PATH, properties.DEVPATH].filter(Boolean).join(' ')
  const isSerialTty = SERIAL_TTY_PATTERN.test(devname)
  const hasKnownArduinoVendor = ARDUINO_VENDOR_IDS.has(vendorId)
  const hasKnownSerialAdapterVendor = SERIAL_ADAPTER_VENDOR_IDS.has(vendorId)
  const hasArduinoHints = textMatchesArduinoHints(text)
  const hasSerialAdapterHints = textMatchesSerialAdapterHints(text)
  const isArduinoLike = hasKnownArduinoVendor || hasArduinoHints || (isSerialTty && (hasKnownSerialAdapterVendor || hasSerialAdapterHints))

  return {
    action,
    subsystem,
    devname: devname || null,
    vendor: vendor || null,
    model: model || null,
    vendorId: vendorId || null,
    modelId: modelId || null,
    serial: serial || null,
    driver: driver || null,
    isSerialTty,
    isArduinoLike,
  }
}

export function eventSummary(device) {
  const name = [device.vendor, device.model].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  const port = device.devname ? ` on ${device.devname}` : ''
  const label = name || (device.isArduinoLike ? 'Arduino-like USB device' : 'USB device')
  return boundedString(`${label}${port}`, MAX_USB_SUMMARY_LENGTH)
}

export class UsbDeviceMonitor {
  constructor({
    command = 'udevadm',
    args = ['monitor', '--udev', '--property', '--subsystem-match=tty', '--subsystem-match=usb'],
    eventLimit = DEFAULT_EVENT_LIMIT,
    serialByIdDir = DEFAULT_SERIAL_BY_ID_DIR,
    spawnImpl = spawn,
  } = {}) {
    this.command = command
    this.args = args
    this.eventLimit = eventLimit
    this.serialByIdDir = serialByIdDir
    this.spawnImpl = spawnImpl
    this.proc = null
    this.buffer = ''
    this.events = []
    this.startedAt = null
    this.error = null
  }

  start() {
    if (this.proc) return
    this.startedAt = new Date().toISOString()

    try {
      this.proc = this.spawnImpl(this.command, this.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      this.error = boundedStatusError(error instanceof Error ? error.message : 'USB monitor failed to start.')
      return
    }

    this.proc.stdout?.on('data', (chunk) => {
      this.consume(chunk.toString())
    })

    this.proc.stderr?.on('data', (chunk) => {
      const message = chunk.toString().trim()
      if (message) this.error = boundedStatusError(message)
    })

    this.proc.once('error', (error) => {
      this.error = boundedStatusError(error.message)
      this.proc = null
    })

    this.proc.once('exit', (code, signal) => {
      if (code !== 0 && signal !== 'SIGTERM') {
        this.error = boundedStatusError(`USB monitor exited with ${signal || code}`)
      }
      this.proc = null
    })
  }

  stop() {
    this.proc?.kill('SIGTERM')
    this.proc = null
  }

  consume(text) {
    this.buffer += text
    if (this.buffer.length > MAX_USB_EVENT_BUFFER_LENGTH) {
      this.buffer = this.buffer.slice(-MAX_USB_EVENT_BUFFER_LENGTH)
      this.error = boundedStatusError('USB monitor emitted an oversized incomplete event.')
    }
    const chunks = this.buffer.split(/\n\s*\n/)
    this.buffer = chunks.pop() ?? ''
    for (const chunk of chunks) {
      const properties = parseUdevProperties(chunk)
      this.record(properties)
    }
  }

  record(properties) {
    const device = classifyUsbDevice(properties)
    if (device.action !== 'add' && device.action !== 'remove') return null
    if (!device.devname && !device.vendor && !device.model && !device.vendorId) return null

    const event = {
      id: randomUUID(),
      receivedAt: new Date().toISOString(),
      summary: eventSummary(device),
      device,
      raw: sanitizeUsbProperties(properties),
    }
    this.events = [event, ...this.events].slice(0, this.eventLimit)
    return event
  }

  async scanSerialDevices() {
    const entries = await readSerialById(this.serialByIdDir)
    for (const entry of entries) {
      this.record({
        ACTION: 'add',
        SUBSYSTEM: 'tty',
        DEVNAME: entry.devname,
        ID_VENDOR: entry.vendor,
        ID_MODEL: entry.model,
        ID_SERIAL: entry.serial,
      })
    }
    return entries
  }

  status() {
    return {
      active: Boolean(this.proc),
      startedAt: this.startedAt,
      error: this.error ? boundedStatusError(this.error) : null,
    }
  }
}

export async function readSerialById(serialByIdDir = DEFAULT_SERIAL_BY_ID_DIR) {
  let directory
  try {
    directory = await opendir(serialByIdDir)
  } catch {
    return []
  }

  const devices = []
  let scannedEntries = 0
  try {
    for await (const entry of directory) {
      scannedEntries += 1
      if (scannedEntries > MAX_SERIAL_BY_ID_SCAN_ENTRIES || devices.length >= MAX_SERIAL_BY_ID_DEVICES) break
      if (!entry.isSymbolicLink() || !SERIAL_BY_ID_NAME_PATTERN.test(entry.name)) continue
      const linkPath = path.join(serialByIdDir, entry.name)
      try {
        const target = await readlink(linkPath)
        const devname = path.resolve(serialByIdDir, target)
        if (!SERIAL_TTY_PATTERN.test(devname)) continue
        const info = await stat(devname)
        if (!info.isCharacterDevice()) continue
        const cleaned = entry.name.replace(/^usb-/, '').replace(/-if\d+-port\d+$/i, '')
        const parts = cleaned.split('_')
        devices.push({
          devname,
          vendor: parts[0]?.replace(/-/g, ' ') || null,
          model: parts.slice(1, -1).join(' ').replace(/-/g, ' ') || cleaned.replace(/_/g, ' '),
          serial: parts.at(-1) || entry.name,
        })
      } catch {
        // Ignore stale symlinks while devices are being attached or removed.
      }
    }
  } finally {
    await directory.close().catch(() => {})
  }

  return devices
}
