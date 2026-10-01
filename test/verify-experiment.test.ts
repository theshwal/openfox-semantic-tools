import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { VERIFY_POLICY_VERSION } from '../src/verify/policy.ts'

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
  assert.ok(report.caseCount >= 30, `only ${report.caseCount} fixtures`)
  assert.equal(report.matched, report.caseCount, JSON.stringify(report.mismatches))
  assert.deepEqual(report.calibratedMismatches, [])
  assert.equal(report.transportFailures, 0)
})

test('the persisted report states how the suite is balanced', async () => {
  // A match rate is only interpretable next to the shape of the suite, so the
  // report carries the family and status distribution rather than a bare total.
  const { report } = await runExperiment()
  const families = report.fixtureFamilies as Record<string, number>
  assert.ok(Object.keys(families).length >= 8, JSON.stringify(families))
  const total = Object.values(families).reduce((n, count) => n + count, 0)
  assert.equal(total, report.caseCount)
  for (const [family, count] of Object.entries(families)) {
    assert.ok(
      count <= Math.ceil(report.caseCount * 0.3),
      `family ${family} takes over the suite with ${count}/${report.caseCount}`,
    )
  }
  const statuses = report.expectedStatusCounts as Record<string, number>
  assert.equal(Object.values(statuses).reduce((n, count) => n + count, 0), report.caseCount)
  // A positive label is not merely rare: it is absent from the suite itself.
  assert.equal(statuses['pass-candidate'], undefined)
})

test('every case records the family it belongs to, so results aggregate', async () => {
  const { report } = await runExperiment()
  for (const entry of report.cases) {
    assert.equal(typeof entry.category === 'string' && entry.category.length > 0, true, entry.id)
    assert.equal(entry.issueId, '#4', entry.id)
  }
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
    assert.equal(entry.policyVersion, VERIFY_POLICY_VERSION, entry.id)
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

/**
 * Runs the live path against a loopback runtime that answers like the real one:
 * a continuous score with a distribution, an explicit confidence, and a model
 * the runtime names itself. No credential, no external service.
 */
async function runLiveAgainstStub(): Promise<{ report: any; runs: any[] }> {
  const { createServer } = await import('node:http')
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = []
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
    incoming.on('end', () => {
      const { questions } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        questions: Record<string, { type: string }>
      }
      const answers = Object.fromEntries(
        Object.entries(questions).map(([id, question]) => {
          if (question.type === 'score') {
            // The documented shape: E[level], not a level index.
            return [id, { type: 'score', score: 0.15, confidence: 0.78, probabilities: { 0: 0.9, 1: 0.06, 2: 0.04 } }]
          }
          return [id, { type: 'noul', noul: 0.8, confidence: 0.9 }]
        }),
      )
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ model: 'stub-model-1', answers }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const out = await mkdtemp(join(tmpdir(), 'semantic-verify-live-'))
  try {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'scripts/verify-experiment.ts', out, '--live'],
      {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          SEMANTIC_ENDPOINT: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/systemone`,
          SEMANTIC_API_KEY: 'sk-live-not-a-real-key-0000',
        },
        stdio: ['ignore', 'ignore', 'ignore'],
      },
    )
    await new Promise<void>((resolve, reject) => {
      child.on('exit', () => resolve())
      child.on('error', reject)
    })
    return {
      report: JSON.parse(await readFile(join(out, 'report.json'), 'utf8')),
      runs: JSON.parse(await readFile(join(out, 'runs.json'), 'utf8')),
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(out, { recursive: true, force: true })
  }
}

test('a live run persists the numbers the analysis needs, and nothing else', async () => {
  const { report, runs } = await runLiveAgainstStub()
  assert.equal(report.mode, 'live')
  assert.ok(report.cases.length > 0)
  for (const entry of report.cases) {
    // The previous artifact said only "unknown": the numbers that produced it
    // were unrecoverable, which is exactly what made the live cases
    // undiagnosable from the report.
    const observed = entry.observedNumbers
    assert.ok(observed, `${entry.id} must record what was observed`)
    assert.equal(typeof observed.provider, 'string')
    // The model the runtime reported, not one the operator configured.
    assert.equal(observed.model, 'stub-model-1')
    assert.deepEqual(Object.keys(observed.gateValues).sort(), [
      'criterionTestable',
      'evidenceSufficiency',
      'needsDeeperVerification',
      'offScope',
      'satisfied',
    ])
    assert.equal(observed.gateValues.satisfied, 0.8)
    assert.equal(observed.gateValues.evidenceSufficiency, 0.15)
    assert.deepEqual(observed.probabilities.evidenceSufficiency, { 0: 0.9, 1: 0.06, 2: 0.04 })
    assert.equal(observed.confidence.evidenceSufficiency, 0.78)
    assert.equal(observed.scores.evidenceSufficiency, 0.15)
    // No gate is silently dropped when the policy found it unusable: the value
    // is recorded as read, and the verdict is what rejects it.
    assert.equal(observed.scores.satisfied, null)
  }
  // The persisted numbers are still not a rate, and the run is not "measured".
  assert.equal(report.measured, false)
  assert.equal(report.falsePassRate, null)
  assert.deepEqual(runs.every((run: any) => run.falsePasses === null), true)
})

test('the persisted live numbers carry no state, no evidence and no secret', async () => {
  const { report } = await runLiveAgainstStub()
  const serialised = JSON.stringify(report)
  // The evidence text the fixtures supply must never reach the artifact.
  for (const forbidden of ['Added a numeric timeout setting', 'bounded timeout', 'diffExcerpts', 'deterministicTestResults']) {
    assert.ok(!serialised.includes(forbidden), `the live report must not carry ${forbidden}`)
  }
  // Nor the endpoint, the port or the credential.
  assert.ok(!serialised.includes('127.0.0.1'))
  assert.ok(!serialised.includes('sk-live-not-a-real-key-0000'))
  assert.ok(!/https?:\/\//.test(serialised))
  // The report states the contract of the block instead of leaving it inferred.
  assert.deepEqual([...report.observedFields.contains].sort(), ['confidence', 'gateValues', 'model', 'probabilities', 'provider', 'scores'])
  assert.ok(report.observedFields.excludes.includes('evidence'))
})

test('a fixture run records no observed numbers, because its numbers are authored', async () => {
  // A scripted transport writes the answers this script itself read, so
  // persisting them back would be a tautology, not evidence.
  const { report } = await runExperiment()
  assert.equal(report.mode, 'fixture')
  for (const entry of report.cases) {
    assert.ok(!('observedNumbers' in entry), `${entry.id} must record no numbers in a fixture run`)
  }
})

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

/**
 * A campaign run on a suite the loader rejects would produce a comparison that
 * looks precise and means nothing, so the runner must stop before any call.
 */
test('a fixture set that breaks the schema rules refuses to run at all', async () => {
  const root = resolve(import.meta.dirname, '..')
  const original = await readFile(resolve(root, 'fixtures/verify/cases.json'), 'utf8')
  const sabotaged = JSON.parse(original) as { cases: Array<Record<string, unknown>> }
  const first = sabotaged.cases[0]
  // Two fixtures that restate each other inflate the suite without adding
  // evidence, which is exactly what the loader exists to catch.
  const second = { ...first, id: 'sabotaged-restatement' }
  sabotaged.cases.push(second)
  await writeFile(resolve(root, 'fixtures/verify/cases.json'), JSON.stringify(sabotaged, null, 2))
  try {
    const { code, stderr } = await runScript(['/tmp/semantic-verify-never-written'])
    assert.notEqual(code, 0, 'a duplicated fixture must stop the run')
    assert.match(stderr, /lexical_duplicate_criterion/)
    assert.match(stderr, /run was refused/)
  } finally {
    await writeFile(resolve(root, 'fixtures/verify/cases.json'), original)
  }
})
