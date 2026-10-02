import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BASE_CAPABILITIES,
  BLANKET_REJECTION,
  INCONCLUSIVE_CODES,
  INCONCLUSIVE_HTTP_STATUSES,
  STRICT_CAPABILITIES,
  TARGETED_REJECTION_STATUSES,
  isBlanketRejection,
  isRefusalStatus,
  isTargetedRejection,
  rejectionObserved,
  statusProvesRejection,
  summarizeCompatibility,
} from '../scripts/conformance-report.ts'

const allBaseTrue = (): Record<string, boolean> =>
  Object.fromEntries(BASE_CAPABILITIES.map((key) => [key, true]))

test('a runtime satisfying every base capability is compatible and strict', () => {
  const summary = summarizeCompatibility({ ...allBaseTrue(), rejectsUnsupportedModel: true })
  assert.equal(summary.compatible, true)
  assert.equal(summary.strictCompatible, true)
  assert.deepEqual(summary.failedBase, [])
  assert.deepEqual(summary.failedStrict, [])
})

test('a runtime accepting an unsupported model stays compatible but is not strictly conformant', () => {
  // This is the exact regression the finding called out: base protocol works,
  // the negative model path does not, and the report must not read as a clean pass.
  const summary = summarizeCompatibility({ ...allBaseTrue(), rejectsUnsupportedModel: false })
  assert.equal(summary.compatible, true)
  assert.equal(summary.strictCompatible, false)
  assert.deepEqual(summary.failedBase, [])
  assert.deepEqual(['rejectsUnsupportedModel'], summary.failedStrict)
})

test('strict capability absent from the report is not treated as a failure', () => {
  // No unsupported-model probe configured: nothing was observed, so nothing fails.
  const summary = summarizeCompatibility(allBaseTrue())
  assert.equal(summary.compatible, true)
  assert.equal(summary.strictCompatible, true)
  assert.deepEqual(summary.failedStrict, [])
})

test('a missing base capability fails compatibility and is named', () => {
  const capabilities = { ...allBaseTrue(), score: false, objectState: false }
  const summary = summarizeCompatibility(capabilities)
  assert.equal(summary.compatible, false)
  assert.equal(summary.strictCompatible, false)
  assert.deepEqual(summary.failedBase.sort(), ['objectState', 'score'])
})

test('an unprobed key cannot silently make a failing runtime look compatible', () => {
  // Only base capabilities decide `compatible`; extra unknown keys are ignored.
  const summary = summarizeCompatibility({ ...allBaseTrue(), someVendorSpecificKey: false })
  assert.equal(summary.compatible, true)
})

// --- Regression: a transport failure must never be read as a rejection capability. ---

test('a transport failure does not prove a rejection capability', () => {
  for (const code of ['network', 'timeout', 'aborted', 'failure', 'egress_blocked']) {
    assert.equal(rejectionObserved('fail', code), false, code)
    assert.equal(INCONCLUSIVE_CODES.has(code), true, code)
  }
})

test('an observed protocol rejection does prove a rejection capability', () => {
  assert.equal(rejectionObserved('fail', 'invalid_response'), true)
  assert.equal(rejectionObserved('fail', 'http_400'), true)
  assert.equal(rejectionObserved('fail', undefined), true)
})

test('a successful answer never proves a rejection capability', () => {
  assert.equal(rejectionObserved('pass', 'invalid_response'), false)
  assert.equal(rejectionObserved('pass', undefined), false)
})

test('an unverified negative capability is not satisfied and is named', () => {
  // The endpoint never answered: the rejection behaviour is unknown, not good.
  const summary = summarizeCompatibility({
    ...allBaseTrue(),
    rejectsUnsupportedModel: 'unverified',
  })
  assert.deepEqual(summary.unverified, ['rejectsUnsupportedModel'])
  assert.equal(summary.compatible, true)
  assert.equal(summary.strictCompatible, false)
  assert.deepEqual(summary.failedStrict, ['rejectsUnsupportedModel'])
})

test('an unverified base capability is not treated as conformance', () => {
  const summary = summarizeCompatibility({ ...allBaseTrue(), score: 'unverified' })
  assert.equal(summary.compatible, false)
  assert.equal(summary.strictCompatible, false)
  assert.deepEqual(summary.failedBase, ['score'])
  assert.deepEqual(summary.unverified, ['score'])
})

test('blanket 4xx rejections are recognised as non-specific', () => {
  assert.equal(BLANKET_REJECTION.test('http_400'), true)
  assert.equal(BLANKET_REJECTION.test('http_401'), true)
  assert.equal(BLANKET_REJECTION.test('http_429'), true)
  assert.equal(BLANKET_REJECTION.test('network'), false)
  assert.equal(BLANKET_REJECTION.test('invalid_response'), false)
})

// --- Regression #7: the numeric status decides, not a textual code. ---

test('a blanket refusal is detected from the actual numeric status', () => {
  // Any 4xx from the runtime is a refusal of traffic.
  assert.equal(isBlanketRejection('http_400', 400), true)
  assert.equal(isBlanketRejection('http_401', 401), true)
  assert.equal(isBlanketRejection('http_429', 429), true)
  assert.equal(isBlanketRejection('http_403', 403), true)
  // A 5xx is the runtime failing on its own side, not refusing this input.
  assert.equal(isBlanketRejection('http', 500), false)
  assert.equal(isBlanketRejection('http', 503), false)
  // The status wins over a code that merely looks like a refusal.
  assert.equal(isBlanketRejection('http_400', 500), false)
  assert.equal(isBlanketRejection('http', 200), false)
  // No status at all (transport failure): the code is all that remains.
  assert.equal(isBlanketRejection('network', undefined), false)
  assert.equal(isBlanketRejection('http_400', undefined), true)
})

test('refusal and inconclusive are different questions', () => {
  assert.equal(isRefusalStatus(400), true)
  assert.equal(isRefusalStatus(429), true)
  assert.equal(isRefusalStatus(500), false)
  // 401/429 are refusals that still cannot prove anything about the payload.
  assert.equal(isRefusalStatus(401), true)
  assert.equal(INCONCLUSIVE_HTTP_STATUSES(401), true)
  assert.equal(INCONCLUSIVE_HTTP_STATUSES(429), true)
  assert.equal(INCONCLUSIVE_HTTP_STATUSES(503), true)
  assert.equal(INCONCLUSIVE_HTTP_STATUSES(400), false)
  assert.equal(INCONCLUSIVE_HTTP_STATUSES(422), false)
})

test('only an allowlisted status proves a targeted rejection', () => {
  // A genuine "invalid input" rejection counts.
  for (const status of [400, 405, 415, 422]) {
    assert.equal(statusProvesRejection(status), true, `status ${status}`)
    assert.equal(isTargetedRejection('fail', 'http', status), true, `status ${status}`)
  }
  // Credential, policy, infrastructure and runtime-side failures never count.
  for (const status of [401, 402, 403, 407, 408, 429, 451, 500, 502, 503]) {
    assert.equal(statusProvesRejection(status), false, `status ${status}`)
    assert.equal(isTargetedRejection('fail', 'http', status), false, `status ${status}`)
  }
})

test('an unrecognized status is never protocol evidence', () => {
  // Regression: a denylist made every unlisted status — including 404, 407 and
  // anything exotic — count as proof. The allowlist inverts that default, so an
  // unknown status stays unverified.
  for (const status of [404, 406, 407, 408, 409, 410, 418, 451, 599, 600]) {
    assert.equal(statusProvesRejection(status), false, `status ${status}`)
    assert.equal(INCONCLUSIVE_HTTP_STATUSES(status), true, `status ${status}`)
  }
  // The allowlist is exactly the four statuses that state the payload was the
  // reason, and nothing else.
  assert.deepEqual(
    [...TARGETED_REJECTION_STATUSES].sort((a, b) => a - b),
    [400, 405, 415, 422],
  )
})

test('rejection evidence uses the status when present and the code otherwise', () => {
  // No status: fall back to the code, as before.
  assert.equal(isTargetedRejection('fail', 'invalid_response', undefined), true)
  assert.equal(isTargetedRejection('fail', 'network', undefined), false)
  assert.equal(isTargetedRejection('fail', 'timeout', undefined), false)
  // A success is never a rejection, whatever the status.
  assert.equal(isTargetedRejection('pass', 'http', 400), false)
  assert.equal(isTargetedRejection('pass', undefined, undefined), false)
  assert.equal(statusProvesRejection(undefined), false)
})

test('client validation and runtime wire probes are named as distinct capabilities', () => {
  // F7: the two rejection checks prove different things and must not be merged.
  assert.ok(BASE_CAPABILITIES.includes('clientRejectsMalformedQuestion'))
  assert.ok(BASE_CAPABILITIES.includes('runtimeRejectsMalformedWirePayload'))
  assert.ok(
    !BASE_CAPABILITIES.includes('rejectsMalformedQuestion' as never),
    'ambiguous name must be gone',
  )
  assert.ok(
    !BASE_CAPABILITIES.includes('liveProviderVerified' as never),
    'identity/verification fields must never be treated as capabilities',
  )
})
