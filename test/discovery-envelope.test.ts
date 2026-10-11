import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createDiscoveryTool } from '../src/discovery/tool.ts'
import type { DiscoveryReport } from '../src/discovery/rank.ts'
import {
  COVERAGE_CAVEAT,
  SCORE_UNVERIFIED_MEANS,
} from '../src/relevance/envelope.ts'
import { DEFAULT_CONFIDENCE_THRESHOLD_PERCENT } from '../src/relevance/threshold.ts'

/**
 * The envelope is only useful if it is UNAVOIDABLE.
 *
 * A developer who adds a new code path that returns a ranked candidate list
 * without the envelope would silently reintroduce the bare-score failure mode
 * this plugin exists to avoid. These tests pin the envelope to every result,
 * not to one call site.
 */

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'envelope-integration-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'alpha.ts'), 'export const tenantScope = "scoped export"\n')
  await writeFile(join(root, 'src', 'beta.ts'), 'export const beta = "unrelated"\n')
  await writeFile(join(root, 'src', 'empty.ts'), '   \n')
  return root
}

function score(level: number, confidence: number | null = null) {
  const probabilities: Record<string, number> = { '0': 0, '1': 0, '2': 0 }
  probabilities[String(level)] = 1
  return {
    type: 'score',
    score: level,
    probabilities,
    ...(confidence === null ? {} : { confidence }),
  }
}

function answersFor(body: any, levels: readonly number[], confidence: number | null = null) {
  const answers: Record<string, unknown> = {}
  Object.keys(body.questions).forEach((id, index) => {
    answers[id] = score(levels[index] ?? 0, confidence)
  })
  return { answers }
}

const ENDPOINT = { endpoint: 'http://localhost/v1/systemone', timeoutMs: 2000 }

function stub(
  respond: (body: any) => Response | unknown,
  settings: () => Record<string, unknown> = () => ENDPOINT,
) {
  const transport: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    const response = respond(body)
    return response instanceof Response ? response : Response.json(response)
  }
  return transport
}

test('every semantic result carries the full envelope', async () => {
  const root = await fixtureRoot()
  const tool = createDiscoveryTool(
    'semantic_search',
    () => ENDPOINT,
    stub((body) => answersFor(body, [2, 0], 0.9)),
  )
  const result = await tool.execute(
    { query: 'tenant scope', candidates: ['src/alpha.ts', 'src/beta.ts'], root },
    { sessionId: 's', workdir: root },
  )
  assert.equal(result.success, true, result.error ?? '')
  const report = JSON.parse(result.output!) as DiscoveryReport

  assert.ok(report.relevance, 'A1-4: a result without the envelope must not be constructible')
  assert.equal(report.relevance.caveats.scoreUnverifiedMeans, SCORE_UNVERIFIED_MEANS)
  assert.equal(report.relevance.caveats.coverageCaveat, COVERAGE_CAVEAT)
  assert.equal(report.relevance.searched.candidatesScored, 2)
  // The reported dial is the resolved FRACTION, whatever spelling the operator
  // typed. The registered default is in percent, so it is converted here.
  assert.equal(
    report.relevance.threshold,
    DEFAULT_CONFIDENCE_THRESHOLD_PERCENT / 100,
  )
})

test('a skipped file is named with its reason, not counted', async () => {
  const root = await fixtureRoot()
  const tool = createDiscoveryTool(
    'semantic_search',
    () => ENDPOINT,
    stub((body) => answersFor(body, [2], 0.9)),
  )
  const result = await tool.execute(
    { query: 'tenant', candidates: ['src/alpha.ts', 'src/empty.ts'], root },
    { sessionId: 's', workdir: root },
  )
  assert.equal(result.success, true, result.error ?? '')
  const report = JSON.parse(result.output!) as DiscoveryReport
  const skipped = report.relevance.skipped
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0].path, 'src/empty.ts')
  assert.equal(skipped[0].reason, 'empty')
})

test('each candidate is labelled above or below the operator threshold', async () => {
  const root = await fixtureRoot()
  const tool = createDiscoveryTool(
    'semantic_search',
    () => ENDPOINT,
    stub((body) => answersFor(body, [2, 0], 0.8)),
  )
  const result = await tool.execute(
    { query: 'tenant', candidates: ['src/alpha.ts', 'src/beta.ts'], root },
    { sessionId: 's', workdir: root },
  )
  const report = JSON.parse(result.output!) as DiscoveryReport
  assert.equal(report.relevance.threshold, 0.75)
  // Both candidates carry confidence 0.8, above the 0.75 default.
  for (const candidate of report.candidates) {
    assert.equal(candidate.thresholdStatus, 'above', `${candidate.path}`)
    assert.equal(candidate.threshold, 0.75)
  }
})

test('a below-threshold candidate stays visible and marked', async () => {
  const root = await fixtureRoot()
  const tool = createDiscoveryTool(
    'semantic_search',
    () => ENDPOINT,
    stub((body) => answersFor(body, [2, 0], 0.5)),
  )
  const result = await tool.execute(
    { query: 'tenant', candidates: ['src/alpha.ts', 'src/beta.ts'], root },
    { sessionId: 's', workdir: root },
  )
  const report = JSON.parse(result.output!) as DiscoveryReport
  assert.equal(report.candidates.length, 2, 'A2-8: a below-threshold candidate is never hidden')
  for (const candidate of report.candidates) {
    assert.equal(candidate.thresholdStatus, 'below')
    assert.equal(candidate.threshold, 0.75)
  }
})

test('a candidate with no usable number is unknown, never above', async () => {
  const root = await fixtureRoot()
  const tool = createDiscoveryTool(
    'semantic_search',
    () => ENDPOINT,
    stub((body) => ({
      answers: {
        relevance_0: score(2, 0.99),
        // No confidence at all: an unavailable number must not be promoted
        // by a permissive threshold.
        relevance_1: { type: 'score', score: 2, probabilities: { '0': 0, '1': 0, '2': 1 } },
      },
    })),
  )
  const result = await tool.execute(
    { query: 'tenant', candidates: ['src/alpha.ts', 'src/beta.ts'], root },
    { sessionId: 's', workdir: root },
  )
  const report = JSON.parse(result.output!) as DiscoveryReport
  const beta = report.candidates.find((c) => c.path === 'src/beta.ts')!
  assert.equal(beta.confidence, null)
  assert.equal(beta.thresholdStatus, 'unknown')
})

test('a below-threshold candidate states its reason in words', async () => {
  const root = await fixtureRoot()
  const tool = createDiscoveryTool(
    'semantic_search',
    () => ENDPOINT,
    stub((body) => answersFor(body, [2, 0], 0.5)),
  )
  const result = await tool.execute(
    { query: 'tenant', candidates: ['src/alpha.ts', 'src/beta.ts'], root },
    { sessionId: 's', workdir: root },
  )
  const report = JSON.parse(result.output!) as DiscoveryReport
  for (const candidate of report.candidates) {
    assert.equal(candidate.thresholdStatus, 'below')
    // A2-8: marked WITH its reason, so a caller reading one field learns why.
    assert.match(candidate.thresholdReason, /below the threshold 0\.75/)
    // And the reason must not read as a dismissal: it is still a lead.
    assert.match(candidate.thresholdReason, /still worth confirming/)
    assert.match(candidate.thresholdReason, new RegExp(String(candidate.confidence)))
  }
})

test('an unknown candidate explains that nothing was judged', async () => {
  const root = await fixtureRoot()
  const tool = createDiscoveryTool(
    'semantic_search',
    () => ENDPOINT,
    stub((body) => ({
      answers: {
        relevance_0: score(2, 0.99),
        relevance_1: { type: 'score', score: 2, probabilities: { '0': 0, '1': 0, '2': 1 } },
      },
    })),
  )
  const result = await tool.execute(
    { query: 'tenant', candidates: ['src/alpha.ts', 'src/beta.ts'], root },
    { sessionId: 's', workdir: root },
  )
  const report = JSON.parse(result.output!) as DiscoveryReport
  const beta = report.candidates.find((c) => c.path === 'src/beta.ts')!
  assert.equal(beta.thresholdStatus, 'unknown')
  // The distinction that matters: unjudged is not the same as rejected.
  assert.match(beta.thresholdReason, /no usable provider confidence/)
  assert.equal(beta.thresholdReason.includes('below'), false)
})

test('a local-recall candidate is not classified against the provider dial', async () => {
  const root = await fixtureRoot()
  const tool = createDiscoveryTool(
    'semantic_search',
    () => ({
      endpoint: 'https://api.example.invalid/v1/systemone',
      endpointClass: 'remote',
      egressPolicy: 'block-remote-automatic',
    }),
    stub(() => new Response('blocked', { status: 503 })),
  )
  const result = await tool.execute(
    { query: 'tenant', root },
    { sessionId: 's', workdir: root },
  )
  const report = JSON.parse(result.output!) as DiscoveryReport
  assert.ok(report.candidates.length > 0)
  for (const candidate of report.candidates) {
    assert.equal(candidate.rankingSource, 'local-recall')
    assert.equal(candidate.thresholdStatus, 'unknown')
    assert.match(candidate.thresholdReason, /local lexical recall/)
    assert.match(candidate.thresholdReason, /not classified against the threshold/)
  }
})

test('a zero threshold does not turn an unusable answer into a pass', async () => {
  const root = await fixtureRoot()
  const tool = createDiscoveryTool(
    'semantic_search',
    () => ({ ...ENDPOINT, confidenceThreshold: 0 }),
    stub((body) => ({
      answers: {
        // A distribution that normalizes and is in range, but concentrates
        // on no single level: the ranking refuses it as a usable answer.
        relevance_0: { type: 'score', score: 0.5, probabilities: { '0': 0.34, '1': 0.33, '2': 0.33 } },
      },
    })),
  )
  const result = await tool.execute(
    { query: 'tenant', candidates: ['src/alpha.ts'], root },
    { sessionId: 's', workdir: root },
  )
  assert.equal(result.success, true, result.error ?? '')
  const report = JSON.parse(result.output!) as DiscoveryReport
  assert.equal(report.candidates[0].usable, false)
  assert.equal(report.candidates[0].thresholdStatus, 'unknown')
})

test('the threshold setting applies without rebuilding the tool', async () => {
  const root = await fixtureRoot()
  let dial = 0.75
  const tool = createDiscoveryTool(
    'semantic_search',
    () => ({ ...ENDPOINT, confidenceThreshold: dial }),
    stub((body) => answersFor(body, [2], 0.8)),
  )
  const before = await tool.execute(
    { query: 'tenant', candidates: ['src/alpha.ts'], root },
    { sessionId: 's', workdir: root },
  )
  assert.equal(
    (JSON.parse(before.output!) as DiscoveryReport).candidates[0].thresholdStatus,
    'above',
  )

  dial = 0.95
  const after = await tool.execute(
    { query: 'tenant', candidates: ['src/alpha.ts'], root },
    { sessionId: 's', workdir: root },
  )
  const report = JSON.parse(after.output!) as DiscoveryReport
  assert.equal(report.candidates[0].thresholdStatus, 'below')
  assert.equal(report.candidates[0].threshold, 0.95)
})

test('a local-only fallback still carries the envelope and says why', async () => {
  const root = await fixtureRoot()
  const tool = createDiscoveryTool(
    'semantic_search',
    () => ({
      endpoint: 'https://api.example.invalid/v1/systemone',
      endpointClass: 'remote',
      egressPolicy: 'block-remote-automatic',
    }),
    stub(() => new Response('blocked', { status: 503 })),
  )
  const result = await tool.execute({ query: 'tenant', root }, { sessionId: 's', workdir: root })
  assert.equal(result.success, true)
  const report = JSON.parse(result.output!) as DiscoveryReport
  assert.ok(report.relevance)
  // No semantic number exists, so the envelope must not pretend otherwise.
  assert.match(report.relevance.caveats.scoreMeans, /No semantic number/i)
  assert.ok(report.relevance.skipped.length >= 0)
})

test('an empty result set still states the coverage caveat', async () => {
  const root = await fixtureRoot()
  const tool = createDiscoveryTool(
    'semantic_search',
    () => ENDPOINT,
    stub((body) => ({
      answers: Object.fromEntries(
        Object.keys(body.questions).map((id) => [id, score(0, 0.1)]),
      ),
    })),
  )
  const result = await tool.execute(
    { query: 'tenant', candidates: ['src/alpha.ts'], root },
    { sessionId: 's', workdir: root },
  )
  assert.equal(result.success, true, result.error ?? '')
  const report = JSON.parse(result.output!) as DiscoveryReport
  assert.equal(report.candidates.length, 1)
  assert.equal(report.candidates[0].thresholdStatus, 'below')
  assert.equal(report.relevance.caveats.coverageCaveat, COVERAGE_CAVEAT)
})

test('every search tool declares the envelope, both search and scan', async () => {
  const root = await fixtureRoot()
  for (const [name, args] of [
    ['semantic_search', { query: 'tenant', candidates: ['src/alpha.ts'], root }],
    ['semantic_scan', { predicate: 'tenant', candidates: ['src/alpha.ts'], root }],
  ] as const) {
    const tool = createDiscoveryTool(name, () => ENDPOINT, stub((body) => answersFor(body, [2], 0.9)))
    const result = await tool.execute(args, { sessionId: 's', workdir: root })
    assert.equal(result.success, true, `${name}: ${result.error ?? ''}`)
    const report = JSON.parse(result.output!) as DiscoveryReport
    assert.ok(report.relevance, `${name} must carry the relevance envelope`)
    assert.equal(report.relevance.searched.candidatesScored, 1, name)
  }
})