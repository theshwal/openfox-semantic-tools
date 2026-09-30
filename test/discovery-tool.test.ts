import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createDiscoveryTool, type DiscoveryToolName } from '../src/discovery/tool.ts'
import type { DiscoveryReport } from '../src/discovery/rank.ts'

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'discovery-tool-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'alpha.ts'), 'export const alpha = "tenant scoped query"\n')
  await writeFile(join(root, 'src', 'beta.ts'), 'export const beta = "unrelated helper"\n')
  return root
}

/**
 * A score answer whose declared value IS the expectation E[level] of its own
 * distribution, as the documented System One contract requires. The answer
 * carries exactly the one question the tool asked, because the transport
 * rejects a response whose answer count differs from the request.
 */
function scoreAnswer(level: number, confidence?: number, questionId: 'relevance' | 'matchStrength' = 'relevance') {
  const probabilities: Record<string, number> = { '0': 0, '1': 0, '2': 0 }
  probabilities[String(level)] = 1
  return {
    answers: {
      [questionId]: { type: 'score', score: level, probabilities, ...(confidence ? { confidence } : {}) },
    },
  }
}

function stub(payload: unknown) {
  const seen: Array<{ body: any; headers: Record<string, string> }> = []
  const transport: typeof fetch = async (_url, init) => {
    seen.push({
      body: JSON.parse(String(init?.body)),
      headers: (init?.headers ?? {}) as Record<string, string>,
    })
    return Response.json(payload)
  }
  return { transport, seen }
}

const ENDPOINT = { endpoint: 'http://localhost/v1/systemone', timeoutMs: 2000 }

async function run(
  name: DiscoveryToolName,
  root: string,
  payload: unknown,
  extra: Record<string, unknown> = {},
) {
  const { transport, seen } = stub(payload)
  const tool = createDiscoveryTool(name, () => ENDPOINT, transport)
  const field = name === 'semantic_search' ? 'query' : 'predicate'
  const result = await tool.execute(
    { [field]: 'Does this scope by tenant?', candidates: ['src/alpha.ts', 'src/beta.ts'], root, ...extra },
    { sessionId: 's', workdir: root },
  )
  return { result, seen }
}

test('both discovery tools register with the semantic_ prefix', async () => {
  const root = await fixtureRoot()
  for (const name of ['semantic_search', 'semantic_scan'] as const) {
    const tool = createDiscoveryTool(name, () => ENDPOINT, async () => Response.json(scoreAnswer(2)))
    assert.equal(tool.name, name)
    assert.match(tool.description, /CANDIDATES/)
  }
})

test('one batched call carries the question and the labelled excerpts', async () => {
  const root = await fixtureRoot()
  const { result, seen } = await run('semantic_search', root, scoreAnswer(2))

  assert.equal(result.success, true, result.error ?? '')
  assert.equal(seen.length, 1, 'one provider call, not one per candidate')
  assert.equal(Object.keys(seen[0].body.questions).length, 1)
  assert.equal(seen[0].body.state.files.length, 2)
  assert.deepEqual(
    seen[0].body.state.files.map((f: { path: string }) => f.path),
    ['src/alpha.ts', 'src/beta.ts'],
  )
  // Only the content the caller asked for is sent.
  assert.ok(seen[0].body.state.files[0].content.includes('tenant scoped'))
})

test('repository-derived content always uses an automatic origin', async () => {
  // Under block-remote-automatic an explicit call would be allowed, so this
  // proves the tool declares automatic and is blocked before sending.
  const { transport, seen } = stub(scoreAnswer(2))
  const tool = createDiscoveryTool(
    'semantic_search',
    () => ({
      endpoint: 'https://api.example.invalid/v1/systemone',
      endpointClass: 'remote',
      egressPolicy: 'block-remote-automatic',
    }),
    transport,
  )
  const root = await fixtureRoot()
  const result = await tool.execute(
    { query: 'x', candidates: ['src/alpha.ts'], root },
    { sessionId: 's', workdir: root },
  )
  assert.equal(result.success, false)
  assert.equal(JSON.parse(result.error!).code, 'egress_blocked')
  assert.equal(seen.length, 0)
})

test('the report is advisory and returns ranked candidates, not a verdict', async () => {
  const root = await fixtureRoot()
  const { result } = await run('semantic_search', root, scoreAnswer(2))
  const report = JSON.parse(result.output!) as DiscoveryReport

  assert.equal(report.advisory, true)
  assert.equal(report.trace.tool, 'semantic_search')
  assert.equal(report.candidates.length, 2)
  assert.ok(report.candidates.every((c) => c.usable))
  assert.equal(report.candidates[0].score, 2)
  assert.ok(report.evidenceBytes > 0)
  assert.ok(report.reportId.startsWith('discovery:semantic_search:'))
  // Ranking must never claim a task is settled.
  assert.ok(!JSON.stringify(report).includes('task complete'))
})

test('a missing or unusable answer ranks nothing instead of inventing relevance', async () => {
  const root = await fixtureRoot()
  // Some of these never reach the ranking stage: a response whose answer count
  // does not match the request is rejected by the transport. That is a failure,
  // never a ranking, so both outcomes are acceptable — a false positive is not.
  for (const payload of [
    { answers: {} },
    { answers: { relevance: { type: 'noul', noul: 0.9 } } },
    { answers: { relevance: { type: 'score', score: 2, probabilities: { 0: 0, 1: 1, 2: 0 } } } },
    { answers: { relevance: { type: 'score', score: 2, probabilities: { 0: 0.34, 1: 0.33, 2: 0.33 } } } },
  ]) {
    const { result } = await run('semantic_search', root, payload)
    if (!result.success) {
      // Rejected outright: no ranking was produced at all.
      assert.ok(result.error)
      continue
    }
    const report = JSON.parse(result.output!) as DiscoveryReport
    assert.ok(report.candidates.every((c) => c.usable === false), JSON.stringify(payload))
    assert.ok(report.candidates.every((c) => c.score === null))
    assert.ok(report.reasons.length > 0, 'a refusal must be explained')
  }
})

test('an answer for a different rubric never ranks, at either layer', async () => {
  const root = await fixtureRoot()
  // The tool declares a three-level rubric, so its score means E[level] over
  // 0..2. A five-level answer is a different question entirely: accepting it
  // would rank candidates on a scale the caller never asked for. The transport
  // rejects it first, and the policy rejects it independently, so the refusal
  // does not depend on a single layer.
  const fiveLevels = {
    answers: {
      relevance: {
        type: 'score',
        score: 3.4,
        probabilities: { 0: 0, 1: 0, 2: 0, 3: 0.3, 4: 0.7 },
      },
    },
  }
  const { result } = await run('semantic_search', root, fiveLevels)
  if (result.success) {
    const report = JSON.parse(result.output!) as DiscoveryReport
    assert.ok(report.candidates.every((c) => c.usable === false), 'a 5-level answer must not rank')
    assert.deepEqual(report.reasons, ['rubric_shape_mismatch'])
  } else {
    assert.equal(JSON.parse(result.error!).code, 'invalid_response')
  }

  // The policy layer is checked directly, so a five-level distribution is
  // refused even if a future transport stopped rejecting it.
  const { rankCandidates } = await import('../src/discovery/rank.ts')
  const ranked = rankCandidates(
    [{ path: 'a.ts', content: 'x' }],
    { relevance: { type: 'score', score: 3.4, probabilities: { 0: 0, 1: 0, 2: 0, 3: 0.3, 4: 0.7 } } } as never,
    'relevance',
  )
  assert.ok(ranked.candidates.every((c) => !c.usable))
  assert.deepEqual(ranked.reasons, ['rubric_shape_mismatch'])

  // A three-level answer whose score exceeds the rubric is refused too.
  const outOfRange = {
    answers: {
      relevance: { type: 'score', score: 2.5, probabilities: { 0: 0, 1: 0.2, 2: 0.8 } },
    },
  }
  const second = await run('semantic_search', root, outOfRange)
  if (second.result.success) {
    const secondReport = JSON.parse(second.result.output!) as DiscoveryReport
    assert.ok(secondReport.candidates.every((c) => c.usable === false))
    assert.ok(secondReport.reasons.includes('score_outside_rubric_range'))
  } else {
    assert.equal(JSON.parse(second.result.error!).code, 'invalid_response')
  }
})

test('provider failures are explicit and never a ranking', async () => {
  const root = await fixtureRoot()
  for (const [expected, makeResponse] of [
    ['http', () => new Response('secret', { status: 503 })],
    ['invalid_response', () => new Response('not json', { status: 200 })],
  ] as const) {
    // A fresh Response per call: a stub must never hand over an already
    // consumed body, and must never reach the real network.
    const tool = createDiscoveryTool(
      'semantic_scan',
      () => ENDPOINT,
      (async () => makeResponse()) as unknown as typeof fetch,
    )
    const result = await tool.execute(
      { predicate: 'x', candidates: ['src/alpha.ts'], root },
      { sessionId: 's', workdir: root },
    )
    assert.equal(result.success, false, expected)
    const parsed = JSON.parse(result.error!)
    assert.equal(parsed.code, expected)
    assert.ok(!result.error!.includes('secret'))
  }
})

test('missing files are reported as skipped, and empty input is a refusal', async () => {
  const root = await fixtureRoot()
  const { result, seen } = await run('semantic_search', root, scoreAnswer(2), {
    candidates: ['src/alpha.ts', 'src/ghost.ts'],
  })
  const report = JSON.parse(result.output!) as DiscoveryReport
  assert.deepEqual(report.trace.skippedPaths, ['src/ghost.ts'])
  assert.equal(seen.length, 1)

  const empty = createDiscoveryTool(
    'semantic_search',
    () => ENDPOINT,
    async () => Response.json(scoreAnswer(2)),
  )
  const refused = await empty.execute(
    { query: 'x', candidates: ['src/ghost.ts'], root },
    { sessionId: 's', workdir: root },
  )
  assert.equal(refused.success, false)
  assert.equal(JSON.parse(refused.error!).code, 'insufficient_evidence')
})

test('invalid arguments never reach the provider', async () => {
  const root = await fixtureRoot()
  const { transport, seen } = stub(scoreAnswer(2))
  const tool = createDiscoveryTool('semantic_search', () => ENDPOINT, transport)
  for (const bad of [
    {},
    { query: '' },
    { query: 'x' },
    { query: 'x', candidates: 'src/alpha.ts' },
    { query: 'x', candidates: [42] },
    { query: 'x', candidates: ['src/alpha.ts'], nope: true },
    { query: 'x', candidates: ['../escape.ts'] },
  ]) {
    const result = await tool.execute(bad, { sessionId: 's', workdir: root })
    assert.equal(result.success, false, JSON.stringify(bad))
  }
  assert.equal(seen.length, 0)
})

test('cancellation stays a failure with its own code', async () => {
  const root = await fixtureRoot()
  const controller = new AbortController()
  controller.abort()
  // An immediate abort means no timer is ever scheduled, so nothing keeps the
  // event loop alive after the assertion.
  const tool = createDiscoveryTool('semantic_scan', () => ({ ...ENDPOINT, timeoutMs: 1 }))
  const result = await tool.execute(
    { predicate: 'x', candidates: ['src/alpha.ts'], root },
    { sessionId: 's', workdir: root, signal: controller.signal },
  )
  assert.equal(result.success, false)
  assert.equal(JSON.parse(result.error!).code, 'aborted')
  assert.equal(controller.signal.aborted, true)
})
