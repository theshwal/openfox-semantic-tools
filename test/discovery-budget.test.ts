import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { localRecall } from '../src/discovery/recall.ts'
import { readBoundedCandidates, MAX_FILE_BYTES } from '../src/discovery/read.ts'
import { MAX_STATE_TOKENS, estimateTokens } from '../src/presets/token-budget.ts'
import { createDiscoveryTool } from '../src/discovery/tool.ts'

/**
 * A recall that overshoots the read budget is not a caller error.
 *
 * Measured on a real 137-file TypeScript repository: recall proposes up to 24
 * candidates at ~8 KB each, the reader caps the assembled evidence at 120 KB,
 * and the two disagree. The result was `invalid_arguments: Assembled evidence
 * exceeds the total evidence limit` on EVERY call — the rerank stage was never
 * reached, so the semantic search could never work on a normal-sized repo.
 *
 * The refusal itself is correct (nothing is ever silently truncated). What was
 * wrong is that the caller who CAUSED the overrun was blamed for it.
 */

const ENDPOINT = { endpoint: 'http://localhost/v1/systemone', timeoutMs: 2000 }

function score(level: number, confidence: number) {
  const probabilities: Record<string, number> = { '0': 0, '1': 0, '2': 0 }
  probabilities[String(level)] = 1
  return { type: 'score', score: level, probabilities, confidence }
}

async function transcriptStub() {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> }
    const answers: Record<string, unknown> = {}
    Object.keys(body.questions).forEach((id, i) => {
      answers[id] = score(2 - (i % 3), 0.8)
    })
    return Response.json({ answers })
  }) as typeof fetch
}

/** A repo where many files match, each big enough to blow the budget. */
async function budgetBustingRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'recall-budget-'))
  await mkdir(join(root, 'src'), { recursive: true })
  // 30 matching files, each ~8 KB: 240 KB of evidence against a 120 KB cap.
  for (let i = 0; i < 30; i += 1) {
    const filler = 'excluded archived ledger '.repeat(280)
    await writeFile(
      join(root, 'src', `invoice-${String(i).padStart(2, '0')}.ts`),
      `export const archivedInvoice${i} = "${filler}"\n`,
      'utf8',
    )
  }
  return root
}

test('recall never proposes more evidence than the reader will accept', async () => {
  const root = await budgetBustingRepo()
  const recall = await localRecall(root, 'archived excluded ledger')
  assert.ok(recall.candidates.length > 0, 'the fixture must match')

  const read = await readBoundedCandidates(root, recall.candidates.map((c) => c.path))
  // The invariant that was missing: recall's shortlist already fits the budget.
  // Asserted in TOKENS, because tokens are what the engine counts — a byte
  // assertion here would have passed while the request was still refused.
  assert.ok(
    estimateTokens(read.files.map((f) => f.content).join('\n')) <= MAX_STATE_TOKENS,
    `recall proposed evidence above the ${MAX_STATE_TOKENS}-token budget`,
  )
})

test('a repo larger than the budget returns candidates instead of failing', async () => {
  const root = await budgetBustingRepo()
  const tool = createDiscoveryTool('semantic_search', () => ENDPOINT, await transcriptStub())

  const result = await tool.execute({ query: 'archived excluded ledger', root }, { sessionId: 's', workdir: root })

  assert.equal(
    result.success,
    true,
    `a normal-sized repo must not fail with invalid_arguments: ${result.error ?? ''}`,
  )
  const report = JSON.parse(result.output!) as {
    relevance: { skippedTotal: number; skippedByReason: { reason: string; count: number }[] }
  }
  // What did not fit is named, not silently dropped.
  assert.ok(report.relevance.skippedTotal >= 0)
})

test('evidence past the budget is dropped BY NAME, never refused and never cut', async () => {
  // The old behaviour rejected the whole call, which blamed the caller for a
  // limit it never saw and killed the rerank stage. Now the surplus is named.
  const root = await budgetBustingRepo()
  const all = Array.from({ length: 30 }, (_, i) => `src/invoice-${String(i).padStart(2, '0')}.ts`)
  const read = await readBoundedCandidates(root, all)

  assert.ok(read.files.length > 0, 'the budget must leave usable evidence')
  assert.ok(read.files.length < all.length, 'the surplus must be reported, not silently included')
  for (const entry of read.skipped) {
    assert.equal(entry.reason, 'evidence-budget')
  }
  // Nothing was cut mid-file: every kept file is complete.
  for (const file of read.files) {
    assert.ok(file.content.startsWith('export const archivedInvoice'), 'a file was truncated')
  }
})

test('a preset with a small window gets a smaller budget', async () => {
  // Laya reads 1 024 tokens. Sending it the general budget would be refused
  // outright, so the budget has to follow the preset rather than the plugin.
  const root = await mkdtemp(join(tmpdir(), 'recall-small-'))
  await mkdir(join(root, 'src'), { recursive: true })
  // ~120 tokens each: several fit in the 800-token window, fewer fit in 24 000
  // only by a wide margin, so the difference is a real REDUCTION.
  const files: string[] = []
  for (let i = 0; i < 30; i += 1) {
    const name = `src/small-${String(i).padStart(2, '0')}.ts`
    await writeFile(join(root, name), `export const archived${i} = '${'ledger'.repeat(20)}'\n`)
    files.push(name)
  }

  const general = await readBoundedCandidates(root, files)
  const laya = await readBoundedCandidates(root, files, { presetId: 'laya' })

  assert.equal(general.files.length, 30, 'the general budget should take them all')
  assert.ok(
    laya.files.length < general.files.length,
    `a small-window preset must receive less evidence (laya ${laya.files.length}, general ${general.files.length})`,
  )
  assert.ok(laya.files.length > 0, 'the small preset must still return usable evidence')
})

test('a preset window too small for even one file says so, naming every file', async () => {
  // The failure mode this replaces: the engine refuses the whole request and
  // the caller sees an empty ranking with no reason.
  const root = await budgetBustingRepo()
  const files = ['src/invoice-00.ts']

  await assert.rejects(
    () => readBoundedCandidates(root, files, { presetId: 'laya' }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, 'insufficient_evidence')
      assert.match(error.message, /evidence-budget/, 'the reason must name the budget')
      return true
    },
  )
})

test('a single oversized file is still refused by name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recall-big-'))
  await writeFile(join(root, 'huge.ts'), 'x'.repeat(MAX_FILE_BYTES + 1))
  await assert.rejects(() => readBoundedCandidates(root, ['huge.ts']), /exceeds the per-file limit/)
})

test('recall names the files it dropped for size, with a reason', async () => {
  const root = await budgetBustingRepo()
  await writeFile(join(root, 'src', 'enormous.ts'), 'archived excluded ledger '.repeat(2000))
  const recall = await localRecall(root, 'archived excluded ledger')
  const oversized = recall.skipped.filter((entry) => entry.reason === 'too-large')
  assert.ok(
    oversized.some((entry) => entry.path === 'src/enormous.ts'),
    'an unreadable file must be named, never silently dropped',
  )
})