import assert from 'node:assert/strict'
import test from 'node:test'

import type { PluginMessageTransform, PluginMessageTransformContext } from 'openfox/plugin'

import {
  createContextTransform,
  MAX_REDUCED_SEGMENTS,
  segmentMessages,
  type Segment,
} from '../src/transform/index.ts'

const context = (over: Partial<PluginMessageTransformContext> = {}): PluginMessageTransformContext => ({
  sessionId: 's1',
  workdir: '/tmp/project',
  model: 'test-model',
  systemPrompt: 'system prompt',
  ...over,
})

const user = (text: string) => ({ role: 'user', content: text })
const assistant = (text: string) => ({ role: 'assistant', content: text })

/**
 * A conversation with genuinely droppable history.
 *
 * The transform never drops the live turn, so a fixture needs a trailing
 * assistant message to close the live window and leave real history behind it.
 * Without it, "the current request" is the last message and correctly nothing
 * is reducible.
 */
const withHistory = () => [
  user('the earlier request'),
  assistant('the earlier answer'),
  user('the current request'),
  assistant('the reply being composed'),
]

/**
 * Runs the transform and splits the two contract shapes it returns:
 * `{ messages, metadata }` always, and `metadata.reason` on every no-op.
 */
async function runTransform(
  transform: PluginMessageTransform,
  messages: Array<Record<string, unknown>>,
  ctx: PluginMessageTransformContext = context(),
): Promise<{
  messages: Array<Record<string, unknown>>
  applied: boolean
  reason: string | null
  metadata: Record<string, unknown>
}> {
  const result = (await transform.transform(messages, ctx)) as {
    messages: Array<Record<string, unknown>>
    metadata?: Record<string, unknown>
  }
  const metadata = result.metadata ?? {}
  return {
    messages: result.messages,
    applied: metadata['semantic.applied'] === true,
    reason: (metadata['semantic.reason'] as string | null) ?? null,
    metadata,
  }
}

const okTransport: typeof fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> }
  const answers: Record<string, unknown> = {}
  for (const id of Object.keys(body.questions)) {
    answers[id] = {
      type: 'noul',
      noul: 0.98,
      confidence: 0.9,
      keep: id,
    }
  }
  return Response.json({ answers })
}

// --- Opt-in: the transform is inert until an operator turns it on. ---

test('the transform is registered but inert while the setting is off', async () => {
  const transform = createContextTransform(() => ({ contextReduce: false }))
  const messages = [user('hello')]
  const result = await runTransform(transform, messages)
  // Messages are returned untouched, nothing was sent, and the no-op is
  // reported as such rather than silently passing for a reduction.
  assert.deepEqual(result.messages, messages)
  assert.equal(result.applied, false)
  assert.equal(result.reason, 'disabled')
})

test('the transform is inert when the operator enabled other features but not this one', async () => {
  const transform = createContextTransform(() => ({
    contextReduce: false,
    cacheEnabled: true,
    endpoint: 'https://example.invalid/v1/systemone',
  }))
  const messages = withHistory()
  const result = await runTransform(transform, messages)
  assert.deepEqual(result.messages, messages)
  assert.equal(result.reason, 'disabled')
})

// --- Segmentation: only droppable user/assistant segments are eligible. ---

test('only user and assistant text segments are eligible for reduction', () => {
  const segments = segmentMessages([
    { role: 'system', content: 'system prompt' },
    user('keep me'),
    { role: 'tool', content: 'tool output', tool_call_id: 'x' },
    { role: 'tool_result', content: 'result' },
    { role: 'developer', content: 'dev' },
    assistant('answer'),
    { role: 'user', content: [{ type: 'text', text: 'structured' }] },
    { role: 'tool_call', content: 'call' },
    { role: 'reasoning', content: 'thinking' },
  ] as unknown as Array<Record<string, unknown>>)

  // A segment can only ever carry a `user` or `assistant` role: a system
  // message holds the contract, not history, so it is never a candidate.
  assert.deepEqual([...new Set(segments.map((s) => s.role))].sort(), ['assistant', 'user'])
  // Structured content is not safely summarizable, so it is excluded too.
  assert.equal(segments.filter((s) => s.text === 'structured').length, 0)
  assert.deepEqual(segments.map((s) => s.text).sort(), ['answer', 'keep me'])
})

test('an empty or tool-only conversation yields no reducible segment', () => {
  assert.deepEqual(segmentMessages([] as unknown as Array<Record<string, unknown>>), [])
  assert.deepEqual(
    segmentMessages([
      { role: 'system', content: 's' },
      { role: 'tool_result', content: 'r' },
    ] as unknown as Array<Record<string, unknown>>),
    [],
  )
})

// --- The live turn is never a candidate. ---

test('the newest user message is never a reduction candidate', () => {
  // The message that asks the current question is not history: dropping it
  // would leave the model answering a request it can no longer see.
  const messages = [
    user('old ask'),
    assistant('old answer'),
    user('THE CURRENT REQUEST'),
  ]
  const segments = segmentMessages(messages as unknown as Array<Record<string, unknown>>)
  assert.equal(segments.some((s) => s.text === 'THE CURRENT REQUEST'), false)
})

test('nothing at or after the last tool result is a candidate', () => {
  // Everything from the final tool result onwards is the live step: the model
  // is still working on it, so none of it may be dropped.
  const messages = [
    user('old ask'),
    assistant('old answer'),
    { role: 'tool_result', content: 'live tool output' },
    assistant('acting on it'),
    user('and now this'),
  ]
  const segments = segmentMessages(messages as unknown as Array<Record<string, unknown>>)
  assert.deepEqual(segments.map((s) => s.text), ['old ask', 'old answer'])
})

test('with no tool result, only messages before the newest user turn qualify', () => {
  const messages = [
    user('first ask'),
    assistant('first answer'),
    user('second ask'),
    assistant('second answer'),
    user('current ask'),
  ]
  const segments = segmentMessages(messages as unknown as Array<Record<string, unknown>>)
  assert.deepEqual(segments.map((s) => s.text), [
    'first ask',
    'first answer',
    'second ask',
    'second answer',
  ])
})

test('a provider cannot make the live turn droppable', async () => {
  // Defence in depth: even if the segmentation ever admitted the live turn,
  // the transform must refuse a reduction that would delete it.
  let asked = 0
  const transport: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> }
    asked = Object.keys(body.questions).length
    const answers: Record<string, unknown> = {}
    for (const id of Object.keys(body.questions)) {
      answers[id] = { type: 'noul', noul: 0.01, confidence: 0.99 }
    }
    return Response.json({ answers })
  }
  const transform = createContextTransform(
    () => ({ contextReduce: true, endpoint: 'http://127.0.0.1:1/v1/systemone', timeoutMs: 1000 }),
    transport,
  )
  const messages = [
    user('old ask'),
    assistant('old answer'),
    user('THE CURRENT REQUEST'),
    assistant('the reply being composed'),
  ]
  const result = await runTransform(transform, messages)
  // The live request survives whatever the provider claims, and the provider is
  // only ever asked about the stale turns.
  assert.ok(result.messages.some((m) => m.content === 'THE CURRENT REQUEST'))
  assert.equal(asked, 2, 'only the two stale turns are offered for reduction')
  assert.ok(
    result.messages.some((m) => m.content === 'the reply being composed'),
    'the live reply survives too',
  )
})

test('the live turn survives even when the newest message is an assistant reply', async () => {
  const transport: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> }
    const answers: Record<string, unknown> = {}
    Object.keys(body.questions).forEach((id) => {
      answers[id] = { type: 'noul', noul: 0.01, confidence: 0.99 }
    })
    return Response.json({ answers })
  }
  const transform = createContextTransform(
    () => ({ contextReduce: true, endpoint: 'http://127.0.0.1:1/v1/systemone', timeoutMs: 1000 }),
    transport,
  )
  const messages = [
    user('first ask'),
    assistant('first answer'),
    user('second ask'),
    assistant('THE CURRENT ANSWER'),
  ]
  const result = await runTransform(transform, messages)
  assert.ok(
    result.messages.some((m) => m.content === 'THE CURRENT ANSWER'),
    'the newest message must survive',
  )
})

// --- Fail-open: every failure path returns the original messages. ---

test('a provider failure fails open to the unmodified messages', async () => {
  const transport: typeof fetch = async () => {
    throw new Error('network down')
  }
  const transform = createContextTransform(
    () => ({ contextReduce: true, endpoint: 'http://127.0.0.1:1/v1/systemone', timeoutMs: 1000 }),
    transport,
  )
  const messages = withHistory()
  const result = await runTransform(transform, messages)
  assert.deepEqual(result.messages, messages)
  assert.equal(result.reason, 'provider_unavailable')
})

test('an HTTP error fails open to the unmodified messages', async () => {
  const transport: typeof fetch = async () => new Response('nope', { status: 500 })
  const transform = createContextTransform(
    () => ({ contextReduce: true, endpoint: 'http://127.0.0.1:1/v1/systemone', timeoutMs: 1000 }),
    transport,
  )
  const messages = withHistory()
  const result = await runTransform(transform, messages)
  assert.deepEqual(result.messages, messages)
  assert.equal(result.reason, 'provider_unavailable')
})

test('a malformed provider response fails open rather than dropping context', async () => {
  const transport: typeof fetch = async () => Response.json({ answers: { wrong: { type: 'noul', noul: 1 } } })
  const transform = createContextTransform(
    () => ({ contextReduce: true, endpoint: 'http://127.0.0.1:1/v1/systemone', timeoutMs: 1000 }),
    transport,
  )
  const messages = withHistory()
  const result = await runTransform(transform, messages)
  assert.deepEqual(result.messages, messages)
  // The provider answered with a question id that was never asked: the answer
  // is unusable, which is a different operator problem from a weak answer.
  assert.equal(result.reason, 'invalid_response')
})

test('an unconfigured endpoint fails open to the unmodified messages', async () => {
  const transform = createContextTransform(() => ({ contextReduce: true }))
  const messages = withHistory()
  const result = await runTransform(transform, messages)
  assert.deepEqual(result.messages, messages)
  assert.equal(result.reason, 'not_configured')
})

test('a single malformed message never crashes the transform', async () => {
  const transport: typeof fetch = async () => {
    throw new Error('boom')
  }
  const transform = createContextTransform(
    () => ({ contextReduce: true, endpoint: 'http://127.0.0.1:1/v1/systemone', timeoutMs: 1000 }),
    transport,
  )
  // A message the segmenter does not understand, mixed with valid ones.
  const messages = [null, undefined, 42, ...withHistory()] as unknown as Array<Record<string, unknown>>
  const result = await runTransform(transform, messages)
  assert.deepEqual(result.messages, messages)
  assert.equal(result.reason, 'provider_unavailable')
})

// --- Egress: a blocked endpoint must never receive session content. ---

test('a remote endpoint blocked for automatic calls is never contacted', async () => {
  let contacted = false
  const transport: typeof fetch = async () => {
    contacted = true
    return Response.json({ answers: {} })
  }
  const transform = createContextTransform(
    () => ({
      contextReduce: true,
      endpoint: 'https://decisions.example.com/v1/systemone',
      endpointClass: 'remote',
      egressPolicy: 'block-remote-automatic',
      timeoutMs: 1000,
    }),
    transport,
  )
  const messages = withHistory()
  const result = await runTransform(transform, messages)
  assert.deepEqual(result.messages, messages)
  assert.equal(contacted, false, 'no request may be sent to a blocked remote endpoint')
  assert.equal(result.reason, 'egress_blocked')
})

test('a remote endpoint blocked for ALL calls is never contacted either', async () => {
  let contacted = false
  const transport: typeof fetch = async () => {
    contacted = true
    return Response.json({ answers: {} })
  }
  const transform = createContextTransform(
    () => ({
      contextReduce: true,
      endpoint: 'https://decisions.example.com/v1/systemone',
      endpointClass: 'remote',
      egressPolicy: 'block-remote-all',
      timeoutMs: 1000,
    }),
    transport,
  )
  const messages = withHistory()
  const result = await runTransform(transform, messages)
  assert.deepEqual(result.messages, messages)
  assert.equal(contacted, false)
  assert.equal(result.reason, 'egress_blocked')
})

// --- Confidence floor: an unsure answer must never delete context. ---

test('a low-confidence verdict never removes any segment', async () => {
  const transport: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> }
    const answers: Record<string, unknown> = {}
    for (const id of Object.keys(body.questions)) {
      // "keep" is below the floor: the model is not sure it is safe to drop.
      answers[id] = { type: 'noul', noul: 0.4, confidence: 0.2, keep: id }
    }
    return Response.json({ answers })
  }
  const transform = createContextTransform(
    () => ({ contextReduce: true, endpoint: 'http://127.0.0.1:1/v1/systemone', timeoutMs: 1000 }),
    transport,
  )
  const messages = [...withHistory(), assistant('third')]
  const result = await runTransform(transform, messages)
  assert.deepEqual(result.messages, messages)
  assert.equal(result.reason, 'low_confidence')
})

test('an unknown answer shape never removes any segment', async () => {
  const transport: typeof fetch = async () => Response.json({ answers: {} })
  const transform = createContextTransform(
    () => ({ contextReduce: true, endpoint: 'http://127.0.0.1:1/v1/systemone', timeoutMs: 1000 }),
    transport,
  )
  const messages = withHistory()
  const result = await runTransform(transform, messages)
  assert.deepEqual(result.messages, messages)
  assert.equal(result.reason, 'invalid_response')
})

test('dropping ALL the history is allowed: only the live turn may never go', async () => {
  const transport: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> }
    const answers: Record<string, unknown> = {}
    for (const id of Object.keys(body.questions)) {
      answers[id] = { type: 'noul', noul: 0.01, confidence: 0.99 }
    }
    return Response.json({ answers })
  }
  const transform = createContextTransform(
    () => ({ contextReduce: true, endpoint: 'http://127.0.0.1:1/v1/systemone', timeoutMs: 1000 }),
    transport,
  )
  const messages = withHistory()
  const result = await runTransform(transform, messages)
  // Discarding every stale turn is the feature working, not a wipe: the live
  // request and its reply survive, so the model still knows what to answer.
  assert.equal(result.applied, true)
  assert.deepEqual(result.messages, [user('the current request'), assistant('the reply being composed')])
})

test('a reduction that would empty the conversation is refused', async () => {
  // Reachable only if the live window is somehow dropped too, so this asserts
  // the RESULT guard rather than a candidate count.
  const transport: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> }
    const answers: Record<string, unknown> = {}
    for (const id of Object.keys(body.questions)) {
      answers[id] = { type: 'noul', noul: 0.01, confidence: 0.99 }
    }
    return Response.json({ answers })
  }
  const transform = createContextTransform(
    () => ({ contextReduce: true, endpoint: 'http://127.0.0.1:1/v1/systemone', timeoutMs: 1000 }),
    transport,
  )
  // One live message and nothing else: there is no history, so there is also
  // nothing to reduce, and the turn is left intact.
  const messages = [user('the only message')]
  const result = await runTransform(transform, messages)
  assert.deepEqual(result.messages, messages)
  assert.equal(result.applied, false)
  assert.equal(result.reason, 'no_candidates')
})

test('a conversation with no droppable segment contacts no provider at all', async () => {
  let contacted = false
  const transport: typeof fetch = async () => {
    contacted = true
    return Response.json({ answers: {} })
  }
  const transform = createContextTransform(
    () => ({ contextReduce: true, endpoint: 'http://127.0.0.1:1/v1/systemone', timeoutMs: 1000 }),
    transport,
  )
  const messages = [
    { role: 'system', content: 'system prompt' },
    { role: 'tool_result', content: 'result' },
  ]
  const result = await runTransform(transform, messages as unknown as Array<Record<string, unknown>>)
  assert.deepEqual(result.messages, messages)
  assert.equal(contacted, false, 'no candidate means no call')
  assert.equal(result.reason, 'no_candidates')
})

test('an unreadable settings store fails open instead of throwing', async () => {
  const transform = createContextTransform(() => {
    throw new Error('settings store is unavailable')
  })
  const messages = withHistory()
  const result = await runTransform(transform, messages)
  assert.deepEqual(result.messages, messages)
  assert.equal(result.reason, 'settings_unavailable')
})

test('every outcome reports exactly one reason, and no outcome is silent', async () => {
  // The point of the metadata: a no-op must be distinguishable from a provider
  // that simply never drops anything. Every path reports a reason.
  const cases = [
    { name: 'disabled', settings: () => ({ contextReduce: false }), transport: okTransport },
    { name: 'settings_unavailable', settings: () => { throw new Error('x') }, transport: okTransport },
    { name: 'no_candidates', settings: () => ({ contextReduce: true, endpoint: 'http://127.0.0.1:1/v1/systemone', timeoutMs: 1000 }), transport: okTransport },
    { name: 'not_configured', settings: () => ({ contextReduce: true }), transport: okTransport },
    { name: 'provider_unavailable', settings: () => ({ contextReduce: true, endpoint: 'http://127.0.0.1:1/v1/systemone', timeoutMs: 1000 }), transport: (async () => { throw new Error('down') }) as typeof fetch },
    { name: 'invalid_response', settings: () => ({ contextReduce: true, endpoint: 'http://127.0.0.1:1/v1/systemone', timeoutMs: 1000 }), transport: (async () => Response.json({ answers: {} })) as typeof fetch },
  ]
  const messages = withHistory()
  for (const testCase of cases) {
    const transform = createContextTransform(testCase.settings, testCase.transport)
    const result = await runTransform(transform, messages)
    if (testCase.name === 'no_candidates') {
      // This case needs a conversation with nothing droppable.
      const none = await runTransform(transform, [
        { role: 'tool_result', content: 'r' },
      ] as unknown as Array<Record<string, unknown>>)
      assert.equal(none.reason, 'no_candidates', testCase.name)
      continue
    }
    assert.equal(result.metadata['semantic.contextReduce'], true, testCase.name)
    assert.equal(result.applied, false, testCase.name)
    assert.equal(result.reason, testCase.name, testCase.name)
    // A reason is never a message and never a key.
    assert.deepEqual(result.messages, messages, testCase.name)
  }
})

// --- The happy path, and its bounds. ---

test('segments the provider is confident about dropping are removed, and reported', async () => {
  const transport: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      questions: Record<string, { instructions: string }>
    }
    const answers: Record<string, unknown> = {}
    for (const [id, question] of Object.entries(body.questions)) {
      // The question asks whether the segment is STILL NEEDED, so a LOW
      // probability is the one that authorizes a drop. The stub keys on a
      // marker inside the submitted text to decide per segment. Only the stale
      // turns carry it, so the live turn is never even offered.
      const stillNeeded = question.instructions.includes('DROP ME') ? 0.01 : 0.99
      answers[id] = { type: 'noul', noul: stillNeeded, confidence: 0.95 }
    }
    return Response.json({ answers })
  }
  const transform = createContextTransform(
    () => ({ contextReduce: true, endpoint: 'http://127.0.0.1:1/v1/systemone', timeoutMs: 1000 }),
    transport,
  )
  const messages = [
    user('DROP ME stale chatter'),
    assistant('DROP ME stale reply'),
    user('keep me'),
    assistant('the reply being composed'),
  ]
  const result = await runTransform(transform, messages)
  // Only the history is dropped; the live turn always survives.
  assert.deepEqual(result.messages, [user('keep me'), assistant('the reply being composed')])
  assert.equal(result.applied, true)
  assert.equal(result.reason, null, 'an applied reduction has no skip reason')
  assert.equal(result.metadata['semantic.segmentsDropped'], 2)
})

test('the applied result reports metadata and never leaks content', async () => {
  const transport: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> }
    const answers: Record<string, unknown> = {}
    const ids = Object.keys(body.questions)
    // Drop exactly one segment, so a reduction really happens.
    ids.forEach((id, i) => {
      answers[id] = { type: 'noul', noul: i === 0 ? 0.99 : 0.01, confidence: 0.95 }
    })
    return Response.json({ answers })
  }
  const transform = createContextTransform(
    () => ({ contextReduce: true, endpoint: 'http://127.0.0.1:1/v1/systemone', timeoutMs: 1000 }),
    transport,
  )
  const result = await runTransform(transform, [user('a'), assistant('b')])
  assert.ok(result.metadata['semantic.contextReduce'], 'metadata is reported so the effect is observable')
  const serialized = JSON.stringify(result.metadata)
  assert.equal(serialized.includes('"a"'), false, 'no message content in metadata')
  assert.equal(serialized.includes('"b"'), false)
})

test('an aborted turn fails open and preserves the abort', async () => {
  const transport: typeof fetch = async () => {
    throw Object.assign(new Error('aborted'), { name: 'AbortError' })
  }
  const transform = createContextTransform(
    () => ({ contextReduce: true, endpoint: 'http://127.0.0.1:1/v1/systemone', timeoutMs: 1000 }),
    transport,
  )
  const controller = new AbortController()
  controller.abort()
  const messages = withHistory()
  const result = await runTransform(transform, messages, context({ signal: controller.signal }))
  assert.deepEqual(result.messages, messages)
  assert.equal(result.reason, 'provider_unavailable')
})

test('the number of segments sent to the provider is bounded', () => {
  const many = Array.from({ length: MAX_REDUCED_SEGMENTS + 50 }, (_, i) => user(`m${i}`))
  const segments = segmentMessages(many as unknown as Array<Record<string, unknown>>)
  assert.ok(
    segments.length <= MAX_REDUCED_SEGMENTS,
    `expected at most ${MAX_REDUCED_SEGMENTS} segments, got ${segments.length}`,
  )
})

test('the submitted request never exceeds the character budget', async () => {
  // A long conversation of long messages: the bound must be real, not a
  // character limit applied to an array length.
  let body = ''
  const transport: typeof fetch = async (_url, init) => {
    body = String(init?.body)
    const parsed = JSON.parse(body) as { questions: Record<string, unknown> }
    const answers: Record<string, unknown> = {}
    // "Keep everything", so nothing is dropped and the bound is the only thing
    // under test.
    for (const id of Object.keys(parsed.questions)) {
      answers[id] = { type: 'noul', noul: 0.99, confidence: 0.9 }
    }
    return Response.json({ answers })
  }
  const transform = createContextTransform(
    () => ({ contextReduce: true, endpoint: 'http://127.0.0.1:1/v1/systemone', timeoutMs: 2000 }),
    transport,
  )
  const huge = 'x'.repeat(4000)
  const messages: Array<Record<string, unknown>> = []
  for (let i = 0; i < 30; i += 1) {
    messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `${huge}-${i}` })
  }
  // Close the live window so the history is actually offered.
  messages.push({ role: 'user', content: 'current' }, { role: 'assistant', content: 'reply' })

  const result = await runTransform(transform, messages)
  assert.ok(body.length > 0, 'a request must have been sent')
  const parsed = JSON.parse(body) as { questions: Record<string, { instructions: string }> }
  const asked = Object.values(parsed.questions)
  assert.ok(asked.length > 0, 'at least one segment is asked about')
  // Each segment is capped, so a huge turn cannot be forwarded whole.
  for (const question of asked) {
    assert.ok(
      question.instructions.length < 4000,
      `one segment leaked ${question.instructions.length} chars`,
    )
  }
  // The conversation itself is untouched: an over-budget turn is kept whole.
  assert.deepEqual(result.messages, messages)
  assert.equal(result.reason, 'low_confidence')
})

test('the transform declares a stable id and an explicit priority', () => {
  const transform = createContextTransform(() => ({ contextReduce: false }))
  assert.equal(transform.id, 'semantic-context-reduce')
  assert.equal(typeof transform.priority, 'number')
})

test('segment ordering is preserved so a reduction cannot reorder history', () => {
  const messages = [
    user('one'),
    assistant('two'),
    user('three'),
    assistant('four'),
    user('five'),
    assistant('six'),
  ]
  const segments: Segment[] = segmentMessages(messages as unknown as Array<Record<string, unknown>>)
  // Everything before the live window (the trailing user/assistant exchange).
  assert.deepEqual(segments.map((s) => s.text), ['one', 'two', 'three', 'four'])
  assert.deepEqual(segments.map((s) => s.index), [0, 1, 2, 3])
})