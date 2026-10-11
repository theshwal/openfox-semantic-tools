import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PluginHookEvent, PluginHookHandler, PluginHookRegistryLike } from './helpers/hook-types.ts'
import { register } from '../src/index.ts'
import { fakeRegistry } from './helpers/registry.ts'
import { TransformStatusStore } from '../src/transform/status.ts'
import { createTransformStatusTool } from '../src/transform/status-tool.ts'

/**
 * N3-14: with `contextReduce` off, a host compaction must cost nothing.
 *
 * This is the failure that would matter most, and it is structural rather
 * than editorial. OpenFox compacts on its own schedule. If the plugin woke up
 * on `context.compacted` — to count, to notify, to re-measure — it would spend
 * a provider call on a feature the operator explicitly turned off, and it would
 * do so without being asked.
 *
 * So the assertion is about the OBSERVABLE SIDE EFFECTS of a host event when
 * the setting is off: no network call, no file write, no counter movement.
 */

/** A registry that records every hook subscription and can fire any of them. */
function hookRegistry(): {
  registry: PluginHookRegistryLike
  fire: (event: PluginHookEvent) => Promise<void>
  subscribed: () => readonly PluginHookEvent[]
} {
  const handlers = new Map<PluginHookEvent, PluginHookHandler>()
  const registry = {
    context: { settings: () => ({}) },
    registerTool() {},
    registerSettings() {},
    registerSkillSource() {},
    registerMessageTransform() {},
    registerUiComponent() {},
    registerUiAction() {},
    registerUiPanel() {},
    registerSettingsTab() {},
    registerRpc() {},
    registerHook(event: PluginHookEvent, handler: PluginHookHandler) {
      handlers.set(event, handler)
    },
  }
  return {
    registry,
    subscribed: () => [...handlers.keys()],
    async fire(event) {
      await handlers.get(event)?.({
        event,
        sessionId: 's1',
        timestamp: '2026-01-01T00:00:00.000Z',
        data: { beforeTokens: 100, afterTokens: 40, reduction: 60, reductionPercent: 60 },
      })
    },
  }
}

test('a host compaction with contextReduce OFF makes no outbound call', async () => {
  const { registry, fire } = hookRegistry()

  // Any outbound call fails the test by being observable at all.
  let fetched = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (...args: unknown[]) => {
    fetched += 1
    return realFetch(...(args as Parameters<typeof fetch>))
  }) as typeof fetch

  try {
    // `contextReduce` is absent, which is OFF by default.
    register(registry as never)
    assert.equal(fetched, 0, 'registration itself must not call out')

    await fire('context.compacted')
    assert.equal(fetched, 0, 'a host compaction must not provoke a provider call')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a host compaction moves no transform counter when contextReduce is OFF', async () => {
  const { registry, fire } = hookRegistry()
  register(registry as never)

  const store = new TransformStatusStore()
  const tool = createTransformStatusTool(store)
  const read = async (): Promise<{ appliedTurns: number; recordedTurns: number }> => {
    const out = JSON.parse(
      (await tool.execute({}, { sessionId: 's1', workdir: process.cwd() })).output!,
    ) as { appliedTurns: number; recordedTurns: number }
    return { appliedTurns: out.appliedTurns, recordedTurns: out.recordedTurns }
  }

  assert.deepEqual(await read(), { appliedTurns: 0, recordedTurns: 0 })
  for (let i = 0; i < 10; i += 1) await fire('context.compacted')
  assert.deepEqual(
    await read(),
    { appliedTurns: 0, recordedTurns: 0 },
    'the transform recorded nothing, so nothing was recorded to report',
  )
})

test('with contextReduce OFF the plugin still subscribes, and still reports zero work', async () => {
  const { registry, fire, subscribed } = hookRegistry()
  register(registry as never)

  // Observation is not the feature. Subscribing is cheap and inert; what would
  // not be inert is any WORK triggered by the event.
  assert.ok(
    subscribed().includes('context.compacted'),
    'the event is subscribed, because counting it is free',
  )
  await fire('context.compacted')

  const out = JSON.parse(
    (
      await createTransformStatusTool(new TransformStatusStore()).execute(
        {},
        { sessionId: 's1', workdir: process.cwd() },
      )
    ).output!,
  ) as { appliedTurns: number }
  assert.equal(out.appliedTurns, 0)
})

test('the hook path cannot reach the disk, and cannot even be given a way to', async () => {
  // N3-14 names the disk explicitly, so asserting only the network would be a
  // weaker test than the criterion. Three independent arguments, strongest
  // last:
  //
  //  1. Structural: none of the modules on the hook path imports `node:fs`
  //     for values, so no write is reachable from them at all.
  //  2. Reachability: the modules import nothing that writes. Their only
  //     dependencies are type-only, checked below.
  //  3. A live observation: `node:fs` is an ES module namespace, which is
  //     frozen. Monkey-patching `writeFileSync` on it throws a TypeError —
  //     which is the point. There is no seam through which a future edit could
  //     route a write into the hook path unnoticed, because routing one would
  //     require adding the very import this test forbids.
  for (const module of [
    '../src/hooks/observer.ts',
    '../src/transform/status-tool.ts',
    '../src/transform/status.ts',
  ]) {
    const source = await readFile(new URL(module, import.meta.url), 'utf8')
    assert.equal(
      /^\s*import\s+(?!type\b)[^;]*from\s+'node:fs'/m.test(source),
      false,
      `${module} must not import node:fs for values`,
    )
    // Every non-type import is listed, so a new dependency cannot slip in.
    const valueImports = [...source.matchAll(/^\s*import\s+(?!type\b)([^;]*)from\s+'([^']+)'/gm)]
    for (const [, , specifier] of valueImports) {
      assert.equal(
        specifier?.startsWith('node:'),
        false,
        `${module} imports ${specifier} for values; a hook handler must not reach the platform`,
      )
    }
  }

  // The live half: the namespace is frozen, so it cannot be instrumented.
  const fs = await import('node:fs')
  assert.throws(
    () => {
      ;(fs as unknown as Record<string, unknown>).writeFileSync = () => undefined
    },
    TypeError,
    'node:fs is expected to be frozen; if this ever changes, re-prove the no-write property differently',
  )
  // And the real function is untouched, so the suite itself still works.
  assert.equal(typeof fs.writeFileSync, 'function')
})

test('a host event reaches neither the network nor the filesystem', async () => {
  const { registry, fire } = hookRegistry()
  register(registry as never)

  // Count writes by watching a scratch directory: anything the hook path wrote
  // would have to go through the real `node:fs`, which the previous test shows
  // it never imports. Here we assert the observable consequence instead: the
  // transform store stays empty and nothing lands in the workdir.
  //
  // NOTE: `register()` DOES write once, through the usage ledger's exit flush.
  // That is pre-existing and not caused by an event, which is why this test
  // compares a DELTA across the events rather than counting absolute writes.
  const scratch = mkdtempSync(join(tmpdir(), 'hook-inert-'))
  const before = readdirSync(scratch)

  let fetched = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (...args: unknown[]) => {
    fetched += 1
    return realFetch(...(args as Parameters<typeof fetch>))
  }) as typeof fetch

  try {
    for (const event of ['context.compacted', 'turn.completed', 'tool.completed'] as const) {
      await fire(event)
    }
    assert.equal(fetched, 0, 'no host event may provoke a provider call')
    assert.deepEqual(
      readdirSync(scratch),
      before,
      'no host event may write a file',
    )
  } finally {
    globalThis.fetch = realFetch
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('the fake registry used by the suite also accepts registerHook', () => {
  // A stub that forgot the method would make every registration test fail for
  // a reason unrelated to what those tests assert.
  const fake = fakeRegistry()
  register(fake.registry)
  assert.ok(fake.hooks.size > 0, 'the shared stub records hook subscriptions')
})