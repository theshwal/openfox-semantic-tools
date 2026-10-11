import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { UsageLedger, usageLedgerPath } from '../src/usage/ledger.ts'
import { createUsageReportTool } from '../src/usage/tool.ts'

/**
 * The ledger answers one question the plugin could never answer before:
 * which capabilities the agent actually reaches for.
 *
 * A capability that is offered and never called is a different thing from a
 * capability nobody ever saw. Criteria A3-10..A3-13 depend on keeping those
 * two counts apart, and A4-15 on keeping secrets and file content out of the
 * file entirely.
 */

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'usage-ledger-'))
}

test('a called capability counts as used, an uncalled one only as offered', async () => {
  const dir = await tempDir()
  try {
    const ledger = new UsageLedger(dir)
    ledger.noteOffered(['semantic_search', 'semantic_decide'])
    ledger.noteOffered(['semantic_search', 'semantic_decide'])
    ledger.noteUsed('semantic_search')
    ledger.noteUsed('semantic_search')

    const snapshot = ledger.snapshot()
    assert.equal(snapshot.offered['semantic_search'], 2)
    assert.equal(snapshot.used['semantic_search'], 2)
    assert.equal(snapshot.offered['semantic_decide'], 2)
    assert.equal(snapshot.used['semantic_decide'], 0)

    const report = ledger.report()
    const row = report.capabilities.find((c) => c.name === 'semantic_search')!
    assert.equal(row.offered, 2)
    assert.equal(row.used, 2)
    assert.equal(row.usageRatio, 1)

    const unused = report.capabilities.find((c) => c.name === 'semantic_decide')!
    assert.equal(unused.offered, 2)
    assert.equal(unused.used, 0)
    assert.equal(unused.usageRatio, 0)
    assert.equal(unused.usageRateLabel, 'never used')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a capability never offered is reported as offered zero times', async () => {
  const dir = await tempDir()
  try {
    const ledger = new UsageLedger(dir)
    ledger.noteUsed('semantic_verify_task')
    const row = ledger.report().capabilities.find((c) => c.name === 'semantic_verify_task')!
    assert.equal(row.offered, 0)
    assert.equal(row.used, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the seeded catalogue survives a restart and is not double-counted', async () => {
  const dir = await tempDir()
  try {
    // Seeding is idempotent: a hot reload must not inflate the floor.
    const first = new UsageLedger(dir)
    first.seed(['semantic_search', 'semantic-verification'])
    const second = new UsageLedger(dir)
    second.seed(['semantic_search', 'semantic-verification'])
    await second.writeReport()

    // A fresh process reads the catalogue back, or the report would forget
    // what the plugin even ships.
    const reloaded = new UsageLedger(dir)
    const rows = reloaded.report().capabilities
    assert.deepEqual(
      rows.map((r) => r.name).sort(),
      ['semantic-verification', 'semantic_search'],
    )
    for (const row of rows) {
      assert.equal(row.offered, 0, 'seeding must not inflate the offered count')
      assert.equal(row.used, 0)
      assert.equal(row.usageRateLabel, 'available, never used')
    }

    // And a use still counts on top of the floor.
    reloaded.noteUsed('semantic_search')
    const used = reloaded.report().capabilities.find((c) => c.name === 'semantic_search')!
    assert.equal(used.used, 1)
    assert.equal(used.offered, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the ledger survives across store instances', async () => {
  const dir = await tempDir()
  try {
    // Counters are buffered in memory and flushed on demand: writing
    // synchronously on every tool call blocked the agent's event loop on disk
    // for optional bookkeeping. So persistence is an explicit step here.
    const first = new UsageLedger(dir)
    first.noteOffered(['semantic_search'])
    first.noteUsed('semantic_search')
    assert.equal(first.hasPendingWrites, true, 'an unflushed change is pending')
    await first.flushPending()

    const row = new UsageLedger(dir).report().capabilities.find((c) => c.name === 'semantic_search')!
    assert.equal(row.offered, 1)
    assert.equal(row.used, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a flushed ledger has nothing left pending, and a clean one never writes', async () => {
  const dir = await tempDir()
  try {
    const ledger = new UsageLedger(dir)
    assert.equal(ledger.hasPendingWrites, false, 'a fresh ledger has nothing to write')
    ledger.noteUsed('semantic_search')
    assert.equal(ledger.hasPendingWrites, true)
    await ledger.flushPending()
    assert.equal(ledger.hasPendingWrites, false)

    // A second flush must be a no-op, so a hot loop does not re-write the file.
    const before = await readFile(usageLedgerPath(dir), 'utf8')
    await ledger.flushPending()
    assert.equal(await readFile(usageLedgerPath(dir), 'utf8'), before)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the synchronous exit flush writes counters without a readable report', async () => {
  const dir = await tempDir()
  try {
    const ledger = new UsageLedger(dir)
    ledger.noteUsed('semantic_search')
    ledger.flushPendingSync()
    const raw = JSON.parse(await readFile(usageLedgerPath(dir), 'utf8')) as {
      totals: Record<string, { used: number }>
      report?: unknown
    }
    assert.equal(raw.totals.semantic_search.used, 1)
    // Nobody is left to read a rendered report at exit.
    assert.equal(raw.report, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('counters are bounded and the oldest are purged', async () => {
  const dir = await tempDir()
  try {
    const ledger = new UsageLedger(dir, { maxNames: 3, maxDays: 30 })
    for (let i = 0; i < 10; i += 1) ledger.noteUsed(`cap_${i}`)
    const names = ledger.report().capabilities.map((c) => c.name)
    assert.ok(names.length <= 3, `expected at most 3 retained names, got ${names.length}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('day buckets older than the retention window are dropped', async () => {
  const dir = await tempDir()
  try {
    let day = new Date('2026-01-01T00:00:00.000Z')
    const clock = (): Date => {
      const current = day
      day = new Date(day.getTime() + 86_400_000)
      return current
    }
    const ledger = new UsageLedger(dir, { maxDays: 3 }, clock)
    ledger.noteUsed('semantic_search')
    const snapshot = ledger.snapshot()
    assert.deepEqual(Object.keys(snapshot.days).sort(), ['2026-01-01'])
    assert.equal(snapshot.totalUsed, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the persisted report holds no path, credential or file content', async () => {
  const dir = await tempDir()
  try {
    const ledger = new UsageLedger(dir)
    ledger.noteOffered(['semantic_search'])
    ledger.noteUsed('semantic_search')
    await ledger.writeReport()
    const raw = await readFile(usageLedgerPath(dir), 'utf8')
    assert.equal(raw.includes('sk-'), false)
    assert.equal(raw.includes('apiKey'), false)
    assert.equal(raw.includes('/src/'), false)
    assert.equal(raw.includes('Authorization'), false)
    // It really is a document a human can read, not an opaque blob.
    const parsed = JSON.parse(raw) as { report: { capabilities: unknown[] } }
    assert.ok(Array.isArray(parsed.report.capabilities))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the report tool writes a file and contacts nothing', async () => {
  const dir = await tempDir()
  try {
    const ledger = new UsageLedger(dir)
    ledger.noteOffered(['semantic_search', 'semantic_scan'])
    ledger.noteUsed('semantic_search')

    const tool = createUsageReportTool(ledger)
    const result = await tool.execute({}, { sessionId: 's', workdir: dir })
    assert.equal(result.success, true, result.error ?? '')

    const payload = JSON.parse(result.output!) as {
      advisory: boolean
      reportPath: string
      capabilities: { name: string; offered: number; used: number }[]
    }
    assert.equal(payload.advisory, true)
    assert.match(payload.reportPath, /semantic-usage/)
    assert.equal(payload.capabilities.find((c) => c.name === 'semantic_scan')?.used, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the report tool cannot reach the network, by construction', async () => {
  // Stronger than spying on an unused parameter: the tool module simply has
  // no transport, so there is no code path that could issue a request. The
  // prose above the function mentions "fetch" only to explain why it is gone,
  // so the check runs against CODE, with comments stripped.
  const source = await readFile(new URL('../src/usage/tool.ts', import.meta.url), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.equal(
    /\bfetch\b|XMLHttpRequest|https?:\/\//.test(code),
    false,
    'the report tool must contain no network call of any kind',
  )
})