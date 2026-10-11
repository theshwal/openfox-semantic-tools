import assert from 'node:assert/strict'
import test from 'node:test'

import type { PluginHookEvent, PluginHookHandler, PluginHookPayload, PluginRegistry } from 'openfox/plugin'

import { createHookObserver, type HookObserver } from '../src/hooks/observer.ts'
import { TransformStatusStore } from '../src/transform/status.ts'
import { createTransformStatusTool } from '../src/transform/status-tool.ts'

/**
 * Host compaction versus ours.
 *
 * The 2.0.161 host measures its own compaction — `CompactionEventRecord`
 * carries `beforeTokens`, `afterTokens`, `reduction` and `reductionPercent`.
 * Two risks follow, and both are structural rather than editorial:
 *
 *  1. attribution — our transform must never claim a reduction it did not make;
 *  2. silence — with `contextReduce` off, a host compaction must cost nothing.
 *
 * The second is the dangerous one. A plugin that woke up on
 * `context.compacted` would spend a provider call on a feature the operator
 * explicitly turned off.
 */

/** A hook payload shaped like the host's own `CompactionEventRecord`. */
function hostCompaction(event: PluginHookEvent): PluginHookPayload {
  return {
    event,
    sessionId: 's1',
    timestamp: '2026-01-01T00:00:00.000Z',
    data: {
      beforeTokens: 10_000,
      afterTokens: 4_000,
      reduction: 6_000,
      reductionPercent: 60,
    },
  }
}

function harness(): { observer: HookObserver; emit: (event: PluginHookEvent) => void } {
  const observer = createHookObserver()
  const handlers = new Map<PluginHookEvent, PluginHookHandler>()
  observer.attach({
    registerHook(event: PluginHookEvent, handler: PluginHookHandler) {
      handlers.set(event, handler)
    },
  } as unknown as PluginRegistry)

  return {
    observer,
    emit(event) {
      handlers.get(event)!(hostCompaction(event))
    },
  }
}

async function readStatus(store: TransformStatusStore): Promise<Record<string, unknown>> {
  const tool = createTransformStatusTool(store)
  const result = await tool.execute({}, { sessionId: 's1', workdir: process.cwd() })
  return JSON.parse(result.output!) as Record<string, unknown>
}

test('a host compaction is observed as the HOST s, never as ours', () => {
  const { observer, emit } = harness()
  emit('context.compacted')

  const entry = observer.snapshot().events.find((e) => e.event === 'context.compacted')
  assert.equal(entry?.count, 1, 'the host event is seen')
  assert.equal(entry?.measured, true)
  assert.equal(
    entry?.attributedTo,
    'host',
    'the reduction belongs to the host; nothing here claims the plugin made it',
  )
})

test('the census records the host reduction figure as a number, keyed but not valued', () => {
  const { observer, emit } = harness()
  emit('context.compacted')

  const entry = observer.snapshot().events.find((e) => e.event === 'context.compacted')
  assert.deepEqual(entry?.dataKeyTypes.reductionPercent, ['number'])
  assert.deepEqual(entry?.dataKeyTypes.beforeTokens, ['number'])
  assert.equal(JSON.stringify(observer.snapshot()).includes('"60"'), false)
})

test('a host compaction never increments our transform counters', async () => {
  // The observer and the transform status are wired together by `register()`,
  // so the test wires them the same way rather than asserting on two objects
  // that were never connected.
  const { observer, emit } = harness()
  const store = new TransformStatusStore()
  const tool = createTransformStatusTool(store, observer)

  const readTransform = async (): Promise<{ appliedTurns: number }> => {
    const report = JSON.parse(
      (await tool.execute({}, { sessionId: 's1', workdir: process.cwd() })).output!,
    ) as { transform: { appliedTurns: number } }
    // Only the counter matters here; ownership is asserted separately.
    return { appliedTurns: report.transform.appliedTurns }
  }

  assert.deepEqual(await readTransform(), { appliedTurns: 0 })
  for (let i = 0; i < 5; i += 1) emit('context.compacted')
  // N3-12: our own numbers move by exactly zero.
  assert.deepEqual(
    await readTransform(),
    { appliedTurns: 0 },
    'a host compaction must not move our own reduction counters',
  )
  assert.equal(
    observer.snapshot().events.find((e) => e.event === 'context.compacted')?.count,
    5,
    'the host event is still counted on its own side',
  )
})

test('the two reduction sources are reported apart, with no merged figure', async () => {
  const { observer, emit } = harness()
  emit('context.compacted')

  const tool = createTransformStatusTool(new TransformStatusStore(), observer)
  const report = JSON.parse(
    (await tool.execute({}, { sessionId: 's1', workdir: process.cwd() })).output!,
  ) as Record<string, unknown>

  const host = (report.hostCompactions ?? []) as { event: string; count: number; attributedTo: string }[]
  const transform = report.transform as { appliedTurns: number; attributedTo: string }
  assert.equal(host.length, 1, 'the host figure is reported on its own line')
  assert.equal(host[0]?.attributedTo, 'host')
  assert.equal(transform.attributedTo, 'plugin')
  assert.equal(transform.appliedTurns, 0, 'ours stays at zero')

  const serialized = JSON.stringify(report)
  assert.equal(
    /totalReduction|combinedReduction|overallReduction/i.test(serialized),
    false,
    'no figure may merge a host reduction with ours',
  )
})

test('an unobserved host compaction stays listed at zero, not absent', async () => {
  const report = (await readStatus(new TransformStatusStore())) as {
    hostCompactions: unknown[]
    complete: boolean
  }

  // "None seen" and "not observable" are different claims; the report must not
  // collapse them into an empty array that reads as the first one.
  assert.deepEqual(report.hostCompactions, [])
  assert.equal(report.complete, false)
})

test('the rolling character window says it is bounded, not lifetime', async () => {
  const store = new TransformStatusStore()
  const tool = createTransformStatusTool(store, createHookObserver())
  const report = JSON.parse(
    (await tool.execute({}, { sessionId: 's1', workdir: process.cwd() })).output!,
  ) as {
    transform: {
      appliedTurns: number
      charsRemovedLast20Turns: number
      windowTurns: number
      retainedTurnsLimit: number
    }
  }

  // `appliedTurns` is a lifetime counter and the character figure is a rolling
  // window. Reporting them under one name would read as one measurement, so the
  // window carries its own label and its bound is visible.
  assert.equal(report.transform.charsRemovedLast20Turns, 0)
  assert.ok(
    !('charsRemoved' in report.transform),
    'the unbounded-sounding name must be gone',
  )
  assert.equal(report.transform.windowTurns, 0)
  assert.equal(report.transform.retainedTurnsLimit, 20)
})
test('only context.compacted is reported as a host compaction', async () => {
  // Regression: `hostCompactions` once listed every MEASURED event, so a plain
  // `turn.completed` appeared there and a reader would take it as "the host
  // compacted a turn". It never does. The full census is `semantic_hook_status`.
  const { observer, emit } = harness()
  emit('turn.completed')
  emit('message.created')
  emit('tool.completed')
  emit('context.compacted')

  const tool = createTransformStatusTool(new TransformStatusStore(), observer)
  const report = JSON.parse(
    (await tool.execute({}, { sessionId: 's1', workdir: process.cwd() })).output!,
  ) as { hostCompactions: { event: string }[] }

  assert.equal(report.hostCompactions.length, 1)
  assert.equal(report.hostCompactions[0]?.event, 'context.compacted')
})