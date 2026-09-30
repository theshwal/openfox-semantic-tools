import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Runs the real offline experiment script and returns its persisted report. */
async function runExperiment(): Promise<{ report: any; runs: any[]; summary: string; exitCode: number }> {
  const out = await mkdtemp(join(tmpdir(), 'semantic-verify-exp-'))
  try {
    const exitCode = await new Promise<number>((resolve) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'scripts/verify-experiment.ts', out],
        { env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: ['ignore', 'ignore', 'ignore'] },
      )
      child.on('exit', (code) => resolve(code ?? 1))
    })
    const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'))
    const runs = JSON.parse(await readFile(join(out, 'runs.json'), 'utf8'))
    const summary = await readFile(join(out, 'summary.md'), 'utf8')
    return { report, runs, summary, exitCode }
  } finally {
    await rm(out, { recursive: true, force: true })
  }
}

test('the labelled suite is reproduced offline with no credentials', async () => {
  const { report, exitCode } = await runExperiment()
  assert.equal(report.mode, 'fixture')
  assert.equal(exitCode, 0)
  assert.ok(report.caseCount >= 7, `only ${report.caseCount} fixtures`)
  assert.equal(report.matched, report.caseCount, JSON.stringify(report.mismatches))
  assert.deepEqual(report.calibratedMismatches, [])
  assert.equal(report.transportFailures, 0)
})

test('the fixtures cover positive, negative and adversarial cases', async () => {
  const { report } = await runExperiment()
  const groups = new Set(report.cases.map((entry: any) => entry.group))
  assert.deepEqual([...groups].sort(), ['adversarial', 'negative', 'positive'])
})

test('a scripted transport can never produce a positive status or a false-pass claim', async () => {
  const { report } = await runExperiment()
  // The uncalibrated policy is structurally unable to say pass.
  assert.deepEqual(report.observedPositiveStatuses, [])
  assert.equal(report.policyCalibrated, false)
  // A scripted answer is authored, not measured: the rate stays null, never 0.
  assert.equal(report.falsePassRate, null)
  assert.equal(report.falseNegativeRate, null)
  assert.equal(report.measured, false)
  // The real fallback rate needs an OpenFox end-to-end run; the per-fixture
  // `fallbacks` count in runs.json is policy routing, not an observed rate.
  assert.equal(report.fallbackRate, null)
  assert.match(report.fallbackRateReason, /not an observed fallback rate/i)
  assert.match(report.falsePassRateReason, /authored, not inferred|too small/i)
  assert.match(report.scope, /Not decision quality/i)
})

test('every case is traceable back to its issue requirement', async () => {
  const { report } = await runExperiment()
  for (const entry of report.cases) {
    assert.match(entry.reportId, /^verify:ac-\d+:[0-9a-f]{16}$/, entry.id)
    assert.equal(entry.criterionId.startsWith('ac-'), true, entry.id)
    assert.equal(entry.issueId, '#4', entry.id)
    assert.equal(entry.advisory, true, entry.id)
    assert.equal(entry.policyVersion, 'verify-0.1.0', entry.id)
    assert.equal(typeof entry.rationale === 'string' && entry.rationale.length > 0, true, entry.id)
  }
})

test('the persisted RunRecords keep every unmeasured metric null, never zero', async () => {
  const { runs, summary } = await runExperiment()
  assert.ok(runs.length >= 7, `only ${runs.length} run records`)
  for (const run of runs) {
    assert.equal(run.mode, 'fixture')
    assert.equal(run.semanticCalls, 1)
    // Unmeasured on a scripted run: a recorded 0 would read as a real result.
    for (const key of [
      'mainInputTokens',
      'mainOutputTokens',
      'mainCalls',
      'verifierCalls',
      'semanticCost',
      'falsePasses',
      'falseNegatives',
    ]) {
      assert.equal(run[key], null, `${run.task}.${key} must stay unknown`)
    }
  }
  assert.ok(summary.includes('unknown'), 'the summary must show unknown, not zero')
  assert.ok(
    summary.includes('fixture/fixture-scripted-policy'),
    'the variant must stay grouped and separate from a baseline',
  )
})

/** Spawns the script and captures its output so failures can be diagnosed. */
async function runScript(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/verify-experiment.ts', ...args], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => (stderr += String(chunk)))
    child.on('exit', (code) => resolve({ code: code ?? 1, stderr }))
  })
}

test('a live run without an endpoint fails loudly instead of falling back', async () => {
  const { code, stderr } = await runScript(['--live', '/tmp/semantic-verify-never-written'])
  assert.notEqual(code, 0, 'a live run without SEMANTIC_ENDPOINT must fail loudly')
  assert.match(stderr, /requires SEMANTIC_ENDPOINT/)
})

test('an unknown option fails loudly instead of being silently ignored', async () => {
  // A mistyped flag must not quietly turn a live run into a fixture run.
  const { code, stderr } = await runScript(['--out', '/tmp/semantic-verify-never-written'])
  assert.notEqual(code, 0)
  assert.match(stderr, /Unknown option\(s\)/)
})
