import { spawn } from 'node:child_process'
import { readdir, readlink, stat } from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_EVENT_LIMIT = 80
const DEFAULT_SERIAL_BY_ID_DIR = '/dev/serial/by-id'
const MAX_USB_FIELD_LENGTH = 240
const MAX_USB_SUMMARY_LENGTH = 320
const MAX_USB_RAW_PROPERTIES = 40
const MAX_USB_RAW_KEY_LENGTH = 80
const MAX_USB_RAW_VALUE_LENGTH = 500
const SERIAL_TTY_PATTERN = /^\/dev\/tty(?:ACM|USB)\d+$/
const ARDUINO_VENDOR_IDS = new Set(['2341', '2a03', '1a86', '10c4', '0403', '1b4f'])
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
  const hasArduinoHints = textMatchesArduinoHints(text) || ARDUINO_VENDOR_IDS.has(vendorId)

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
    isArduinoLike: Boolean(hasArduinoHints && (isSerialTty || subsystem === 'tty' || subsystem === 'usb')),
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
      this.error = error instanceof Error ? error.message : 'USB monitor failed to start.'
      return
    }

    this.proc.stdout?.on('data', (chunk) => {
      this.consume(chunk.toString())
    })

    this.proc.stderr?.on('data', (chunk) => {
      const message = chunk.toString().trim()
      if (message) this.error = message
    })

    this.proc.once('error', (error) => {
      this.error = error.message
      this.proc = null
    })

    this.proc.once('exit', (code, signal) => {
      if (code !== 0 && signal !== 'SIGTERM') {
        this.error = `USB monitor exited with ${signal || code}`
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
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
      error: this.error,
    }
  }
}

export async function readSerialById(serialByIdDir = DEFAULT_SERIAL_BY_ID_DIR) {
  let entries
  try {
    entries = await readdir(serialByIdDir)
  } catch {
    return []
  }

  const devices = []
  for (const entry of entries) {
    const linkPath = path.join(serialByIdDir, entry)
    try {
      const target = await readlink(linkPath)
      const devname = path.resolve(serialByIdDir, target)
      const info = await stat(devname)
      if (!info.isCharacterDevice()) continue
      const cleaned = entry.replace(/^usb-/, '').replace(/-if\d+-port\d+$/i, '')
      const parts = cleaned.split('_')
      devices.push({
        devname,
        vendor: parts[0]?.replace(/-/g, ' ') || null,
        model: parts.slice(1, -1).join(' ').replace(/-/g, ' ') || cleaned.replace(/_/g, ' '),
        serial: parts.at(-1) || entry,
      })
    } catch {
      // Ignore stale symlinks while devices are being attached or removed.
    }
  }

  return devices
}
