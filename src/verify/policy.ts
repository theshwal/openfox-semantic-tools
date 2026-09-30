// Use-case policy for the semantic verification experiment.
//
// This module is the ONLY place where a probability becomes a verdict. The
// provider adapter stays numeric, the OpenFox tool layer stays neutral, and the
// thresholds below are uncalibrated constants that a labelled fixture run may
// eventually inform. Nothing here is exposed as a setting: a global confidence
// slider would be exactly the kind of unjustified knob AGENTS.md forbids.

export const VERIFY_POLICY_VERSION = 'verify-0.2.0'

export type GateId =
  | 'satisfied'
  | 'evidenceSufficiency'
  | 'offScope'
  | 'needsDeeperVerification'

/**
 * `high-is-good`: a high value supports acceptance.
 * `high-is-risk`: a high value signals a problem, so the gate is satisfied
 * only when the value stays LOW.
 *
 * The polarity is declared once per gate so no caller has to remember which
 * questions are phrased as risks and which are phrased as positives.
 */
export type GatePolarity = 'high-is-good' | 'high-is-risk'
export type GateDirection = 'at-least' | 'at-most'
export type GateVerdict = 'met' | 'unmet' | 'undecided' | 'unusable'

export interface VerifyGate {
  readonly id: GateId
  readonly direction: GateDirection
  readonly polarity: GatePolarity
  /** The inclusive value at which the gate starts to be decisive. */
  readonly threshold: number
  /**
   * Closed interval of "not decisive enough to act on", or null when the gate
   * has no ambiguous region and every admissible value is decisive.
   *
   * When present, the band always shares one edge with `threshold`, and that
   * shared edge is EXCLUSIVE in the undecided zone because the threshold itself
   * is decisive:
   *
   * - `at-least`: undecided is [low, threshold), met >= threshold, unmet < low
   * - `at-most`:  undecided is (threshold, high], met <= threshold, unmet > high
   *
   * A discrete ordinal rubric uses null: its rungs are already distinct
   * verdicts, so pretending a rung is "uncertain" would only blur a correct
   * routing decision.
   */
  readonly undecided: readonly [number, number] | null
  /** Admissible answer range. A value outside it is unusable, never decisive. */
  readonly range: readonly [number, number]
}

export interface VerifyPolicy {
  readonly version: string
  /**
   * No labelled run against a real provider has been performed yet. While this
   * is false the policy cannot emit a positive verdict, whatever the answers say.
   */
  readonly calibrated: boolean
  readonly gates: readonly VerifyGate[]
}

/** Score rubric for `evidenceSufficiency`, shared with the built question set. */
export const EVIDENCE_SUFFICIENCY_RUBRIC = [
  'No evidence related to the criterion is present',
  'Indirect or partial evidence that does not directly address the criterion',
  'Direct evidence that addresses the criterion with code and test output',
] as const

/**
 * The rubric's top level number. A three-level rubric runs 0..2, so the top is
 * `length - 1`. Because the score is an expectation over that range, a value at
 * or above the midpoint of the top interval is treated as direct evidence: the
 * expectation has clearly moved into the strongest rung.
 */
const TOP_EVIDENCE_RUNG = EVIDENCE_SUFFICIENCY_RUBRIC.length - 1
const DIRECT_EVIDENCE_THRESHOLD = TOP_EVIDENCE_RUNG - 0.5

export const DEFAULT_POLICY: VerifyPolicy = {
  version: VERIFY_POLICY_VERSION,
  calibrated: false,
  gates: [
    {
      id: 'satisfied',
      direction: 'at-least',
      polarity: 'high-is-good',
      threshold: 0.9,
      undecided: [0.6, 0.9],
      range: [0, 1],
    },
    {
      id: 'evidenceSufficiency',
      direction: 'at-least',
      polarity: 'high-is-good',
      // The rubric has 3 levels, so the expectation runs 0..2 (top level number
      // 2). "Direct evidence" means the expectation has crossed into the upper
      // half of the top interval. The band below that point has not committed to
      // the strongest rung, and a lower value is decisively not direct evidence.
      threshold: DIRECT_EVIDENCE_THRESHOLD,
      undecided: [DIRECT_EVIDENCE_THRESHOLD, TOP_EVIDENCE_RUNG + 0.5],
      range: [0, TOP_EVIDENCE_RUNG],
    },
    {
      id: 'offScope',
      direction: 'at-most',
      polarity: 'high-is-risk',
      threshold: 0.2,
      undecided: [0.2, 0.4],
      range: [0, 1],
    },
    {
      id: 'needsDeeperVerification',
      direction: 'at-most',
      polarity: 'high-is-risk',
      threshold: 0.5,
      undecided: [0.5, 0.8],
      range: [0, 1],
    },
  ],
}

export type VerifyStatus =
  | 'pass-candidate'
  | 'needs-verification'
  | 'insufficient-evidence'
  | 'off-scope'
  | 'unknown'

export interface GateOutcome {
  readonly id: GateId
  readonly threshold: number
  readonly direction: GateDirection
  readonly polarity: GatePolarity
  readonly value: number | null
  readonly verdict: GateVerdict
}

export interface PolicyDecision {
  readonly status: VerifyStatus
  readonly policyVersion: string
  readonly calibrated: boolean
  readonly gates: readonly GateOutcome[]
  readonly reasons: readonly string[]
}

/** Minimum declared confidence before an answer may drive any verdict. */
const MIN_ANSWER_CONFIDENCE = 0.5

/**
 * Tolerance when checking a score against the expectation implied by its own
 * distribution.
 *
 * A score is E[level] = Σ(level × probability), the documented System One
 * meaning. Responses are reported to two decimals, so an exact distribution can
 * imply an expectation that differs by half of the last reported digit. 0.01
 * covers one rounding step; it is deliberately tight enough that a genuine
 * contradiction, such as a score of 0.15 against an expectation of 1.43, is
 * still rejected.
 */
const SCORE_EXPECTATION_TOLERANCE = 0.01

/**
 * Binary floating point cannot represent 0.15 - 0.14 exactly: the subtraction
 * yields 0.010000000000000009, which is greater than the tolerance and would
 * reject a correctly rounded response. Comparing the two numbers with a small
 * relative slack keeps the boundary honest.
 */
const FLOAT_SLACK = 1e-9

/**
 * Probability mass a rubric answer must place on a single level for the answer
 * to be decisive.
 *
 * The floor is strictly above 0.5 on purpose: at exactly 0.5 the top two levels
 * are tied, the model expressed no preference, and rounding it to a level would
 * fabricate a discrete outcome it never asserted. A tie is therefore unusable,
 * not a coin flip.
 */
const MIN_DECISIVE_MASS = 0.5 + Number.EPSILON

/**
 * Computes E[level] from a rubric distribution.
 *
 * Returns null when the distribution is absent, not a plain record of
 * numeric masses, or does not sum to one within a rounding tolerance.
 */
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
  // Responses carry two decimals per level, so the masses can sum to 0.99 or
  // 1.01 without being wrong.
  if (levels === 0 || Math.abs(sum - 1) > 0.02) return null
  return expectation
}

/**
 * A normalized answer is only usable if it is internally consistent.
 *
 * A score answer carries both a `score` and a `probabilities` distribution. Per
 * the documented contract the score is the expectation E[level] over that
 * distribution, not a level index: a three-level rubric yields a value that may
 * fall anywhere in [0, 2] and often lands between two levels. The adapter
 * accepts whatever the runtime returns, so the two are cross-checked here: a
 * score that disagrees with its own distribution is a contradiction and is
 * rejected, while a continuous or rounded expectation is accepted.
 *
 * An explicit `confidence` is honoured independently: a low-confidence answer is
 * unusable rather than a weak positive.
 */
function readValue(answer: unknown, gate: VerifyGate): number | null {
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
    // A provider may state its own uncertainty; below the floor the answer is
    // not trustworthy enough to drive any verdict, favourable or not.
    if (record.confidence < MIN_ANSWER_CONFIDENCE) return null
  }
  if (record.type === 'score') {
    const { score, probabilities } = record
    if (typeof score !== 'number' || !Number.isFinite(score)) return null
    const expectation = expectationOf(probabilities)
    if (expectation === null) return null
    // Cross-check: the declared score must match the expectation its own
    // distribution implies, within the tolerance the response precision allows.
    if (Math.abs(score - expectation) > SCORE_EXPECTATION_TOLERANCE + FLOAT_SLACK) return null

    // The mass decides decisiveness, not the index. A level index is NOT
    // derived by rounding: that would invent a discrete outcome.
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

function classify(gate: VerifyGate, answer: unknown): GateOutcome {
  const base = {
    id: gate.id,
    threshold: gate.threshold,
    direction: gate.direction,
    polarity: gate.polarity,
  }
  const value = readValue(answer, gate)
  if (value === null) return { ...base, value: null, verdict: 'unusable' }
  const [rangeMin, rangeMax] = gate.range
  if (value < rangeMin || value > rangeMax) return { ...base, value, verdict: 'unusable' }

  const [low, high] = gate.undecided ?? []
  const decisive =
    gate.direction === 'at-least' ? value >= gate.threshold : value <= gate.threshold
  if (decisive) return { ...base, value, verdict: 'met' }
  if (gate.undecided === null) return { ...base, value, verdict: 'unmet' }

  const belowBand =
    gate.direction === 'at-least' ? value < low! : value > high!
  return { ...base, value, verdict: belowBand ? 'unmet' : 'undecided' }
}

/** Reason code contributed by a gate whose value is decisively unmet. */
const UNMET_REASON: Record<GateId, string> = {
  offScope: 'off_scope_detected',
  evidenceSufficiency: 'evidence_insufficient',
  needsDeeperVerification: 'deeper_verification_recommended',
  satisfied: 'criterion_not_satisfied',
}

export function evaluateVerifyPolicy(
  answers: Record<string, unknown>,
  policy: VerifyPolicy = DEFAULT_POLICY,
): PolicyDecision {
  const gates = policy.gates.map((gate) => classify(gate, answers[gate.id]))
  const base = { policyVersion: policy.version, calibrated: policy.calibrated, gates }

  // A decisive failure stays visible even when another gate is undecided: the
  // status stays `unknown`, but the caller must still learn what is wrong.
  const unmetReasons = gates
    .filter((gate) => gate.verdict === 'unmet')
    .map((gate) => UNMET_REASON[gate.id])

  if (gates.some((gate) => gate.verdict === 'unusable')) {
    return { ...base, status: 'unknown', reasons: ['answer_unusable', ...unmetReasons] }
  }
  if (gates.some((gate) => gate.verdict === 'undecided')) {
    return { ...base, status: 'unknown', reasons: ['answer_undecided', ...unmetReasons] }
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
    // A positive verdict is not reachable before a measured calibration exists.
    status = 'unknown'
    reasons.push('policy_not_calibrated')
  }

  return { ...base, status, reasons }
}
