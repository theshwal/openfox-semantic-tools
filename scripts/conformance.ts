import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { SystemOneHttpProvider, ProviderError } from '../src/providers/system-one.ts'
import { classifyEndpoint, type EndpointClass } from '../src/egress.ts'
import { summarizeCompatibility, rejectionObserved, BLANKET_REJECTION, INCONCLUSIVE_CODES } from './conformance-report.ts'
import type { DecisionQuestion, DecisionRequest, ChoiceQuestion, ScoreQuestion } from '../src/decision/types.ts'

// Credentials and endpoint are read only from the process environment and never persisted.
const endpoint = process.env.SEMANTIC_ENDPOINT
if (!endpoint) throw new Error('Set SEMANTIC_ENDPOINT to the verified full POST endpoint')
const unsupportedModel = process.env.SEMANTIC_UNSUPPORTED_MODEL
const providerId = process.env.SEMANTIC_PROVIDER_ID ?? 'unknown'
const endpointClass: EndpointClass = classifyEndpoint(endpoint)
const provider = new SystemOneHttpProvider({
  endpoint,
  apiKey: process.env.SEMANTIC_API_KEY,
  model: process.env.SEMANTIC_MODEL,
  timeoutMs: 10000,
})

const noul: DecisionQuestion = { type: 'noul', instructions: 'Does the state report a passing test?' }
const choiceObject: ChoiceQuestion = {
  type: 'choice',
  instructions: 'Choose the reported test outcome',
  criteria: { pass: 'Test passes', fail: 'Test fails' },
}
const choiceArray: ChoiceQuestion = { type: 'choice', instructions: 'Select outcome', criteria: ['pass', 'fail'] }
const score: ScoreQuestion = { type: 'score', instructions: 'Rate the completeness of test evidence', criteria: ['No evidence', 'Reported test result'] }
const mixed: Record<string, DecisionQuestion> = { noul, choice: choiceObject, score }

type Expectation = 'pass' | 'fail'

/**
 * Cases are declared once and are runtime-agnostic, so the same suite runs
 * against any System One-compatible endpoint without editing the case list.
 *
 * `expect: 'fail'` asserts that the provider rejects or the endpoint reports an
 * error; `expect: 'pass'` asserts a valid normalized answer. Capability
 * differences between runtimes surface as documented deviations rather than as
 * transport heuristics.
 */
const cases: Array<{ id: string; group: string; expect: Expectation; request: DecisionRequest; model?: string }> = [
  { id: 'noul-single', group: 'question-types', expect: 'pass', request: { state: 'A public synthetic test passes.', questions: { q: noul } } },
  { id: 'choice-object-criteria', group: 'question-types', expect: 'pass', request: { state: 'A public synthetic test passes.', questions: { q: choiceObject } } },
  { id: 'choice-array-criteria', group: 'question-types', expect: 'pass', request: { state: 'A public synthetic test passes.', questions: { q: choiceArray } } },
  { id: 'score-ordered-array', group: 'question-types', expect: 'pass', request: { state: 'A public synthetic test result is reported.', questions: { q: score } } },
  { id: 'batched-mixed-questions', group: 'batching', expect: 'pass', request: { state: 'A public synthetic test passes.', questions: mixed } },  { id: 'state-string', group: 'state-shapes', expect: 'pass', request: { state: 'A public synthetic test passes.', questions: { q: noul } } },
  { id: 'state-object', group: 'state-shapes', expect: 'pass', request: { state: { test: 'passes', fixture: 'public synthetic' }, questions: { q: noul } } },
  { id: 'state-array', group: 'state-shapes', expect: 'pass', request: { state: ['public synthetic', 'test passes'], questions: { q: noul } } },
  { id: 'model-omitted', group: 'model-handling', expect: 'pass', request: { state: 'A public synthetic test passes.', questions: { q: noul } } },
  ...(process.env.SEMANTIC_MODEL
    ? [{ id: 'model-supplied', group: 'model-handling', expect: 'pass' as Expectation, model: process.env.SEMANTIC_MODEL, request: { state: 'A public synthetic test passes.', questions: { q: noul } } }]
    : []),
  { id: 'malformed-question-rejected-client-side', group: 'negative', expect: 'fail', request: { state: 'A public synthetic test passes.', questions: { q: { type: 'not-a-real-type', instructions: 'Check' } as unknown as DecisionQuestion } } },
  { id: 'malformed-wire-payload-rejected', group: 'negative', expect: 'fail', request: { state: 'A public synthetic test passes.', questions: { q: noul } } },
  ...(unsupportedModel
    ? [{ id: 'unsupported-model', group: 'negative', expect: 'fail' as Expectation, model: unsupportedModel, request: { state: 'A public synthetic test passes.', questions: { q: noul } } }]
    : []),
]

interface CaseResult {
  id: string
  group: string
  expectation: Expectation
  observed: 'pass' | 'fail'
  matched: boolean
  code?: string
  response?: { model?: string; answers: Record<string, { type: string }>; latencyMs: number }
}

const results: CaseResult[] = []
let sentUnsupportedModel = false

for (const entry of cases) {
  // The malformed-wire case sends a deliberately invalid body straight to the
  // endpoint; the transport is bypassed so the runtime's own error is observed.
  if (entry.id === 'malformed-wire-payload-rejected') {
    try {
      const malformedResponse = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(process.env.SEMANTIC_API_KEY ? { Authorization: `Bearer ${process.env.SEMANTIC_API_KEY}` } : {}) },
        body: JSON.stringify({ state: 'public synthetic', questions: { q: { type: 'noul' } } }),      })
      results.push({
        id: entry.id,
        group: entry.group,
        expectation: entry.expect,
        observed: malformedResponse.ok ? 'pass' : 'fail',
        matched: !malformedResponse.ok,
        ...(malformedResponse.ok ? {} : { code: `http_${malformedResponse.status}` }),
      })
    } catch {
      results.push({ id: entry.id, group: entry.group, expectation: entry.expect, observed: 'fail', matched: true, code: 'network' })
    }
    continue
  }

  try {
    const request: DecisionRequest = { ...entry.request, ...(entry.model ? { model: entry.model } : {}) }
    const response = await provider.decide(request)
    // Guard against the undefined === undefined case: a run without a configured
    // unsupported-model id must not be reported as accepting one.
    if (unsupportedModel !== undefined && entry.model === unsupportedModel) sentUnsupportedModel = true
    results.push({
      id: entry.id,
      group: entry.group,
      expectation: entry.expect,
      observed: 'pass',
      matched: entry.expect === 'pass',
      response: { ...(response.model ? { model: response.model } : {}), answers: response.answers as Record<string, { type: string }>, latencyMs: response.latencyMs ?? 0 },
    })
  } catch (error) {
    const code = error instanceof ProviderError ? error.code : `failure: ${String((error as Error)?.message ?? error).slice(0, 200)}`
    results.push({ id: entry.id, group: entry.group, expectation: entry.expect, observed: 'fail', matched: entry.expect === 'fail', code })
  }
}

const byId = (id: string) => results.find((r) => r.id === id)
const passed = (id: string) => byId(id)?.observed === 'pass'

// Reachability is observed, never declared. A run whose endpoint never answered
// a single positive case did not exercise any runtime.
const positiveCases = results.filter((r) => r.expectation === 'pass')
const answeredPositive = positiveCases.filter((r) => r.observed === 'pass').length
const transportFailures = results.filter(
  (r) => r.observed === 'fail' && INCONCLUSIVE_CODES.has(r.code ?? ''),
).length
const endpointReachable = answeredPositive > 0

/**
 * Host classification is a SYNTACTIC property of the configured URL, nothing
 * more. It is NOT provider identity: a public-looking hostname may resolve to a
 * loopback address (nip.io and friends), a private address may be a remote
 * provider reached through a tunnel, and a hostname may be pointed at any
 * server at any time. It therefore never asserts who answered.
 */
const endpointClassification: EndpointClass = endpointClass
const remoteEndpointObserved = endpointReachable && endpointClass === 'remote'
const localEndpointObserved = endpointReachable && endpointClass !== 'remote'
// The operator typed a label. It carries no verification value.
const providerLabelExplicitlyConfigured = providerId !== 'unknown'

/**
 * A blanket rejection means the runtime refuses traffic wholesale rather than
 * rejecting one specific malformed input. It is detected as: no positive case
 * was ever answered AND at least one 4xx was returned.
 *
 * A 4xx on a negative case alone is legitimate protocol evidence and must not
 * mask it: a conformant runtime legitimately answers 400 to malformed input.
 */
const blanketRejection =
  !endpointReachable &&
  results.some((r) => r.observed === 'fail' && r.code !== undefined && BLANKET_REJECTION.test(r.code))

/**
 * A negative capability is only reported as satisfied when the runtime actually
 * answered and rejected the input for a protocol reason. A transport failure
 * proves nothing, so it is reported as `unverified` rather than as a pass.
 *
 * When the runtime answers EVERY request with the same blanket 4xx, it is
 * refusing traffic wholesale rather than rejecting this specific malformed
 * input. That is not rejection evidence either.
 */
const negativeCapability = (id: string): boolean | 'unverified' => {
  const result = byId(id)
  if (!result) return 'unverified'
  if (blanketRejection) return 'unverified'
  return rejectionObserved(result.observed, result.code) ? true : 'unverified'
}

const capabilities: Record<string, boolean | 'unverified'> = {
  noul: passed('noul-single'),
  choice: passed('choice-array-criteria') || passed('choice-object-criteria'),
  choiceArrayCriteria: passed('choice-array-criteria'),
  choiceObjectCriteria: passed('choice-object-criteria'),
  score: passed('score-ordered-array'),
  batchedQuestions: passed('batched-mixed-questions'),
  objectState: passed('state-object'),
  arrayState: passed('state-array'),
  // Client-side validation: decided by this plugin before any socket is opened.
  // It is independent of the runtime, so it is never invalidated by a transport
  // failure and must not be derived from a negative-probe result.
  clientRejectsMalformedQuestion: byId('malformed-question-rejected-client-side')?.observed === 'fail',
  // Runtime probe: a malformed payload was actually put on the wire.
  runtimeRejectsMalformedWirePayload: negativeCapability('malformed-wire-payload-rejected'),
  ...(unsupportedModel ? { rejectsUnsupportedModel: negativeCapability('unsupported-model') } : {}),
}

const { compatible, strictCompatible, failedBase, failedStrict, unverified } = summarizeCompatibility(capabilities)

const protocolConformanceObserved = endpointReachable && compatible

// Deviations are the authoritative list of observed differences.
const deviations: Array<{ id: string; detail: string }> = []
for (const result of results) {
  if (!result.matched) {
    deviations.push({ id: result.id, detail: `expected ${result.expectation}, observed ${result.observed}${result.code ? ` (${result.code})` : ''}` })
  }
}
if (!capabilities.choiceObjectCriteria && capabilities.choiceArrayCriteria) {
  deviations.push({ id: 'choice-object-criteria', detail: 'runtime does not support key/description choice criteria; use array criteria' })
}
if (sentUnsupportedModel) {
  deviations.push({ id: 'unsupported-model', detail: 'runtime accepted a deliberately unsupported model id' })
}

const out = resolve(process.argv[2] ?? 'benchmark/results/conformance')
await mkdir(out, { recursive: true })
await writeFile(
  resolve(out, 'report.json'),
  JSON.stringify(
    {
      // Schema version: bumped to 2 for the F6/F7 corrections. Consumers must
      // read the fields below by name; removed identity fields are gone on
      // purpose and are not restated under a new name.
      schemaVersion: 2,
      // Operator-supplied label. Purely descriptive: it asserts nothing about
      // which system answered.
      providerLabel: providerId,
      endpoint: 'redacted',
      // Syntactic classification of the configured URL (local/private/remote).
      // NOT provider identity: a public hostname can resolve to loopback
      // (nip.io), and a private address can tunnel to a hosted provider.
      endpointClassification,
      // What was actually observed in this run:
      //   - something answered, and the URL classified as remote / not remote
      //   - the probed protocol was satisfied
      //   - the operator typed a label (no verification value)
      endpointReachable,
      remoteEndpointObserved,
      localEndpointObserved,
      protocolConformanceObserved,
      providerLabelExplicitlyConfigured,
      answeredPositiveCases: answeredPositive,
      transportFailures,
      blanketRejection,
      // `compatible`: the runtime can serve the documented base protocol.
      // `strictCompatible`: it also behaved correctly on every negative path probed.
      // A runtime may legitimately be compatible=true with strictCompatible=false.
      // `deviations` is the authoritative list of observed differences — never
      // read `compatible` alone as "no deviation was found".
      compatible,
      strictCompatible,
      failedBaseCapabilities: failedBase,
      failedStrictCapabilities: failedStrict,
      unverified,
      capabilities,
      deviations,
      scope: 'protocol conformance; not decision-quality, latency, provider identity or OpenFox end-to-end evidence',
      results,
    },
    null,
    2,
  ) + '\n',
)

console.log(
  `Conformance: ${results.filter((r) => r.matched).length}/${results.length} cases matched expectations; compatible=${compatible}; strictCompatible=${strictCompatible}; remoteEndpointObserved=${remoteEndpointObserved}; ${deviations.length} deviation(s). No provider identity is asserted.`,
)
if (!compatible || !strictCompatible) process.exitCode = 1
