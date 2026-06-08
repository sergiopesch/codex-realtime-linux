import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyUsbDevice, eventSummary, parseUdevProperties, UsbDeviceMonitor } from './usb.mjs'

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

test('UsbDeviceMonitor records complete add events from streamed udev chunks', () => {
  const monitor = new UsbDeviceMonitor({ spawnImpl: () => null })
  monitor.consume('ACTION=add\nSUBSYSTEM=tty\n')
  monitor.consume('DEVNAME=/dev/ttyACM0\nID_VENDOR=Arduino\nID_MODEL=Uno\n\n')

  assert.equal(monitor.events.length, 1)
  assert.equal(monitor.events[0].device.isArduinoLike, true)
  assert.equal(monitor.events[0].summary, 'Arduino Uno on /dev/ttyACM0')
})
