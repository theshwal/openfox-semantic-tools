import assert from 'node:assert/strict'
import test from 'node:test'

import { createQuestionCalibrationTool } from '../src/calibration/question-tool.ts'
import { fingerprintQuestion } from '../src/calibration/question-eval.ts'

const ctx = { sessionId: 's', workdir: '/tmp', projectId: 'p' }
const SETTINGS = { backend: 'custom', endpoint: 'http://localhost/v1/systemone', model: 'fixture-model' }

function settings(extra: Record<string, unknown> = {}) {
  return { ...SETTINGS, ...extra }
}

test('the tool evaluates labelled noul cases and never leaks state or secrets', async () => {
  const seen: any[] = []
  const tool = createQuestionCalibrationTool(() => settings({ apiKey: 'super-secret' }), async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    seen.push({ body, auth: (init?.headers as Record<string, string>).Authorization })
    const state = body.state
    return Response.json({
      model: 'fixture-model',
      answers: {
        question: {
          type: 'noul',
          noul: state.includes('precise') ? 0.9 : 0.2,
        },
      },
    })
  })
  const result = await tool.execute(
    {
      question: { type: 'noul', instructions: 'Does the note contain a precise diagnosis?' },
      cases: [
        { id: 'clear', state: 'a precise diagnosis of pulmonary embolism', expected: true },
        { id: 'vague', state: 'the patient is unwell', expected: false },
      ],
      questionVersion: 'notes-v1',
    },
    ctx,
  )
  assert.equal(result.success, true)
  const report = JSON.parse(result.output!)
  assert.equal(report.advisory, true)
  assert.equal(report.active, false)
  assert.equal(report.provider.presetId, 'custom')
  assert.equal(report.provider.model, 'fixture-model')
  assert.equal(report.question.type, 'noul')
  assert.equal(report.question.version, 'notes-v1')
  assert.equal(
    report.question.fingerprint,
    fingerprintQuestion({ type: 'noul', instructions: 'Does the note contain a precise diagnosis?' }),
  )
  assert.equal(report.aggregate.total, 2)
  assert.equal(report.aggregate.answered, 2)
  assert.equal(report.aggregate.matched, 2)
  assert.equal(report.aggregate.agreement, 1)
  assert.equal(report.candidate.active, false)
  assert.equal(report.candidate.question.fingerprint, report.question.fingerprint)
  assert.equal(seen.length, 2)
  for (const call of seen) {
    assert.equal(call.auth, 'Bearer super-secret', 'the credential is only ever sent to the provider')
  }
  // The report itself must not carry raw private state, the endpoint or the key.
  const serialized = result.output!
  assert.ok(!serialized.includes('pulmonary embolism'))
  assert.ok(!serialized.includes('patient is unwell'))
  assert.ok(!serialized.includes('super-secret'))
  assert.ok(!serialized.includes('localhost'))
  for (const entry of report.cases) {
    assert.equal(entry.state, undefined)
  }
})

test('malformed arguments fail before any provider call', async () => {
  let calls = 0
  const tool = createQuestionCalibrationTool(() => settings(), async () => {
    calls++
    return Response.json({ answers: {} })
  })
  for (const args of [
    {},
    { question: { type: 'noul', instructions: 'x' } },
    { question: { type: 'noul', instructions: 'x' }, cases: [] },
    { question: { type: 'noul', instructions: 'x' }, cases: [{ id: 'a', state: 's', expected: 'yes' }] },
    { question: { type: 'noul', instructions: 'x' }, cases: [{ id: 'a', state: 's', expected: true }], surprise: 1 },
  ]) {
    const result = await tool.execute(args as never, ctx)
    assert.equal(result.success, false, JSON.stringify(args))
    const error = JSON.parse(result.error!)
    assert.equal(error.code, 'invalid_arguments')
    assert.ok(!result.error!.includes('super-secret'))
  }
  assert.equal(calls, 0)
})

test('an invalid expected score level is rejected before the request', async () => {
  let calls = 0
  const tool = createQuestionCalibrationTool(() => settings(), async () => {
    calls++
    return Response.json({ answers: {} })
  })
  const result = await tool.execute(
    {
      question: { type: 'score', instructions: 'Level?', criteria: ['low', 'high'] },
      cases: [{ id: 'a', state: 's', expected: 2 }],
    },
    ctx,
  )
  assert.equal(result.success, false)
  assert.equal(JSON.parse(result.error!).code, 'invalid_arguments')
  assert.equal(calls, 0)
})

test('a malformed provider answer is a per-case error and still yields a report', async () => {
  const tool = createQuestionCalibrationTool(() => settings(), async () =>
    Response.json({ model: 'fixture-model', answers: { question: { type: 'noul', noul: 7 } } }),
  )
  const result = await tool.execute(
    {
      question: { type: 'noul', instructions: 'Does it hold?' },
      cases: [{ id: 'a', state: 's', expected: true }],
    },
    ctx,
  )
  // The shared adapter rejects the whole payload, so the case is an explicit
  // provider error: visible, and never a semantic answer.
  assert.equal(result.success, true, 'an evaluation report is still a report')
  const report = JSON.parse(result.output!)
  assert.equal(report.cases[0].answered, false)
  assert.equal(report.cases[0].observed, null)
  assert.equal(report.cases[0].error, 'invalid_response')
  assert.equal(report.aggregate.errors, 1)
  assert.equal(report.aggregate.answered, 0)
  assert.equal(report.aggregate.agreement, null)
  assert.equal(report.metrics.noul.brierScore, null)
  assert.deepEqual(report.reviewCaseIds, ['a'])
})

test('a total provider failure is reported per case and still yields a report', async () => {
  const tool = createQuestionCalibrationTool(() => settings(), async () => new Response('token=leak', { status: 503 }))
  const result = await tool.execute(
    {
      question: { type: 'noul', instructions: 'Does it hold?' },
      cases: [
        { id: 'a', state: 's', expected: true },
        { id: 'b', state: 's', expected: false },
      ],
    },
    ctx,
  )
  assert.equal(result.success, true)
  const report = JSON.parse(result.output!)
  assert.equal(report.aggregate.total, 2)
  assert.equal(report.aggregate.answered, 0)
  assert.equal(report.aggregate.errors, 2)
  assert.equal(report.metrics.noul.brierScore, null)
  assert.equal(report.metrics.noul.falsePositives, 0)
  assert.equal(report.cases[0].error, 'http')
  assert.ok(!JSON.stringify(report).includes('leak'))
})

test('blocked remote egress fails the tool instead of sending labelled states', async () => {
  let calls = 0
  const tool = createQuestionCalibrationTool(
    () => settings({ endpoint: 'https://provider.example/v1/systemone', endpointClass: 'remote', egressPolicy: 'block-remote-all' }),
    async () => {
      calls++
      return Response.json({ answers: {} })
    },
  )
  const result = await tool.execute(
    {
      question: { type: 'noul', instructions: 'Does it hold?' },
      cases: [{ id: 'a', state: 'private state', expected: true }],
    },
    ctx,
  )
  assert.equal(result.success, false)
  assert.equal(JSON.parse(result.error!).code, 'egress_blocked')
  assert.equal(calls, 0)
  assert.ok(!result.error!.includes('provider.example'))
})

test('cancellation propagates instead of producing a report', async () => {
  const controller = new AbortController()
  controller.abort()
  const tool = createQuestionCalibrationTool(() => settings())
  const result = await tool.execute(
    {
      question: { type: 'noul', instructions: 'Does it hold?' },
      cases: [{ id: 'a', state: 's', expected: true }],
    },
    { ...ctx, signal: controller.signal },
  )
  assert.equal(result.success, false)
  assert.equal(JSON.parse(result.error!).code, 'aborted')
})

test('the registered tool is wired to the global settings reader', async () => {
  // The global-scope guarantee is asserted with every tool in
  // test/register.test.ts; here only the wiring is proved: the tool reads the
  // settings the registry exposes and reaches the provider with them.
  const { register } = await import('../src/index.ts')
  const { fakeRegistry } = await import('./helpers/registry.ts')
  const fake = fakeRegistry()
  register(fake.registry)
  const tool = fake.tools.get('semantic_question_calibration')
  assert.ok(tool, 'the calibration tool must be registered')
  assert.equal(tool!.name, 'semantic_question_calibration')
  const result = await tool!.execute(
    {
      question: { type: 'noul', instructions: 'Does it hold?' },
      cases: [{ id: 'a', state: 's', expected: true }],
    },
    ctx,
  )
  // The fake registry has no endpoint configured, so the failure must be the
  // controlled configuration error and never an unhandled exception.
  assert.equal(result.success, false)
  assert.equal(JSON.parse(result.error!).code, 'configuration')
})
