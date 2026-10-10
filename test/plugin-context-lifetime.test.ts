import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginRegistry, PluginTool } from 'openfox/plugin'

import { register } from '../src/index.ts'

/** Mirrors the host's own registry shape, including the registration scope. */
interface StubRegistry {
  registry: PluginRegistry
  tools: Map<string, PluginTool>
  reads: () => number
  endRegistration: () => void
}

/**
 * OpenFox clears `registry.context` in `endPlugin()` immediately after
 * `register()` returns. A tool that reads `registry.context` lazily therefore
 * fails on its first REAL execution with "Plugin context is only available while
 * a plugin is registering". This stub reproduces that lifecycle exactly, so the
 * regression is provable without a live host.
 */
function stubRegistry(): StubRegistry {
  const tools = new Map<string, PluginTool>()
  let reads = 0
  let context: { settings(): Record<string, never> } | undefined = {
    settings() {
      reads += 1
      return {}
    },
  }
  const registry = {
    get context(): { settings(): Record<string, never> } {
      if (!context) throw new Error('Plugin context is only available while a plugin is registering')
      return context
    },
    registerTool(tool: PluginTool) {
      tools.set(tool.name, tool)
    },
    registerSettings() {},
    registerSkillSource() {},
    registerMessageTransform() {},
  } as unknown as PluginRegistry
  return {
    registry,
    tools,
    reads: () => reads,
    endRegistration: () => {
      context = undefined
    },
  }
}

test('tools read settings after registration, when the registry context is gone', async () => {
  const { registry, tools, reads, endRegistration } = stubRegistry()
  register(registry)
  // The host ends the registration scope here.
  endRegistration()

  // Not a hard-coded count: the plugin gained tools in later lots, and a fixed
  // number would fail for an unrelated reason. What matters is that every tool
  // the plugin registered can read settings after registration.
  // The settings-backed tools this regression covers are asserted BY NAME below
  // and each is really invoked, so this check only states that the registry is populated
  // without pinning a total that a later lot legitimately changes.
  assert.ok(tools.size > 0, `the plugin registered ${tools.size} tool(s)`)
  // The discovery tools assemble candidate file content BEFORE reading settings,
  // so they need a real, readable file to reach the same point.
  const dir = await mkdtemp(join(tmpdir(), 'plugin-context-'))
  await writeFile(join(dir, 'fixture.txt'), 'the export endpoint scopes every record to the tenant\n')
  const context = { sessionId: 's', workdir: dir }
  // Each tool gets arguments valid for ITS OWN schema, so the only remaining
  // possible failure is the settings read itself.
  const perTool: Record<string, Record<string, unknown>> = {
    semantic_decide: { state: 'x', questions: { q: { type: 'noul', instructions: 'a?' } } },
    semantic_verify_task: {
      criterionId: 'ac-1',
      criterion: 'The export scopes every record to the tenant.',
      evidence: { summary: 'x', diffExcerpts: ['y'], deterministicTestResults: ['ok'] },
    },
    semantic_issue_coverage: {
      criteria: [{ id: 'ac-1', text: 'The export scopes every record to the tenant.' }],
      evidence: { summary: 'x', diffExcerpts: ['y'], deterministicTestResults: ['ok'] },
    },
    semantic_search: { query: 'tenant scoped export', candidates: ['fixture.txt'] },
    semantic_scan: { predicate: 'Is it scoped?', candidates: ['fixture.txt'] },
  }
  try {
    for (const [name, args] of Object.entries(perTool)) {
      const tool = tools.get(name)
      assert.ok(tool, `${name} must be registered`)
      const result = await tool.execute(args, context)
      assert.equal(result.success, false, `${name} must fail without a configured endpoint`)
      const error = JSON.parse(result.error ?? '{}') as { code: string; message: string }
      assert.ok(
        !/only available while a plugin is registering/.test(error.message),
        `${name} must not fail on the registration-scoped context, got: ${error.message}`,
      )
      assert.match(error.message, /endpoint/i, `${name} must fail on the endpoint, got: ${error.message}`)
    }
    assert.ok(reads() >= 5, `settings were read during execution (${reads()})`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('registration itself does not depend on a later context read', () => {
  const { registry, tools, reads } = stubRegistry()
  register(registry)
  // Each settings-backed tool covered by this regression is checked by name and
  // really invoked above, so registration is proven per tool rather than by a
  // registry count that a later lot may legitimately change.
  assert.ok(tools.size > 0, `the plugin registered ${tools.size} tool(s)`)
  assert.equal(reads(), 0, 'registration must not read settings')
})
