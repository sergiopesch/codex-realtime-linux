import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { classifyUsbDevice, eventSummary, parseUdevProperties, readSerialById, UsbDeviceMonitor } from './usb.mjs'

test('parseUdevProperties parses udev monitor property blocks', () => {
  const properties = parseUdevProperties(`
ACTION=add
SUBSYSTEM=tty
DEVNAME=/dev/ttyACM0
ID_VENDOR=Arduino__www.arduino.cc_
ID_MODEL=Arduino_Uno
`)

  assert.equal(properties.ACTION, 'add')
  assert.equal(properties.SUBSYSTEM, 'tty')
  assert.equal(properties.DEVNAME, '/dev/ttyACM0')
  assert.equal(properties.ID_MODEL, 'Arduino_Uno')
})

test('classifyUsbDevice identifies an Arduino Uno ttyACM device', () => {
  const device = classifyUsbDevice({
    ACTION: 'add',
    SUBSYSTEM: 'tty',
    DEVNAME: '/dev/ttyACM0',
    ID_VENDOR_ID: '2341',
    ID_VENDOR: 'Arduino',
    ID_MODEL: 'Arduino_Uno',
  })

  assert.equal(device.isSerialTty, true)
  assert.equal(device.isArduinoLike, true)
  assert.match(eventSummary(device), /Arduino Arduino_Uno on \/dev\/ttyACM0/)
})

test('classifyUsbDevice identifies common CH340 Arduino clone adapters', () => {
  const device = classifyUsbDevice({
    ACTION: 'add',
    SUBSYSTEM: 'tty',
    DEVNAME: '/dev/ttyUSB0',
    ID_VENDOR_ID: '1a86',
    ID_VENDOR: 'QinHeng Electronics',
    ID_MODEL: 'CH340 serial converter',
  })

  assert.equal(device.isSerialTty, true)
  assert.equal(device.isArduinoLike, true)
})

test('classifyUsbDevice requires a serial tty for generic USB serial adapters', () => {
  const nonTtyAdapter = classifyUsbDevice({
    ACTION: 'add',
    SUBSYSTEM: 'usb',
    ID_VENDOR_ID: '10c4',
    ID_VENDOR: 'Silicon Labs',
    ID_MODEL: 'CP2102 USB to UART Bridge Controller',
  })
  const ttyAdapter = classifyUsbDevice({
    ACTION: 'add',
    SUBSYSTEM: 'tty',
    DEVNAME: '/dev/ttyUSB1',
    ID_VENDOR_ID: '10c4',
    ID_VENDOR: 'Silicon Labs',
    ID_MODEL: 'CP2102 USB to UART Bridge Controller',
  })

  assert.equal(nonTtyAdapter.isSerialTty, false)
  assert.equal(nonTtyAdapter.isArduinoLike, false)
  assert.equal(ttyAdapter.isSerialTty, true)
  assert.equal(ttyAdapter.isArduinoLike, true)
})

test('classifyUsbDevice does not treat unrelated USB devices as Arduino boards', () => {
  const device = classifyUsbDevice({
    ACTION: 'add',
    SUBSYSTEM: 'usb',
    ID_VENDOR: 'Lenovo',
    ID_MODEL: 'Integrated Camera',
  })

  assert.equal(device.isSerialTty, false)
  assert.equal(device.isArduinoLike, false)
})

test('readSerialById ignores unsafe or non-serial by-id entries', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codex-usb-by-id-'))
  t.after(() => rm(tempDir, { recursive: true, force: true }))

  const byIdDir = path.join(tempDir, 'by-id')
  await mkdir(byIdDir, { recursive: true })
  await writeFile(path.join(byIdDir, 'plain-file'), 'not a symlink')
  await symlink('/dev/null', path.join(byIdDir, 'usb-Arduino_Uno_123-if00'))
  await symlink('/dev/null', path.join(byIdDir, 'usb-Arduino Uno unsafe-if00'))
  await symlink('../ttyS0', path.join(byIdDir, 'usb-Serial_TTY_S0-if00'))

  assert.deepEqual(await readSerialById(byIdDir), [])
})

test('UsbDeviceMonitor records complete add events from streamed udev chunks', () => {
  const monitor = new UsbDeviceMonitor({ spawnImpl: () => null })
  monitor.consume('ACTION=add\nSUBSYSTEM=tty\n')
  monitor.consume('DEVNAME=/dev/ttyACM0\nID_VENDOR=Arduino\nID_MODEL=Uno\n\n')

  assert.equal(monitor.events.length, 1)
  assert.equal(monitor.events[0].device.isArduinoLike, true)
  assert.equal(monitor.events[0].summary, 'Arduino Uno on /dev/ttyACM0')
  assert.match(monitor.events[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('UsbDeviceMonitor bounds device event payloads before exposing them', () => {
  const monitor = new UsbDeviceMonitor({ spawnImpl: () => null })
  const properties = {
    ACTION: 'add',
    SUBSYSTEM: 'tty',
    DEVNAME: `/dev/ttyACM0${'x'.repeat(500)}`,
    ID_VENDOR: 'Arduino',
    ID_MODEL: `Uno ${'m'.repeat(500)}`,
    ID_SERIAL: 's'.repeat(900),
  }
  for (let index = 0; index < 80; index += 1) {
    properties[`EXTRA_${index}_${'k'.repeat(120)}`] = 'v'.repeat(900)
  }

  const event = monitor.record(properties)

  assert.ok(event)
  assert.ok(event.summary.length <= 320)
  assert.ok(event.device.devname.length <= 240)
  assert.ok(event.device.model.length <= 240)
  assert.ok(event.device.serial.length <= 240)
  assert.ok(Object.keys(event.raw).length <= 40)
  assert.ok(Object.keys(event.raw).every((key) => key.length <= 80))
  assert.ok(Object.values(event.raw).every((value) => value.length <= 500))
})

test('UsbDeviceMonitor bounds status error text before exposing it', () => {
  const monitor = new UsbDeviceMonitor({
    spawnImpl: () => {
      throw new Error(`udevadm failed ${'x'.repeat(2_000)}`)
    },
  })

  monitor.start()

  assert.equal(monitor.status().error.length <= 500, true)
  assert.equal(monitor.status().error.endsWith('...'), true)
})
