import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createDiscoveryTool } from '../src/discovery/tool.ts'
import { localRecall } from '../src/discovery/recall.ts'
import { MAX_FILE_BYTES } from '../src/discovery/read.ts'
import type { DiscoveryReport } from '../src/discovery/rank.ts'
import { COVERAGE_CAVEAT } from '../src/relevance/envelope.ts'

/**
 * B1-17..B1-20: what the search COVERED, and what it never saw.
 *
 * The failure this prevents is quiet and expensive: "nothing found" reads as
 * "the code does not exist", when in truth the file was too large, binary, in a
 * pruned directory, or simply never matched a lexical token. Those are opposite
 * conclusions and a bare candidate list cannot tell them apart.
 *
 * B1-18 is the hard one: when the candidate list comes back EMPTY there is no
 * envelope to carry the reasons, so they have to survive into the refusal
 * itself. Otherwise the caller has strictly less information than on a hit.
 */

const ENDPOINT = { endpoint: 'http://localhost/v1/systemone', timeoutMs: 2000 }

function score(level: number, confidence: number) {
  const probabilities: Record<string, number> = { '0': 0, '1': 0, '2': 0 }
  probabilities[String(level)] = 1
  return { type: 'score', score: level, probabilities, confidence }
}

function stub(levels: readonly number[] = [2], confidence = 0.9) {
  const transport: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    const answers: Record<string, unknown> = {}
    Object.keys(body.questions).forEach((id, index) => {
      answers[id] = score(levels[index] ?? levels[levels.length - 1] ?? 0, confidence)
    })
    return Response.json({ answers })
  }
  return transport
}

async function emptyRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'coverage-empty-'))
}

test('B1-18 an empty candidate list still NAMES every file that was not read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coverage-allempty-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'a.bin'), Buffer.from([0x00, 0x01, 0x00, 0x02]))
  await writeFile(join(root, 'src', 'b.ts'), '   \n')

  const tool = createDiscoveryTool('semantic_scan', () => ENDPOINT, stub([2]))
  // Every requested path is unusable, so the result set is empty. The reasons
  // must survive into the refusal: it is the only place left to carry them,
  // and without them the caller knows strictly less than on a hit.
  const result = await tool.execute(
    { predicate: 'scoped', candidates: ['src/a.bin', 'src/b.ts', 'src/ghost.ts'], root },
    { sessionId: 's', workdir: root },
  )
  assert.equal(result.success, false)
  assert.equal(JSON.parse(result.error!).code, 'insufficient_evidence')
  const message = JSON.parse(result.error!).message as string

  assert.match(message, /src\/a\.bin \(binary\)/, 'the binary file must be named')
  assert.match(message, /src\/b\.ts \(empty\)/, 'the empty file must be named')
  assert.match(message, /src\/ghost\.ts \(missing\)/, 'the missing file must be named')
  // And it must not read as a claim that the code does not exist.
  assert.equal(
    /does not exist|not found in/i.test(message),
    false,
    'an unreadable file is not proof of absence',
  )
})

test('B1-18 an empty local recall names what it could not read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coverage-recall-empty-'))
  await mkdir(join(root, 'src'), { recursive: true })
  // Matched by the lexical scan, refused by the reader: too large to transmit.
  await writeFile(
    join(root, 'src', 'huge.ts'),
    'authentication '.repeat(Math.ceil(MAX_FILE_BYTES / 15) + 8),
  )

  const tool = createDiscoveryTool('semantic_search', () => ENDPOINT, stub([2]))
  const result = await tool.execute(
    { query: 'authentication', root },
    { sessionId: 's', workdir: root },
  )
  assert.equal(result.success, false)
  const message = JSON.parse(result.error!).message as string
  assert.match(message, /src\/huge\.ts \(too-large\)/)
})

test('B1-18 the skip list in a refusal is bounded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coverage-allempty-many-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'a.ts'), '   \n')
  // 40 unreadable paths: the maximum one call accepts.
  const candidates = [
    'src/a.ts',
    ...Array.from({ length: 39 }, (_, i) => `src/missing-${i}.ts`),
  ]

  const tool = createDiscoveryTool('semantic_scan', () => ENDPOINT, stub([2]))
  const result = await tool.execute(
    { predicate: 'scoped', candidates, root },
    { sessionId: 's', workdir: root },
  )
  assert.equal(result.success, false)
  const message = JSON.parse(result.error!).message as string
  // Bounded, so a refusal can never turn into a directory listing.
  assert.ok(message.length < 1500, `the refusal grew to ${message.length} characters`)
  assert.match(message, /and \d+ more/)
})

test('B1-18 a repository with no usable file is refused, never reported as "nothing relevant"', async () => {
  const root = await emptyRepo()
  const tool = createDiscoveryTool('semantic_search', () => ENDPOINT, stub())
  const result = await tool.execute({ query: 'authentication', root }, { sessionId: 's', workdir: root })
  assert.equal(result.success, false, 'an empty repository must not yield an empty success')
  assert.equal(JSON.parse(result.error!).code, 'insufficient_evidence')
})

test('B1-17 a fully-ignored repository says so rather than looking empty', async () => {
  const root = await emptyRepo()
  // Everything the walk would normally look at is inside a pruned directory.
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'authentication token handling\n')

  const recall = await localRecall(root, 'authentication')
  assert.equal(recall.candidates.length, 0)
  assert.ok(recall.ignoredDirectories >= 1, 'the pruned directory must be counted')

  const tool = createDiscoveryTool('semantic_search', () => ENDPOINT, stub())
  const result = await tool.execute({ query: 'authentication', root }, { sessionId: 's', workdir: root })
  assert.equal(result.success, false)
  assert.equal(JSON.parse(result.error!).code, 'insufficient_evidence')
})

test('B1-18 a partially-ignored repository names every file it could not use', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coverage-partial-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'auth.ts'), 'export const authentication = true\n')
  // Oversized: real content, but never a valid candidate.
  await writeFile(
    join(root, 'src', 'huge.ts'),
    'authentication '.repeat(Math.ceil(MAX_FILE_BYTES / 15) + 8),
  )
  // Binary: readable, but not text.
  await writeFile(join(root, 'src', 'blob.bin'), Buffer.from([0x00, 0x01, 0x00, 0x02]))
  // Empty: readable, but says nothing.
  await writeFile(join(root, 'src', 'blank.ts'), '   \n')

  const recall = await localRecall(root, 'authentication')
  const skippedPaths = recall.skipped.map((entry) => entry.path).sort()
  assert.ok(skippedPaths.includes('src/blob.bin'), 'the binary file must be named')
  assert.ok(skippedPaths.includes('src/blank.ts'), 'the empty file must be named')
  assert.ok(skippedPaths.includes('src/huge.ts'), 'the oversized file must be named')
  assert.ok(
    recall.skipped.every((entry) => entry.path && entry.reason),
    'every skip carries a path and a reason',
  )
  // The usable file was still found: skipping is not failing.
  assert.ok(recall.candidates.some((c) => c.path === 'src/auth.ts'))

  const tool = createDiscoveryTool('semantic_search', () => ENDPOINT, stub([2]))
  const result = await tool.execute({ query: 'authentication', root }, { sessionId: 's', workdir: root })
  assert.equal(result.success, true, result.error ?? '')
  const report = JSON.parse(result.output!) as DiscoveryReport
  assert.equal(report.relevance.skipped.length, 3, 'all three unusable files are reported')
  assert.ok(report.relevance.searched.filesScanned >= 4)
})

test('B1-19 an empty candidate list still carries the caveat', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coverage-nomatch-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'alpha.ts'), 'export const unrelated = 1\n')

  const tool = createDiscoveryTool('semantic_search', () => ENDPOINT, stub([0], 0.1))
  const result = await tool.execute(
    { query: 'zzzz-no-such-concept-qqqq', candidates: ['src/alpha.ts'], root },
    { sessionId: 's', workdir: root },
  )
  assert.equal(result.success, true, result.error ?? '')
  const report = JSON.parse(result.output!) as DiscoveryReport
  // The file WAS judged, and the answer was "no bearing": usable, below the dial.
  assert.equal(report.candidates.length, 1)
  assert.equal(report.candidates[0].thresholdStatus, 'below')
  assert.equal(report.relevance.caveats.coverageCaveat, COVERAGE_CAVEAT)
  assert.match(report.relevance.caveats.coverageCaveat, /does not prove absence/i)
})

test('B1-17 the explicit-candidate path reports skips too', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coverage-explicit-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'alpha.ts'), 'export const a = 1\n')
  await writeFile(join(root, 'src', 'blank.ts'), '   \n')

  const tool = createDiscoveryTool('semantic_scan', () => ENDPOINT, stub([2]))
  const result = await tool.execute(
    { predicate: 'scoped', candidates: ['src/alpha.ts', 'src/ghost.ts', 'src/blank.ts'], root },
    { sessionId: 's', workdir: root },
  )
  assert.equal(result.success, true, result.error ?? '')
  const report = JSON.parse(result.output!) as DiscoveryReport
  assert.deepEqual(
    report.relevance.skipped.map((entry) => entry.path).sort(),
    ['src/blank.ts', 'src/ghost.ts'],
  )
  assert.deepEqual(
    [...new Set(report.relevance.skipped.map((entry) => entry.reason))].sort(),
    ['empty', 'missing'],
  )
})

test('the envelope always reports the searched count even with no recall', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coverage-counts-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'alpha.ts'), 'export const a = 1\n')
  await writeFile(join(root, 'src', 'beta.ts'), 'export const b = 2\n')

  const tool = createDiscoveryTool('semantic_scan', () => ENDPOINT, stub([2, 2]))
  const result = await tool.execute(
    { predicate: 'scoped', candidates: ['src/alpha.ts', 'src/beta.ts'], root },
    { sessionId: 's', workdir: root },
  )
  const report = JSON.parse(result.output!) as DiscoveryReport
  assert.equal(report.relevance.searched.candidatesScored, 2)
  assert.equal(report.relevance.searched.filesScanned, 2)
  assert.equal(report.relevance.searched.ignoredDirectories, undefined)
  assert.deepEqual(report.relevance.skipped, [])
})