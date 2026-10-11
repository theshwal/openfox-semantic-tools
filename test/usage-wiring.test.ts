import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginSkillSource, PluginTool } from 'openfox/plugin'

import { register } from '../src/index.ts'
import { withUsage } from '../src/usage/wrap.ts'
import { UsageLedger, usageLedgerPath } from '../src/usage/ledger.ts'
import { fakeRegistry } from './helpers/registry.ts'

/**
 * A3-13: the counter that makes the "offered vs used" distinction real.
 *
 * A capability that is listed every turn and invoked never is pure prompt
 * overhead; a capability nobody was ever offered cannot be evaluated at all.
 * Keeping those two counts apart is only meaningful if the REAL plugin wiring
 * feeds them, so these tests exercise `register()` itself rather than the
 * ledger in isolation.
 */

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'usage-wiring-'))
}

/**
 * Registers the real plugin against a ledger at `dir`, so an invocation
 * through a returned tool is observable in that exact file.
 *
 * The ledger is INJECTED rather than reconstructed: a second instance would
 * read and write a second snapshot, and the test would assert against a
 * different file from the one the plugin actually wrote.
 */
function registerReal(dir: string): {
  tools: Map<string, PluginTool>
  ledger: UsageLedger
  skillSources: PluginSkillSource[]
} {
  // The SHARED stub, not a hand-rolled one: `register()` also registers the
  // session activity panel, and a private stub that forgot one of its methods
  // would fail here for a reason unrelated to what this file asserts.
  const fake = fakeRegistry()
  const ledger = new UsageLedger(dir)
  register(fake.registry, { usage: ledger })
  return { tools: fake.tools, ledger, skillSources: fake.skillSources }
}

test('a real tool invocation increments the used counter', async () => {
  const dir = await tempDir()
  try {
    const { tools, ledger } = registerReal(dir)

    // semantic_usage_report is NOT wrapped: a counter that counts its own
    // reads would inflate the number every time someone checks it. Pick a
    // wrapped tool instead and count it through the registry.
    const probe = tools.get('semantic_calibration_candidate')
    assert.ok(probe, 'a wrapped tool must be registered')
    const result = await probe.execute(
      {
        id: 'probe',
        provider: { presetId: 'custom' },
        cases: [
          {
            id: 'c1',
            expectedStatus: 'unknown',
            gates: {
              criterionTestable: 0.5,
              satisfied: 0.5,
              evidenceSufficiency: 0.5,
              offScope: 0.1,
              needsDeeperVerification: 0.5,
            },
          },
        ],
      },
      { sessionId: 's', workdir: dir },
    )
    assert.equal(typeof result.success, 'boolean', result.error ?? '')

    const row = ledger.report().capabilities.find(
      (c) => c.name === 'semantic_calibration_candidate',
    )
    assert.ok(row, 'an invoked tool must appear in the report')
    assert.equal(row.used, 1)
    assert.equal(row.offered, 0)
    assert.equal(row.usageRateLabel, 'used without being offered')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('every registered tool is wrapped, so no call escapes the counter', async () => {
  const dir = await tempDir()
  try {
    const { tools, ledger } = registerReal(dir)
    assert.ok(tools.size >= 10, `expected the full tool set, got ${tools.size}`)

    for (const [name, tool] of tools) {
      // Every tool either fails on the missing endpoint or writes a report.
      // None throws, which is what proves the wrapper is transparent.
      const result = await tool.execute({}, { sessionId: 's', workdir: dir })
      assert.equal(typeof result.success, 'boolean', `${name} returned no verdict`)
    }

    // semantic_usage_report is invoked by the loop itself; the rest run and
    // return without needing a provider, so they must all be counted.
    const counted = new Set(
      ledger.report().capabilities.filter((c) => c.used > 0).map((c) => c.name),
    )
    assert.ok(
      counted.size >= 8,
      `expected most tools counted, got ${[...counted].join(', ')}`,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a tool listed but never invoked only ever counts as offered', async () => {
  const dir = await tempDir()
  try {
    const ledger = new UsageLedger(dir)
    // Offered twice, invoked zero times: pure prompt overhead, which is
    // exactly the fact A3-13 exists to make visible.
    ledger.noteOffered(['semantic-code-discovery', 'semantic-verification'])
    ledger.noteOffered(['semantic-code-discovery', 'semantic-verification'])

    const row = ledger.report().capabilities.find((c) => c.name === 'semantic-code-discovery')!
    assert.equal(row.offered, 2)
    assert.equal(row.used, 0)
    assert.equal(row.usageRatio, 0)
    assert.equal(row.usageRateLabel, 'never used')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a bookkeeping failure never changes what a tool returns', async () => {
  const broken = {
    noteUsed() {
      throw new Error('disk full')
    },
  } as unknown as UsageLedger

  const ok = { success: true, output: '{"ok":true}' }
  const tool: PluginTool = {
    name: 'probe',
    description: 'probe',
    parameters: { type: 'object' },
    execute: async () => ok,
  }
  const wrapped = withUsage(tool, broken)
  assert.deepEqual(
    await wrapped.execute({}, { sessionId: 's', workdir: process.cwd() }),
    ok,
    'a ledger error must be swallowed, never propagated into a tool result',
  )
})

test('with no ledger the tool is returned untouched', () => {
  const tool: PluginTool = {
    name: 'probe',
    description: 'probe',
    parameters: { type: 'object' },
    execute: async () => ({ success: true }),
  }
  assert.equal(withUsage(tool, undefined), tool, 'the identity is preserved')
})

test('counters persist where the report tool says they do', async () => {
  const dir = await tempDir()
  try {
    const { tools, ledger } = registerReal(dir)
    const before = await tools.get('semantic_usage_report')!.execute(
      {},
      { sessionId: 's', workdir: dir },
    )
    assert.equal(before.success, true, before.error ?? '')
    const payload = JSON.parse(before.output!) as { reportPath: string }
    assert.match(payload.reportPath, /semantic-usage\.json$/)
    // The injected ledger writes exactly where it says it does.
    assert.equal(payload.reportPath, usageLedgerPath(dir))
    const raw = JSON.parse(await readFile(payload.reportPath, 'utf8')) as {
      report: { capabilities: unknown[] }
    }
    assert.ok(Array.isArray(raw.report.capabilities))
    // Registration seeds the catalogue, so a report written before any
    // invocation already lists every shipped capability and skill rather than
    // being an empty object nobody can act on.
    assert.ok(
      raw.report.capabilities.length >= 10,
      `expected the full catalogue, got ${raw.report.capabilities.length}`
    )
    assert.equal(raw.report.capabilities.some((c) => (c as { name: string }).name === 'semantic_search'), true)
    assert.equal(
      raw.report.capabilities.some((c) => (c as { name: string }).name === 'semantic-verification'),
      true,
      'skills must appear in the report too'
    )
    // Nothing has been used yet, and every row says so.
    assert.equal(ledger.report().totalUsed, 0)
    for (const entry of raw.report.capabilities) {
      const row = entry as { offered: number; used: number; usageRateLabel: string }
      assert.equal(row.used, 0)
      assert.equal(row.usageRateLabel, 'available, never used')
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('loading a skill in production counts as a real OFFER', async () => {
  // The review found `offered` was never recorded outside tests, while the docs
  // promised an offered-vs-used ratio. A skill load is the one moment the plugin
  // can actually observe a capability being presented, so it is the source.
  const dir = await tempDir()
  try {
    const { ledger, skillSources } = registerReal(dir)
    const source = skillSources[0]
    assert.ok(source, 'a skill source must be registered')

    const skills = await source.load()
    assert.ok(skills.length > 0)

    const report = ledger.report()
    for (const skill of skills) {
      const row = report.capabilities.find((c) => c.name === skill.id)
      assert.ok(row, `${skill.id} must appear in the report`)
      assert.equal(row.offered, 1, `${skill.id} was offered exactly once`)
      assert.equal(row.used, 0)
      assert.equal(row.usageRatio, 0)
    }
    // A second load is a second offer: the ratio becomes meaningful.
    await source.load()
    const after = ledger.report()
    const row = after.capabilities.find((c) => c.name === skills[0]!.id)!
    assert.equal(row.offered, 2)
    assert.equal(row.used, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a tool row never claims an offer it cannot observe', async () => {
  const dir = await tempDir()
  try {
    const { tools, ledger } = registerReal(dir)
    const probe = tools.get('semantic_calibration_candidate')!
    await probe.execute(
      {
        id: 'p',
        provider: { presetId: 'custom' },
        cases: [
          {
            id: 'c',
            expectedStatus: 'unknown',
            gates: {
              criterionTestable: 0.5,
              satisfied: 0.5,
              evidenceSufficiency: 0.5,
              offScope: 0.1,
              needsDeeperVerification: 0.5,
            },
          },
        ],
      },
      { sessionId: 's', workdir: dir },
    )
    const row = ledger.report().capabilities.find((c) => c.name === 'semantic_calibration_candidate')!
    // Reachability comes from allowedTools, which the plugin never sees, so
    // the honest answer is zero offers rather than an invented number.
    assert.equal(row.offered, 0)
    assert.equal(row.used, 1)
    assert.equal(row.usageRatio, null, 'no ratio is computable without offers')
    assert.equal(row.usageRateLabel, 'used without being offered')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})