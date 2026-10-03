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
  await writeFile(join(root, 'src', 'alpha.ts'), 'export const tenantScope = "tenant scoped export query"\n')
  await writeFile(join(root, 'src', 'beta.ts'), 'export const beta = "unrelated helper"\n')
  await writeFile(join(root, 'src', 'gamma.ts'), 'export const tenantAudit = "tenant audit log"\n')
  return root
}

function score(level: number, confidence?: number) {
  const probabilities: Record<string, number> = { '0': 0, '1': 0, '2': 0 }
  probabilities[String(level)] = 1
  return { type: 'score', score: level, probabilities, ...(confidence === undefined ? {} : { confidence }) }
}

function answersFor(body: any, levels: readonly number[] = [2, 0, 1]) {
  const ids = Object.keys(body.questions)
  const answers: Record<string, unknown> = {}
  ids.forEach((id, index) => {
    answers[id] = score(levels[index] ?? levels[levels.length - 1] ?? 0)
  })
  return { answers }
}

function dynamicStub(
  respond: (body: any, call: number) => Response | unknown = (body) => answersFor(body),
) {
  const seen: Array<{ body: any; headers: Record<string, string> }> = []
  let call = 0
  const transport: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    seen.push({ body, headers: (init?.headers ?? {}) as Record<string, string> })
    const response = respond(body, call++)
    return response instanceof Response ? response : Response.json(response)
  }
  return { transport, seen }
}

const ENDPOINT = { endpoint: 'http://localhost/v1/systemone', timeoutMs: 2000 }

async function runExplicit(
  name: DiscoveryToolName,
  root: string,
  levels: readonly number[] = [2, 0],
) {
  const { transport, seen } = dynamicStub((body) => answersFor(body, levels))
  const tool = createDiscoveryTool(name, () => ENDPOINT, transport)
  const field = name === 'semantic_search' ? 'query' : 'predicate'
  const result = await tool.execute(
    {
      [field]: 'Does this scope by tenant?',
      candidates: ['src/alpha.ts', 'src/beta.ts'],
      root,
    },
    { sessionId: 's', workdir: root },
  )
  return { result, seen }
}

test('semantic_search can omit candidates while semantic_scan still requires them', async () => {
  const root = await fixtureRoot()
  const { transport } = dynamicStub()
  const search = createDiscoveryTool('semantic_search', () => ENDPOINT, transport)
  const scan = createDiscoveryTool('semantic_scan', () => ENDPOINT, transport)

  assert.deepEqual((search.parameters as any).required, ['query'])
  assert.deepEqual((scan.parameters as any).required, ['predicate', 'candidates'])

  const scanResult = await scan.execute({ predicate: 'tenant scope', root }, { sessionId: 's', workdir: root })
  assert.equal(scanResult.success, false)
  assert.equal(JSON.parse(scanResult.error!).code, 'invalid_arguments')
})

test('one provider call contains one score question per candidate', async () => {
  const root = await fixtureRoot()
  const { result, seen } = await runExplicit('semantic_search', root, [2, 0])

  assert.equal(result.success, true, result.error ?? '')
  assert.equal(seen.length, 1, 'reranking stays one batched provider call')
  assert.equal(Object.keys(seen[0].body.questions).length, 2)
  assert.deepEqual(Object.keys(seen[0].body.questions).sort(), ['relevance_0', 'relevance_1'])
  assert.equal(seen[0].body.state.files.length, 2)
  assert.match(seen[0].body.questions.relevance_0.instructions, /src\/alpha\.ts/)
  assert.match(seen[0].body.questions.relevance_1.instructions, /src\/beta\.ts/)
})

test('semantic ranking is per-file rather than one score copied to every file', async () => {
  const root = await fixtureRoot()
  const { result } = await runExplicit('semantic_search', root, [0, 2])
  const report = JSON.parse(result.output!) as DiscoveryReport

  assert.equal(report.semanticApplied, true)
  assert.deepEqual(report.candidates.map((candidate) => candidate.path), ['src/beta.ts', 'src/alpha.ts'])
  assert.deepEqual(report.candidates.map((candidate) => candidate.score), [2, 0])
  assert.ok(report.candidates.every((candidate) => candidate.rankingSource === 'semantic'))
})

test('semantic_search performs bounded local recall before semantic reranking', async () => {
  const root = await fixtureRoot()
  const { transport, seen } = dynamicStub((body) => {
    // Make alpha strongest even if recall also surfaced gamma.
    const answers: Record<string, unknown> = {}
    body.state.files.forEach((file: { path: string }, index: number) => {
      answers[`relevance_${index}`] = score(file.path.endsWith('alpha.ts') ? 2 : 1)
    })
    return { answers }
  })
  const tool = createDiscoveryTool('semantic_search', () => ENDPOINT, transport)
  const result = await tool.execute(
    { query: 'tenant export', root },
    { sessionId: 's', workdir: root },
  )
  assert.equal(result.success, true, result.error ?? '')
  assert.equal(seen.length, 1)
  const report = JSON.parse(result.output!) as DiscoveryReport
  assert.equal(report.recall?.used, true)
  assert.ok((report.recall?.scannedFiles ?? 0) >= 3)
  assert.ok(report.trace.candidatePaths.includes('src/alpha.ts'))
  assert.equal(report.candidates[0].path, 'src/alpha.ts')
  assert.equal(report.semanticApplied, true)
})

test('provider failure after local recall returns an explicit local-only shortlist', async () => {
  const root = await fixtureRoot()
  const { transport, seen } = dynamicStub(() => new Response('secret-provider-body', { status: 503 }))
  const tool = createDiscoveryTool('semantic_search', () => ENDPOINT, transport)
  const result = await tool.execute(
    { query: 'tenant export', root },
    { sessionId: 's', workdir: root },
  )
  assert.equal(result.success, true)
  assert.equal(seen.length, 1)
  const report = JSON.parse(result.output!) as DiscoveryReport
  assert.equal(report.semanticApplied, false)
  assert.equal(report.provider, null)
  assert.ok(report.reasons.includes('semantic_fallback:http'))
  assert.equal(report.candidates[0].rankingSource, 'local-recall')
  assert.ok((report.candidates[0].localRecallScore ?? 0) > 0)
  assert.equal(result.output!.includes('secret-provider-body'), false)
})

test('egress-blocked auto-recall search falls back locally without sending content', async () => {
  const root = await fixtureRoot()
  const { transport, seen } = dynamicStub()
  const tool = createDiscoveryTool(
    'semantic_search',
    () => ({
      endpoint: 'https://api.example.invalid/v1/systemone',
      endpointClass: 'remote',
      egressPolicy: 'block-remote-automatic',
    }),
    transport,
  )
  const result = await tool.execute(
    { query: 'tenant export', root },
    { sessionId: 's', workdir: root },
  )
  assert.equal(result.success, true)
  assert.equal(seen.length, 0)
  const report = JSON.parse(result.output!) as DiscoveryReport
  assert.equal(report.semanticApplied, false)
  assert.ok(report.reasons.includes('semantic_fallback:egress_blocked'))
})

test('explicit candidates preserve fail-closed provider behavior', async () => {
  const root = await fixtureRoot()
  const { transport, seen } = dynamicStub(() => new Response('secret', { status: 503 }))
  const tool = createDiscoveryTool('semantic_search', () => ENDPOINT, transport)
  const result = await tool.execute(
    { query: 'tenant export', candidates: ['src/alpha.ts'], root },
    { sessionId: 's', workdir: root },
  )
  assert.equal(result.success, false)
  assert.equal(JSON.parse(result.error!).code, 'http')
  assert.equal(seen.length, 1)
  assert.equal(result.error!.includes('secret'), false)
})

test('repository-derived explicit content still uses an automatic origin', async () => {
  const root = await fixtureRoot()
  const { transport, seen } = dynamicStub()
  const tool = createDiscoveryTool(
    'semantic_search',
    () => ({
      endpoint: 'https://api.example.invalid/v1/systemone',
      endpointClass: 'remote',
      egressPolicy: 'block-remote-automatic',
    }),
    transport,
  )
  const result = await tool.execute(
    { query: 'x', candidates: ['src/alpha.ts'], root },
    { sessionId: 's', workdir: root },
  )
  assert.equal(result.success, false)
  assert.equal(JSON.parse(result.error!).code, 'egress_blocked')
  assert.equal(seen.length, 0)
})

test('an unusable answer invalidates only its own candidate', async () => {
  const root = await fixtureRoot()
  const { transport } = dynamicStub((body) => ({
    answers: {
      relevance_0: score(2),
      relevance_1: { type: 'score', score: 2, probabilities: { 0: 0, 1: 1, 2: 0 } },
    },
  }))
  const tool = createDiscoveryTool('semantic_search', () => ENDPOINT, transport)
  const result = await tool.execute(
    { query: 'tenant', candidates: ['src/alpha.ts', 'src/beta.ts'], root },
    { sessionId: 's', workdir: root },
  )
  const report = JSON.parse(result.output!) as DiscoveryReport
  assert.equal(report.candidates[0].path, 'src/alpha.ts')
  assert.equal(report.candidates[0].usable, true)
  const beta = report.candidates.find((candidate) => candidate.path === 'src/beta.ts')!
  assert.equal(beta.usable, false)
  assert.ok(report.reasons.some((reason) => reason.startsWith('src/beta.ts:')))
})

test('semantic_scan also gets per-candidate scores but never auto-scans the repo', async () => {
  const root = await fixtureRoot()
  const { result, seen } = await runExplicit('semantic_scan', root, [1, 2])
  assert.equal(result.success, true)
  assert.deepEqual(Object.keys(seen[0].body.questions).sort(), ['matchStrength_0', 'matchStrength_1'])
  const report = JSON.parse(result.output!) as DiscoveryReport
  assert.equal(report.recall, undefined)
  assert.equal(report.candidates[0].path, 'src/beta.ts')
})

test('missing explicit files are reported as skipped', async () => {
  const root = await fixtureRoot()
  const { transport } = dynamicStub((body) => answersFor(body, [2]))
  const tool = createDiscoveryTool('semantic_search', () => ENDPOINT, transport)
  const result = await tool.execute(
    { query: 'tenant', candidates: ['src/alpha.ts', 'src/ghost.ts'], root },
    { sessionId: 's', workdir: root },
  )
  const report = JSON.parse(result.output!) as DiscoveryReport
  assert.deepEqual(report.trace.skippedPaths, ['src/ghost.ts'])
})

test('invalid arguments do not reach the provider', async () => {
  const root = await fixtureRoot()
  const { transport, seen } = dynamicStub()
  const search = createDiscoveryTool('semantic_search', () => ENDPOINT, transport)
  const scan = createDiscoveryTool('semantic_scan', () => ENDPOINT, transport)

  for (const bad of [
    {},
    { query: '' },
    { query: 'x', candidates: 'src/alpha.ts' },
    { query: 'x', candidates: [42] },
    { query: 'x', candidates: ['src/alpha.ts'], nope: true },
    { query: 'x', candidates: ['../escape.ts'] },
  ]) {
    const result = await search.execute(bad, { sessionId: 's', workdir: root })
    assert.equal(result.success, false, JSON.stringify(bad))
  }
  const noCandidates = await scan.execute({ predicate: 'x', root }, { sessionId: 's', workdir: root })
  assert.equal(noCandidates.success, false)
  assert.equal(seen.length, 0)
})

test('a no-match local recall is an explicit insufficient-evidence result', async () => {
  const root = await fixtureRoot()
  const { transport, seen } = dynamicStub()
  const tool = createDiscoveryTool('semantic_search', () => ENDPOINT, transport)
  const result = await tool.execute(
    { query: 'zzzz-no-such-concept-qqqq', root },
    { sessionId: 's', workdir: root },
  )
  assert.equal(result.success, false)
  assert.equal(JSON.parse(result.error!).code, 'insufficient_evidence')
  assert.equal(seen.length, 0)
})

test('cancellation on explicit semantic discovery remains a failure', async () => {
  const root = await fixtureRoot()
  const controller = new AbortController()
  controller.abort()
  const tool = createDiscoveryTool('semantic_scan', () => ({ ...ENDPOINT, timeoutMs: 1 }))
  const result = await tool.execute(
    { predicate: 'x', candidates: ['src/alpha.ts'], root },
    { sessionId: 's', workdir: root, signal: controller.signal },
  )
  assert.equal(result.success, false)
  assert.equal(JSON.parse(result.error!).code, 'aborted')
})
