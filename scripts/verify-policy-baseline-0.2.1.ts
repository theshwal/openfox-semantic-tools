// Frozen copy of the `verify-0.2.1` verdict rules, kept ONLY so an offline
// replay can demonstrate that it reproduces the statuses those two live
// campaigns recorded before the policy was changed.
//
// This file is not part of the shipped policy and no tool imports it. It is
// deliberately NOT a second copy of the gates: it reads `DEFAULT_POLICY.gates`
// as they are, so a replay can never smuggle a threshold change past the
// comparison. What it freezes is exactly the two rules the change replaced —
// one single `unusable` verdict for both a contradiction and a hesitation, and
// the routing that short-circuits on it.
//
// The constants below are the 0.2.1 values, restated here verbatim.
import { DEFAULT_POLICY, type GateId, type GateOutcome, type VerifyGate, type VerifyPolicy, type VerifyStatus } from '../src/verify/policy.ts'

const MIN_ANSWER_CONFIDENCE = 0.5
const SCORE_EXPECTATION_TOLERANCE = 0.01
const FLOAT_SLACK = 1e-9
const MIN_DECISIVE_MASS = 0.5 + Number.EPSILON

function expectationOf(probabilities: unknown): number | null {
  if (probabilities === null || typeof probabilities !== 'object' || Array.isArray(probabilities)) {
    return null
  }
  let sum = 0
  let expectation = 0
  let levels = 0
  for (const [level, mass] of Object.entries(probabilities as Record<string, unknown>)) {
    if (typeof mass !== 'number' || !Number.isFinite(mass) || mass < 0 || mass > 1) return null
    if (!/^\d+$/.test(level)) return null
    sum += mass
    expectation += Number(level) * mass
    levels += 1
  }
  if (levels === 0 || Math.abs(sum - 1) > 0.02) return null
  return expectation
}

function readValue(answer: unknown): number | null {
  if (answer === null || typeof answer !== 'object') return null
  const record = answer as {
    type?: unknown
    probability?: unknown
    score?: unknown
    probabilities?: unknown
    confidence?: unknown
  }
  if (record.confidence !== undefined) {
    if (typeof record.confidence !== 'number' || !Number.isFinite(record.confidence)) return null
    if (record.confidence < MIN_ANSWER_CONFIDENCE) return null
  }
  if (record.type === 'score') {
    const { score, probabilities } = record
    if (typeof score !== 'number' || !Number.isFinite(score)) return null
    const expectation = expectationOf(probabilities)
    if (expectation === null) return null
    if (Math.abs(score - expectation) > SCORE_EXPECTATION_TOLERANCE + FLOAT_SLACK) return null
    let decisiveMass = 0
    for (const mass of Object.values(probabilities as Record<string, number>)) {
      if (mass > decisiveMass) decisiveMass = mass
    }
    if (decisiveMass < MIN_DECISIVE_MASS) return null
    return score
  }
  const raw = record.probability
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  return raw
}

function classify(
  gate: VerifyGate,
  answer: unknown,
): GateOutcome {
  const base = {
    id: gate.id,
    threshold: gate.threshold,
    direction: gate.direction,
    polarity: gate.polarity,
  }
  const value = readValue(answer)
  if (value === null) return { ...base, value: null, verdict: 'unusable' }
  const [rangeMin, rangeMax] = gate.range
  if (value < rangeMin || value > rangeMax) return { ...base, value, verdict: 'unusable' }

  const [low, high] = gate.undecided ?? []
  const decisive = gate.direction === 'at-least' ? value >= gate.threshold : value <= gate.threshold
  if (decisive) return { ...base, value, verdict: 'met' }
  if (gate.undecided === null) return { ...base, value, verdict: 'unmet' }

  const belowBand = gate.direction === 'at-least' ? value < low! : value > high!
  return { ...base, value, verdict: belowBand ? 'unmet' : 'undecided' }
}

/**
 * The four gates `verify-0.2.1` declared, in their own vocabulary. The
 * `criterionTestable` gate was added later and has no 0.2.1 reason code: a
 * frozen baseline must not invent one, and the replay already reports it as
 * `gatesNotAskedByTheseRuns`.
 */
const UNMET_REASON: Partial<Record<GateId, string>> = {
  offScope: 'off_scope_detected',
  evidenceSufficiency: 'evidence_insufficient',
  needsDeeperVerification: 'deeper_verification_recommended',
  satisfied: 'criterion_not_satisfied',
}

/** The `verify-0.2.1` decision, reproduced on the gates the policy declares. */
export function evaluateBaselinePolicy(
  answers: Record<string, unknown>,
  policy: VerifyPolicy = DEFAULT_POLICY,
): { status: VerifyStatus; gates: GateOutcome[]; reasons: string[] } {
  const gates = policy.gates.map((gate) => classify(gate, answers[gate.id]))
  const unmetReasons = gates
    .filter((gate) => gate.verdict === 'unmet')
    .map((gate) => UNMET_REASON[gate.id] ?? `criterion_not_decided:${gate.id}`)

  if (gates.some((gate) => gate.verdict === 'unusable')) {
    return { status: 'unknown', gates, reasons: ['answer_unusable', ...unmetReasons] }
  }
  if (gates.some((gate) => gate.verdict === 'undecided')) {
    return { status: 'unknown', gates, reasons: ['answer_undecided', ...unmetReasons] }
  }

  const unmet = (id: GateId) => gates.find((gate) => gate.id === id)?.verdict === 'unmet'
  const reasons: string[] = []
  let status: VerifyStatus

  if (unmet('offScope')) {
    status = 'off-scope'
    reasons.push('off_scope_detected')
  } else if (unmet('evidenceSufficiency')) {
    status = 'insufficient-evidence'
    reasons.push('evidence_insufficient')
  } else if (unmet('needsDeeperVerification')) {
    status = 'needs-verification'
    reasons.push('deeper_verification_recommended')
  } else if (unmet('satisfied')) {
    status = 'needs-verification'
    reasons.push('criterion_not_satisfied')
  } else {
    status = 'pass-candidate'
  }

  if (status === 'pass-candidate' && !policy.calibrated) {
    status = 'unknown'
    reasons.push('policy_not_calibrated')
  }

  return { status, gates, reasons }
}

export const BASELINE_POLICY_VERSION = 'verify-0.2.1'
