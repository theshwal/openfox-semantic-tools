import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createIssueCoverageTool,
  MAX_COVERAGE_CRITERIA,
  type IssueCoverageReport,
} from '../src/verify/coverage.ts'
import { DEFAULT_POLICY, VERIFY_POLICY_VERSION } from '../src/verify/policy.ts'
import { VERIFY_QUESTION_IDS } from '../src/verify/questions.ts'

const ctx = { sessionId: 'fixture', workdir: '/tmp', projectId: 'project' }

function answers(
  satisfied: number,
  sufficiency: 0 | 1 | 2,
  offScope = 0.02,
  needsDeeper = 0.05,
  testable = 0.95,
) {
  return {
    answers: {
      [VERIFY_QUESTION_IDS.criterionTestable]: { type: 'noul', noul: testable },
      [VERIFY_QUESTION_IDS.satisfied]: { type: 'noul', noul: satisfied },
      [VERIFY_QUESTION_IDS.evidenceSufficiency]: {
        type: 'score',
        score: sufficiency,
        probabilities: {
          0: sufficiency === 0 ? 1 : 0,
          1: sufficiency === 1 ? 1 : 0,
          2: sufficiency === 2 ? 1 : 0,
        },
      },
      [VERIFY_QUESTION_IDS.offScope]: { type: 'noul', noul: offScope },
      [VERIFY_QUESTION_IDS.needsDeeperVerification]: { type: 'noul', noul: needsDeeper },
    },
  }
}

function sequenceTransport(
  payloadFor: (criterion: string, call: number) => unknown | Response,
) {
  const seen: any[] = []
  let call = 0
  const transport: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    seen.push(body)
    const criterion = String(body.state.acceptanceCriterion)
    const value = payloadFor(criterion, call++)
    return value instanceof Response ? value : Response.json(value)
  }
  return { transport, seen }
}

const baseArgs = {
  issueId: '#33',
  task: 'Implement all explicit acceptance criteria without replacing deterministic checks.',
  criteria: [
    { id: 'ac-1', text: 'The first criterion is implemented.' },
    { id: 'ac-2', text: 'The second criterion is implemented.' },
    { id: 'ac-3', text: 'The third criterion is implemented.' },
  ],
  evidence: {
    summary: 'Implemented the bounded issue coverage layer.',
    diffExcerpts: ['+ semantic_issue_coverage'],
    deterministicTestResults: ['ok - focused tests'],
  },
  evidenceRefs: ['src/verify/coverage.ts', 'test/issue-coverage.test.ts'],
}

test('mixed criteria map to covered, missing and uncertain through the existing policy', async () => {
  const { transport } = sequenceTransport((criterion) => {
    if (criterion.includes('first')) return answers(0.99, 2)
    if (criterion.includes('second')) return answers(0.1, 2)
    return answers(0.7, 2)
  })
  const tool = createIssueCoverageTool(
    () => ({ endpoint: 'http://localhost/v1/systemone' }),
    { transport, policy: { ...DEFAULT_POLICY, calibrated: true } },
  )
  const result = await tool.execute(baseArgs, ctx)
  assert.equal(result.success, true)
  const report = JSON.parse(result.output!) as IssueCoverageReport

  assert.deepEqual(
    report.criteria.map((criterion) => criterion.coverage),
    ['covered', 'missing', 'uncertain'],
  )
  assert.deepEqual(report.counts, { covered: 1, missing: 1, uncertain: 1 })
  assert.equal(report.needsFollowup, true)
  assert.equal(report.advisory, true)
  assert.equal(report.criteria[1].verificationStatus, 'needs-verification')
})

test('an uncalibrated positive result can never become covered', async () => {
  const { transport } = sequenceTransport(() => answers(0.99, 2))
  const tool = createIssueCoverageTool(
    () => ({ endpoint: 'http://localhost/v1/systemone' }),
    { transport },
  )
  const result = await tool.execute(
    { criteria: [{ id: 'ac-1', text: 'The criterion is implemented.' }] },
    ctx,
  )
  const report = JSON.parse(result.output!) as IssueCoverageReport
  assert.equal(report.criteria[0].verificationStatus, 'unknown')
  assert.equal(report.criteria[0].coverage, 'uncertain')
  assert.equal(report.counts.covered, 0)
  assert.equal(report.calibrated, false)
})

test('missing requires sufficient evidence as well as a decisively unmet criterion', async () => {
  const { transport } = sequenceTransport(() => answers(0.1, 0))
  const tool = createIssueCoverageTool(
    () => ({ endpoint: 'http://localhost/v1/systemone' }),
    { transport, policy: { ...DEFAULT_POLICY, calibrated: true } },
  )
  const result = await tool.execute(
    { criteria: [{ id: 'ac-1', text: 'The criterion is implemented.' }] },
    ctx,
  )
  const report = JSON.parse(result.output!) as IssueCoverageReport
  assert.equal(report.criteria[0].coverage, 'uncertain')
  assert.ok(report.criteria[0].reasons.includes('criterion_not_satisfied'))
  assert.ok(report.criteria[0].reasons.includes('evidence_insufficient'))
})

test('off-scope evidence is reported separately and always requires follow-up', async () => {
  const { transport } = sequenceTransport(() => answers(0.99, 2, 0.95))
  const tool = createIssueCoverageTool(
    () => ({ endpoint: 'http://localhost/v1/systemone' }),
    { transport, policy: { ...DEFAULT_POLICY, calibrated: true } },
  )
  const result = await tool.execute(
    { criteria: [{ id: 'ac-1', text: 'The criterion is implemented.' }] },
    ctx,
  )
  const report = JSON.parse(result.output!) as IssueCoverageReport
  assert.equal(report.criteria[0].coverage, 'uncertain')
  assert.equal(report.criteria[0].offScopeEvidence, true)
  assert.equal(report.needsFollowup, true)
})

test('task context is transmitted but evidenceRefs remain local-only trace data', async () => {
  const { transport, seen } = sequenceTransport(() => answers(0.99, 2))
  const tool = createIssueCoverageTool(
    () => ({ endpoint: 'http://localhost/v1/systemone' }),
    { transport, policy: { ...DEFAULT_POLICY, calibrated: true } },
  )
  const result = await tool.execute(
    {
      issueId: '#33',
      task: 'Exact task context.',
      criteria: [{ id: 'ac-1', text: 'The criterion is implemented.' }],
      evidenceRefs: ['private/local/path.ts'],
    },
    ctx,
  )
  const report = JSON.parse(result.output!) as IssueCoverageReport
  assert.equal(seen[0].state.taskContext, 'Exact task context.')
  assert.equal(JSON.stringify(seen[0]).includes('private/local/path.ts'), false)
  assert.deepEqual(report.criteria[0].evidenceRefs, ['private/local/path.ts'])
})

test('provider failure aborts coverage instead of fabricating remaining statuses', async () => {
  const { transport } = sequenceTransport((_criterion, call) =>
    call === 0 ? answers(0.99, 2) : new Response('do-not-reflect-this', { status: 503 }),
  )
  const tool = createIssueCoverageTool(
    () => ({ endpoint: 'http://localhost/v1/systemone' }),
    { transport, policy: { ...DEFAULT_POLICY, calibrated: true } },
  )
  const result = await tool.execute(
    {
      criteria: [
        { id: 'ac-1', text: 'First criterion.' },
        { id: 'ac-2', text: 'Second criterion.' },
      ],
    },
    ctx,
  )
  assert.equal(result.success, false)
  const error = JSON.parse(result.error!)
  assert.equal(error.code, 'http')
  assert.equal(result.error!.includes('do-not-reflect-this'), false)
  assert.equal(result.output, undefined)
})

test('automatic egress policy blocks the whole assessment before sending repository state', async () => {
  const { transport, seen } = sequenceTransport(() => answers(0.99, 2))
  const tool = createIssueCoverageTool(
    () => ({
      endpoint: 'https://api.example.invalid/v1/systemone',
      endpointClass: 'remote',
      egressPolicy: 'block-remote-automatic',
    }),
    { transport },
  )
  const result = await tool.execute(
    { criteria: [{ id: 'ac-1', text: 'The criterion is implemented.' }] },
    ctx,
  )
  assert.equal(result.success, false)
  assert.equal(JSON.parse(result.error!).code, 'egress_blocked')
  assert.equal(seen.length, 0)
})

test('stale calibration never grants covered status', async () => {
  const { transport } = sequenceTransport(() => answers(0.99, 2))
  const tool = createIssueCoverageTool(
    () => ({
      backend: 'custom',
      endpoint: 'http://localhost/v1/systemone',
      model: 'new-model',
      calibrationProfileJson: JSON.stringify({
        schemaVersion: 1,
        id: 'stale-profile',
        provider: { presetId: 'custom', model: 'old-model' },
        policyVersion: VERIFY_POLICY_VERSION,
        testedAt: '2026-10-01T00:00:00.000Z',
        status: 'user-calibrated',
        provenance: 'test',
        active: true,
        calibrated: true,
      }),
    }),
    { transport },
  )
  const result = await tool.execute(
    { criteria: [{ id: 'ac-1', text: 'The criterion is implemented.' }] },
    ctx,
  )
  const report = JSON.parse(result.output!) as IssueCoverageReport
  assert.equal(report.criteria[0].coverage, 'uncertain')
  assert.equal(report.calibrated, false)
})

test('explicit calibration overrides are reused above profile defaults', async () => {
  const { transport } = sequenceTransport(() => answers(0.8, 2, 0.1, 0.1))
  const tool = createIssueCoverageTool(
    () => ({
      backend: 'custom',
      endpoint: 'http://localhost/v1/systemone',
      calibrationProfileJson: JSON.stringify({
        schemaVersion: 1,
        id: 'active-profile',
        provider: { presetId: 'custom' },
        policyVersion: VERIFY_POLICY_VERSION,
        testedAt: '2026-10-01T00:00:00.000Z',
        status: 'provisional',
        provenance: 'test',
        active: true,
        calibrated: false,
        gateOverrides: {
          satisfied: { threshold: 0.85, undecided: [0.5, 0.85] },
        },
      }),
      calibrationOverridesJson: JSON.stringify({
        calibrated: true,
        gates: { satisfied: { threshold: 0.75 } },
      }),
    }),
    { transport },
  )
  const result = await tool.execute(
    { criteria: [{ id: 'ac-1', text: 'The criterion is implemented.' }] },
    ctx,
  )
  const report = JSON.parse(result.output!) as IssueCoverageReport
  assert.equal(report.criteria[0].coverage, 'covered')
  const satisfied = report.criteria[0].gates.find((gate) => gate.id === 'satisfied')!
  assert.equal(satisfied.threshold, 0.75)
})

test('criteria are bounded, unique and validated before any provider call', async () => {
  const { transport, seen } = sequenceTransport(() => answers(0.99, 2))
  const tool = createIssueCoverageTool(
    () => ({ endpoint: 'http://localhost/v1/systemone' }),
    { transport },
  )
  const tooMany = Array.from({ length: MAX_COVERAGE_CRITERIA + 1 }, (_, i) => ({
    id: `ac-${i}`,
    text: `criterion ${i}`,
  }))
  for (const args of [
    { criteria: [] },
    { criteria: tooMany },
    { criteria: [{ id: 'ac-1', text: 'one' }, { id: 'ac-1', text: 'two' }] },
    { criteria: [{ id: 'ac-1', text: 'one', unexpected: true }] },
    { criteria: [{ id: 'ac-1', text: 'one' }], unexpected: true },
  ]) {
    const result = await tool.execute(args, ctx)
    assert.equal(result.success, false)
    assert.equal(JSON.parse(result.error!).code, 'invalid_arguments')
  }
  assert.equal(seen.length, 0)
})
