import assert from 'node:assert/strict'
import test from 'node:test'

import { MAX_EVIDENCE_BYTES, MAX_IDENTIFIER_LENGTH, MAX_REFERENCE_COUNT, buildVerifyState } from '../src/verify/state.ts'
import { ProviderError } from '../src/errors.ts'

const base = {
  criterionId: 'ac-2',
  criterion: 'Timeout configuration is bounded and documented.',
  evidence: {
    summary: 'Added a bounded timeout setting.',
    diffExcerpts: ['+ timeoutMs: number'],
    deterministicTestResults: ['ok 1 - timeout bounds'],
  },
}

test('the state is compact, JSON-safe and carries exactly the supplied material', () => {
  const { state, trace, bytes } = buildVerifyState(base)
  assert.equal(state.acceptanceCriterion, base.criterion)
  assert.deepEqual(state.diffExcerpts, base.evidence.diffExcerpts)
  assert.deepEqual(state.deterministicTestResults, base.evidence.deterministicTestResults)
  assert.equal(state.implementationSummary, base.evidence.summary)
  assert.ok(bytes > 0)
  assert.equal(trace.criterionId, 'ac-2')
  assert.equal(trace.criterionText, base.criterion)
  assert.equal(trace.issueId, null)
})

test('absent optional evidence is simply omitted, never invented', () => {
  const { state } = buildVerifyState({ criterionId: 'ac-3', criterion: 'Documented.' })
  assert.deepEqual(state, { acceptanceCriterion: 'Documented.' })
})

test('evidence references stay local and are never sent to the provider', () => {
  const refs = ['src/verify/tool.ts', 'test/verify-tool.test.ts#k']
  const { state, trace } = buildVerifyState({ ...base, evidenceRefs: refs })
  assert.deepEqual(trace.evidenceRefs, refs)
  const serialized = JSON.stringify(state)
  for (const ref of refs) assert.ok(!serialized.includes(ref), 'repo references must not be transmitted')
})

test('the report id is stable for identical input and changes with the evidence', () => {
  const a = buildVerifyState(base).reportId
  const b = buildVerifyState({ ...base }).reportId
  const c = buildVerifyState({ ...base, evidence: { ...base.evidence, diffExcerpts: ['+ timeoutMs: string'] } }).reportId
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.match(a, /^verify:ac-2:[0-9a-f]{16}$/)
})

test('oversized evidence is rejected rather than silently truncated', () => {
  // Bounded entries, collectively over the aggregate limit: the per-entry cap
  // does not mask the total bound.
  const many = Array.from({ length: MAX_REFERENCE_COUNT - 1 }, () => 'x'.repeat(MAX_IDENTIFIER_LENGTH))
  const huge = { ...base, evidence: { ...base.evidence, diffExcerpts: many } }
  assert.throws(() => buildVerifyState(huge), (error: unknown) => {
    assert.ok(error instanceof ProviderError)
    assert.equal(error.code, 'invalid_arguments')
    assert.match(error.message, /exceeds the evidence size limit/)
    return true
  })

  // Just under the aggregate limit is accepted, so the bound is not a blanket
  // refusal of any long evidence.
  const ok = {
    ...base,
    evidence: { ...base.evidence, diffExcerpts: ['x'.repeat(MAX_IDENTIFIER_LENGTH)] },
  }
  assert.ok(buildVerifyState(ok).bytes > 0)
})

test('a criterion id cannot be used to inflate a persisted report', () => {
  // A single tool argument must not be able to produce an arbitrarily large
  // report id on disk.
  const huge = { ...base, criterionId: 'a'.repeat(2_000_000) }
  assert.throws(() => buildVerifyState(huge), (error: unknown) => {
    assert.ok(error instanceof ProviderError)
    assert.equal(error.code, 'invalid_arguments')
    assert.match(error.message, /criterionId exceeds/)
    return true
  })

  // A long but bounded id is still sanitized and capped inside the report id.
  const { reportId } = buildVerifyState({ ...base, criterionId: 'x'.repeat(MAX_IDENTIFIER_LENGTH) })
  assert.ok(reportId.length < 80, `report id is ${reportId.length} chars`)
  assert.match(reportId, /^verify:[A-Za-z0-9._-]+:[0-9a-f]{16}$/)
})

test('the reference list is bounded', () => {
  const many = Array.from({ length: MAX_REFERENCE_COUNT + 1 }, (_v, i) => `ref-${i}`)
  assert.throws(() => buildVerifyState({ ...base, evidenceRefs: many }), ProviderError)
  assert.throws(
    () => buildVerifyState({ ...base, evidenceRefs: ['r'.repeat(MAX_IDENTIFIER_LENGTH + 1)] }),
    ProviderError,
  )
})

test('malformed or empty required material is rejected before any request', () => {
  const bad: unknown[] = [
    undefined,
    {},
    { ...base, criterionId: '' },
    { ...base, criterion: '   ' },
    { ...base, evidence: { diffExcerpts: 'not-an-array' } },
    { ...base, evidence: { diffExcerpts: [42] } },
    { ...base, evidence: { summary: 5 } },
    { ...base, unknownField: true },
    { ...base, model: '' },
  ]
  for (const value of bad) {
    assert.throws(() => buildVerifyState(value as never), ProviderError, JSON.stringify(value)?.slice(0, 60))
  }
})
