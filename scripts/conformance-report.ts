// Pure report-shape logic, kept importable so the compatible/strictCompatible
// semantics can be regression-tested without a live endpoint.
export type CapabilityMap = Record<string, boolean | 'unverified'>

/**
 * The report deliberately contains NO provider identity or provider-verification
 * field. Nothing in a protocol probe can establish *which* system answered: a
 * hostname is a label, TLS/DNS can point anywhere, and a public-looking address
 * can be loopback (nip.io and similar) while a private one can be a tunnel to a
 * hosted provider. Only these three observations are reported:
 *
 * - `remoteEndpointObserved` / `localEndpointObserved` — the syntactic
 *   classification of the configured URL, and that something answered.
 * - `protocolConformanceObserved` — the probed protocol was satisfied.
 * - `providerLabelExplicitlyConfigured` — the operator typed a label. Nothing more.
 */

/**
 * A negative case only proves a rejection capability when the endpoint actually
 * answered. A transport-level failure (unreachable, timeout, DNS, aborted) or
 * an undifferentiated blanket rejection says nothing about whether the runtime
 * rejects *that specific* malformed input for protocol reasons.
 */
export const INCONCLUSIVE_CODES = new Set(['network', 'timeout', 'aborted', 'failure', 'egress_blocked'])

export function rejectionObserved(observed: 'pass' | 'fail', code: string | undefined): boolean {
  return observed === 'fail' && !INCONCLUSIVE_CODES.has(code ?? '')
}

/**
 * Statuses that can never prove a *targeted* protocol rejection, however the
 * failure was observed. Everything outside {@link TARGETED_REJECTION_STATUSES}
 * lands here:
 *
 * - `401`/`403`/`407` — refused over credentials, so the runtime never
 *   evaluated the payload. Auth behaviour is reported separately.
 * - `402`/`451` — a policy or commercial refusal, not a statement about the
 *   payload's validity.
 * - `408` — the runtime timed out waiting; it never judged the request.
 * - `429` — rate limiting is an infrastructure condition.
 * - `400`/`405`/`415`/`422` are the only genuine rejections (see the allowlist).
 * - `5xx` — the runtime failed on its own side.
 * - network/timeout/abort — nothing answered at all.
 *
 * This is narrower than {@link isRefusalStatus}: a 401/429 is still a refusal,
 * it just cannot be read as a judgement about the payload.
 */
/**
 * The ONLY statuses that may be recorded as proof of a targeted protocol
 * rejection: they state, in the status itself, that this request was rejected
 * because of what it contained.
 *
 * This is an allowlist on purpose. A denylist would make every unlisted status
 * — `407` proxy auth required, `408` request timeout, `402`, `451`, and any
 * status a runtime might invent — count as protocol evidence by default, which
 * is exactly the failure mode this suite exists to prevent. An unrecognized
 * status is `unverified`, never a pass.
 */
export const TARGETED_REJECTION_STATUSES: ReadonlySet<number> = new Set([
  400, // Bad Request: malformed or invalid payload
  405, // Method Not Allowed
  415, // Unsupported Media Type
  422, // Unprocessable Content
])

/**
 * True when the observed failure carries a numeric status that still allows it
 * to be read as a targeted protocol rejection.
 */
export function statusProvesRejection(httpStatus: number | undefined): boolean {
  if (httpStatus === undefined) return false
  return TARGETED_REJECTION_STATUSES.has(httpStatus)
}

/**
 * Inverse of {@link statusProvesRejection}: any status that is not explicitly a
 * targeted rejection leaves the capability `unverified`.
 */
export const INCONCLUSIVE_HTTP_STATUSES = (status: number): boolean =>
  !TARGETED_REJECTION_STATUSES.has(status)

/**
 * True when the runtime refused the request with a 4xx status.
 *
 * This is the "refused traffic" test, and it is deliberately different from
 * {@link INCONCLUSIVE_HTTP_STATUSES}, which asks a narrower question: can this
 * particular failure be read as a *targeted* protocol rejection? A 401 satisfies
 * both (it is a refusal, and it is not evidence about the payload).
 */
export const isRefusalStatus = (status: number): boolean => status >= 400 && status < 500

/**
 * Codes that show a generic "reject everything" response rather than a targeted
 * rejection.
 *
 * Detection uses the ACTUAL numeric status rather than the code text, so it
 * cannot be fooled by a substring and cannot fire on a status the runtime never
 * returned. Responses carrying no status (a transport failure) fall back to the
 * code, where a 4xx-shaped code is all that remains.
 */
export const BLANKET_REJECTION = /^http_4\d\d$/

export function isBlanketRejection(code: string | undefined, httpStatus: number | undefined): boolean {
  if (httpStatus !== undefined) return isRefusalStatus(httpStatus)
  return code !== undefined && BLANKET_REJECTION.test(code)
}

/**
 * A rejection capability requires an observed rejection that is neither a
 * transport failure nor an inconclusive status. When a numeric status is
 * available it is authoritative; otherwise the code is used.
 */
export function isTargetedRejection(
  observed: 'pass' | 'fail',
  code: string | undefined,
  httpStatus?: number,
): boolean {
  if (observed !== 'fail') return false
  if (httpStatus !== undefined) return statusProvesRejection(httpStatus)
  return rejectionObserved(observed, code)
}

/**
 * Base protocol capabilities every System One-compatible runtime must provide.
 * These decide `compatible`. A value of `unverified` counts as NOT satisfied:
 * an unanswered probe must never be reported as conformance.
 */
export const BASE_CAPABILITIES = [
  'noul',
  'choice',
  'choiceArrayCriteria',
  'choiceObjectCriteria',
  'score',
  'batchedQuestions',
  'objectState',
  'arrayState',
  // Proves THIS CLIENT refuses the input before any request is sent. It is a
  // property of the plugin, never of the remote runtime.
  'clientRejectsMalformedQuestion',
  // Proves the RUNTIME answered a malformed wire payload with a rejection.
  'runtimeRejectsMalformedWirePayload',
] as const

/**
 * Negative-path behaviours a runtime is *expected* to get right but which are
 * not required for base protocol compatibility: accepting a deliberately
 * unsupported model id does not stop a runtime from serving valid requests.
 * These decide `strictCompatible` only.
 */
export const STRICT_CAPABILITIES = ['rejectsUnsupportedModel'] as const

/**
 * `compatible` answers "can this runtime serve the documented protocol?".
 * `strictCompatible` additionally answers "did it also behave correctly on the
 * negative paths we probed?".
 *
 * A runtime can legitimately be `compatible: true, strictCompatible: false`.
 * Consumers must not read `compatible` as "no deviations were found":
 * `deviations` remains the authoritative list of observed differences.
 */
export function summarizeCompatibility(capabilities: CapabilityMap): {
  compatible: boolean
  strictCompatible: boolean
  failedBase: string[]
  failedStrict: string[]
  unverified: string[]
} {
  const failedBase = BASE_CAPABILITIES.filter((key) => capabilities[key] !== true)
  const failedStrict = STRICT_CAPABILITIES.filter((key) => key in capabilities && capabilities[key] !== true)
  const unverified = Object.entries(capabilities)
    .filter(([, value]) => value === 'unverified')
    .map(([key]) => key)
    .sort()
  return {
    compatible: failedBase.length === 0,
    strictCompatible: failedBase.length === 0 && failedStrict.length === 0,
    failedBase,
    failedStrict,
    unverified,
  }
}
