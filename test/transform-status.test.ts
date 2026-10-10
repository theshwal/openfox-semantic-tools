import assert from 'node:assert/strict'
import test from 'node:test'

import type { PluginMessageTransformContext } from 'openfox/plugin'

import { createContextTransform } from '../src/transform/index.ts'
import { createTransformStatusTool } from '../src/transform/status-tool.ts'
import { TransformStatusStore, readTransformMetadata } from '../src/transform/status.ts'

const context: PluginMessageTransformContext = {
  sessionId: 's1',
  workdir: '/tmp/project',
  model: 'test-model',
  systemPrompt: 'system prompt',
}

const user = (text: string) => ({ role: 'user', content: text })
const assistant = (text: string) => ({ role: 'assistant', content: text })
const withHistory = () => [
  user('stale ask'),
  assistant('stale answer'),
  user('current request'),
  assistant('reply being composed'),
]

const keepAll: typeof fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> }
  const answers: Record<string, unknown> = {}
  for (const id of Object.keys(body.questions)) {
    answers[id] = { type: 'noul', noul: 0.99, confidence: 0.9 }
  }
  return Response.json({ answers })
}

const dropHistory: typeof fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> }
  const answers: Record<string, unknown> = {}
  Object.keys(body.questions).forEach((id) => {
    answers[id] = { type: 'noul', noul: 0.01, confidence: 0.95 }
  })
  return Response.json({ answers })
}

// --- The metadata reader ---

test('metadata from another transform is ignored, not misread', () => {
  assert.equal(readTransformMetadata(undefined), null)
  assert.equal(readTransformMetadata({}), null)
  assert.equal(
    readTransformMetadata({ 'semantic.applied': true, 'semantic.reason': null }),
    null,
    'a transform that never claimed to be ours is not recorded as ours',
  )
})

test('unreadable numbers become null, never a fabricated zero', () => {
  const parsed = readTransformMetadata({
    'semantic.contextReduce': true,
    'semantic.applied': false,
    'semantic.reason': 'low_confidence',
    'semantic.segmentsOffered': 'many',
  })
  assert.ok(parsed)
  assert.equal(parsed.segmentsOffered, null, 'an unknown count is null, not 0')
  assert.equal(parsed.segmentsDropped, null)
  assert.equal(parsed.uncertain, null)
  // Issue #6's "estimated token effect" is recorded in CHARACTERS. A token
  // figure would need the host's tokenizer, which this plugin does not have.
  assert.equal(parsed.charsRemoved, null, 'an unknown size is null, not 0')
  assert.equal(parsed.droppedRoles, null)
})

test('an applied reduction records its size in characters, and never its content', async () => {
  const store = new TransformStatusStore()
  const transform = createContextTransform(
    () => ({ contextReduce: true, endpoint: 'http://127.0.0.1:1/v1/systemone', timeoutMs: 1000 }),
    dropHistory,
    store,
  )
  await transform.transform(withHistory(), context)
  const last = store.snapshot()[0]
  assert.ok(last?.applied)
  assert.ok((last.charsRemoved ?? 0) > 0, 'a real reduction must report a real size')
  assert.ok((last.charsAfter ?? 0) < (last.charsBefore ?? 0))
  assert.equal(
    last.charsRemoved,
    (last.charsBefore ?? 0) - (last.charsAfter ?? 0),
    'the reported removal must be exactly the difference',
  )
  // Roles are recorded; content never is.
  assert.deepEqual(last.droppedRoles, ['assistant', 'user'], 'roles are sorted, so the report is stable')
  const serialized = JSON.stringify(store.snapshot())
  assert.equal(serialized.includes('stale ask'), false, 'no message text in the status')
  assert.equal(serialized.includes('stale answer'), false)
})

test('no token count is invented where no tokenizer exists', async () => {
  const store = new TransformStatusStore()
  const transform = createContextTransform(
    () => ({ contextReduce: true, endpoint: 'http://127.0.0.1:1/v1/systemone', timeoutMs: 1000 }),
    dropHistory,
    store,
  )
  await transform.transform(withHistory(), context)
  const serialized = JSON.stringify(store.snapshot()).toLowerCase()
  // A token figure without the host tokenizer would be a guess presented as a
  // measurement. Characters only.
  assert.equal(serialized.includes('token'), false, 'no token estimate may be presented as measured')
})

test('the store records every outcome the transform produces', async () => {
  const store = new TransformStatusStore()
  const transform = createContextTransform(
    () => ({ contextReduce: false }),
    keepAll,
    store,
  )
  await transform.transform(withHistory(), context)
  const snapshot = store.snapshot()
  assert.equal(snapshot.length, 1)
  assert.equal(snapshot[0]?.reason, 'disabled')
  assert.equal(snapshot[0]?.applied, false)
  assert.equal(store.appliedTurns, 0)
})

test('the store counts applied turns and never stores content', async () => {
  const store = new TransformStatusStore()
  const transform = createContextTransform(
    () => ({ contextReduce: true, endpoint: 'http://127.0.0.1:1/v1/systemone', timeoutMs: 1000 }),
    dropHistory,
    store,
  )
  await transform.transform(withHistory(), context)
  await transform.transform(withHistory(), context)
  assert.equal(store.appliedTurns, 2)
  const serialized = JSON.stringify(store.snapshot())
  assert.equal(serialized.includes('stale ask'), false, 'no message content is retained')
  assert.equal(serialized.includes('current request'), false)
  assert.equal(serialized.includes('127.0.0.1'), false, 'no endpoint is retained')
})

test('the store is bounded so a long session cannot grow it without limit', async () => {
  const store = new TransformStatusStore()
  const transform = createContextTransform(
    () => ({ contextReduce: false }),
    keepAll,
    store,
  )
  for (let i = 0; i < 40; i += 1) await transform.transform(withHistory(), context)
  assert.ok(store.snapshot().length <= 20, `kept ${store.snapshot().length} entries`)
  // Newest first, so the most recent outcome is always available.
  assert.equal(store.snapshot()[0]?.reason, 'disabled')
})

test('a snapshot cannot mutate the store', () => {
  const store = new TransformStatusStore()
  store.record({ applied: true, reason: null, segmentsDropped: 1 })
  const snapshot = store.snapshot()
  snapshot[0]!.segmentsDropped = 999
  assert.equal(store.snapshot()[0]?.segmentsDropped, 1)
})

// --- The tool ---

test('the status tool reports the DEFER verdict and what the transform did', async () => {
  const store = new TransformStatusStore()
  const transform = createContextTransform(
    () => ({ contextReduce: true, endpoint: 'http://127.0.0.1:1/v1/systemone', timeoutMs: 1000 }),
    dropHistory,
    store,
  )
  await transform.transform(withHistory(), context)
  await transform.transform(withHistory(), context)

  const tool = createTransformStatusTool(store)
  const result = await tool.execute({}, { sessionId: 's', workdir: '/tmp' })
  assert.equal(result.success, true)
  const report = JSON.parse(result.output ?? '{}') as Record<string, any>

  // The tool must never read as an endorsement of the feature.
  assert.equal(report.verdict, 'DEFER')
  assert.equal(report.status, 'experimental-unmeasured')
  assert.equal(report.advisory, true)
  assert.equal(report.appliedTurns, 2)
  assert.equal(report.recordedTurns, 2)
  assert.equal(report.last.applied, true)
  assert.equal(report.last.segmentsDropped, 2)
})

test('the status tool explains why a turn was left unchanged', async () => {
  const store = new TransformStatusStore()
  // Disabled, so every recorded reason is `disabled`.
  const transform = createContextTransform(() => ({ contextReduce: false }), keepAll, store)
  await transform.transform(withHistory(), context)
  await transform.transform(withHistory(), context)

  const tool = createTransformStatusTool(store)
  const report = JSON.parse((await tool.execute({}, { sessionId: 's', workdir: '/tmp' })).output ?? '{}') as Record<string, any>
  // The PATTERN is what makes the signal useful, not just the last event.
  assert.deepEqual(report.reasonsSeen, ['disabled'])
  assert.equal(report.appliedTurns, 0)
})

test('the status tool reports an empty session honestly', async () => {
  const tool = createTransformStatusTool(new TransformStatusStore())
  const report = JSON.parse((await tool.execute({}, { sessionId: 's', workdir: '/tmp' })).output ?? '{}') as Record<string, any>
  assert.equal(report.appliedTurns, 0)
  assert.equal(report.recordedTurns, 0)
  // "Nothing recorded" is not the same as "nothing happened".
  assert.equal(report.last, null)
  assert.deepEqual(report.reasonsSeen, [])
})

test('the status tool contacts no provider', async () => {
  let contacted = false
  const transport: typeof fetch = async () => {
    contacted = true
    return Response.json({ answers: {} })
  }
  const store = new TransformStatusStore()
  const transform = createContextTransform(
    () => ({ contextReduce: true, endpoint: 'http://127.0.0.1:1/v1/systemone', timeoutMs: 1000 }),
    transport,
    store,
  )
  await transform.transform(withHistory(), context)
  contacted = false
  const tool = createTransformStatusTool(store)
  await tool.execute({}, { sessionId: 's', workdir: '/tmp' })
  assert.equal(contacted, false, 'reading the status must never call out')
})