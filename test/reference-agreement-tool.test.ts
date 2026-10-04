import assert from 'node:assert/strict'
import test from 'node:test'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { createReferenceAgreementTool } from '../src/calibration/reference-tool.ts'
import { SETTINGS } from '../src/index.ts'

const ctx = { sessionId: 's', workdir: '/tmp', projectId: 'p' }
const BASE = { backend: 'custom', endpoint: 'http://localhost/v1/systemone', model: 'fixture-model' }
const QUESTION = { type: 'noul', instructions: 'Does the note contain a precise diagnosis?' }
const REFERENCE = { source: 'llm', model: 'main-model-x', promptVersion: 'notes-prompt-v3' }

function settings(extra: Record<string, unknown> = {}) {
  return { ...BASE, ...extra }
}

test('the tool compares the provider against a frozen reference and never leaks state or secrets when nothing is reviewed', async () => {
  const seen: Array<{ body: string; auth: string | undefined }> = []
  const tool = createReferenceAgreementTool(
    () => settings({ apiKey: 'super-secret' }),
    async (_url, init) => {
      seen.push({
        body: String(init?.body),
        auth: (init?.headers as Record<string, string>).Authorization,
      })
      return Response.json({
        model: 'fixture-model',
        answers: { question: { type: 'noul', noul: 0.9 } },
      })
    },
  )
  const result = await tool.execute(
    {
      question: QUESTION,
      cases: [
        { id: 'clear', state: 'a precise diagnosis of pulmonary embolism', referenceAnswer: true },
        { id: 'vague', state: 'the patient is unwell', referenceAnswer: false },
      ],
      reference: REFERENCE,
      questionVersion: 'notes-v1',
    },
    ctx,
  )
  assert.equal(result.success, true, result.error)
  const report = JSON.parse(result.output!)
  assert.equal(report.advisory, true)
  assert.equal(report.active, false)
  assert.equal(report.metric.name, 'agreement')
  assert.equal(report.reference.model, 'main-model-x')
  assert.equal(report.question.version, 'notes-v1')
  assert.equal(report.aggregate.total, 2)
  assert.equal(report.aggregate.agreement, 0.5)
  assert.deepEqual(report.review.map((entry: { id: string }) => entry.id), ['vague'])
  assert.equal(seen.length, 2)
  for (const call of seen) {
    assert.equal(call.auth, 'Bearer super-secret', 'the credential only ever reaches the semantic provider')
  }
  // The reference answer never reaches the provider request either: only the
  // frozen state and the question are sent.
  assert.ok(!seen.some((call) => call.body.includes('referenceAnswer')))
  const serialized = result.output!
  assert.ok(!serialized.includes('pulmonary embolism'))
  assert.ok(!serialized.includes('patient is unwell'))
  assert.ok(!serialized.includes('super-secret'))
  assert.ok(!serialized.includes('localhost'))
})

test('a missing provenance record or a leaked semantic answer fails before any provider call', async () => {
  let calls = 0
  const tool = createReferenceAgreementTool(
    () => settings(),
    async () => {
      calls++
      return Response.json({ answers: {} })
    },
  )
  for (const args of [
    { question: QUESTION, cases: [{ id: 'a', state: 's', referenceAnswer: true }] },
    { question: QUESTION, reference: { source: 'llm', promptVersion: 'v1' }, cases: [] },
    {
      question: QUESTION,
      reference: REFERENCE,
      cases: [{ id: 'a', state: 's', referenceAnswer: true, answer: { type: 'noul', probability: 0.9 } }],
    },
    { question: QUESTION, reference: REFERENCE, cases: [{ id: 'a', state: 's' }], extra: 1 },
  ]) {
    const result = await tool.execute(args as never, ctx)
    assert.equal(result.success, false, JSON.stringify(args))
    assert.equal(JSON.parse(result.error!).code, 'invalid_arguments')
  }
  assert.equal(calls, 0)
})

test('a provider failure is reported per case and never becomes agreement', async () => {
  const tool = createReferenceAgreementTool(
    () => settings(),
    async (_url, init) => {
      const state = String(JSON.parse(String(init?.body)).state)
      if (state === 'boom') return new Response('token=leak', { status: 503 })
      // The shared adapter rejects a malformed answer for the whole payload, so
      // over the wire it is an explicit provider error, not a silent match.
      if (state === 'garbage') return Response.json({ answers: { question: { type: 'noul', noul: 7 } } })
      return Response.json({ model: 'fixture-model', answers: { question: { type: 'noul', noul: 0.9 } } })
    },
  )
  const result = await tool.execute(
    {
      question: QUESTION,
      reference: REFERENCE,
      cases: [
        { id: 'ok', state: 'sa', referenceAnswer: true },
        { id: 'boom', state: 'boom', referenceAnswer: true },
        { id: 'garbage', state: 'garbage', referenceAnswer: true },
      ],
    },
    ctx,
  )
  assert.equal(result.success, true)
  const report = JSON.parse(result.output!)
  assert.equal(report.aggregate.total, 3)
  assert.equal(report.aggregate.answered, 1)
  assert.equal(report.aggregate.agreed, 1)
  assert.equal(report.aggregate.errors, 2)
  assert.equal(report.aggregate.malformed, 0)
  // Neither failure became an agreement, and both are first-class review items.
  assert.deepEqual(report.review.map((entry: { id: string }) => entry.id), ['boom', 'garbage'])
  for (const entry of report.review) {
    assert.equal(entry.observed, null)
    assert.equal(entry.reason, 'provider_error')
    assert.ok(entry.error)
  }
  assert.ok(!result.output!.includes('leak'))
})

test('blocked remote egress and cancellation fail the tool instead of sending frozen states', async () => {
  let calls = 0
  const blocked = createReferenceAgreementTool(
    () => settings({ endpoint: 'https://provider.example/v1/systemone', endpointClass: 'remote', egressPolicy: 'block-remote-all' }),
    async () => {
      calls++
      return Response.json({ answers: {} })
    },
  )
  const egress = await blocked.execute(
    { question: QUESTION, reference: REFERENCE, cases: [{ id: 'a', state: 'private', referenceAnswer: true }] },
    ctx,
  )
  assert.equal(egress.success, false)
  assert.equal(JSON.parse(egress.error!).code, 'egress_blocked')
  assert.ok(!egress.error!.includes('provider.example'))
  assert.equal(calls, 0)

  const controller = new AbortController()
  controller.abort()
  const cancelled = createReferenceAgreementTool(() => settings())
  const result = await cancelled.execute(
    { question: QUESTION, reference: REFERENCE, cases: [{ id: 'a', state: 's', referenceAnswer: true }] },
    { ...ctx, signal: controller.signal },
  )
  assert.equal(result.success, false)
  assert.equal(JSON.parse(result.error!).code, 'aborted')
})

test('the plugin adds no second LLM client, no new setting and no new outbound call site', async () => {
  // Provenance: the reference crosses a caller boundary, so nothing in src/ may
  // call a chat-completions style LLM API of its own.
  // Anchored to the test file, not process.cwd(), so the guard still inspects
  // the real sources when the runner is started from another directory.
  const srcDir = resolve(import.meta.dirname, '../src')
  // Recursive: an LLM client would live in a subdirectory (providers, decision,
  // calibration), so a top-level-only scan would inspect nothing that matters.
  const entries = await readdir(srcDir, { recursive: true })
  const files = entries.filter((entry) => entry.endsWith('.ts'))
  // A floor, so a future change that breaks the walk fails loudly instead of
  // passing on a partial or empty list.
  assert.ok(files.length >= 30, `only ${files.length} source files scanned, the walk is incomplete`)
  const sources = new Map<string, string>()
  for (const entry of files) {
    sources.set(entry, await readFile(resolve(srcDir, entry), 'utf8'))
  }
  for (const [name, text] of sources) {
    assert.ok(
      !/chat\/completions|messages:\s*\[|openai|anthropic/i.test(text),
      `${name} must not contain a second LLM client`,
    )
  }
  // No new credential or endpoint setting: the settings schema is untouched.
  assert.deepEqual(
    SETTINGS.fields.map((field) => field.key),
    [
      'backend',
      'endpoint',
      'model',
      'runtimeVersion',
      'calibrationProfileJson',
      'calibrationOverridesJson',
      'apiKey',
      'timeoutMs',
      'endpointClass',
      'egressPolicy',
      'cacheEnabled',
      'cacheTtlMs',
      'cacheMaxEntries',
    ],
  )
})

test('both calibration tools share one wrapper implementation, not a copy', async () => {
  // The hazard these had was DRIFT, not size: two copies each encoded the
  // egress origin, the runtimeVersion trim, the question schema and the
  // secret-hygiene error echo, and nothing failed when a fix reached one and
  // not the other. They are now specs over one shared builder.
  const [referenceTool, questionTool] = await Promise.all([
    import('../src/calibration/reference-tool.ts'),
    import('../src/calibration/question-tool.ts'),
  ])
  // The builders produce the same object shape from different specs.
  const ctxSettings = { backend: 'custom', endpoint: 'http://localhost/v1/systemone', model: 'fixture-model' }
  const a = referenceTool.createReferenceAgreementTool(() => ctxSettings)
  const b = questionTool.createQuestionCalibrationTool(() => ctxSettings)
  assert.equal(a.name, 'semantic_reference_agreement')
  assert.equal(b.name, 'semantic_question_calibration')
  // Identical question sub-schema, by shared reference rather than by copy:
  // the tool JSON Schemas must not merely be equal, they must be the same node.
  const { QUESTION_SCHEMA } = await import('../src/calibration/calibration-tool.ts')
  assert.equal((a.parameters as never as { properties: { question: unknown } }).properties.question, QUESTION_SCHEMA)
  assert.equal((b.parameters as never as { properties: { question: unknown } }).properties.question, QUESTION_SCHEMA)
  // Both close over the one shared egress/error path.
  const shared = await import('../src/calibration/calibration-tool.ts')
  assert.equal(typeof shared.createCalibrationTool, 'function')
  // The shared source holds exactly one of each; the two question-calibration
  // wrappers hold none, so a fix cannot reach one tool and miss the other.
  // `candidate-tool.ts` is excluded: it takes no state and calls no provider.
  const files = await readdir(resolve(import.meta.dirname, '../src/calibration'))
  assert.ok(files.includes('calibration-tool.ts'), 'the shared builder must exist')
  const wrappers = files.filter(
    (f) => (f === 'question-tool.ts' || f === 'reference-tool.ts'),
  )
  assert.deepEqual(wrappers.sort(), ['question-tool.ts', 'reference-tool.ts'])
  const sources = await Promise.all(
    wrappers.map((f) => readFile(resolve(import.meta.dirname, '../src/calibration', f), 'utf8')),
  )
  for (const text of sources) {
    assert.ok(!text.includes('new SystemOneHttpProvider'), 'a tool wrapper must not build its own provider')
    assert.ok(!text.includes("origin: '"), 'a tool wrapper must not encode its own egress origin')
    assert.ok(
      !text.includes('Invalid arguments or unavailable plugin settings'),
      'a tool wrapper must not duplicate the error echo',
    )
    assert.ok(!text.includes("type: 'enum',"), 'a tool wrapper must not redefine the question schema')
  }
  // And the shared builder really does hold exactly one of each.
  const sharedSource = await readFile(resolve(import.meta.dirname, '../src/calibration/calibration-tool.ts'), 'utf8')
  assert.equal(sharedSource.split('new SystemOneHttpProvider').length - 1, 1)
  assert.equal(sharedSource.split("origin: 'explicit'").length - 1, 1)
  assert.equal(sharedSource.split('Invalid arguments or unavailable plugin settings').length - 1, 1)
})

test('the registered tool is wired to the global settings reader', async () => {
  const { register } = await import('../src/index.ts')
  const { fakeRegistry } = await import('./helpers/registry.ts')
  const fake = fakeRegistry()
  register(fake.registry)
  const tool = fake.tools.get('semantic_reference_agreement')
  assert.ok(tool, 'the reference agreement tool must be registered')
  const result = await tool!.execute(
    { question: QUESTION, reference: REFERENCE, cases: [{ id: 'a', state: 's', referenceAnswer: true }] },
    ctx,
  )
  // The fake registry has no endpoint configured, so the failure must be the
  // controlled configuration error and never an unhandled exception.
  assert.equal(result.success, false)
  assert.equal(JSON.parse(result.error!).code, 'configuration')
})
