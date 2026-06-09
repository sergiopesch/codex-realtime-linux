import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  ArduinoUploadError,
  getArduinoCliStatus,
  listSerialPorts,
  normalizeUploadRequest,
  sketchForAction,
  uploadArduinoSketch,
} from './arduino.mjs'

test('sketchForAction creates an onboard LED on sketch', () => {
  const sketch = sketchForAction('onboard_led_on')

  assert.match(sketch, /LED_BUILTIN/)
  assert.match(sketch, /digitalWrite\(LED_BUILTIN, HIGH\)/)
  assert.match(sketch, /void setup\(\)/)
  assert.match(sketch, /void loop\(\)/)
})

test('normalizeUploadRequest defaults to the onboard LED on action', () => {
  const request = normalizeUploadRequest({})

  assert.equal(request.action, 'onboard_led_on')
  assert.equal(request.fqbn, null)
  assert.equal(request.port, null)
  assert.match(request.sketch, /LED_BUILTIN/)
})

test('normalizeUploadRequest rejects custom sketches without setup and loop', () => {
  assert.throws(
    () => normalizeUploadRequest({ action: 'custom_sketch', sketch: 'int value = 1;' }),
    (error) =>
      error instanceof ArduinoUploadError &&
      error.status === 400 &&
      error.code === 'arduino_invalid_sketch',
  )
})

test('normalizeUploadRequest rejects unsupported serial ports and malformed FQBNs', () => {
  assert.throws(
    () => normalizeUploadRequest({ port: '/etc/passwd' }),
    (error) =>
      error instanceof ArduinoUploadError &&
      error.status === 400 &&
      error.code === 'arduino_invalid_port',
  )

  assert.throws(
    () => normalizeUploadRequest({ fqbn: 'arduino avr uno' }),
    (error) =>
      error instanceof ArduinoUploadError &&
      error.status === 400 &&
      error.code === 'arduino_invalid_fqbn',
  )
})

test('ArduinoUploadError bounds large diagnostic detail strings', () => {
  const error = new ArduinoUploadError('Failed', {
    details: {
      stdout: 'x'.repeat(8_000),
      nested: {
        stderr: 'y'.repeat(8_000),
      },
    },
  })

  assert.equal(error.details.stdout.length < 4_100, true)
  assert.equal(error.details.stdout.endsWith('... [truncated]'), true)
  assert.equal(error.details.nested.stderr.length < 4_100, true)
  assert.equal(error.details.nested.stderr.endsWith('... [truncated]'), true)
})

test('getArduinoCliStatus bounds version, command, and error fields', async () => {
  const available = await getArduinoCliStatus({
    run: async () => ({ stdout: `Version ${'v'.repeat(2_000)}`, stderr: '' }),
  })

  assert.equal(available.available, true)
  assert.equal(available.version.length <= 500, true)
  assert.equal(available.command.length <= 500, true)

  const unavailable = await getArduinoCliStatus({
    run: async () => {
      throw new Error(`arduino-cli failed ${'e'.repeat(2_000)}`)
    },
  })

  assert.equal(unavailable.available, false)
  assert.equal(unavailable.error.length <= 500, true)
  assert.equal(unavailable.error.endsWith('...'), true)
})

test('listSerialPorts returns ttyACM and ttyUSB devices', async () => {
  const devDir = await mkdtemp(path.join(os.tmpdir(), 'codex-arduino-dev-'))
  await writeFile(path.join(devDir, 'ttyACM0'), '')
  await writeFile(path.join(devDir, 'ttyUSB1'), '')
  await writeFile(path.join(devDir, 'ttyS0'), '')

  assert.deepEqual(await listSerialPorts({ devDir }), [
    path.join(devDir, 'ttyACM0'),
    path.join(devDir, 'ttyUSB1'),
  ])
})

test('uploadArduinoSketch ignores unsupported detected board addresses and falls back to scanned serial ports', async () => {
  const commands = []
  const run = async (args) => {
    commands.push(args)
    return { stdout: `${args[0]} ok`, stderr: '' }
  }

  const result = await uploadArduinoSketch(
    { action: 'onboard_led_on' },
    {
      run,
      listPorts: async () => ['/dev/ttyUSB0'],
      listBoards: async () => [{ address: '192.168.1.42', fqbn: 'arduino:avr:uno', boardName: 'Network board' }],
    },
  )

  assert.equal(result.port, '/dev/ttyUSB0')
  assert.deepEqual(commands[1].slice(0, 5), ['upload', '-p', '/dev/ttyUSB0', '--fqbn', 'arduino:avr:uno'])
})

test('uploadArduinoSketch bounds compile and upload command output', async () => {
  const run = async (args) => ({
    stdout: `${args[0]} ${'x'.repeat(8_000)}`,
    stderr: `${args[0]} ${'y'.repeat(8_000)}`,
  })

  const result = await uploadArduinoSketch(
    { action: 'onboard_led_on', port: '/dev/ttyACM0', fqbn: 'arduino:avr:uno' },
    { run, listPorts: async () => ['/dev/ttyACM0'] },
  )

  assert.equal(result.compile.stdout.length < 4_100, true)
  assert.equal(result.compile.stderr.endsWith('... [truncated]'), true)
  assert.equal(result.upload.stdout.length < 4_100, true)
  assert.equal(result.upload.stderr.endsWith('... [truncated]'), true)
})

test('uploadArduinoSketch compiles and uploads through arduino-cli', async () => {
  const commands = []
  const run = async (args) => {
    commands.push(args)
    return { stdout: `${args[0]} ok`, stderr: '' }
  }

  const result = await uploadArduinoSketch(
    { action: 'onboard_led_blink', port: '/dev/ttyACM0', fqbn: 'arduino:avr:uno' },
    { run, listPorts: async () => ['/dev/ttyACM0'] },
  )

  assert.equal(result.action, 'onboard_led_blink')
  assert.equal(result.port, '/dev/ttyACM0')
  const compileCommand = commands.find((command) => command[0] === 'compile')
  const uploadCommand = commands.find((command) => command[0] === 'upload')
  assert.deepEqual(compileCommand.slice(0, 3), ['compile', '--fqbn', 'arduino:avr:uno'])
  assert.deepEqual(uploadCommand.slice(0, 5), ['upload', '-p', '/dev/ttyACM0', '--fqbn', 'arduino:avr:uno'])
})

test('uploadArduinoSketch uses detected board FQBN when no FQBN is supplied', async () => {
  const commands = []
  const run = async (args) => {
    commands.push(args)
    return { stdout: `${args[0]} ok`, stderr: '' }
  }

  const result = await uploadArduinoSketch(
    { action: 'onboard_led_on' },
    {
      run,
      listPorts: async () => ['/dev/ttyACM0'],
      listBoards: async () => [{ address: '/dev/ttyACM0', fqbn: 'arduino:avr:nano', boardName: 'Arduino Nano' }],
    },
  )

  assert.equal(result.fqbn, 'arduino:avr:nano')
  assert.equal(result.boardName, 'Arduino Nano')
  assert.deepEqual(commands[0].slice(0, 3), ['compile', '--fqbn', 'arduino:avr:nano'])
  assert.deepEqual(commands[1].slice(0, 5), ['upload', '-p', '/dev/ttyACM0', '--fqbn', 'arduino:avr:nano'])
})

test('uploadArduinoSketch does not borrow another board FQBN for an explicit port', async () => {
  const commands = []
  const run = async (args) => {
    commands.push(args)
    return { stdout: `${args[0]} ok`, stderr: '' }
  }

  const result = await uploadArduinoSketch(
    { action: 'onboard_led_on', port: '/dev/ttyACM0' },
    {
      run,
      listPorts: async () => ['/dev/ttyACM0', '/dev/ttyUSB0'],
      listBoards: async () => [{ address: '/dev/ttyUSB0', fqbn: 'arduino:avr:nano', boardName: 'Arduino Nano' }],
    },
  )

  assert.equal(result.port, '/dev/ttyACM0')
  assert.equal(result.fqbn, 'arduino:avr:uno')
  assert.equal(result.boardName, null)
  assert.deepEqual(commands[0].slice(0, 3), ['compile', '--fqbn', 'arduino:avr:uno'])
  assert.deepEqual(commands[1].slice(0, 5), ['upload', '-p', '/dev/ttyACM0', '--fqbn', 'arduino:avr:uno'])
})

test('uploadArduinoSketch fails clearly when no serial port is available', async () => {
  await assert.rejects(
    () => uploadArduinoSketch({ action: 'onboard_led_on' }, { listPorts: async () => [], listBoards: async () => [] }),
    (error) =>
      error instanceof ArduinoUploadError &&
      error.status === 404 &&
      error.code === 'arduino_port_not_found' &&
      Array.isArray(error.details.serialPorts) &&
      Array.isArray(error.details.detectedBoards),
  )
})
