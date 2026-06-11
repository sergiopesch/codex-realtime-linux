import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultOutputPath = path.join(repoRoot, 'docs', 'mvp-readiness-report.md')
const verificationRecordPath = path.join(repoRoot, 'docs', 'mvp-verification-record.md')
const liveProbePath = path.join(repoRoot, 'docs', 'mvp-live-probe-result.md')
const manualChecklistPath = path.join(repoRoot, 'docs', 'mvp-live-checklist-result.md')

const requiredAutomatedEvidence = [
  '`npm run lint`: passed',
  '`npm run build`: passed',
  '`npm test`: passed',
  '`npm run smoke:degraded`: passed',
  '`npm run smoke:desktop`: passed',
  '`npm run smoke:renderer`: passed',
  '`npm audit --omit=dev`: passed',
]

function usage() {
  return `Usage:
  npm run verify:mvp
  npm run verify:mvp -- --allow-incomplete
  npm run verify:mvp -- --output docs/mvp-readiness-report.md

Default mode exits non-zero unless the MVP release evidence is complete.
`
}

function parseArgs(argv) {
  const options = {
    allowIncomplete: false,
    outputPath: defaultOutputPath,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--allow-incomplete') {
      options.allowIncomplete = true
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

function boundedText(value, fallback = '', maxLength = 2_000) {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() : ''
  if (!text) return fallback
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`
}

async function readOptionalFile(filePath) {
  try {
    return await readFile(filePath, 'utf8')
  } catch {
    return ''
  }
}

function result(check, status, evidence) {
  return {
    check,
    status,
    evidence: boundedText(evidence, 'No evidence recorded.', 2_000).replace(/\|/g, '\\|'),
  }
}

function run(command, args) {
  return new Promise((resolve) => {
    const proc = spawn(command, args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    proc.once('error', (error) => resolve({ ok: false, stdout, stderr: error.message }))
    proc.once('exit', (code) => resolve({ ok: code === 0, stdout, stderr }))
  })
}

function parseMarkdownRows(markdown) {
  return markdown
    .split('\n')
    .filter((line) => line.startsWith('|') && !/^\|\s*-/.test(line) && !/^\|\s*(Check|Probe)\s*\|/.test(line))
    .map((line) => line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 3)
    .map(([name, status, evidence]) => ({ name, status, evidence }))
}

function checkVerificationRecord(markdown) {
  if (!markdown) return result('Verification record', 'fail', `${path.relative(repoRoot, verificationRecordPath)} is missing.`)
  const missing = requiredAutomatedEvidence.filter((line) => !markdown.includes(line))
  if (missing.length > 0) {
    return result('Verification record', 'fail', `Missing automated evidence: ${missing.join(', ')}`)
  }
  return result('Verification record', 'pass', 'Automated evidence entries are recorded.')
}

function checkLiveProbe(markdown) {
  if (!markdown) return result('Live probe record', 'fail', `${path.relative(repoRoot, liveProbePath)} is missing. Run npm run verify:live.`)
  const statusMatch = /^Status:\s*(.+)$/m.exec(markdown)
  const summaryMatch = /^Summary:\s*(\d+) passed,\s*(\d+) warnings,\s*(\d+) failed\./m.exec(markdown)
  const failed = summaryMatch ? Number(summaryMatch[3]) : Number.NaN
  if (statusMatch?.[1] !== 'usable' || failed !== 0) {
    return result('Live probe record', 'fail', `Live probe is not usable: status=${statusMatch?.[1] ?? 'missing'}, failed=${Number.isNaN(failed) ? 'missing' : failed}.`)
  }
  return result('Live probe record', 'pass', summaryMatch ? summaryMatch[0] : 'Live probe is usable.')
}

function checkManualChecklist(markdown, currentCommit) {
  if (!markdown) return result('Manual checklist record', 'fail', `${path.relative(repoRoot, manualChecklistPath)} is missing. Run npm run verify:manual.`)
  const statusMatch = /^Status:\s*(.+)$/m.exec(markdown)
  if (statusMatch?.[1] !== 'complete') {
    return result('Manual checklist record', 'fail', `Manual checklist status is ${statusMatch?.[1] ?? 'missing'}, expected complete.`)
  }
  const commitMatch = /^Commit:\s*(.+)$/m.exec(markdown)
  const checklistCommit = commitMatch ? commitMatch[1].trim() : ''
  if (!currentCommit || !checklistCommit || !(currentCommit.startsWith(checklistCommit) || checklistCommit.startsWith(currentCommit))) {
    return result('Manual checklist record', 'fail', `Manual checklist commit ${checklistCommit || 'missing'} does not match current commit ${currentCommit || 'unknown'}.`)
  }

  const rows = parseMarkdownRows(markdown)
  const nonPassingRows = rows.filter((row) => row.status !== 'pass')
  const missingEvidenceRows = rows.filter((row) => !row.evidence || row.evidence === 'No evidence recorded.')
  if (rows.length === 0) return result('Manual checklist record', 'fail', 'Manual checklist has no rows.')
  if (nonPassingRows.length > 0) {
    return result('Manual checklist record', 'fail', `Non-passing rows: ${nonPassingRows.map((row) => `${row.name}=${row.status}`).join(', ')}`)
  }
  if (missingEvidenceRows.length > 0) {
    return result('Manual checklist record', 'fail', `Rows missing evidence: ${missingEvidenceRows.map((row) => row.name).join(', ')}`)
  }
  return result('Manual checklist record', 'pass', `${rows.length} manual rows are passing with evidence.`)
}

function renderReport({ generatedAt, rows }) {
  const ready = rows.every((row) => row.status === 'pass')
  return `# MVP Readiness Report

Generated: ${generatedAt}
Status: ${ready ? 'ready' : 'not-ready'}

| Gate | Status | Evidence |
| --- | --- | --- |
${rows.map((row) => `| ${row.check} | ${row.status} | ${row.evidence} |`).join('\n')}

## Completion Rule

MVP readiness requires every gate above to be marked \`pass\`. If this report is \`not-ready\`, do not tag or describe the app as MVP-ready.
`
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }

  const [verificationRecord, liveProbe, manualChecklist] = await Promise.all([
    readOptionalFile(verificationRecordPath),
    readOptionalFile(liveProbePath),
    readOptionalFile(manualChecklistPath),
  ])
  const currentCommitResult = await run('git', ['rev-parse', '--short', 'HEAD'])
  const currentCommit = currentCommitResult.ok ? currentCommitResult.stdout.trim() : ''
  const rows = [
    checkVerificationRecord(verificationRecord),
    checkLiveProbe(liveProbe),
    checkManualChecklist(manualChecklist, currentCommit),
  ]
  const report = renderReport({ generatedAt: new Date().toISOString(), rows })
  await mkdir(path.dirname(options.outputPath), { recursive: true })
  await writeFile(options.outputPath, report)
  console.log(`Wrote ${path.relative(repoRoot, options.outputPath)}`)
  const ready = rows.every((row) => row.status === 'pass')
  if (!ready && !options.allowIncomplete) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
