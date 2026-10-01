import assert from 'node:assert/strict'
import test from 'node:test'

import { createVerifyTool, type VerifyReport } from '../src/verify/tool.ts'
import { buildVerifyQuestions, VERIFY_QUESTION_IDS } from '../src/verify/questions.ts'
import { VERIFY_POLICY_VERSION } from '../src/verify/policy.ts'
import { DEFAULT_POLICY } from '../src/verify/policy.ts'

const ctx = { sessionId: 'fixture', workdir: '/tmp', projectId: 'project' }

const args = {
  criterionId: 'ac-1',
  criterion: 'Timeouts are bounded.',
  evidence: {
    summary: 'Added a bounded timeout setting.',
    diffExcerpts: ['+ timeoutMs: number'],
    deterministicTestResults: ['ok 1 - timeout bounds'],
  },
}

const answers = (
  satisfied: number,
  sufficiency: 0 | 1 | 2,
  offScope: number,
  needsDeeper: number,
  testable = 0.95,
) => ({
  answers: {
    [VERIFY_QUESTION_IDS.criterionTestable]: { type: 'noul', noul: testable },
    [VERIFY_QUESTION_IDS.satisfied]: { type: 'noul', noul: satisfied },
    [VERIFY_QUESTION_IDS.evidenceSufficiency]: {
      type: 'score',
      score: sufficiency,
      probabilities: { 0: 0, 1: 0, 2: 1 },
    },
    [VERIFY_QUESTION_IDS.offScope]: { type: 'noul', noul: offScope },
    [VERIFY_QUESTION_IDS.needsDeeperVerification]: { type: 'noul', noul: needsDeeper },
  },
})

/** Captures the outgoing request and replays a canned provider answer. */
function stubTransport(payload: unknown) {
  const seen: Array<{ body: any; headers: Record<string, string> }> = []
  const transport: typeof fetch = async (_url, init) => {
    seen.push({
      body: JSON.parse(String(init?.body)),
      headers: (init?.headers ?? {}) as Record<string, string>,
    })
    return Response.json(payload)
  }
  return { transport, seen }
}

test('one batched call asks every policy question exactly once', async () => {
  const { transport, seen } = stubTransport(answers(0.95, 2, 0.02, 0.05))
  const tool = createVerifyTool(() => ({ endpoint: 'http://localhost/v1/systemone' }), { transport })
  const result = await tool.execute(args, ctx)

  assert.equal(result.success, true)
  assert.equal(seen.length, 1, 'a single provider call must cover every question')
  assert.deepEqual(Object.keys(seen[0].body.questions).sort(), [
    'criterionTestable',
    'evidenceSufficiency',
    'needsDeeperVerification',
    'offScope',
    'satisfied',
  ])
  assert.equal(seen[0].body.state.acceptanceCriterion, args.criterion)
  // The evidence rubric must stay an ordered array for the common contract.
  assert.ok(Array.isArray(seen[0].body.questions.evidenceSufficiency.criteria))
})

test('an undecidable criterion is a dedicated unknown, never a verdict', async () => {
  // "Improve performance" has no state in which it is true and none in which it
  // is false. Every other answer about it is noise, so the policy must stop
  // there with its own reason rather than report a follow-up nobody can act on.
  const { criterionTestable } = buildVerifyQuestions('Improve performance.')
  assert.equal(criterionTestable.type, 'noul')
  const instructions = (criterionTestable as { instructions: string }).instructions
  assert.ok(instructions.includes('Improve performance.'), 'the criterion text must be quoted back')
  assert.match(instructions.toLowerCase(), /could some concrete state of the code make it/)

  const gate = DEFAULT_POLICY.gates.find((entry) => entry.id === 'criterionTestable')!
  // Phrased so a HIGH answer means "decidable", matching the gate's polarity.
  assert.equal(gate.polarity, 'high-is-good')
  assert.equal(gate.direction, 'at-least')

  for (const payload of [answers(0.99, 2, 0.01, 0.01, 0.1), answers(0.01, 2, 0.9, 0.95, 0.1)]) {
    const report = JSON.parse(
      (
        await createVerifyTool(() => ({ endpoint: 'http://localhost/v1/systemone' }), {
          transport: stubTransport(payload).transport,
          policy: { ...DEFAULT_POLICY, calibrated: true },
        }).execute(args, ctx)
      ).output!,
    ) as VerifyReport
    assert.equal(report.status, 'unknown')
    assert.equal(report.reasons[0], 'criterion_not_testable')
  }
})

test('the declared confidence is reported as telemetry and decides nothing', async () => {
  // A runtime that says it is certain and a runtime that says it is not must
  // produce the same status from the same numbers. The confidence is kept in
  // the report so a later calibrated run can correlate the two.
  const withConfidence = (confidence: number) => ({
    answers: {
      [VERIFY_QUESTION_IDS.criterionTestable]: { type: 'noul', noul: 0.95, confidence },
      [VERIFY_QUESTION_IDS.satisfied]: { type: 'noul', noul: 0.99, confidence },
      [VERIFY_QUESTION_IDS.evidenceSufficiency]: {
        type: 'score',
        score: 2,
        probabilities: { 0: 0, 1: 0, 2: 1 },
        confidence,
      },
      [VERIFY_QUESTION_IDS.offScope]: { type: 'noul', noul: 0.01, confidence },
      [VERIFY_QUESTION_IDS.needsDeeperVerification]: { type: 'noul', noul: 0.01, confidence },
    },
  })
  const run = async (payload: unknown, calibrated: boolean) => {
    const tool = createVerifyTool(() => ({ endpoint: 'http://localhost/v1/systemone' }), {
      transport: stubTransport(payload).transport,
      policy: { ...DEFAULT_POLICY, calibrated },
    })
    return JSON.parse((await tool.execute(args, ctx)).output!) as VerifyReport
  }

  const certain = await run(withConfidence(0.99), true)
  const selfDoubting = await run(withConfidence(0), true)
  assert.equal(certain.status, 'pass-candidate')
  assert.equal(selfDoubting.status, 'pass-candidate', 'a declared 0 must not change the status')
  assert.equal(selfDoubting.telemetry.declaredConfidence.satisfied, 0)
  assert.equal(certain.telemetry.declaredConfidence.satisfied, 0.99)
  // Telemetry is numbers only, and the shipped policy still cannot pass.
  assert.equal((await run(withConfidence(0.99), false)).status, 'unknown')
})

test('the offScope question states one polarity, matching its high-is-risk gate', () => {
  // The gate is `high-is-risk` with `at-most`, so a HIGH answer must mean
  // "off scope". A question phrased as "is the change staying on scope?" makes
  // a high answer mean the opposite of what the policy reads, which is how a
  // single polarity gets lost.
  const gate = DEFAULT_POLICY.gates.find((entry) => entry.id === 'offScope')!
  assert.equal(gate.polarity, 'high-is-risk')
  assert.equal(gate.direction, 'at-most')
  const { offScope } = buildVerifyQuestions('Timeouts are bounded.')
  assert.equal(offScope.type, 'noul')
  const instructions = (offScope as { instructions: string }).instructions.toLowerCase()
  assert.match(instructions, /high only when unrelated behaviour is genuinely changed/)
  // The wording must not ask whether the change stays on scope: that inverts
  // the polarity of the very question the gate depends on.
  assert.doesNotMatch(instructions, /staying on scope/)
  assert.doesNotMatch(instructions, /answer high only when unrelated behaviour is genuinely touched/)
})

test('the production report is advisory and never a positive verdict', async () => {
  const { transport } = stubTransport(answers(0.99, 2, 0.01, 0.01))
  const tool = createVerifyTool(() => ({ endpoint: 'http://localhost/v1/systemone' }), { transport })
  const report = JSON.parse((await tool.execute(args, ctx)).output!) as VerifyReport

  assert.equal(report.status, 'unknown')
  assert.equal(report.advisory, true)
  assert.equal(report.calibrated, false)
  assert.equal(report.policyVersion, VERIFY_POLICY_VERSION)
  assert.ok(report.reasons.includes('policy_not_calibrated'))
})

test('the report is traceable and aggregatable without exposing provider payload', async () => {
  const { transport } = stubTransport(answers(0.95, 2, 0.02, 0.05))
  const tool = createVerifyTool(() => ({ endpoint: 'http://localhost/v1/systemone' }), { transport })
  const report = JSON.parse(
    (await tool.execute({ ...args, issueId: '#4', evidenceRefs: ['src/verify/tool.ts'] }, ctx)).output!,
  ) as VerifyReport

  assert.match(report.reportId, /^verify:[A-Za-z0-9._-]+:[0-9a-f]{16}$/)
  assert.ok(report.reportId.startsWith('verify:ac-1:'))
  assert.equal(report.trace.issueId, '#4')
  assert.equal(report.trace.criterionId, 'ac-1')
  assert.equal(report.trace.criterionText, args.criterion)
  assert.deepEqual(report.trace.evidenceRefs, ['src/verify/tool.ts'])
  assert.ok(!JSON.stringify(report).includes('endpoint'))
  assert.ok(report.evidenceBytes > 0)
})

test('a calibrated policy can surface a positive status as a candidate only', async () => {
  const { transport } = stubTransport(answers(0.99, 2, 0.01, 0.01))
  const tool = createVerifyTool(() => ({ endpoint: 'http://localhost/v1/systemone' }), {
    transport,
    policy: { ...DEFAULT_POLICY, calibrated: true },
  })
  const report = JSON.parse((await tool.execute(args, ctx)).output!) as VerifyReport
  assert.equal(report.status, 'pass-candidate')
  // Even when positive, the result stays advice and never claims completion.
  assert.equal(report.advisory, true)
  assert.equal(JSON.stringify(report).includes('task complete'), false)
})

test('repository-derived evidence is always sent with an automatic origin', async () => {
  // block-remote-automatic permits explicit calls only. If the tool forgot to
  // declare an automatic origin, this remote call would wrongly succeed.
  const { transport, seen } = stubTransport(answers(0.9, 2, 0.02, 0.05))
  const tool = createVerifyTool(
    () => ({
      endpoint: 'https://api.example.invalid/v1/systemone',
      endpointClass: 'remote',
      egressPolicy: 'block-remote-automatic',
    }),
    { transport },
  )
  const result = await tool.execute(args, ctx)

  assert.equal(result.success, false)
  assert.equal(JSON.parse(result.error!).code, 'egress_blocked')
  assert.equal(seen.length, 0, 'a blocked call must send nothing at all')
})

test('an explicit semantic_decide call stays allowed under the same policy', async () => {
  // Proves the new tool did not narrow the Lot 1 contract.
  const { createDecisionTool } = await import('../src/tool.ts')
  const { transport, seen } = stubTransport({ answers: { q: { type: 'noul', noul: 0.9 } } })
  const tool = createDecisionTool(
    () => ({
      endpoint: 'https://api.example.invalid/v1/systemone',
      endpointClass: 'remote',
      egressPolicy: 'block-remote-automatic',
    }),
    transport,
  )
  const result = await tool.execute(
    { state: 'public', questions: { q: { type: 'noul', instructions: 'Is this public?' } } },
    ctx,
  )
  assert.equal(result.success, true)
  assert.equal(seen.length, 1)
})

test('local endpoints are never blocked for verification content', async () => {
  const { transport, seen } = stubTransport(answers(0.9, 2, 0.02, 0.05))
  const tool = createVerifyTool(
    () => ({ endpoint: 'http://127.0.0.1:1/v1/systemone', egressPolicy: 'block-remote-all' }),
    { transport },
  )
  const result = await tool.execute(args, ctx)
  assert.equal(result.success, true)
  assert.equal(seen.length, 1)
})

test('invalid input is rejected before any provider call', async () => {
  const { transport, seen } = stubTransport(answers(0.9, 2, 0.02, 0.05))
  const tool = createVerifyTool(() => ({ endpoint: 'http://localhost/v1/systemone' }), { transport })
  for (const bad of [{}, { criterionId: 'ac-1' }, { ...args, criterion: '  ' }, { ...args, nope: 1 }]) {
    const result = await tool.execute(bad, ctx)
    assert.equal(result.success, false, JSON.stringify(bad))
  }
  assert.equal(seen.length, 0)
})

test('provider failures never surface as a positive or negative verdict', async () => {
  const cases: Array<[string, () => Promise<Response>]> = [
    ['http', async () => new Response('secret-token-in-body', { status: 503 })],
    ['invalid_response', async () => new Response('<html>not json</html>', { status: 200 })],
    ['invalid_response', async () => Response.json({ answers: { satisfied: { type: 'noul', noul: 0.99 } } })],
  ]
  for (const [expectedCode, response] of cases) {
    const tool = createVerifyTool(
      () => ({ endpoint: 'http://localhost/v1/systemone' }),
      { transport: (async () => response()) as typeof fetch },
    )
    const result = await tool.execute(args, ctx)
    assert.equal(result.success, false)
    const parsed = JSON.parse(result.error!)
    assert.equal(parsed.code, expectedCode)
    assert.ok(!JSON.stringify(parsed).includes('secret-token-in-body'), 'no upstream body may be reflected')
  }
})

test('cancellation and timeouts stay failures with their own codes', async () => {
  const controller = new AbortController()
  controller.abort()
  const tool = createVerifyTool(() => ({ endpoint: 'http://localhost/v1/systemone' }))
  const aborted = await tool.execute(args, { ...ctx, signal: controller.signal })
  assert.equal(JSON.parse(aborted.error!).code, 'aborted')

  const slow = createVerifyTool(
    () => ({ endpoint: 'http://localhost/v1/systemone', timeoutMs: 50 }),
    {
      transport: ((_u: unknown, init: any) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })) as unknown as typeof fetch,
    },
  )
  const timedOut = await slow.execute(args, ctx)
  assert.equal(JSON.parse(timedOut.error!).code, 'timeout')
})

test('an internal fault is not reported as a caller argument error', async () => {
  // A settings read that throws is a plugin-side problem, not a bad argument.
  // Telling the agent to "fix its arguments" would send it the wrong way.
  const tool = createVerifyTool(() => {
    throw new Error('settings backend unavailable: super-secret-token')
  })
  const result = await tool.execute(args, ctx)
  assert.equal(result.success, false)
  const parsed = JSON.parse(result.error!)
  assert.equal(parsed.code, 'internal')
  assert.ok(!result.error!.includes('super-secret-token'), 'no internal message may be reflected')
})

test('the API key is never echoed in the report or the error', async () => {
  const tool = createVerifyTool(
    () => ({ endpoint: 'http://localhost/v1/systemone', apiKey: 'sk-do-not-log-me' }),
    { transport: (async () => new Response('nope', { status: 500 })) as typeof fetch },
  )
  const result = await tool.execute(args, ctx)
  assert.equal(JSON.stringify(result).includes('sk-do-not-log-me'), false)
})


test('verification resolves explicit calibration overrides above an active profile', async () => {
  const { transport } = stubTransport(answers(0.8, 2, 0.1, 0.1))
  const tool = createVerifyTool(
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
        gateOverrides: { satisfied: { threshold: 0.85, undecided: [0.5, 0.85] } },
      }),
      calibrationOverridesJson: JSON.stringify({
        calibrated: true,
        gates: { satisfied: { threshold: 0.75 } },
      }),
    }),
    { transport },
  )
  const report = JSON.parse((await tool.execute(args, ctx)).output!) as VerifyReport
  assert.equal(report.calibrated, true)
  const satisfied = report.gates.find((gate) => gate.id === 'satisfied')!
  assert.equal(satisfied.threshold, 0.75)
  assert.equal(satisfied.verdict, 'met')
})
