import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  summarizeCompatibility,
  isTargetedRejection,
  isBlanketRejection,
  INCONCLUSIVE_CODES,
  INCONCLUSIVE_HTTP_STATUSES,
} from './conformance-report.ts'
import { SystemOneHttpProvider, ProviderError } from '../src/providers/system-one.ts'
import { classifyEndpoint, type EndpointClass } from '../src/egress.ts'
import type { DecisionQuestion, DecisionRequest, ChoiceQuestion, ScoreQuestion } from '../src/decision/types.ts'

const startedAt = new Date().toISOString()

// Credentials and endpoint are read only from the process environment and never persisted.
const endpoint = process.env.SEMANTIC_ENDPOINT
if (!endpoint) throw new Error('Set SEMANTIC_ENDPOINT to the verified full POST endpoint')
const unsupportedModel = process.env.SEMANTIC_UNSUPPORTED_MODEL
const providerId = process.env.SEMANTIC_PROVIDER_ID ?? 'unknown'
const endpointClass: EndpointClass = classifyEndpoint(endpoint)
/**
 * The suite's own provider deliberately carries NO configured default model.
 *
 * `model-omitted` is only meaningful if no model is silently filled in from
 * settings behind the caller's back: with a default configured on this provider,
 * every case without an explicit model would put that default on the wire and
 * the case would silently re-test the default instead of omission.
 *
 * The `model-supplied` case still exercises the configured `SEMANTIC_MODEL` by
 * passing it explicitly on the request, which is where a model belongs in a
 * protocol probe.
 */
const provider = new SystemOneHttpProvider({
  endpoint,
  apiKey: process.env.SEMANTIC_API_KEY,
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
  /**
   * Numeric HTTP status when the runtime actually answered with a non-2xx.
   * A bare status only: never the body, headers, URL or credentials, which can
   * echo submitted source or secrets.
   */
  httpStatus?: number
  response?: { model?: string; answers: Record<string, { type: string }>; latencyMs: number }
}

/**
 * `model-omitted` is only meaningful because the suite's provider carries no
 * configured default model: without that, every case without an explicit model
 * would put the default on the wire and the case would silently re-test the
 * default instead of omission.
 */
const modelOmittedOnWire = {
  suiteProviderHasDefaultModel: false,
  detail: 'the suite provider is constructed without a default model, so model-omitted sends no model field',
}

const results: CaseResult[] = []
let sentUnsupportedModel = false

for (const entry of cases) {
  // The malformed-wire case sends a deliberately invalid body straight to the
  // endpoint; the transport is bypassed so the runtime's own error is observed.
  if (entry.id === 'malformed-wire-payload-rejected') {
    try {
      // Bounded exactly like the transport: a timeout so an endpoint that
      // accepts the body but never answers cannot hang the campaign, and
      // `redirect: 'error'` so the probe cannot be silently redirected to
      // another host and recorded as the configured runtime.
      const malformedResponse = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json', ...(process.env.SEMANTIC_API_KEY ? { Authorization: `Bearer ${process.env.SEMANTIC_API_KEY}` } : {}) },
        body: JSON.stringify({ state: 'public synthetic', questions: { q: { type: 'noul' } } }),
      })
      // The body is cancelled unread: it is never parsed, logged or persisted.
      await malformedResponse.body?.cancel()
      results.push({
        id: entry.id,
        group: entry.group,
        expectation: entry.expect,
        observed: malformedResponse.ok ? 'pass' : 'fail',
        matched: !malformedResponse.ok,
        ...(malformedResponse.ok ? {} : { code: `http_${malformedResponse.status}`, httpStatus: malformedResponse.status }),
      })
    } catch (error) {
      const aborted = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
      results.push({
        id: entry.id,
        group: entry.group,
        expectation: entry.expect,
        observed: 'fail',
        matched: true,
        code: aborted ? 'timeout' : 'network',
      })
    }
    continue
  }

  try {
    // The suite's provider has no configured default, so a case without an
    // explicit `model` really is sent with no model field at all. That the
    // endpoint agrees is proven by a real capturing stub in the test suite, not
    // asserted here.
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
    const httpStatus = error instanceof ProviderError ? error.httpStatus : undefined
    results.push({
      id: entry.id,
      group: entry.group,
      expectation: entry.expect,
      observed: 'fail',
      matched: entry.expect === 'fail',
      code,
      ...(httpStatus === undefined ? {} : { httpStatus }),
    })
  }
}

/**
 * Opt-in auth observation.
 *
 * When `SEMANTIC_AUTH_PROBE=omit`, the same already-configured endpoint is
 * probed once with a valid synthetic request sent WITHOUT the Authorization
 * header. It records only what the endpoint did — never the body, headers, URL
 * or credentials.
 *
 * This is deliberately an *observation*, not a compatibility requirement: an
 * unauthenticated local endpoint is perfectly conformant and will answer
 * normally. Its value is distinguishing "this endpoint ignores credentials"
 * from "this endpoint refused the call over credentials", which a 401 on the
 * authenticated path alone cannot tell apart from a protocol rejection.
 *
 * When it was not requested, or was attempted but stayed inconclusive, it is
 * reported as `unverified` rather than as a pass or a failure.
 */
interface AuthProbeResult {
  attempted: boolean
  reason?: string
  requiresAuth: boolean | 'unverified'
  /** `'unverified'` when the probe never got far enough to observe an answer. */
  normalizedWithoutAuth: boolean | 'unverified'
  httpStatus: number | null
  note: string
}

let authProbe: AuthProbeResult = {
  attempted: false,
  reason: 'not-requested',
  requiresAuth: 'unverified',
  normalizedWithoutAuth: 'unverified',
  httpStatus: null,
  note: 'set SEMANTIC_AUTH_PROBE=omit to observe how the endpoint answers without an Authorization header',
}

if (process.env.SEMANTIC_AUTH_PROBE === 'omit') {
  if (!process.env.SEMANTIC_API_KEY) {
    // Nothing to omit: probing an endpoint that was never authenticated would
    // measure nothing at all.
    authProbe = {
      attempted: false,
      reason: 'no-api-key-configured',
      requiresAuth: 'unverified',
      normalizedWithoutAuth: 'unverified',
      httpStatus: null,
      note: 'no SEMANTIC_API_KEY configured, so an unauthenticated request would be identical to the normal one',
    }
  } else {
    // The same endpoint and transport, built WITHOUT the key: no Authorization
    // header is ever set.
    const unauthenticatedProvider = new SystemOneHttpProvider({
      endpoint,
      model: process.env.SEMANTIC_MODEL,
      timeoutMs: 10000,
    })
    try {
      await unauthenticatedProvider.decide({
        state: 'A public synthetic test passes.',
        questions: { q: { type: 'noul', instructions: 'Does the state report a passing test?' } },
      })
      authProbe = {
        attempted: true,
        requiresAuth: false,
        normalizedWithoutAuth: true,
        httpStatus: 200,
        note: 'endpoint answered a valid request without credentials',
      }
    } catch (error) {
      const status = error instanceof ProviderError ? error.httpStatus : undefined
      if (status === 401 || status === 403) {
        authProbe = {
          attempted: true,
          requiresAuth: true,
          normalizedWithoutAuth: false,
          httpStatus: status,
          note: 'endpoint refused the request without credentials',
        }
      } else {
        // 429, 5xx, timeout, network, redirect or an unnormalizable body: the
        // run cannot attribute this failure to credentials.
        const code = error instanceof ProviderError ? error.code : 'failure'
        authProbe = {
          attempted: true,
          requiresAuth: 'unverified',
          // Nothing was observed: the runtime failed before answering, so
          // whether an unauthenticated request would normalize is UNKNOWN.
          // Recording `false` here would persist a definitive negative claim the
          // run never made.
          normalizedWithoutAuth: 'unverified',
          httpStatus: status ?? null,
          note: `probe did not isolate credential handling (${code}${status === undefined ? '' : `/${status}`})`,
        }
      }
    }
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
  results.some((r) => r.observed === 'fail' && isBlanketRejection(r.code, r.httpStatus))

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
  return isTargetedRejection(result.observed, result.code, result.httpStatus) ? true : 'unverified'
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
      /**
       * Campaign metadata.
       *
       * Everything here is either OPERATOR-DECLARED or OBSERVED-IN-THIS-RUN.
       * Nothing is inferred, and nothing is copied from a previous run:
       *
       * - `startedAt`/`finishedAt` — observed, this run only.
       * - `runtimeVersion` — OPERATOR-DECLARED, `null` when not supplied. It
       *   is a label the operator typed; nothing in this suite verifies it.
       * - `model` — the configured model id (operator-declared), `null` when
       *   none was configured. Never a model echoed back by a runtime.
       * - `command` — the fixed command that produces this report.
       *
       * The endpoint stays `redacted` and no API key, URL, header or private
       * path is written here.
       */
      campaign: {
        startedAt,
        finishedAt: new Date().toISOString(),
        runtimeVersion: process.env.SEMANTIC_RUNTIME_VERSION?.trim() || null,
        model: process.env.SEMANTIC_MODEL?.trim() || null,
        command: 'npm run conformance -- <report-directory>',
        // What each value is, so a reader never has to guess whether a field
        // was measured or merely declared.
        provenance: {
          startedAt: 'observed',
          finishedAt: 'observed',
          runtimeVersion: 'operator-declared',
          model: 'operator-declared',
          command: 'fixed',
        },
      },
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
      // Whether `model-omitted` really omitted the model on the wire. A false
      // here means the case proved nothing about omission and must not be read
      // as evidence of default-model behaviour.
      modelOmittedOnWire,
      // Auth is reported as its own observation and is deliberately NOT a base
      // or strict compatibility capability: an unauthenticated local endpoint
      // is allowed to answer normally.
      authProbe,
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
