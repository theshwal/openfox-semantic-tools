import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_POLICY,
  VERIFY_POLICY_VERSION,
  evaluateVerifyPolicy,
  type GateId,
} from '../src/verify/policy.ts'
import type { DecisionAnswer } from '../src/decision/types.ts'

/**
 * A rubric answer must carry a distribution agreeing with its score, the way a
 * real runtime returns it, otherwise the policy rejects it as unusable.
 */
const scoreAnswer = (score: 0 | 1 | 2) =>
  ({
    type: 'score',
    score,
    probabilities: { 0: score === 0 ? 1 : 0, 1: score === 1 ? 1 : 0, 2: score === 2 ? 1 : 0 },
  }) as DecisionAnswer

const answers = (
  satisfied: number,
  sufficiency: 0 | 1 | 2,
  offScope: number,
  needsDeeper: number,
): Record<string, DecisionAnswer> => ({
  satisfied: { type: 'noul', probability: satisfied },
  evidenceSufficiency: scoreAnswer(sufficiency),
  offScope: { type: 'noul', probability: offScope },
  needsDeeperVerification: { type: 'noul', probability: needsDeeper },
})

const calibratedPolicy = { ...DEFAULT_POLICY, calibrated: true }

test('the shipped policy is versioned and explicitly uncalibrated', () => {
  assert.equal(DEFAULT_POLICY.version, VERIFY_POLICY_VERSION)
  assert.equal(DEFAULT_POLICY.calibrated, false)
  assert.equal(DEFAULT_POLICY.gates.length, 4)
})

test('every gate declares one polarity and one threshold, with a sound band', () => {
  const ids = DEFAULT_POLICY.gates.map((gate) => gate.id)
  assert.deepEqual(
    [...ids].sort(),
    ['evidenceSufficiency', 'needsDeeperVerification', 'offScope', 'satisfied'],
  )
  for (const gate of DEFAULT_POLICY.gates) {
    const [rangeMin, rangeMax] = gate.range
    assert.ok(rangeMin <= gate.threshold && gate.threshold <= rangeMax, `${gate.id} threshold must be admissible`)
    if (gate.undecided === null) continue
    const [low, high] = gate.undecided
    assert.ok(low <= high, `${gate.id} band must be ordered`)
    if (gate.direction === 'at-least') {
      assert.ok(high <= gate.threshold, `${gate.id}: band must not reach the threshold`)
      assert.ok(gate.polarity === 'high-is-good')
    } else {
      assert.ok(low >= gate.threshold, `${gate.id}: band must not reach the threshold`)
      assert.ok(gate.polarity === 'high-is-risk')
    }
  }
})

test('a discrete rubric has no ambiguous region, so every rung routes', () => {
  const sufficiency = DEFAULT_POLICY.gates.find((gate) => gate.id === 'evidenceSufficiency')
  assert.equal(sufficiency?.undecided, null)
  for (const [score, expected] of [[2, 'met'], [1, 'unmet'], [0, 'unmet']] as const) {
    const decision = evaluateVerifyPolicy(
      answers(0.99, score as 0 | 1 | 2, 0.01, 0.01),
      calibratedPolicy,
    )
    const gate = decision.gates.find((entry) => entry.id === 'evidenceSufficiency')
    assert.equal(gate?.verdict, expected, `score ${score}`)
  }
})

test('an uncalibrated policy can never emit a positive verdict', () => {
  // Every gate is met and far outside the uncertainty bands.
  const perfect = answers(0.99, 2, 0.01, 0.01)
  const shipped = evaluateVerifyPolicy(perfect)
  assert.equal(shipped.status, 'unknown')
  assert.ok(shipped.reasons.includes('policy_not_calibrated'))
  // The same answers only pass when a measured calibration exists.
  const measured = evaluateVerifyPolicy(perfect, calibratedPolicy)
  assert.equal(measured.status, 'pass-candidate')
})

test('a missing or unparsable answer is undecided, never a pass', () => {
  for (const broken of [
    {},
    { satisfied: { type: 'noul', probability: 0.99 } },
    { ...answers(0.99, 2, 0.01, 0.01), satisfied: { type: 'noul' } },
    { ...answers(0.99, 2, 0.01, 0.01), evidenceSufficiency: { type: 'score', score: 9 } },
    { ...answers(0.99, 2, 0.01, 0.01), offScope: { type: 'noul', probability: Number.NaN } },
  ]) {
    const decision = evaluateVerifyPolicy(broken as Record<string, DecisionAnswer>, calibratedPolicy)
    assert.notEqual(decision.status, 'pass-candidate')
    assert.equal(decision.status, 'unknown')
    assert.ok(decision.reasons.includes('answer_unusable'))
  }
})

test('values inside the uncertainty band are undecided, not a pass', () => {
  // 0.8 satisfies nothing but is far too high to be called decisive evidence.
  const decision = evaluateVerifyPolicy(answers(0.8, 2, 0.01, 0.01), calibratedPolicy)
  assert.equal(decision.status, 'unknown')
  const satisfied = decision.gates.find((gate) => gate.id === ('satisfied' as GateId))
  assert.equal(satisfied?.verdict, 'undecided')
})

test('an answer whose distribution contradicts its own value is unusable', () => {
  // The transport accepts a self-contradictory score. Reading only `score` here
  // would mark the evidence gate met while 100% of the mass sits on "indirect
  // evidence" — a false pass in the most dangerous direction.
  const contradictory = {
    ...answers(0.99, 2, 0.01, 0.01),
    evidenceSufficiency: { type: 'score', score: 2, probabilities: { 0: 0, 1: 1, 2: 0 } },
  }
  const decision = evaluateVerifyPolicy(contradictory as Record<string, DecisionAnswer>, calibratedPolicy)
  assert.equal(decision.status, 'unknown')
  assert.ok(decision.reasons.includes('answer_unusable'))
  const gate = decision.gates.find((entry) => entry.id === 'evidenceSufficiency')
  assert.equal(gate?.verdict, 'unusable')
})

test('a low confidence makes every gate unusable, never a pass', () => {
  const confident = { ...answers(0.99, 2, 0.01, 0.01) }
  // `NoulAnswer` carries no confidence in the shared contract, so the shape is
  // asserted through the policy's own reader, which accepts the field when a
  // runtime provides it.
  const doubtful = {
    satisfied: { type: 'noul', probability: 0.99, confidence: 0 },
    evidenceSufficiency: {
      type: 'score',
      score: 2,
      probabilities: { 0: 0, 1: 0, 2: 1 },
      confidence: 0,
    },
    offScope: { type: 'noul', probability: 0.01, confidence: 0 },
    needsDeeperVerification: { type: 'noul', probability: 0.01, confidence: 0 },
  }
  // The very same values pass when the provider is confident.
  assert.equal(evaluateVerifyPolicy(confident, calibratedPolicy).status, 'pass-candidate')
  const decision = evaluateVerifyPolicy(doubtful, calibratedPolicy)
  assert.equal(decision.status, 'unknown')
  assert.ok(decision.reasons.includes('answer_unusable'))
})

test('a decision reports a decisive failure even when another gate is undecided', () => {
  // offScope is decisive and unmet; satisfied is inside its band. The caller
  // must still learn that something is off-scope.
  const decision = evaluateVerifyPolicy(answers(0.7, 2, 0.95, 0.01), calibratedPolicy)
  assert.equal(decision.status, 'unknown')
  assert.ok(
    decision.reasons.includes('off_scope_detected'),
    `reasons must expose the decisive failure, got ${decision.reasons.join(',')}`,
  )
})

test('a decisive failure routes to the documented follow-up status', () => {
  const offScope = evaluateVerifyPolicy(answers(0.99, 2, 0.9, 0.01), calibratedPolicy)
  assert.equal(offScope.status, 'off-scope')

  const noEvidence = evaluateVerifyPolicy(answers(0.99, 0, 0.01, 0.01), calibratedPolicy)
  assert.equal(noEvidence.status, 'insufficient-evidence')

  const needsDeeper = evaluateVerifyPolicy(answers(0.99, 2, 0.01, 0.95), calibratedPolicy)
  assert.equal(needsDeeper.status, 'needs-verification')
})

test('a calibrated policy still refuses a pass when any gate is unmet', () => {
  for (const partial of [
    answers(0.2, 2, 0.01, 0.01),
    answers(0.99, 1, 0.01, 0.01),
    answers(0.99, 2, 0.8, 0.01),
    answers(0.99, 2, 0.01, 0.8),
  ]) {
    assert.notEqual(evaluateVerifyPolicy(partial, calibratedPolicy).status, 'pass-candidate')
  }
})

test('the reported gate values match the answers that were given', () => {
  const decision = evaluateVerifyPolicy(answers(0.99, 2, 0.01, 0.01))
  const byId = new Map(decision.gates.map((gate) => [gate.id, gate]))
  assert.equal(byId.get('satisfied' as GateId)?.value, 0.99)
  assert.equal(byId.get('evidenceSufficiency' as GateId)?.value, 2)
  assert.equal(byId.get('offScope' as GateId)?.value, 0.01)
  assert.equal(byId.get('needsDeeperVerification' as GateId)?.value, 0.01)
})
