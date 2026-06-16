import { spawn } from 'node:child_process'
import process from 'node:process'

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const gates = [
  {
    name: 'Lint',
    command: npmCommand,
    args: ['run', 'lint'],
  },
  {
    name: 'Build',
    command: npmCommand,
    args: ['run', 'build'],
  },
  {
    name: 'Unit tests',
    command: npmCommand,
    args: ['test'],
  },
  {
    name: 'Degraded-mode smoke',
    command: npmCommand,
    args: ['run', 'smoke:degraded'],
  },
  {
    name: 'Renderer smoke',
    command: npmCommand,
    args: ['run', 'smoke:renderer'],
  },
  {
    name: 'Production dependency audit',
    command: npmCommand,
    args: ['audit', '--omit=dev'],
  },
]

function usage() {
  return `Usage:
  npm run verify:ci

Runs the automated, headless release gates:
  - npm run lint
  - npm run build
  - npm test
  - npm run smoke:degraded
  - npm run smoke:renderer
  - npm audit --omit=dev

Not included here:
  - npm run smoke:desktop
  - npm run verify:live
  - npm run verify:manual

Those checks depend on a real Linux desktop session, live environment state, OS
permissions, or physical hardware. Run npm run release:check for the full local
release gate, which runs these automated checks first and then validates the
recorded live/manual MVP evidence.
`
}

function parseArgs(argv) {
  const options = { help: false }
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return options
}

function formatDuration(milliseconds) {
  return `${(milliseconds / 1000).toFixed(1)}s`
}

function runGate(gate) {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    const proc = spawn(gate.command, gate.args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    })
    proc.once('error', (error) => {
      resolve({
        ...gate,
        ok: false,
        durationMs: Date.now() - startedAt,
        detail: error.message,
      })
    })
    proc.once('exit', (code, signal) => {
      resolve({
        ...gate,
        ok: code === 0,
        durationMs: Date.now() - startedAt,
        detail: signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`,
      })
    })
  })
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }

  const results = []
  for (const gate of gates) {
    console.log(`\n==> ${gate.name}: ${gate.command} ${gate.args.join(' ')}`)
    const result = await runGate(gate)
    results.push(result)
    if (!result.ok) break
  }

  console.log('\nCI verification summary:')
  for (const result of results) {
    const status = result.ok ? 'pass' : 'fail'
    console.log(`- ${status}: ${result.name} (${formatDuration(result.durationMs)}, ${result.detail})`)
  }

  const skipped = gates.slice(results.length)
  for (const gate of skipped) {
    console.log(`- skipped: ${gate.name}`)
  }

  const failed = results.find((result) => !result.ok)
  if (failed) {
    process.exitCode = 1
    return
  }

  console.log('\nAll automated CI gates passed.')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
