import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const PROJECT = resolve(import.meta.dirname, '..')
const SCRIPT = join(PROJECT, 'scripts/transform-benchmark.ts')

/**
 * The benchmark must stay a measurement, never a claim.
 *
 * The project's evaluation rule forbids asserting a saving without measuring
 * it, so the report is asserted to CARRY its own uncertainty: an explicit
 * verdict, `measured: false` for the quality axis it cannot observe, and no
 * invented provider numbers. If someone later makes this script emit a
 * confident saving, this test fails.
 */
async function benchmark(out: string): Promise<Record<string, any>> {
  await run('node', ['--import', 'tsx', SCRIPT, out], { cwd: PROJECT })
  return JSON.parse(await readFile(join(out, 'report.json'), 'utf8'))
}

test('the benchmark records an inconclusive verdict and never claims a saving', async () => {
  const out = await mkdtemp(join(tmpdir(), 'transform-bench-'))
  try {
    const report = await benchmark(out)

    assert.equal(report.verdict, 'INCONCLUSIVE')
    assert.equal(
      report.measured,
      false,
      'the harness cannot measure task quality, so it must say so',
    )
    assert.ok(report.verdictReason.length > 0, 'the verdict must carry its reason')

    // The offline run contacts no provider, so nothing may be attributed to one.
    assert.match(report.semanticProvider, /stub \(offline\)/)

    // The baseline is the no-op path: it must cost zero semantic calls, which
    // is what makes it a baseline.
    assert.equal(report.totals.baseline.semanticCalls, 0)

    // Every conversation is measured in both variants.
    const variants = new Set(report.runs.map((r: any) => r.variant))
    assert.ok(variants.has('baseline'))
    assert.ok(variants.has('candidate'))
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('a conversation with no droppable segment produces no reduction at all', async () => {
  const out = await mkdtemp(join(tmpdir(), 'transform-bench-'))
  try {
    const report = await benchmark(out)
    const toolOnly = report.runs.filter(
      (r: any) => r.id === 'tool-only-session' && r.variant !== 'baseline',
    )
    assert.ok(toolOnly.length > 0)
    for (const run_ of toolOnly) {
      // Nothing is sent and nothing is removed: tool output is never a
      // candidate, so the transform must not even call the provider.
      assert.equal(run_.semanticCalls, 0)
      assert.equal(run_.segmentsDropped, 0)
      assert.equal(run_.messagesOut, run_.messagesIn)
    }
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('the synthetic variant exercises the saving path but is labelled a non-result', async () => {
  const out = await mkdtemp(join(tmpdir(), 'transform-bench-'))
  try {
    const report = await benchmark(out)
    const reduced = report.runs.filter(
      (r: any) => r.variant === 'synthetic-drop-all' && r.segmentsDropped > 0,
    )
    assert.ok(reduced.length > 0, 'the saving path must actually execute')
    for (const run_ of reduced) {
      assert.ok(
        run_.mainInputTokensOut < run_.mainInputTokensIn,
        'a reduction must lower the estimated input tokens',
      )
      // A reduction must never empty the conversation: the transform refuses a
      // total wipe, and that safety property is asserted here too.
      assert.ok(run_.messagesOut > 0)
    }

    const summary = await readFile(join(out, 'summary.md'), 'utf8')
    assert.match(summary, /NOT a result/)
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('provider cost is reported as null when no price is supplied, never zero', async () => {
  const out = await mkdtemp(join(tmpdir(), 'transform-bench-'))
  try {
    const report = await benchmark(out)
    // A zero cost would be the claim "this is free"; an unknown cost is not.
    assert.equal(report.totals.candidate.semanticCostUsd, null)
    assert.match(report.costNote, /null, not zero/)
    for (const run_ of report.runs) {
      assert.equal(run_.semanticCostUsd, null, 'no run may claim a price nobody supplied')
    }
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('a supplied price produces a real cost, and the baseline stays free', async () => {
  const out = await mkdtemp(join(tmpdir(), 'transform-bench-'))
  const previous = process.env.SEMANTIC_INPUT_USD_PER_MTOK
  try {
    process.env.SEMANTIC_INPUT_USD_PER_MTOK = '2'
    const report = await benchmark(out)
    const candidate = report.totals.candidate
    assert.ok(candidate.semanticCostUsd > 0, 'the candidate variant does spend provider tokens')
    // The baseline is the transform disabled: it must cost nothing at all.
    assert.equal(report.totals.baseline.semanticCostUsd, 0)
    // Linear in tokens, so the figure is checkable rather than asserted.
    const expected = (candidate.semanticInputTokens / 1_000_000) * 2
    assert.ok(
      Math.abs(candidate.semanticCostUsd - expected) < 1e-12,
      `expected ${expected}, got ${candidate.semanticCostUsd}`,
    )
  } finally {
    if (previous === undefined) delete process.env.SEMANTIC_INPUT_USD_PER_MTOK
    else process.env.SEMANTIC_INPUT_USD_PER_MTOK = previous
    await rm(out, { recursive: true, force: true })
  }
})

test('an invalid price is refused rather than silently treated as zero', async () => {
  const out = await mkdtemp(join(tmpdir(), 'transform-bench-'))
  const previous = process.env.SEMANTIC_INPUT_USD_PER_MTOK
  try {
    process.env.SEMANTIC_INPUT_USD_PER_MTOK = 'not-a-number'
    await assert.rejects(benchmark(out), /SEMANTIC_INPUT_USD_PER_MTOK/)
  } finally {
    if (previous === undefined) delete process.env.SEMANTIC_INPUT_USD_PER_MTOK
    else process.env.SEMANTIC_INPUT_USD_PER_MTOK = previous
    await rm(out, { recursive: true, force: true })
  }
})

test('the quality axis is measured through the project evaluator, not a second copy', async () => {
  const out = await mkdtemp(join(tmpdir(), 'transform-bench-'))
  try {
    const report = await benchmark(out)
    const quality = report.providerCapability
    assert.ok(quality, 'the report must carry the quality axis')
    // The metric is NAMED so a reader cannot mistake concordance for
    // correctness, and it is an accuracy only because the labels are human.
    assert.ok(quality.metric === 'accuracy' || quality.metric === 'agreement')
    assert.ok(quality.metricKind === 'accuracy' || quality.metricKind === 'concordance')
    assert.ok(quality.total > 0, 'the axis must actually run cases')
    // It states its own limit: this is NOT task quality.
    assert.match(quality.scope, /NOT task quality/)
    // And the top-level task-quality flag stays false.
    assert.equal(report.qualityMeasured, false)
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('every run reports a reason, so a silent no-op is impossible', async () => {
  const out = await mkdtemp(join(tmpdir(), 'transform-bench-'))
  try {
    const report = await benchmark(out)
    for (const run_ of report.runs) {
      if (run_.applied) {
        assert.equal(run_.reason, null, `${run_.id}/${run_.variant}: applied has no reason`)
      } else {
        assert.ok(typeof run_.reason === 'string' && run_.reason.length > 0, `${run_.id}/${run_.variant} must say why`)
      }
    }
    // The offline candidate cannot drop anything, so its reason is explained.
    const candidates = report.runs.filter((r: any) => r.variant === 'candidate')
    assert.ok(candidates.every((r: any) => r.reason !== null))
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('the report never contains message content from the conversations', async () => {
  const out = await mkdtemp(join(tmpdir(), 'transform-bench-'))
  try {
    // The run must happen before the file is read; otherwise this asserts on
    // a stale report and passes for the wrong reason.
    await benchmark(out)
    const raw = await readFile(join(out, 'report.json'), 'utf8')
    // A synthetic fixture string that would only appear if content leaked.
    assert.equal(raw.includes('tenant scoping to the export endpoint'), false)
    assert.equal(raw.includes('normalizes a tenant identifier'), false)
    assert.equal(raw.includes('SELECT * FROM records'), false)
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})