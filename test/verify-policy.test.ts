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
 * A rubric answer must carry a distribution agreeing with its expectation, the
 * way a real runtime returns it, otherwise the policy rejects it as unusable.
 *
 * `score` is the expectation E[level] = Σ(level × probability), per the
 * documented System One contract, so a degenerate one-hot distribution at the
 * top level satisfies it just as a continuous value does.
 */
const scoreAnswer = (score: number, probabilities?: Record<string, number>) =>
  ({
    type: 'score',
    score,
    probabilities:
      probabilities ?? { '0': score === 0 ? 1 : 0, '1': score === 1 ? 1 : 0, '2': score === 2 ? 1 : 0 },
  }) as unknown as DecisionAnswer

/** `criterionTestable` defaults to a clearly testable criterion. */
const answers = (
  satisfied: number,
  sufficiency: 0 | 1 | 2,
  offScope: number,
  needsDeeper: number,
  testable = 0.99,
): Record<string, DecisionAnswer> => ({
  criterionTestable: { type: 'noul', probability: testable },
  satisfied: { type: 'noul', probability: satisfied },
  evidenceSufficiency: scoreAnswer(sufficiency),
  offScope: { type: 'noul', probability: offScope },
  needsDeeperVerification: { type: 'noul', probability: needsDeeper },
})

const calibratedPolicy = { ...DEFAULT_POLICY, calibrated: true }

test('the shipped policy is versioned and explicitly uncalibrated', () => {
  assert.equal(DEFAULT_POLICY.version, VERIFY_POLICY_VERSION)
  assert.equal(DEFAULT_POLICY.calibrated, false)
  assert.equal(DEFAULT_POLICY.gates.length, 5)
})

test('every gate declares one polarity and one threshold, with a sound band', () => {
  const ids = DEFAULT_POLICY.gates.map((gate) => gate.id)
  assert.deepEqual(
    [...ids].sort(),
    [
      'criterionTestable',
      'evidenceSufficiency',
      'needsDeeperVerification',
      'offScope',
      'satisfied',
    ],
  )
  for (const gate of DEFAULT_POLICY.gates) {
    const [rangeMin, rangeMax] = gate.range
    assert.ok(rangeMin <= gate.threshold && gate.threshold <= rangeMax, `${gate.id} threshold must be admissible`)
    if (gate.undecided === null) continue
    const [low, high] = gate.undecided
    assert.ok(low <= high, `${gate.id} band must be ordered`)
    if (gate.direction === 'at-least') {
      // With a continuous reading the band may start at the threshold (the value
      // itself is the reading), but it must never cross it, or a value could be
      // both undecided and decisive.
      assert.ok(low <= gate.threshold, `${gate.id}: band must not cross the threshold`)
      assert.ok(gate.polarity === 'high-is-good')
    } else {
      assert.ok(low >= gate.threshold, `${gate.id}: band must not cross the threshold`)
      assert.ok(gate.polarity === 'high-is-risk')
    }
  }
})

test('a score is read as the expectation, not as a level index', () => {
  // The documented contract: score = E[level] = Σ(level × probability).
  // The live runtime returns continuous values, so a fractional expectation on a
  // 3-level rubric is a legitimate answer, not a malformed one.
  const continuous = {
    ...answers(0.99, 2, 0.01, 0.01),
    evidenceSufficiency: scoreAnswer(1.9, { 0: 0, 1: 0.1, 2: 0.9 }),
  }
  const decision = evaluateVerifyPolicy(continuous as Record<string, DecisionAnswer>, calibratedPolicy)
  const gate = decision.gates.find((entry) => entry.id === 'evidenceSufficiency')
  assert.equal(gate?.verdict, 'met', 'E[level] = 1.9 sits decisively at the top of a 0..2 rubric')
  assert.equal(gate?.value, 1.9)
  assert.equal(decision.status, 'pass-candidate')
})

test('the expectation is checked against the distribution, within rounding tolerance', () => {
  const gateOf = (a: unknown) =>
    evaluateVerifyPolicy(a as Record<string, DecisionAnswer>, calibratedPolicy).gates.find(
      (entry) => entry.id === 'evidenceSufficiency',
    )?.verdict

  // Official documented example: 0 × 0.0 + 1 × 0.57 + 2 × 0.43 = 1.43. The
  // answer is self-consistent, so it is usable and routed by its value.
  const exact = {
    ...answers(0.99, 2, 0.01, 0.01),
    evidenceSufficiency: scoreAnswer(1.43, { 0: 0, 1: 0.57, 2: 0.43 }),
  }
  assert.equal(gateOf(exact), 'unmet', 'E[level] = 1.43 is below the direct-evidence threshold')

  // The live campaign returned 0.15 where its own distribution implies 0.14:
  // a two-decimal rounding difference. It stays inside tolerance, so it is
  // accepted and routed, rather than rejected as malformed.
  const rounded = {
    ...answers(0.99, 2, 0.01, 0.01),
    evidenceSufficiency: scoreAnswer(0.15, { 0: 0.9, 1: 0.06, 2: 0.04 }),
  }
  assert.equal(gateOf(rounded), 'unmet', 'rounding inside tolerance is accepted, then routed')

  // A genuine contradiction is still rejected: 0.15 against an expectation of
  // 1.43 is far outside the rounding tolerance.
  const contradicted = {
    ...answers(0.99, 2, 0.01, 0.01),
    evidenceSufficiency: scoreAnswer(0.15, { 0: 0, 1: 0.57, 2: 0.43 }),
  }
  assert.equal(gateOf(contradicted), 'unusable')
})

test('an incoherent answer stays unusable, whatever the runtime declared', () => {
  // The coherence guard is independent of confidence: a contradiction is
  // rejected even when the provider is certain, and carries no value at all.
  const contradicted = {
    ...answers(0.99, 2, 0.01, 0.01),
    evidenceSufficiency: {
      type: 'score',
      score: 2,
      probabilities: { 0: 0, 1: 1, 2: 0 },
      confidence: 0.99,
    },
  }
  const decision = evaluateVerifyPolicy(contradicted as Record<string, DecisionAnswer>, calibratedPolicy)
  const gate = decision.gates.find((entry) => entry.id === 'evidenceSufficiency')
  assert.equal(gate?.verdict, 'unusable')
  assert.equal(gate?.value, null, 'a contradictory answer has no value to report')
  assert.ok(decision.reasons.includes('answer_unusable'))
  assert.equal(decision.status, 'unknown')
})

test('a declared confidence is telemetry and never a policy input', () => {
  // The recorded live campaigns carried confidence values as low as 0 on every
  // gate. `verify-0.2.2` read that as a verdict, which erased every decisive
  // reading in the run: 14/14 cases collapsed to `unknown`. A number the
  // runtime states about itself cannot be evidence about the repository, and it
  // is not comparable between providers, so it must not move a threshold.
  const same = { ...answers(0.99, 2, 0.01, 0.01) }
  const selfDoubting = {
    criterionTestable: { type: 'noul', probability: 0.99, confidence: 0 },
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
  for (const policy of [calibratedPolicy, DEFAULT_POLICY]) {
    const confident = evaluateVerifyPolicy(same, policy)
    const doubtful = evaluateVerifyPolicy(selfDoubting, policy)
    assert.equal(doubtful.status, confident.status)
    assert.deepEqual(
      doubtful.gates.map((gate) => gate.verdict),
      confident.gates.map((gate) => gate.verdict),
      'identical numbers must classify identically whatever the runtime declared',
    )
    assert.equal(
      doubtful.telemetry.declaredConfidence.satisfied,
      0,
      'the declared value is still reported, as telemetry',
    )
  }
  // And the values that used to be refused are now simply classified.
  const decision = evaluateVerifyPolicy(selfDoubting, calibratedPolicy)
  assert.equal(decision.status, 'pass-candidate')
  assert.equal(decision.reasons.includes('answer_low_confidence'), false)
  for (const gate of decision.gates) assert.equal(gate.verdict, 'met', gate.id)
})

test('a tied distribution is classified by the gate, not refused as a level', () => {
  // A 50/50 split on the two top rungs gives E[level] = 1.5, which is a real,
  // coherent reading that sits in the evidence gate's own band. The policy does
  // not need a mass floor to know that: the band is the answer.
  const tied = {
    ...answers(0.99, 2, 0.01, 0.01),
    evidenceSufficiency: scoreAnswer(1.5, { 0: 0, 1: 0.5, 2: 0.5 }),
  }
  const decision = evaluateVerifyPolicy(tied as Record<string, DecisionAnswer>, calibratedPolicy)
  const gate = decision.gates.find((entry) => entry.id === 'evidenceSufficiency')
  assert.equal(gate?.verdict, 'undecided', '1.5 is below the 1.9 gate and above the 1.5 floor')
  assert.equal(gate?.value, 1.5, 'the expectation is still readable and is reported')
  assert.equal(decision.status, 'unknown')
  assert.notEqual(decision.status, 'pass-candidate')
})

test('a score outside the declared rubric range is unusable', () => {
  // The range is 0..len(criteria)-1 = 0..2 here, never 0..1.
  const outOfRange = {
    ...answers(0.99, 2, 0.01, 0.01),
    evidenceSufficiency: scoreAnswer(3, { 0: 0, 1: 0, 2: 1 }),
  }
  const decision = evaluateVerifyPolicy(outOfRange as Record<string, DecisionAnswer>, calibratedPolicy)
  assert.equal(decision.status, 'unknown')
  const gate = decision.gates.find((entry) => entry.id === 'evidenceSufficiency')
  assert.equal(gate?.verdict, 'unusable')
})

test('direct evidence means the expectation reached the top level, per the score contract', () => {
  const sufficiency = DEFAULT_POLICY.gates.find((gate) => gate.id === 'evidenceSufficiency')!
  // The rubric runs 0..2, so the contract's `E[level] >= top - 0.1` gate is
  // 1.9. It is deliberately NOT the midpoint of the top interval: 1.5 would let
  // an expectation that is mostly "indirect evidence" through as direct.
  assert.equal(sufficiency.threshold, 1.9)
  assert.deepEqual(sufficiency.range, [0, 2])

  const gateOf = (probabilities: Record<string, number>, score: number) =>
    evaluateVerifyPolicy(
      {
        ...answers(0.99, 2, 0.01, 0.01),
        evidenceSufficiency: scoreAnswer(score, probabilities),
      } as Record<string, DecisionAnswer>,
      calibratedPolicy,
    ).gates.find((entry) => entry.id === 'evidenceSufficiency')?.verdict

  // 0.9 of the mass on the top rung gives E[level] = 1.9: it reaches the gate.
  assert.equal(gateOf({ 0: 0, 1: 0.1, 2: 0.9 }, 1.9), 'met')
  // 0.9 of the mass on the MIDDLE rung gives E[level] = 0.9: decisively not
  // direct evidence.
  assert.equal(gateOf({ 0: 0.1, 1: 0.9, 2: 0 }, 0.9), 'unmet')
  // E[level] = 1.65 with 0.65 of the mass on the top rung: a real reading that
  // has not committed, so undecided rather than met.
  assert.equal(gateOf({ 0: 0, 1: 0.35, 2: 0.65 }, 1.65), 'undecided')
})

test('the band between the rungs never reads as direct evidence', () => {
  // A continuous expectation that has not committed to the top rung is
  // undecided, not met. Under the previous midpoint threshold (1.5) these
  // values would have been a positive evidence gate.
  const sufficiency = DEFAULT_POLICY.gates.find((gate) => gate.id === 'evidenceSufficiency')!
  assert.ok(sufficiency.threshold > 1.5, 'the threshold must sit near the top, not the midpoint')
  const inBand = (score: number, probabilities: Record<string, number>) =>
    evaluateVerifyPolicy(
      { ...answers(0.99, 2, 0.01, 0.01), evidenceSufficiency: scoreAnswer(score, probabilities) } as Record<string, DecisionAnswer>,
      calibratedPolicy,
    )
  // 0.7 of the mass on the top rung, E[level] = 1.7: a real reading, but the
  // top rung is not in reach, so the answer is undecided rather than a pass.
  const partial = inBand(1.7, { 0: 0, 1: 0.3, 2: 0.7 })
  assert.equal(partial.gates.find((g) => g.id === 'evidenceSufficiency')?.verdict, 'undecided')
  assert.notEqual(partial.status, 'pass-candidate')
})

test('a discrete rubric still routes every decisive expectation', () => {
  const sufficiency = DEFAULT_POLICY.gates.find((gate) => gate.id === 'evidenceSufficiency')
  assert.ok(sufficiency)
  // The score is an expectation, so the rubric keeps a band between "clearly not
  // direct evidence" and "direct evidence" rather than only whole rungs.
  assert.notEqual(sufficiency.undecided, null)
  // A one-hot distribution at each rung is still a decisive answer, and must
  // route on the expectation value: 0 and 1 are not direct, 2 is.
  for (const [score, expected] of [
    [2, 'met'],
    [0, 'unmet'],
    [1, 'unmet'],
  ] as const) {
    const decision = evaluateVerifyPolicy(
      answers(0.99, score as 0 | 1 | 2, 0.01, 0.01),
      calibratedPolicy,
    )
    const gate = decision.gates.find((entry) => entry.id === 'evidenceSufficiency')
    assert.equal(gate?.verdict, expected, `one-hot at level ${score}`)
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

test('a missing or unparsable answer is unknown, never a pass', () => {
  for (const broken of [
    {},
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
    answers(0.99, 2, 0.01, 0.01, 0.2),
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
  assert.equal(byId.get('criterionTestable' as GateId)?.value, 0.99)
})

test('the reported telemetry carries numbers only, one per gate', () => {
  const decision = evaluateVerifyPolicy(answers(0.99, 2, 0.01, 0.01))
  const declared = decision.telemetry.declaredConfidence
  assert.deepEqual(Object.keys(declared).sort(), [
    'criterionTestable',
    'evidenceSufficiency',
    'needsDeeperVerification',
    'offScope',
    'satisfied',
  ])
  for (const value of Object.values(declared)) {
    assert.ok(value === null || typeof value === 'number')
  }
})

/* ------------------------------------------------------------------ *
 * Precedence. Each rule below is checked against the others, because a
 * precedence bug is only visible where two conditions hold at once.
 * ------------------------------------------------------------------ */

test('an incoherent answer outranks every other reading', () => {
  // Everything else is decisive and bad, but a contradictory answer carries no
  // value: nothing may be concluded from the rest.
  const decision = evaluateVerifyPolicy({
    ...answers(0.99, 2, 0.95, 0.95, 0.99),
    satisfied: { type: 'noul', probability: 0.01 },
    evidenceSufficiency: { type: 'score', score: 2, probabilities: { 0: 1, 1: 0, 2: 0 } },
  } as Record<string, DecisionAnswer>, calibratedPolicy)
  assert.equal(decision.status, 'unknown')
  assert.equal(decision.reasons[0], 'answer_unusable')
})

test('an undecidable criterion outranks a decisive failure and is never a pass', () => {
  // "Improve performance" is not decidable, and a deeper pass cannot make it so.
  // The status is `unknown` with a dedicated reason, NOT needs-verification and
  // NOT insufficient-evidence: the next action is to rewrite the criterion.
  for (const evidence of [
    answers(0.99, 2, 0.95, 0.01, 0.1),
    answers(0.99, 2, 0.01, 0.95, 0.1),
    answers(0.01, 2, 0.01, 0.01, 0.1),
    answers(0.99, 0, 0.01, 0.01, 0.1),
  ]) {
    const decision = evaluateVerifyPolicy(evidence as Record<string, DecisionAnswer>, calibratedPolicy)
    assert.equal(decision.status, 'unknown')
    assert.equal(decision.reasons[0], 'criterion_not_testable')
    assert.notEqual(decision.status, 'pass-candidate')
  }
})

test('off-scope outranks a criterion that reads as not satisfied', () => {
  // Both are decisive. The scope failure is the one that must not be hidden by
  // the follow-up status, because it says the change itself is the problem.
  const decision = evaluateVerifyPolicy(answers(0.01, 2, 0.9, 0.01), calibratedPolicy)
  assert.equal(decision.status, 'off-scope')
  assert.deepEqual(decision.reasons, ['off_scope_detected', 'criterion_not_satisfied'])
})

test('a decisively false criterion is needs-verification, not insufficient-evidence', () => {
  // The evidence is direct, the criterion is clearly not met: the work is
  // incomplete, and the follow-up is a deeper look at the implementation.
  const decision = evaluateVerifyPolicy(answers(0.05, 2, 0.02, 0.9), calibratedPolicy)
  assert.equal(decision.status, 'needs-verification')
  assert.ok(decision.reasons.includes('criterion_not_satisfied'))
})

test('insufficient evidence only decides when satisfied did not', () => {
  // `satisfied` is undecided: nothing proved it, nothing refuted it, so the
  // evidence reading is the actionable one.
  const undecidedSatisfied = evaluateVerifyPolicy(answers(0.7, 0, 0.01, 0.01), calibratedPolicy)
  assert.equal(undecidedSatisfied.status, 'insufficient-evidence')
  assert.deepEqual(undecidedSatisfied.reasons, ['evidence_insufficient'])

  // `satisfied` is decisively false: reporting "insufficient evidence" would
  // send the caller to gather evidence for a criterion that is already refuted.
  const refuted = evaluateVerifyPolicy(answers(0.01, 0, 0.01, 0.01), calibratedPolicy)
  assert.equal(refuted.status, 'needs-verification')
  assert.deepEqual(refuted.reasons, ['criterion_not_satisfied', 'evidence_insufficient'])
})

test('a neutral risk gate and a neutral satisfied gate are both unknown', () => {
  // needsDeeper in its band: not a decisive risk, so it must not manufacture a
  // needs-verification the answers did not support.
  const decision = evaluateVerifyPolicy(answers(0.99, 2, 0.01, 0.6), calibratedPolicy)
  assert.equal(decision.status, 'unknown')
  assert.deepEqual(decision.reasons, ['answer_undecided'])
  assert.equal(
    decision.gates.find((gate) => gate.id === 'needsDeeperVerification')?.verdict,
    'undecided',
  )
})

test('a decisively uncommitted criterion is a distinct unknown, never a verdict', () => {
  // Neither testable nor refuted: the band is the honest answer.
  const decision = evaluateVerifyPolicy(answers(0.99, 2, 0.01, 0.01, 0.6), calibratedPolicy)
  assert.equal(decision.status, 'unknown')
  assert.equal(decision.reasons.includes('criterion_not_testable'), false)
  assert.equal(
    decision.gates.find((gate) => gate.id === 'criterionTestable')?.verdict,
    'undecided',
  )
})

test('a pass candidate requires every positive condition and a calibration', () => {
  const all = answers(0.99, 2, 0.01, 0.01, 0.99)
  assert.equal(evaluateVerifyPolicy(all, calibratedPolicy).status, 'pass-candidate')
  // One condition short at a time. Each must break the pass.
  for (const oneShort of [
    { ...all, criterionTestable: { type: 'noul', probability: 0.1 } },
    { ...all, satisfied: { type: 'noul', probability: 0.1 } },
    { ...all, evidenceSufficiency: scoreAnswer(0, { 0: 1, 1: 0, 2: 0 }) },
    { ...all, offScope: { type: 'noul', probability: 0.9 } },
    { ...all, needsDeeperVerification: { type: 'noul', probability: 0.9 } },
    { ...all, satisfied: { type: 'noul', probability: 0.7 } },
    { ...all, offScope: { type: 'noul', probability: 0.3 } },
    { ...all, needsDeeperVerification: { type: 'noul', probability: 0.6 } },
    { ...all, evidenceSufficiency: scoreAnswer(1.6, { 0: 0, 1: 0.4, 2: 0.6 }) },
    { ...all, criterionTestable: { type: 'noul', probability: 0.6 } },
  ]) {
    assert.notEqual(
      evaluateVerifyPolicy(oneShort as Record<string, DecisionAnswer>, calibratedPolicy).status,
      'pass-candidate',
    )
  }
  // And the shipped policy is positive-reachable for no answer at all.
  assert.equal(evaluateVerifyPolicy(all).status, 'unknown')
})
