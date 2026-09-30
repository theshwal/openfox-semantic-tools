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

/** Codes that show a generic "reject everything" response rather than a targeted rejection. */
export const BLANKET_REJECTION = /^http_4\d\d$/

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
