import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BASE_CAPABILITIES,
  BLANKET_REJECTION,
  INCONCLUSIVE_CODES,
  STRICT_CAPABILITIES,
  rejectionObserved,
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
