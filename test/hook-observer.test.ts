import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  PluginHookEvent,
  PluginHookHandler,
  PluginHookPayload,
  PluginRegistry,
} from 'openfox/plugin'

import {
  OBSERVED_EVENTS,
  createHookObserver,
  type ObservedEvent,
} from '../src/hooks/observer.ts'
import { UsageLedger } from '../src/usage/ledger.ts'

/**
 * The hook contract.
 *
 * `PluginHookHandler` returns `void` upstream, so a handler physically cannot
 * accept, refuse or alter a tool call. These tests assert that structural fact
 * rather than trusting a comment: a handler that built a return value, branched
 * on a verdict, or rethrew would be able to interfere with a turn, and this is
 * the only place that says so mechanically.
 */

// Only events the 2.0.161 host actually emits. `docs/HOOK-PAYLOADS.md` records
// the measurement: five declared values are inert on this release, so a
// subscription to one of them would succeed silently and never fire.
const EMITTED: readonly PluginHookEvent[] = [
  'session.created',
  'turn.completed',
  'workflow.step.completed',
  'workflow.execution.changed',
  'task.completed',
  'message.created',
  'tool.completed',
  'criterion.updated',
  'context.compacted',
  'retry.triggered',
]

const NEVER_EMITTED: readonly PluginHookEvent[] = [
  'llm.completed',
  'provider.changed',
  'devserver.started',
  'devserver.stopped',
  'devserver.state.changed',
]

function payload(over: Partial<PluginHookPayload> = {}): PluginHookPayload {
  return {
    event: 'tool.completed',
    sessionId: 's1',
    timestamp: '2026-01-01T00:00:00.000Z',
    data: {},
    ...over,
  }
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'hook-observer-'))
}

test('only events the host actually emits are subscribed', async () => {
  const dir = await tempDir()
  try {
    const observer = createHookObserver()
    const registry = { registerHook() {} } as unknown as PluginRegistry
    observer.attach(registry)

    // The measured set, and nothing inert.
    assert.deepEqual([...OBSERVED_EVENTS].sort(), [...EMITTED].sort())
    for (const inert of NEVER_EMITTED) {
      assert.equal(
        (OBSERVED_EVENTS as readonly string[]).includes(inert),
        false,
        `${inert} is declared upstream but never emitted by 2.0.161`,
      )
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('every registered handler returns undefined, so it cannot decide anything', async () => {
  const dir = await tempDir()
  try {
    const observer = createHookObserver()
    const registered = new Map<PluginHookEvent, PluginHookHandler>()
    const registry = {
      registerHook(event: PluginHookEvent, handler: PluginHookHandler) {
        registered.set(event, handler)
      },
    } as unknown as PluginRegistry
    observer.attach(registry)

    assert.ok(registered.size >= 5, 'nothing to prove if no handler was registered')
    for (const [event, handler] of registered) {
      const result = await handler(payload({ event }))
      assert.equal(
        result,
        undefined,
        `${event} handler returned a value; a void handler has no decision channel`,
      )
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a payload with unexpected or hostile data is absorbed without throwing', async () => {
  const dir = await tempDir()
  try {
    const observer = createHookObserver()
    const handlers = new Map<PluginHookEvent, PluginHookHandler>()
    observer.attach({
      registerHook(event: PluginHookEvent, handler: PluginHookHandler) {
        handlers.set(event, handler)
      },
    } as unknown as PluginRegistry)

    const hostile: PluginHookPayload = payload({
      event: 'tool.completed',
      data: {
        anything: { nested: [1, 'two', null] },
        circular: undefined,
        text: 'arbitrary host-supplied content',
      },
    })
    // A handler that threw would propagate into the host's turn.
    for (const handler of handlers.values()) {
      await assert.doesNotReject(async () => handler(hostile))
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('observed counts accumulate per event and per session', async () => {
  const dir = await tempDir()
  try {
    const observer = createHookObserver()
    const handlers = new Map<PluginHookEvent, PluginHookHandler>()
    observer.attach({
      registerHook(event: PluginHookEvent, handler: PluginHookHandler) {
        handlers.set(event, handler)
      },
    } as unknown as PluginRegistry)

    await handlers.get('tool.completed')!(payload({ sessionId: 'a' }))
    await handlers.get('tool.completed')!(payload({ sessionId: 'b' }))
    await handlers.get('turn.completed')!(payload({ event: 'turn.completed', sessionId: 'a' }))

    const seen = observer.snapshot()
    const tools = seen.events.find((e: ObservedEvent) => e.event === 'tool.completed')
    assert.equal(tools?.count, 2)
    assert.equal(tools?.sessions, 2)
    const turns = seen.events.find((e: ObservedEvent) => e.event === 'turn.completed')
    assert.equal(turns?.count, 1)
    assert.equal(seen.advisory, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the observer stores counts and session ids only, never payload values', async () => {
  const dir = await tempDir()
  try {
    const observer = createHookObserver()
    const handlers = new Map<PluginHookEvent, PluginHookHandler>()
    observer.attach({
      registerHook(event: PluginHookEvent, handler: PluginHookHandler) {
        handlers.set(event, handler)
      },
    } as unknown as PluginRegistry)

    await handlers.get('tool.completed')!(
      payload({ sessionId: 'secret-session-id', data: { question: 'private repository content' } }),
    )

    const toolEntry = observer
    .snapshot()
    .events.find((e) => e.event === 'tool.completed')
    // The KEY `question` is recorded, on purpose: knowing that a key exists and
    // is a string is the whole point of the census. Its VALUE is not, and a
    // key name cannot carry repository text.
    assert.deepEqual(toolEntry?.dataKeyTypes.question, ['string'])
    // Neither the value nor the session id is retained.
    assert.equal(JSON.stringify(observer.snapshot()).includes('private repository content'), false)
    assert.equal(JSON.stringify(observer.snapshot()).includes('secret-session-id'), false)
    // The count survives, which is the whole point of the store.
    assert.equal(toolEntry?.count, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the compaction summary — the most sensitive payload the host sends — is never retained', async () => {
  // MEASURED, not assumed. Reading `dist/chunk-JNGNOZRQ.js` in the installed
  // 2.0.161 host shows `context.compacted` carries `summary`: the conversation
  // summary the host just wrote, plus window ids and sub-agent tags.
  //
  // This is the single most sensitive payload in the hook surface, because it
  // is a verbatim condensation of what the user said. The observer must note
  // that such a key EXISTS and is a string — so a reader can classify the risk —
  // without ever retaining it.
  const observer = createHookObserver()
  const handlers = new Map<PluginHookEvent, PluginHookHandler>()
  observer.attach({
    registerHook(event: PluginHookEvent, handler: PluginHookHandler) {
      handlers.set(event, handler)
    },
  } as unknown as PluginRegistry)

  const SECRET = 'the user said their password is hunter2 and the repo is /home/me/secret'
  await handlers.get('context.compacted')!(
    payload({
      event: 'context.compacted',
      data: {
        closedWindowId: 'w1',
        newWindowId: 'w2',
        beforeTokens: 10_000,
        afterTokens: 0,
        summary: SECRET,
        subAgentId: 'a1',
        subAgentType: 'review',
      },
    }),
  )

  const serialized = JSON.stringify(observer.snapshot())
  assert.equal(serialized.includes('hunter2'), false, 'the summary text must never be retained')
  assert.equal(serialized.includes('/home/me'), false, 'nor anything else it contains')
  assert.equal(serialized.includes('w1'), false, 'nor the window ids')

  // The KEY is reported, with its type: that is the whole point of the census.
  const entry = observer.snapshot().events.find((e) => e.event === 'context.compacted')
  assert.deepEqual(entry?.dataKeyTypes.summary, ['string'])
  assert.deepEqual(entry?.dataKeyTypes.beforeTokens, ['number'])
  assert.equal(entry?.count, 1, 'the event is still counted')
})

test('the census records which data keys arrived, keyed and typed, never valued', async () => {
  const dir = await tempDir()
  try {
    const observer = createHookObserver()
    const handlers = new Map<PluginHookEvent, PluginHookHandler>()
    observer.attach({
      registerHook(event: PluginHookEvent, handler: PluginHookHandler) {
        handlers.set(event, handler)
      },
    } as unknown as PluginRegistry)

    await handlers.get('tool.completed')!(
      payload({
        data: {
          toolName: 'semantic_search',
          durationMs: 42,
          ok: true,
          args: { query: 'private content' },
        },
      }),
    )

    const entry = observer.snapshot().events.find((e) => e.event === 'tool.completed')
    assert.deepEqual(entry?.dataKeyTypes['toolName'], ['string'])
    assert.deepEqual(entry?.dataKeyTypes['durationMs'], ['number'])
    assert.deepEqual(entry?.dataKeyTypes['ok'], ['boolean'])
    assert.deepEqual(entry?.dataKeyTypes['args'], ['object'])

    // The census is a schema record. The VALUE of `args` was never read into it.
    const serialized = JSON.stringify(observer.snapshot())
    assert.equal(serialized.includes('private content'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the census is what an unmeasured event stays: explicit, not absent', async () => {
  const dir = await tempDir()
  try {
    const observer = createHookObserver()
    // Before any traffic, every subscribed event is listed at zero. A consumer
    // must not have to distinguish "not seen" from "not observed".
    const snapshot = observer.snapshot()
    assert.equal(snapshot.events.length, OBSERVED_EVENTS.length)
    for (const entry of snapshot.events) {
      assert.equal(entry.count, 0)
      assert.equal(entry.measured, false)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an observed event is marked measured, and only then', async () => {
  const dir = await tempDir()
  try {
    const observer = createHookObserver()
    const handlers = new Map<PluginHookEvent, PluginHookHandler>()
    observer.attach({
      registerHook(event: PluginHookEvent, handler: PluginHookHandler) {
        handlers.set(event, handler)
      },
    } as unknown as PluginRegistry)

    await handlers.get('tool.completed')!(payload())
    const events = observer.snapshot().events
    const seen = events.find((e) => e.event === 'tool.completed')
    const unseen = events.find((e) => e.event === 'context.compacted')
    assert.equal(seen?.measured, true)
    assert.equal(unseen?.measured, false, 'an unobserved event must not claim to be measured')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the host observation and our usage ledger stay separate stores', async () => {
  // N2-9. The host already publishes its own tool statistics, and this plugin
  // publishes its own. Merging them would make both unverifiable: a reader
  // could no longer tell which counters came from where. So the separation is
  // asserted on the module graph, not merely observed to hold today.
  const [observerSource, ledgerSource] = await Promise.all([
    readFile(new URL('../src/hooks/observer.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/usage/ledger.ts', import.meta.url), 'utf8'),
  ])

  assert.equal(
    /from '\.\.\/(?:usage|hooks)\//.test(observerSource),
    false,
    'the observer must not read or write the usage ledger',
  )
  assert.equal(
    /from '\.\.\/hooks\//.test(ledgerSource),
    false,
    'the usage ledger must not read or write the observer',
  )

  // And the live consequence: a host event moves the observer's count and
  // nothing else, so no future edit could quietly fold the two together.
  const observer = createHookObserver()
  const handlers = new Map<PluginHookEvent, PluginHookHandler>()
  observer.attach({
    registerHook(event: PluginHookEvent, handler: PluginHookHandler) {
      handlers.set(event, handler)
    },
  } as unknown as PluginRegistry)

  const dir = await tempDir()
  try {
    const ledger = new UsageLedger(dir)
    const before = ledger.report().totalUsed
    await handlers.get('tool.completed')!(payload({ data: { toolName: 'x' } }))
    assert.equal(
      ledger.report().totalUsed,
      before,
      'a HOST event must never increment OUR usage counter',
    )
    assert.equal(observer.snapshot().events.find((e) => e.event === 'tool.completed')?.count, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
