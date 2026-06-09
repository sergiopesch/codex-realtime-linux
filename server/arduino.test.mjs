import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  ArduinoUploadError,
  getArduinoCliStatus,
  listArduinoBoards,
  listSerialPorts,
  normalizeUploadRequest,
  resolveSerialByIdPortTarget,
  runCommand,
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

test('normalizeUploadRequest requires an explicit supported action', () => {
  assert.throws(
    () => normalizeUploadRequest({}),
    (error) =>
      error instanceof ArduinoUploadError &&
      error.status === 400 &&
      error.code === 'arduino_invalid_action',
  )

  const request = normalizeUploadRequest({ action: 'onboard_led_on' })

  assert.equal(request.action, 'onboard_led_on')
  assert.equal(request.fqbn, null)
  assert.equal(request.port, null)
  assert.match(request.sketch, /LED_BUILTIN/)
})

test('normalizeUploadRequest accepts explicit safe sketch names', () => {
  const request = normalizeUploadRequest({ action: 'onboard_led_blink', sketchName: 'BlinkDemo_1' })

  assert.equal(request.sketchName, 'BlinkDemo_1')
})

test('normalizeUploadRequest rejects invalid explicit sketch names', () => {
  assert.throws(
    () => normalizeUploadRequest({ action: 'onboard_led_blink', sketchName: '../BlinkDemo' }),
    (error) =>
      error instanceof ArduinoUploadError &&
      error.status === 400 &&
      error.code === 'arduino_invalid_sketch_name',
  )

  assert.throws(
    () => normalizeUploadRequest({ action: 'onboard_led_blink', sketchName: `B${'link'.repeat(20)}` }),
    (error) =>
      error instanceof ArduinoUploadError &&
      error.status === 400 &&
      error.code === 'arduino_invalid_sketch_name',
  )
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
    () => normalizeUploadRequest({ action: 'onboard_led_on', port: '/etc/passwd' }),
    (error) =>
      error instanceof ArduinoUploadError &&
      error.status === 400 &&
      error.code === 'arduino_invalid_port',
  )

  assert.throws(
    () => normalizeUploadRequest({ action: 'onboard_led_on', fqbn: 'arduino avr uno' }),
    (error) =>
      error instanceof ArduinoUploadError &&
      error.status === 400 &&
      error.code === 'arduino_invalid_fqbn',
  )

  assert.throws(
    () => normalizeUploadRequest({ action: 'onboard_led_on', port: `/dev/serial/by-id/${'a'.repeat(260)}` }),
    (error) =>
      error instanceof ArduinoUploadError &&
      error.status === 400 &&
      error.code === 'arduino_invalid_port',
  )

  assert.throws(
    () => normalizeUploadRequest({ action: 'onboard_led_on', fqbn: `arduino:avr:${'uno'.repeat(90)}` }),
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

test('invalid ARDUINO_DEFAULT_FQBN falls back to a safe Uno target', async () => {
  const previousDefault = process.env.ARDUINO_DEFAULT_FQBN
  process.env.ARDUINO_DEFAULT_FQBN = 'invalid default fqbn'
  try {
    const module = await import(`./arduino.mjs?invalid-default-${Date.now()}`)
    const status = await module.getArduinoCliStatus({
      run: async () => ({ stdout: 'Version 1.0.0', stderr: '' }),
    })
    assert.equal(status.defaultFqbn, 'arduino:avr:uno')
  } finally {
    if (previousDefault === undefined) delete process.env.ARDUINO_DEFAULT_FQBN
    else process.env.ARDUINO_DEFAULT_FQBN = previousDefault
  }
})

test('invalid ARDUINO_CLI_PATH falls back to the bundled CLI path', async () => {
  const previousCliPath = process.env.ARDUINO_CLI_PATH
  process.env.ARDUINO_CLI_PATH = 'relative/arduino-cli'
  try {
    const module = await import(`./arduino.mjs?invalid-cli-path-${Date.now()}`)
    const status = await module.getArduinoCliStatus({
      run: async () => ({ stdout: 'Version 1.0.0', stderr: '' }),
    })

    assert.equal(status.available, true)
    assert.equal(status.command, path.join(process.cwd(), 'bin', 'arduino-cli'))
    assert.notEqual(status.command, 'relative/arduino-cli')
  } finally {
    if (previousCliPath === undefined) delete process.env.ARDUINO_CLI_PATH
    else process.env.ARDUINO_CLI_PATH = previousCliPath
  }
})

test('listSerialPorts returns ttyACM and ttyUSB devices', async (t) => {
  const devDir = await mkdtemp(path.join(os.tmpdir(), 'codex-arduino-dev-'))
  t.after(() => rm(devDir, { recursive: true, force: true }))
  const serialByIdDir = path.join(devDir, 'missing-serial-by-id')
  await writeFile(path.join(devDir, 'ttyACM0'), '')
  await writeFile(path.join(devDir, 'ttyUSB1'), '')
  await writeFile(path.join(devDir, 'ttyS0'), '')

  assert.deepEqual(await listSerialPorts({ devDir, serialByIdDir }), [
    path.join(devDir, 'ttyACM0'),
    path.join(devDir, 'ttyUSB1'),
  ])
})

test('listSerialPorts prefers stable serial-by-id links before tty fallbacks', async (t) => {
  const devDir = await mkdtemp(path.join(os.tmpdir(), 'codex-arduino-dev-'))
  t.after(() => rm(devDir, { recursive: true, force: true }))
  const serialByIdDir = path.join(devDir, 'serial', 'by-id')
  const byIdPort = path.join(serialByIdDir, 'usb-Arduino_Uno-if00')

  await mkdir(serialByIdDir, { recursive: true })
  await writeFile(path.join(devDir, 'ttyACM0'), '')
  await writeFile(path.join(devDir, 'ttyUSB1'), '')
  await symlink('../../ttyACM0', byIdPort)

  assert.deepEqual(await listSerialPorts({ devDir, serialByIdDir }), [
    byIdPort,
    path.join(devDir, 'ttyACM0'),
    path.join(devDir, 'ttyUSB1'),
  ])
})

test('resolveSerialByIdPortTarget maps a stable by-id port to its tty target', async (t) => {
  const devDir = await mkdtemp(path.join(os.tmpdir(), 'codex-arduino-dev-'))
  t.after(() => rm(devDir, { recursive: true, force: true }))
  const serialByIdDir = path.join(devDir, 'serial', 'by-id')
  const byIdPort = path.join(serialByIdDir, 'usb-Arduino_Nano-if00')

  await mkdir(serialByIdDir, { recursive: true })
  await writeFile(path.join(devDir, 'ttyUSB0'), '')
  await symlink('../../ttyUSB0', byIdPort)

  assert.equal(
    await resolveSerialByIdPortTarget(byIdPort, { devDir, serialByIdDir }),
    path.join(devDir, 'ttyUSB0'),
  )
})

test('listSerialPorts bounds returned serial ports', async (t) => {
  const devDir = await mkdtemp(path.join(os.tmpdir(), 'codex-arduino-dev-'))
  t.after(() => rm(devDir, { recursive: true, force: true }))
  const serialByIdDir = path.join(devDir, 'missing-serial-by-id')

  await Promise.all(
    Array.from({ length: 100 }, (_, index) => writeFile(path.join(devDir, `ttyUSB${index}`), '')),
  )

  const ports = await listSerialPorts({ devDir, serialByIdDir })

  assert.equal(ports.length, 80)
  assert.ok(ports.every((port) => port.startsWith(devDir)))
})

test('listArduinoBoards bounds detected board metadata and rejects malformed FQBNs', async () => {
  const boards = await listArduinoBoards({
    run: async () => ({
      stdout: JSON.stringify({
        detected_ports: [
          {
            port: {
              address: `/dev/ttyACM0${'1'.repeat(900)}`,
              label: 'USB serial board '.repeat(80),
              protocol: 'serial'.repeat(120),
            },
            matching_boards: [
              {
                name: 'Arduino Nano '.repeat(80),
                fqbn: 'not a fqbn '.repeat(80),
              },
            ],
          },
        ],
      }),
      stderr: '',
    }),
  })

  assert.equal(boards.length, 1)
  assert.equal(boards[0].address.length <= 500, true)
  assert.equal(boards[0].label.length <= 500, true)
  assert.equal(boards[0].protocol.length <= 500, true)
  assert.equal(boards[0].boardName.length <= 500, true)
  assert.equal(boards[0].fqbn, null)
})

test('listArduinoBoards prefers a valid matching board FQBN', async () => {
  const boards = await listArduinoBoards({
    run: async () => ({
      stdout: JSON.stringify({
        detected_ports: [
          {
            port: {
              address: '/dev/ttyUSB0',
              label: 'USB serial board',
              protocol: 'serial',
            },
            matching_boards: [
              {
                name: 'Malformed board match',
                fqbn: 'not a fqbn',
              },
              {
                name: 'Arduino Nano',
                fqbn: 'arduino:avr:nano',
              },
            ],
          },
        ],
      }),
      stderr: '',
    }),
  })

  assert.equal(boards.length, 1)
  assert.equal(boards[0].boardName, 'Arduino Nano')
  assert.equal(boards[0].fqbn, 'arduino:avr:nano')
})

test('uploadArduinoSketch ignores malformed detected board FQBNs', async () => {
  const commands = []
  const run = async (args) => {
    commands.push(args)
    return { stdout: `${args[0]} ok`, stderr: '' }
  }

  const result = await uploadArduinoSketch(
    { action: 'onboard_led_on' },
    {
      run,
      listPorts: async () => ['/dev/ttyUSB0', '/tmp/not-a-serial-port'],
      listBoards: async () => [{ address: '/dev/ttyUSB0', fqbn: 'bad fqbn', boardName: 'Arduino Uno' }],
    },
  )

  assert.equal(result.fqbn, 'arduino:avr:uno')
  assert.deepEqual(commands[0].slice(0, 3), ['compile', '--fqbn', 'arduino:avr:uno'])
  assert.deepEqual(commands[1].slice(0, 5), ['upload', '-p', '/dev/ttyUSB0', '--fqbn', 'arduino:avr:uno'])
})

test('uploadArduinoSketch ignores oversized detected board FQBNs', async () => {
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
      listBoards: async () => [{ address: '/dev/ttyUSB0', fqbn: `arduino:avr:${'nano'.repeat(90)}`, boardName: 'Arduino Nano' }],
    },
  )

  assert.equal(result.fqbn, 'arduino:avr:uno')
  assert.equal(result.boardName, 'Arduino Nano')
  assert.deepEqual(commands[0].slice(0, 3), ['compile', '--fqbn', 'arduino:avr:uno'])
  assert.deepEqual(commands[1].slice(0, 5), ['upload', '-p', '/dev/ttyUSB0', '--fqbn', 'arduino:avr:uno'])
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
      listBoards: async () => [{ address: '192.168.1.42', fqbn: 'arduino:avr:nano', boardName: 'Network board' }],
    },
  )

  assert.equal(result.port, '/dev/ttyUSB0')
  assert.equal(result.fqbn, 'arduino:avr:uno')
  assert.equal(result.boardName, null)
  assert.deepEqual(commands[0].slice(0, 3), ['compile', '--fqbn', 'arduino:avr:uno'])
  assert.deepEqual(commands[1].slice(0, 5), ['upload', '-p', '/dev/ttyUSB0', '--fqbn', 'arduino:avr:uno'])
})

test('uploadArduinoSketch prefers serial-by-id ports when board metadata is unavailable', async () => {
  const commands = []
  const run = async (args) => {
    commands.push(args)
    return { stdout: `${args[0]} ok`, stderr: '' }
  }

  const result = await uploadArduinoSketch(
    { action: 'onboard_led_on' },
    {
      run,
      listPorts: async () => ['/dev/serial/by-id/usb-Arduino_Uno-if00', '/dev/ttyACM0'],
      listBoards: async () => [],
    },
  )

  assert.equal(result.port, '/dev/serial/by-id/usb-Arduino_Uno-if00')
  assert.deepEqual(commands[1].slice(0, 5), [
    'upload',
    '-p',
    '/dev/serial/by-id/usb-Arduino_Uno-if00',
    '--fqbn',
    'arduino:avr:uno',
  ])
})

test('uploadArduinoSketch prefers stable serial-by-id port for a single detected tty board', async () => {
  const commands = []
  const run = async (args) => {
    commands.push(args)
    return { stdout: `${args[0]} ok`, stderr: '' }
  }

  const result = await uploadArduinoSketch(
    { action: 'onboard_led_on' },
    {
      run,
      listPorts: async () => ['/dev/serial/by-id/usb-Arduino_Uno-if00', '/dev/ttyACM0'],
      listBoards: async () => [{ address: '/dev/ttyACM0', fqbn: 'arduino:avr:uno', boardName: 'Arduino Uno' }],
    },
  )

  assert.equal(result.port, '/dev/serial/by-id/usb-Arduino_Uno-if00')
  assert.equal(result.fqbn, 'arduino:avr:uno')
  assert.equal(result.boardName, 'Arduino Uno')
  assert.deepEqual(commands[1].slice(0, 5), [
    'upload',
    '-p',
    '/dev/serial/by-id/usb-Arduino_Uno-if00',
    '--fqbn',
    'arduino:avr:uno',
  ])
})

test('uploadArduinoSketch uses detected board FQBN for an explicit stable serial-by-id port', async () => {
  const commands = []
  const run = async (args) => {
    commands.push(args)
    return { stdout: `${args[0]} ok`, stderr: '' }
  }

  const result = await uploadArduinoSketch(
    { action: 'onboard_led_on', port: '/dev/serial/by-id/usb-Arduino_Nano-if00' },
    {
      run,
      listPorts: async () => ['/dev/serial/by-id/usb-Arduino_Nano-if00', '/dev/ttyUSB0'],
      listBoards: async () => [{ address: '/dev/ttyUSB0', fqbn: 'arduino:avr:nano', boardName: 'Arduino Nano' }],
    },
  )

  assert.equal(result.port, '/dev/serial/by-id/usb-Arduino_Nano-if00')
  assert.equal(result.fqbn, 'arduino:avr:nano')
  assert.equal(result.boardName, 'Arduino Nano')
  assert.deepEqual(commands[0].slice(0, 3), ['compile', '--fqbn', 'arduino:avr:nano'])
  assert.deepEqual(commands[1].slice(0, 5), [
    'upload',
    '-p',
    '/dev/serial/by-id/usb-Arduino_Nano-if00',
    '--fqbn',
    'arduino:avr:nano',
  ])
})

test('uploadArduinoSketch maps an explicit stable by-id port to the matching board among multiple ttys', async () => {
  const commands = []
  const run = async (args) => {
    commands.push(args)
    return { stdout: `${args[0]} ok`, stderr: '' }
  }

  const result = await uploadArduinoSketch(
    { action: 'onboard_led_blink', port: '/dev/serial/by-id/usb-Arduino_Nano-if00' },
    {
      run,
      listPorts: async () => [
        '/dev/serial/by-id/usb-Arduino_Nano-if00',
        '/dev/ttyACM0',
        '/dev/ttyUSB0',
      ],
      listBoards: async () => [
        { address: '/dev/ttyACM0', fqbn: 'arduino:avr:uno', boardName: 'Arduino Uno' },
        { address: '/dev/ttyUSB0', fqbn: 'arduino:avr:nano', boardName: 'Arduino Nano' },
      ],
      resolvePortAlias: async () => '/dev/ttyUSB0',
    },
  )

  assert.equal(result.port, '/dev/serial/by-id/usb-Arduino_Nano-if00')
  assert.equal(result.fqbn, 'arduino:avr:nano')
  assert.equal(result.boardName, 'Arduino Nano')
  assert.deepEqual(commands[0].slice(0, 3), ['compile', '--fqbn', 'arduino:avr:nano'])
  assert.deepEqual(commands[1].slice(0, 5), [
    'upload',
    '-p',
    '/dev/serial/by-id/usb-Arduino_Nano-if00',
    '--fqbn',
    'arduino:avr:nano',
  ])
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

test('uploadArduinoSketch caps noisy arduino-cli process output while capturing it', async () => {
  const previousCliPath = process.env.ARDUINO_CLI_PATH
  const cliDir = await mkdtemp(path.join(os.tmpdir(), 'codex-arduino-cli-'))
  const cliPath = path.join(cliDir, 'arduino-cli')
  await writeFile(
    cliPath,
    `#!/usr/bin/env node
process.stdout.write('stdout ' + 'x'.repeat(50000))
process.stderr.write('stderr ' + 'y'.repeat(50000))
`,
  )
  await chmod(cliPath, 0o700)
  process.env.ARDUINO_CLI_PATH = cliPath

  try {
    const module = await import(`./arduino.mjs?noisy-cli-${Date.now()}`)
    const result = await module.uploadArduinoSketch(
      { action: 'onboard_led_on', port: '/dev/ttyACM0', fqbn: 'arduino:avr:uno' },
      { listPorts: async () => ['/dev/ttyACM0'], listBoards: async () => [] },
    )

    assert.equal(result.compile.stdout.length < 4_100, true)
    assert.equal(result.compile.stdout.startsWith('[truncated output]'), true)
    assert.equal(result.compile.stderr.startsWith('[truncated output]'), true)
    assert.equal(result.upload.stdout.startsWith('[truncated output]'), true)
  } finally {
    if (previousCliPath === undefined) delete process.env.ARDUINO_CLI_PATH
    else process.env.ARDUINO_CLI_PATH = previousCliPath
    await rm(cliDir, { recursive: true, force: true })
  }
})

test('runCommand escalates timed-out arduino-cli processes to SIGKILL', async () => {
  const proc = new EventEmitter()
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  const killedSignals = []
  proc.kill = (signal) => {
    killedSignals.push(signal)
    if (signal === 'SIGKILL') setImmediate(() => proc.emit('exit', null, signal))
    return true
  }

  await assert.rejects(
    () => runCommand('arduino-cli', ['compile'], {
      spawnImpl: () => proc,
      timeoutMs: 1,
      killGraceMs: 5,
    }),
    (error) =>
      error instanceof ArduinoUploadError &&
      error.status === 504 &&
      error.code === 'arduino_cli_timeout',
  )

  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(killedSignals, ['SIGTERM', 'SIGKILL'])
})

test('runCommand normalizes synchronous arduino-cli startup failures', async () => {
  await assert.rejects(
    () => runCommand('arduino-cli', ['version'], {
      spawnImpl: () => {
        throw new Error('spawn failed before process creation')
      },
    }),
    (error) =>
      error instanceof ArduinoUploadError &&
      error.status === 503 &&
      error.code === 'arduino_cli_missing' &&
      error.details === 'spawn failed before process creation' &&
      /arduino-cli is not available/.test(error.message),
  )
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

test('uploadArduinoSketch requires an explicit port when multiple boards are detected', async () => {
  await assert.rejects(
    () => uploadArduinoSketch(
      { action: 'onboard_led_blink' },
      {
        listPorts: async () => ['/dev/ttyACM0', '/dev/ttyUSB0'],
        listBoards: async () => [
          { address: '/dev/ttyACM0', fqbn: 'arduino:avr:uno', boardName: 'Arduino Uno' },
          { address: '/dev/ttyUSB0', fqbn: 'arduino:avr:nano', boardName: 'Arduino Nano' },
        ],
      },
    ),
    (error) =>
      error instanceof ArduinoUploadError &&
      error.status === 409 &&
      error.code === 'arduino_ambiguous_port' &&
      error.details.detectedBoards.length === 2 &&
      /explicit serial port/.test(error.message),
  )
})

test('uploadArduinoSketch requires an explicit port when multiple serial ports lack board metadata', async () => {
  await assert.rejects(
    () => uploadArduinoSketch(
      { action: 'onboard_led_blink' },
      {
        listPorts: async () => ['/dev/ttyACM0', '/dev/ttyUSB0'],
        listBoards: async () => [],
      },
    ),
    (error) =>
      error instanceof ArduinoUploadError &&
      error.status === 409 &&
      error.code === 'arduino_ambiguous_port' &&
      error.details.serialPorts.length === 2 &&
      error.details.detectedBoards.length === 0 &&
      /does not guess/.test(error.details.hint),
  )
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

test('uploadArduinoSketch rejects explicit ports that are not currently detected', async () => {
  let commands = 0
  await assert.rejects(
    () => uploadArduinoSketch(
      { action: 'onboard_led_on', port: '/dev/ttyACM9', fqbn: 'arduino:avr:uno' },
      {
        run: async () => {
          commands += 1
          return { stdout: 'unexpected command', stderr: '' }
        },
        listPorts: async () => ['/dev/ttyACM0'],
        listBoards: async () => [{ address: '/dev/ttyACM0', fqbn: 'arduino:avr:uno', boardName: 'Arduino Uno' }],
      },
    ),
    (error) =>
      error instanceof ArduinoUploadError &&
      error.status === 404 &&
      error.code === 'arduino_port_not_found' &&
      error.details.requestedPort === '/dev/ttyACM9' &&
      error.details.serialPorts.includes('/dev/ttyACM0') &&
      /not currently detected/.test(error.message),
  )
  assert.equal(commands, 0)
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
