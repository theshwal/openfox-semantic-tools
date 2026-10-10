import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, type Server } from 'node:http'

import { buildCases, runConformanceSuite } from '../scripts/conformance-suite.ts'
import { campaignCommand, findLeak, runCampaign, toEvidenceEntry, type CampaignTarget } from '../scripts/conformance-campaign.ts'

/** A runtime that answers the base protocol and rejects a malformed payload. */
function startRuntime(handler?: (body: string) => { status: number; payload?: unknown }): Promise<{ server: Server; url: string }> {
  const conformant = (body: string) => {
    const { questions } = JSON.parse(body) as { questions: Record<string, { type: string; instructions?: string; criteria?: string[] | Record<string, string> }> }
    // A conformant runtime refuses a payload whose question carries no
    // instructions: that is the malformed-wire probe.
    if (Object.values(questions).some((q) => !q?.instructions)) return { status: 400, payload: { error: 'invalid question' } }
    return {
      status: 200,
      payload: {
        answers: Object.fromEntries(
          Object.entries(questions).map(([id, question]) => {
            const criteria = Array.isArray(question.criteria) ? question.criteria : Object.keys(question.criteria ?? {})
            if (question.type === 'noul') return [id, { type: 'noul', noul: 0.8 }]
            if (question.type === 'choice') {
              return [id, { type: 'choice', choice: criteria[0], probabilities: Object.fromEntries(criteria.map((label, index) => [label, index === 0 ? 0.6 : 0.4])) }]
            }
            return [id, { type: 'score', score: 1, probabilities: { '0': 0.3, '1': 0.7 } }]
          }),
        ),
      },
    }
  }
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = []
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
    incoming.on('end', () => {
      const { status, payload } = (handler ?? conformant)(Buffer.concat(chunks).toString('utf8'))
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(payload === undefined ? '' : JSON.stringify(payload))
    })
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/systemone` }),
    ),
  )
}

async function stop(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

test('the case list is declared once and never varies per runtime', () => {
  const withoutExtras = buildCases({})
  const withExtras = buildCases({ model: 'm', unsupportedModel: 'u' })
  // Only the two operator-configured cases may differ, and they are added, never
  // substituted: no runtime-specific case is ever introduced.
  assert.deepEqual(withoutExtras.map((c) => c.id), withExtras.map((c) => c.id).filter((id) => id !== 'model-supplied' && id !== 'unsupported-model'))
  assert.ok(withExtras.some((c) => c.id === 'model-supplied'))
  assert.ok(withExtras.some((c) => c.id === 'unsupported-model'))
  // Declared once: the same object is returned for the same configuration, so
  // no per-runtime edit is possible.
  assert.deepEqual(buildCases({}), withoutExtras)
})

test('the same suite runs unchanged against two different runtimes', async () => {
  const a = await startRuntime()
  const b = await startRuntime((body) => {
    // A runtime with the observed Kev-shaped deviation: array criteria refused,
    // object criteria served.
    const { questions } = JSON.parse(body) as { questions: Record<string, { type: string; instructions?: string; criteria?: string[] | Record<string, string> }> }
    // The malformed-wire probe is `{ q: { type: 'noul' } }`, with no
    // instructions: a conformant runtime rejects it, and this one does too.
    if (!questions.q?.instructions) return { status: 400, payload: { error: 'invalid question' } }
    const hasArrayChoice = Object.values(questions).some((q) => q.type === 'choice' && Array.isArray(q.criteria))
    if (hasArrayChoice) return { status: 400, payload: { error: 'array criteria unsupported' } }
    return {
      status: 200,
      payload: {
        answers: Object.fromEntries(
          Object.entries(questions).map(([id, question]) => {
            const criteria = Array.isArray(question.criteria) ? question.criteria : Object.keys(question.criteria ?? {})
            if (question.type === 'noul') return [id, { type: 'noul', noul: 0.8 }]
            return [id, { type: 'choice', choice: criteria[0], probabilities: Object.fromEntries(criteria.map((label, index) => [label, index === 0 ? 0.6 : 0.4])) }]
          }),
        ),
      },
    }
  })
  try {
    const first = await runConformanceSuite({ endpoint: a.url, providerId: 'runtime-a', timeoutMs: 2000 })
    const second = await runConformanceSuite({ endpoint: b.url, providerId: 'runtime-b', timeoutMs: 2000 })
    // Identical case list, identical total: the suite is reusable per runtime.
    assert.equal(first.totalCases, second.totalCases)
    assert.equal(first.compatible, true)
    assert.equal(first.deviations.length, 0)
    // The deviation is a runtime property, not a suite property.
    assert.equal(second.capabilities.choiceArrayCriteria, false)
    assert.equal(second.capabilities.choiceObjectCriteria, true)
    assert.ok(second.deviations.some((d) => d.id === 'choice-array-criteria'))
  } finally {
    await stop(a.server)
    await stop(b.server)
  }
})

test('an unreachable endpoint still produces a report instead of aborting', async () => {
  const report = await runConformanceSuite({ endpoint: 'http://127.0.0.1:1/v1/systemone', timeoutMs: 1000 })
  assert.equal(report.endpointReachable, false)
  assert.equal(report.compatible, false)
  assert.ok(report.transportFailures > 0)
  // Nothing unanswered is ever turned into a positive capability.
  assert.equal(report.capabilities.noul, false)
  assert.equal(report.capabilities.runtimeRejectsMalformedWirePayload, 'unverified')
})

test('a runtime accepting a malformed payload is unverified, not a positive capability', async () => {
  // A lenient runtime: it answers 200 even for a payload it should refuse.
  const { server, url } = await startRuntime(() => ({ status: 200, payload: { answers: { q: { type: 'noul', noul: 0.8 } } } }))
  try {
    const report = await runConformanceSuite({ endpoint: url, providerId: 'lenient-runtime', timeoutMs: 2000 })
    // The runtime answered instead of rejecting: not rejection evidence.
    assert.equal(report.capabilities.runtimeRejectsMalformedWirePayload, 'unverified')
    assert.ok(report.unverified.includes('runtimeRejectsMalformedWirePayload'))
  } finally {
    await stop(server)
  }
})

test('the malformed-wire probe keeps the HTTP status and whether the body was normalizable', async () => {
  // A targeted 4xx and a lenient 200 are completely different protocol
  // behaviours, and `observed: 'fail'` alone does not tell them apart.
  // Serves the base protocol and refuses only the malformed payload, so the
  // targeted rejection is real evidence rather than a blanket refusal.
  const refusing = await startRuntime((body) => {
    const { questions } = JSON.parse(body) as { questions: Record<string, { instructions?: string }> }
    if (Object.values(questions).some((q) => !q?.instructions)) {
      return { status: 422, payload: { error: 'question is missing instructions' } }
    }
    return {
      status: 200,
      payload: {
        answers: Object.fromEntries(
          Object.entries(questions).map(([id, question]) => {
            const criteria = (question as { criteria?: string[] | Record<string, string> }).criteria
            const labels = Array.isArray(criteria) ? criteria : Object.keys(criteria ?? {})
            if ((question as { type: string }).type === 'noul') return [id, { type: 'noul', noul: 0.8 }]
            if ((question as { type: string }).type === 'choice') {
              return [id, { type: 'choice', choice: labels[0], probabilities: { [labels[0]]: 0.6, [labels[1] ?? labels[0]]: 0.4 } }]
            }
            return [id, { type: 'score', score: 1, probabilities: { '0': 0.3, '1': 0.7 } }]
          }),
        ),
      },
    }
  })
  const lenient = await startRuntime(() => ({ status: 200, payload: { answers: { q: { type: 'noul', noul: 0.8 } } } }))
  const empty = await startRuntime(() => ({ status: 400, payload: undefined }))
  try {
    const refused = (await runConformanceSuite({ endpoint: refusing.url, providerId: 'refusing', timeoutMs: 2000 }))
      .results.find((r) => r.id === 'malformed-wire-payload-rejected')!
    assert.equal(refused.wire?.httpStatus, 422)
    assert.equal(refused.wire?.normalizable, false, 'an error body is not a normalizable answer')
    assert.equal(refused.code, 'http_422')
    // The verdict itself is unchanged: a targeted rejection still proves the
    // rejection capability, and BASE_CAPABILITIES was not relaxed to get here.
    assert.equal(
      (await runConformanceSuite({ endpoint: refusing.url, providerId: 'refusing', timeoutMs: 2000 })).capabilities
        .runtimeRejectsMalformedWirePayload,
      true,
    )

    const answered = (await runConformanceSuite({ endpoint: lenient.url, providerId: 'lenient', timeoutMs: 2000 }))
      .results.find((r) => r.id === 'malformed-wire-payload-rejected')!
    // 200 on a malformed payload, with a body this client could have used: the
    // leniency is now visible instead of only inferable from `unverified`.
    assert.equal(answered.wire?.httpStatus, 200)
    assert.equal(answered.wire?.normalizable, true, 'the returned answers were usable')
    assert.equal(answered.code, undefined)

    const bare = (await runConformanceSuite({ endpoint: empty.url, providerId: 'empty', timeoutMs: 2000 }))
      .results.find((r) => r.id === 'malformed-wire-payload-rejected')!
    assert.equal(bare.wire?.httpStatus, 400)
    assert.equal(bare.wire?.normalizable, false, 'no body is not a normalizable answer')
  } finally {
    await stop(refusing.server)
    await stop(lenient.server)
    await stop(empty.server)
  }
})

test('a transport failure on the wire probe records no status and no body claim', async () => {
  const report = await runConformanceSuite({ endpoint: 'http://127.0.0.1:1/v1/systemone', timeoutMs: 1000 })
  const result = report.results.find((r) => r.id === 'malformed-wire-payload-rejected')!
  assert.equal(result.code, 'network')
  // Null, not false: nothing answered, so nothing is claimed about the body.
  assert.equal(result.wire?.httpStatus, null)
  assert.equal(result.wire?.normalizable, null)
})

test('persisted campaign evidence carries the runtime, command, capabilities and deviations only', async () => {
  const { server, url } = await startRuntime()
  try {
    const report = await runConformanceSuite({ endpoint: url, providerId: 'evidence-runtime', model: 'a-model', timeoutMs: 2000 })
    const target: CampaignTarget = { id: 'evidence-runtime', endpoint: url, model: 'a-model', runtimeVersion: '2026.09 (operator observed)' }
    const entry = toEvidenceEntry(target, report)
    assert.equal(entry.target, 'evidence-runtime')
    assert.equal(entry.runtimeVersion, '2026.09 (operator observed)')
    assert.equal(entry.matchedCases, report.matchedCases)
    assert.equal(entry.totalCases, report.totalCases)
    assert.ok(entry.command.includes('npm run conformance'))
    // No host, no port, no key, no response payload, no latency.
    assert.ok(!JSON.stringify(entry).includes('127.0.0.1'))
    assert.equal(findLeak(entry), null)
  } finally {
    await stop(server)
  }
})

test('a campaign runs several runtimes through the same suite and sanitizes the evidence', async () => {
  const a = await startRuntime()
  const b = await startRuntime()
  try {
    const { evidence, leaks } = await runCampaign([
      { id: 'laya-compatible', endpoint: a.url, runtimeVersion: 'laya 0.x' },
      // No model configured: the runtime names its own, which is what the
      // recorded `modelsObserved` reports.
      { id: 'kev-local', endpoint: b.url },
    ])
    assert.equal(leaks.length, 0, 'a loopback campaign must not be flagged as a leak')
    assert.equal(evidence.runs.length, 2)
    // The evidence never claims quality: the scope is fixed.
    assert.ok(evidence.scope.includes('not decision quality'))
    for (const run of evidence.runs) {
      assert.ok(!JSON.stringify(run).includes('127.0.0.1'))
      assert.equal(findLeak(run), null)
      // Quality/calibration is never asserted from a protocol probe.
      assert.equal(typeof run.compatible, 'boolean')
      assert.equal(typeof run.strictCompatible, 'boolean')
      // The case count must follow the case list, not a hand-written number:
      // no model configured means no `model-supplied` case, so 11.
      assert.equal(run.totalCases, 11, `${run.target} case count must follow the declared case list`)
    }
  } finally {
    await stop(a.server)
    await stop(b.server)
  }
})

test('a private endpoint or a credential can never be persisted as evidence', () => {
  // 198.51.100.0/24 is the RFC 5737 documentation range. It exercises the very
  // same detector as a real tailnet address would, without naming a host that
  // actually exists.
  const PRIVATE_IP = '198.51.100.7'
  const entry = {
    target: 'kev-local',
    runtimeVersion: null,
    command: `SEMANTIC_ENDPOINT=http://${PRIVATE_IP}:8080/v1/systemone npm run conformance`,
    endpointClassification: 'private',
    modelsObserved: [],
    compatible: false,
    strictCompatible: false,
    matchedCases: 9,
    totalCases: 11,
    capabilities: {},
    deviations: [],
    unverified: [],
  }
  assert.ok(findLeak(entry), 'a private IP in the persisted command must be refused')

  const credential = { ...entry, command: 'SEMANTIC_API_KEY=sk-live-abcdef123456' }
  assert.ok(findLeak(credential), 'a credential in the persisted command must be refused')

  const bearer = { ...entry, command: 'Authorization: Bearer abcdef' }
  assert.ok(findLeak(bearer), 'a bearer token must be refused')

  const clean = { ...entry, command: campaignCommand({ id: 'kev-local', endpoint: `http://${PRIVATE_IP}:8080/v1/systemone`, apiKey: 'sk-live-abcdef123456' }) }
  assert.equal(findLeak(clean), null, 'the recorded command must carry no endpoint and no key')
})

test('a credential is refused whatever it is named, not only when it looks like a provider key', () => {
  // `sk-` is only the shape this project happens to have seen. A secret is a
  // secret whatever name it is filed under, so the generic forms hold too.
  const base = {
    target: 'kev-local',
    runtimeVersion: null,
    command: '',
    endpointClassification: 'private',
    modelsObserved: [],
    compatible: false,
    strictCompatible: false,
    matchedCases: 0,
    totalCases: 0,
    capabilities: {},
    deviations: [],
    unverified: [],
  }
  for (const secret of [
    'api_key=hunter2hunter2',
    'apiKey: abcdefgh',
    'API-KEY=super-secret-value',
    'access_token=ya29.abcdefgh',
    'auth_token = zzz-abcdefgh',
    'token=qwertyuiop123',
    'SECRET=topsecretvalue',
    'password=hunter2hunter2',
    'passwd=hunter2hunter2',
    'credential=abcdefabcdef',
  ]) {
    assert.ok(findLeak({ ...base, command: `npm run conformance -- ${secret}` }), `must refuse: ${secret}`)
  }
  // Non-provider prefixes are caught too, not just `sk-`.
  for (const secret of ['hf_abcdefghijkl', 'glpat-abcdefgh', 'ghp_abcdefghij', 'xoxb-abcdefgh']) {
    assert.ok(findLeak({ ...base, command: `npm run conformance -- ${secret}` }), `must refuse: ${secret}`)
  }
  // A field that merely names a secret, with no value, is not a leak: the
  // command legitimately advertises which variables the operator sets.
  assert.equal(findLeak({ ...base, command: 'SEMANTIC_API_KEY=<redacted> npm run conformance' }), null)
  assert.equal(findLeak({ ...base, command: 'SEMANTIC_ENDPOINT=<redacted> npm run conformance' }), null)
})

test('a committable campaign artifact never carries a host, a key or a real address', async () => {
  // Scoped to the artifacts this issue may commit, not the whole repository:
  // the campaign evidence file and the preset table.
  const { readFile } = await import('node:fs/promises')
  const { resolve } = await import('node:path')
  const root = resolve(import.meta.dirname, '..')

  const evidence = JSON.parse(await readFile(resolve(root, 'benchmark/evidence/conformance-campaign.json'), 'utf8'))
  assert.ok(Array.isArray(evidence.runs) && evidence.runs.length > 0, 'the evidence must record at least one run')
  for (const run of evidence.runs) {
    assert.equal(findLeak(run), null, `committed evidence leaks for ${run.target}`)
  }
  const whole = JSON.stringify(evidence)
  assert.ok(!/\b100\.87\./.test(whole), 'no tailnet address may appear in committed evidence')
  assert.ok(!/https?:\/\//.test(whole), 'no URL may appear in committed evidence')

  // The recorded case counts must be reachable from the case list: a case is
  // added only for an operator-configured model or unsupported model id, so a
  // count that matches neither 11, 12 nor 13 was hand-written.
  const { buildCases } = await import('../scripts/conformance-suite.ts')
  const reachable = new Set([11, 12, 13].map((n) => buildCases(n === 11 ? {} : n === 12 ? { model: 'm' } : { model: 'm', unsupportedModel: 'u' }).length))
  for (const run of evidence.runs) {
    assert.ok(reachable.has(run.totalCases), `${run.target} records ${run.totalCases} cases, unreachable from the case list`)
    assert.equal(typeof run.modelsObserved, 'object')
  }

  const presets = await import('../src/presets/index.ts')
  for (const preset of presets.PRESETS) {
    const serialised = JSON.stringify(preset)
    assert.ok(!/https?:\/\/|\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(serialised), `${preset.id} must carry no host`)
    assert.ok(!/\b(?:api[_-]?key|password|secret)\b\s*[:=]\s*\S/i.test(serialised), `${preset.id} must carry no credential`)
  }
})

test('one unusable target never destroys the evidence for the others', async () => {
  // A typo in the operator's local campaign file must not throw away the runs
  // that did work, and the error text may itself echo the endpoint.
  const good = await startRuntime()
  try {
    const { evidence } = await runCampaign([
      { id: 'runtimes-a', endpoint: good.url },
      { id: 'broken-target', endpoint: 'not-a-url-at-all' },
      { id: 'runtimes-b', endpoint: good.url },
    ])
    assert.equal(evidence.runs.length, 3, 'the failing target is recorded, not silently dropped')
    // The healthy targets keep their real result.
    assert.equal(evidence.runs[0].compatible, true)
    assert.equal(evidence.runs[2].compatible, true)
    assert.ok(evidence.runs[0].totalCases > 0)
    // The broken one claims nothing and carries no raw error text.
    const broken = evidence.runs[1]
    assert.equal(broken.target, 'broken-target')
    assert.equal(broken.compatible, false)
    assert.equal(broken.matchedCases, 0)
    assert.equal(broken.totalCases, 0)
    assert.deepEqual(broken.capabilities, {})
    assert.ok(!JSON.stringify(evidence).includes('not-a-url-at-all'), 'the malformed endpoint must not survive')
    assert.equal(findLeak(broken), null)
  } finally {
    await stop(good.server)
  }
})
