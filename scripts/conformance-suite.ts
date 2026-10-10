// The conformance suite itself: one declared, runtime-agnostic case list plus
// the report it produces. Kept importable so the CLI, the offline smoke run and
// the multi-runtime campaign all execute exactly the same cases. Nothing here
// is edited per runtime, which is what makes the evidence comparable.
import { SystemOneHttpProvider, ProviderError } from '../src/providers/system-one.ts'
import { isRecord } from '../src/decision/validation.ts'
import { classifyEndpoint, type EndpointClass } from '../src/egress.ts'
import { summarizeCompatibility, rejectionObserved, BLANKET_REJECTION, INCONCLUSIVE_CODES } from './conformance-report.ts'
import type { DecisionQuestion, DecisionRequest, ChoiceQuestion, ScoreQuestion } from '../src/decision/types.ts'

export interface ConformanceSuiteOptions {
  readonly endpoint: string
  readonly apiKey?: string
  readonly model?: string
  readonly unsupportedModel?: string
  /** Operator-typed label. Descriptive only; it asserts nothing. */
  readonly providerId?: string
  /**
   * `omit` sends one valid synthetic request WITHOUT the `Authorization`
   * header, to distinguish "this endpoint ignores credentials" from "this
   * endpoint refused the call over credentials".
   */
  readonly authProbe?: 'omit'
  readonly timeoutMs?: number
  readonly transport?: typeof fetch
}

/**
 * Observes how the endpoint answers without credentials.
 *
 * A 401/403 without credentials only isolates credential handling when the
 * same endpoint demonstrably serves an AUTHENTICATED request; otherwise a
 * blanket refusal would be indistinguishable from an endpoint that refuses
 * everything. Every inconclusive path reports `unverified` rather than
 * recording a negative the run never observed.
 */
async function probeAuth(
  options: ConformanceSuiteOptions,
  endpointReachable: boolean,
): Promise<AuthProbeResult> {
  const notRequested: AuthProbeResult = {
    attempted: false,
    reason: 'not-requested',
    requiresAuth: 'unverified',
    normalizedWithoutAuth: 'unverified',
    httpStatus: null,
    note: 'set SEMANTIC_AUTH_PROBE=omit to observe how the endpoint answers without an Authorization header',
  }
  if (options.authProbe !== 'omit') return notRequested
  if (!options.apiKey) {
    // Nothing to omit: probing an endpoint that was never authenticated would
    // measure nothing at all.
    return {
      attempted: false,
      reason: 'no-api-key-configured',
      requiresAuth: 'unverified',
      normalizedWithoutAuth: 'unverified',
      httpStatus: null,
      note: 'no API key configured, so an unauthenticated request would be identical to the normal one',
    }
  }

  // The same endpoint and transport, built WITHOUT the key.
  const unauthenticated = new SystemOneHttpProvider({
    endpoint: options.endpoint,
    timeoutMs: options.timeoutMs ?? 10_000,
    ...(options.transport ? { transport: options.transport } : {}),
  })
  try {
    await unauthenticated.decide({
      state: 'A public synthetic test passes.',
      questions: { q: { type: 'noul', instructions: 'Does the state report a passing test?' } },
    })
    return {
      attempted: true,
      requiresAuth: false,
      normalizedWithoutAuth: true,
      // A successful call exposes NO status: the provider only surfaces
      // `httpStatus` on a non-2xx answer, and any value here would be
      // invented. `null` means "no failure status was observed".
      httpStatus: null,
      note: 'endpoint answered a valid request without credentials',
    }
  } catch (error) {
    const status = error instanceof ProviderError ? error.httpStatus : undefined
    if (status === 401 || status === 403) {
      return {
        attempted: true,
        requiresAuth: endpointReachable ? true : 'unverified',
        normalizedWithoutAuth: endpointReachable ? false : 'unverified',
        httpStatus: status,
        note: endpointReachable
          ? 'endpoint refused the request without credentials, and served authenticated requests'
          : 'endpoint refused the request without credentials, but no authenticated request succeeded, so credential handling is not isolated',
      }
    }
    // 429, 5xx, timeout, network, redirect or an unnormalizable body: the run
    // cannot attribute this failure to credentials.
    const code = error instanceof ProviderError ? error.code : 'failure'
    return {
      attempted: true,
      requiresAuth: 'unverified',
      normalizedWithoutAuth: 'unverified',
      httpStatus: status ?? null,
      note: `probe did not isolate credential handling (${code}${status === undefined ? '' : `/${status}`})`,
    }
  }
}

type Expectation = 'pass' | 'fail'

const noul: DecisionQuestion = { type: 'noul', instructions: 'Does the state report a passing test?' }
const choiceObject: ChoiceQuestion = {
  type: 'choice',
  instructions: 'Choose the reported test outcome',
  criteria: { pass: 'Test passes', fail: 'Test fails' },
}
const choiceArray: ChoiceQuestion = { type: 'choice', instructions: 'Select outcome', criteria: ['pass', 'fail'] }
const score: ScoreQuestion = { type: 'score', instructions: 'Rate the completeness of test evidence', criteria: ['No evidence', 'Reported test result'] }
const mixed: Record<string, DecisionQuestion> = { noul, choice: choiceObject, score }

interface CaseEntry {
  id: string
  group: string
  expect: Expectation
  request: DecisionRequest
  model?: string
}

/**
 * Cases are declared once and are runtime-agnostic, so the same suite runs
 * against any System One-compatible endpoint without editing the case list.
 *
 * `expect: 'fail'` asserts that the provider rejects or the endpoint reports an
 * error; `expect: 'pass'` asserts a valid normalized answer. Capability
 * differences between runtimes surface as documented deviations rather than as
 * transport heuristics.
 *
 * The two optional cases (a supplied model, an unsupported model id) depend
 * only on operator configuration, never on which runtime is targeted.
 */
export function buildCases(options: { model?: string; unsupportedModel?: string }): CaseEntry[] {
  return [
    { id: 'noul-single', group: 'question-types', expect: 'pass', request: { state: 'A public synthetic test passes.', questions: { q: noul } } },
    { id: 'choice-object-criteria', group: 'question-types', expect: 'pass', request: { state: 'A public synthetic test passes.', questions: { q: choiceObject } } },
    { id: 'choice-array-criteria', group: 'question-types', expect: 'pass', request: { state: 'A public synthetic test passes.', questions: { q: choiceArray } } },
    { id: 'score-ordered-array', group: 'question-types', expect: 'pass', request: { state: 'A public synthetic test result is reported.', questions: { q: score } } },
    { id: 'batched-mixed-questions', group: 'batching', expect: 'pass', request: { state: 'A public synthetic test passes.', questions: mixed } },
    { id: 'state-string', group: 'state-shapes', expect: 'pass', request: { state: 'A public synthetic test passes.', questions: { q: noul } } },
    { id: 'state-object', group: 'state-shapes', expect: 'pass', request: { state: { test: 'passes', fixture: 'public synthetic' }, questions: { q: noul } } },
    { id: 'state-array', group: 'state-shapes', expect: 'pass', request: { state: ['public synthetic', 'test passes'], questions: { q: noul } } },
    { id: 'model-omitted', group: 'model-handling', expect: 'pass', request: { state: 'A public synthetic test passes.', questions: { q: noul } } },
    ...(options.model
      ? [{ id: 'model-supplied', group: 'model-handling', expect: 'pass' as Expectation, model: options.model, request: { state: 'A public synthetic test passes.', questions: { q: noul } } }]
      : []),
    { id: 'malformed-question-rejected-client-side', group: 'negative', expect: 'fail', request: { state: 'A public synthetic test passes.', questions: { q: { type: 'not-a-real-type', instructions: 'Check' } as unknown as DecisionQuestion } } },
    { id: 'malformed-wire-payload-rejected', group: 'negative', expect: 'fail', request: { state: 'A public synthetic test passes.', questions: { q: noul } } },
    ...(options.unsupportedModel
      ? [{ id: 'unsupported-model', group: 'negative', expect: 'fail' as Expectation, model: options.unsupportedModel, request: { state: 'A public synthetic test passes.', questions: { q: noul } } }]
      : []),
  ]
}

interface CaseResult {
  id: string
  group: string
  expectation: Expectation
  observed: 'pass' | 'fail'
  matched: boolean
  code?: string
  /**
   * The HTTP status the endpoint returned for this case, when one was
   * observed. It is how a 401 is distinguished from a protocol rejection: an
   * endpoint answering only 401 was never asked a protocol question at all.
   */
  httpStatus?: number
  /**
   * Present only for the malformed-wire probe, where the transport is bypassed
   * and the runtime's own answer is the observation.
   */
  wire?: WireProbe
  response?: { model?: string; answers: Record<string, { type: string }>; latencyMs: number }
}

/**
 * What the malformed-wire probe actually saw.
 *
 * `httpStatus` keeps the status the runtime returned, which is the part of the
 * answer that explains the deviation: a targeted 4xx and a lenient 200 are
 * completely different protocol behaviours and neither is captured by
 * `observed: 'fail'`.
 *
 * `normalizable` records whether the body the runtime DID return is something
 * this client could have turned into a normalized answer. It changes no verdict
 * — a lenient runtime still fails to prove a rejection capability — it only
 * makes the observation readable. It is null when the body was never read.
 */
export interface WireProbe {
  /** Status returned for the deliberately malformed payload. Null on a transport failure. */
  httpStatus: number | null
  /**
   * Whether a returned body was a valid `answers` payload for the one question
   * sent, i.e. whether the response was normalizable. Null when no body was
   * read (transport failure, or a status with no readable body).
   */
  normalizable: boolean | null
}

/**
 * How the endpoint answered WITHOUT an `Authorization` header.
 *
 * Reported as `unverified` rather than pass/fail whenever the probe was not
 * requested or could not isolate credential handling, because a definitive
 * negative the run never observed is a false claim.
 */
export interface AuthProbeResult {
  attempted: boolean
  reason?: string
  requiresAuth: boolean | 'unverified'
  /** `'unverified'` when the probe never got far enough to observe an answer. */
  normalizedWithoutAuth: boolean | 'unverified'
  /** `null` when no failure status was observed; a success exposes none. */
  httpStatus: number | null
  note: string
}

export interface ConformanceReport {
  schemaVersion: number
  providerLabel: string
  endpoint: 'redacted'
  endpointClassification: EndpointClass
  endpointReachable: boolean
  remoteEndpointObserved: boolean
  localEndpointObserved: boolean
  protocolConformanceObserved: boolean
  providerLabelExplicitlyConfigured: boolean
  answeredPositiveCases: number
  totalCases: number
  matchedCases: number
  transportFailures: number
  /**
   * Whether `model-omitted` really omitted the model on the wire. `false` here
   * means the case proved nothing about omission and must not be read as
   * evidence of default-model behaviour.
   */
  modelOmittedOnWire: {
    suiteProviderHasDefaultModel: boolean
    detail: string
  }
  /**
   * Observed credential handling. Deliberately NOT a base or strict
   * compatibility capability: an unauthenticated local endpoint is allowed to
   * answer normally.
   */
  authProbe: AuthProbeResult
  blanketRejection: boolean
  compatible: boolean
  strictCompatible: boolean
  failedBaseCapabilities: string[]
  failedStrictCapabilities: string[]
  unverified: string[]
  capabilities: Record<string, boolean | 'unverified'>
  deviations: Array<{ id: string; detail: string }>
  scope: string
  results: CaseResult[]
}

/**
 * Sends a deliberately invalid body straight to the endpoint, bypassing the
 * transport so the runtime's own error is observed, and records what came back.
 *
 * The status is preserved and the body is checked for normalizability, so a
 * lenient runtime (200 on a malformed payload) is distinguishable from one that
 * refused the input. Neither outcome is ever read as more than what it is: the
 * capability verdict still comes from `rejectionObserved`.
 */
async function probeMalformedWire(options: {
  endpoint: string
  apiKey?: string
  transport: typeof fetch
}): Promise<CaseResult> {
  const base = {
    id: 'malformed-wire-payload-rejected',
    group: 'negative',
    expectation: 'fail' as Expectation,
  }
  let response: Response
  try {
    response = await options.transport(options.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}) },
      body: JSON.stringify({ state: 'public synthetic', questions: { q: { type: 'noul' } } }),
    })
  } catch {
    return { ...base, observed: 'fail', matched: true, code: 'network', wire: { httpStatus: null, normalizable: null } }
  }

  // The body is only read to record what arrived. It is never echoed: an
  // upstream body can contain submitted content or credentials.
  let normalizable: boolean | null = null
  try {
    const payload: unknown = await response.json()
    // Exactly the shape this client would have needed to accept the response.
    normalizable =
      isRecord(payload) &&
      isRecord(payload.answers) &&
      isRecord(payload.answers.q) &&
      payload.answers.q.type === 'noul' &&
      probability(payload.answers.q.noul)
  } catch {
    // No body, or a body that is not JSON: nothing to normalize.
    normalizable = false
  }

  return {
    ...base,
    observed: response.ok ? 'pass' : 'fail',
    matched: !response.ok,
    ...(response.ok ? {} : { code: `http_${response.status}` }),
    wire: { httpStatus: response.status, normalizable },
  }
}

/** Mirrors the adapter's own probability check, so `normalizable` means the same thing. */
function probability(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

/** Renders the wire observation into the deviation detail. Absent for other cases. */
function describeWire(wire: WireProbe | undefined): string {
  if (wire === undefined) return ''
  const normalizability =
    wire.normalizable === null ? 'body not read' : wire.normalizable ? 'body normalizable' : 'body not normalizable'
  return ` [http ${String(wire.httpStatus)}, ${normalizability}]`
}

/**
 * Runs every declared case against the configured endpoint and returns the
 * report. Never throws for an unreachable or blocked endpoint: an unanswered
 * probe is reported as `unverified`, not as a pass and not as an abort.
 */
export async function runConformanceSuite(options: ConformanceSuiteOptions): Promise<ConformanceReport> {
  const { endpoint, apiKey, model, unsupportedModel } = options
  const providerId = options.providerId ?? 'unknown'
  const endpointClass: EndpointClass = classifyEndpoint(endpoint)
  /**
   * The suite's own provider deliberately carries NO configured default model.
   *
   * `model-omitted` is only meaningful if no model is silently filled in from
   * settings behind the caller's back: with a default configured on this
   * provider, every case without an explicit model would put that default on
   * the wire and the case would silently re-test the default instead of
   * omission.
   *
   * The `model-supplied` case still exercises the configured model by passing
   * it explicitly on the request, which is where a model belongs in a
   * protocol probe.
   */
  const provider = new SystemOneHttpProvider({
    endpoint,
    ...(apiKey ? { apiKey } : {}),
    timeoutMs: options.timeoutMs ?? 10000,
    ...(options.transport ? { transport: options.transport } : {}),
  })

  const cases = buildCases({ ...(model ? { model } : {}), ...(unsupportedModel ? { unsupportedModel } : {}) })
  const results: CaseResult[] = []
  let sentUnsupportedModel = false

  for (const entry of cases) {
    // The malformed-wire case sends a deliberately invalid body straight to the
    // endpoint; the transport is bypassed so the runtime's own error is observed.
    if (entry.id === 'malformed-wire-payload-rejected') {
      results.push(await probeMalformedWire({ endpoint, ...(apiKey ? { apiKey } : {}), transport: options.transport ?? fetch }))
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
      // The status is preserved so a credential refusal (401/403) is never
      // read as protocol evidence: no protocol question was ever answered.
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
   * input. That is not rejection evidence either. A runtime that *accepts* a
   * malformed payload is likewise not evidence of a rejection capability.
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
      deviations.push({ id: result.id, detail: `expected ${result.expectation}, observed ${result.observed}${result.code ? ` (${result.code})` : ''}${describeWire(result.wire)}` })
    }
  }
  if (!capabilities.choiceObjectCriteria && capabilities.choiceArrayCriteria) {
    deviations.push({ id: 'choice-object-criteria', detail: 'runtime does not support key/description choice criteria; use array criteria' })
  }
  if (sentUnsupportedModel) {
    deviations.push({ id: 'unsupported-model', detail: 'runtime accepted a deliberately unsupported model id' })
  }

  return {
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
    endpointClassification: endpointClass,
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
    totalCases: results.length,
    matchedCases: results.filter((r) => r.matched).length,
    transportFailures,
    blanketRejection,
    modelOmittedOnWire: {
      suiteProviderHasDefaultModel: false,
      detail:
        'the suite provider is constructed without a default model, so model-omitted sends no model field',
    },
    authProbe: await probeAuth(options, endpointReachable),
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
  }
}

export function summarizeReportLine(report: ConformanceReport): string {
  return `Conformance: ${report.matchedCases}/${report.totalCases} cases matched expectations; compatible=${report.compatible}; strictCompatible=${report.strictCompatible}; remoteEndpointObserved=${report.remoteEndpointObserved}; ${report.deviations.length} deviation(s). No provider identity is asserted.`
}
