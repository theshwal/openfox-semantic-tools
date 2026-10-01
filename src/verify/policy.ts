// Use-case policy for the semantic verification experiment.
//
// This module is the ONLY place where a probability becomes a verdict. The
// provider adapter stays numeric, the OpenFox tool layer stays neutral, and the
// thresholds below are uncalibrated constants that a labelled fixture run may
// eventually inform. Nothing here is exposed as a setting: a global confidence
// slider would be exactly the kind of unjustified knob AGENTS.md forbids.

export const VERIFY_POLICY_VERSION = 'verify-0.3.0'

export type GateId =
  | 'satisfied'
  | 'evidenceSufficiency'
  | 'offScope'
  | 'needsDeeperVerification'
  | 'criterionTestable'

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
/**
 * `unusable`: the answer is malformed, out of the admissible range, or
 * contradicts itself. It carries no value the policy may read, and it can
 * never be a step towards a positive.
 *
 * There is deliberately NO confidence-derived verdict. A value the runtime
 * declares about its own certainty is telemetry, not evidence about the
 * repository: it is not comparable across runtimes, it is not comparable
 * across providers, and a policy threshold on it measures the runtime rather
 * than the code. `verify-0.2.2` had a `low-confidence` verdict driven by a
 * declared confidence floor and a decisive-mass floor; both were removed
 * because they made a coherent, well-formed answer indistinguishable from a
 * malformed one, and in the recorded live campaigns they discarded every
 * decisive reading on the other gates. A valid, coherent answer is now
 * classified ONLY by the gate's own threshold and band.
 */
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
 * `length - 1`.
 */
const TOP_EVIDENCE_RUNG = EVIDENCE_SUFFICIENCY_RUBRIC.length - 1

/**
 * "Direct evidence" gate, in level units, per the score contract in
 * `docs/SCORE-CONTRACT.md` (option A).
 *
 * The score is E[level], so the gate asks whether the expectation has reached
 * the TOP level, the strongest rung. The contract states the gate explicitly as
 * `E[level] >= top - 0.1`: a score may be used to cross a threshold, and never
 * to measure a distance. The 0.1 slack absorbs the two-decimal rounding a real
 * runtime reports.
 */
const DIRECT_EVIDENCE_THRESHOLD = TOP_EVIDENCE_RUNG - 0.1

/**
 * Where "decisively NOT direct evidence" ends, in level units.
 *
 * Unchanged from the previous policy and derived from the rubric, not tuned: a
 * value at or above the top of the middle rung has moved into the upper half of
 * the scale and is no longer an unambiguous "no direct evidence". Below it the
 * answer is decisive and is reported as insufficient evidence.
 *
 * Between this edge and the gate, the expectation has neither committed to the
 * top rung nor been ruled out, so the band is `undecided` — the safe direction,
 * `unknown`, never a positive.
 */
const NOT_DIRECT_FLOOR = TOP_EVIDENCE_RUNG - 0.5

/**
 * `criterionTestable`: the criterion itself must be decidable from evidence.
 *
 * A criterion like "improve performance" has no state in which it is satisfied
 * and no state in which it fails, so EVERY other answer about it is noise. This
 * gate is asked BEFORE the substantive ones are trusted, and a decisively
 * negative reading is its own terminal `unknown` with the reason
 * `criterion_not_testable`. It is never a pass and never a
 * `needs-verification`: a deeper pass cannot make an undecidable criterion
 * decidable, and the correct next action is to rewrite the criterion.
 */
const CRITERION_TESTABLE_THRESHOLD = 0.8
const CRITERION_NOT_TESTABLE_FLOOR = 0.4

export const DEFAULT_POLICY: VerifyPolicy = {
  version: VERIFY_POLICY_VERSION,
  calibrated: false,
  gates: [
    {
      id: 'criterionTestable',
      direction: 'at-least',
      polarity: 'high-is-good',
      threshold: CRITERION_TESTABLE_THRESHOLD,
      undecided: [CRITERION_NOT_TESTABLE_FLOOR, CRITERION_TESTABLE_THRESHOLD],
      range: [0, 1],
    },
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
      // 2). "Direct evidence" is an expectation that reached the top level, per
      // docs/SCORE-CONTRACT.md. Below the gate the answer is undecided down to
      // the top of the middle rung, and decisively insufficient below that.
      threshold: DIRECT_EVIDENCE_THRESHOLD,
      undecided: [NOT_DIRECT_FLOOR, DIRECT_EVIDENCE_THRESHOLD],
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
  /**
   * Numbers the runtime declared about ITS OWN certainty, kept as telemetry
   * only. They are reported so a later calibrated run can correlate them with
   * an outcome; they never reach a threshold, a verdict or a status. Values
   * only, so nothing textual from a provider payload can reach a report.
   */
  readonly telemetry: { readonly declaredConfidence: Readonly<Record<string, number | null>> }
}

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
 * Reads the number the runtime committed to, or null when the answer is
 * malformed or self-contradictory.
 *
 * There is one question here, and it is about COHERENCE only: a `score` answer
 * carries both a `score` and a `probabilities` distribution, and per the
 * documented contract the score is the expectation E[level] over that
 * distribution. A score that disagrees with its own distribution is a
 * CONTRADICTION and is `unusable`; a continuous or rounded expectation is
 * accepted.
 *
 * Nothing about a declared `confidence` can change the result. A non-numeric
 * confidence is still a malformed payload, so it is refused, but a LOW value is
 * simply telemetry.
 */
function readValue(answer: unknown): number | null {
  if (answer === null || typeof answer !== 'object') return null
  const record = answer as {
    type?: unknown
    probability?: unknown
    score?: unknown
    probabilities?: unknown
    confidence?: unknown
  }
  if (record.confidence !== undefined && typeof record.confidence !== 'number') return null
  if (record.type === 'score') {
    const { score, probabilities } = record
    if (typeof score !== 'number' || !Number.isFinite(score)) return null
    const expectation = expectationOf(probabilities)
    if (expectation === null) return null
    if (Math.abs(score - expectation) > SCORE_EXPECTATION_TOLERANCE + FLOAT_SLACK) return null
    return score
  }
  const raw = record.probability
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  return raw
}

/** The declared confidence, as a number, for telemetry. Never a policy input. */
function declaredConfidenceOf(answer: unknown): number | null {
  if (answer === null || typeof answer !== 'object') return null
  const value = (answer as { confidence?: unknown }).confidence
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function classify(gate: VerifyGate, answer: unknown): GateOutcome {
  const base = {
    id: gate.id,
    threshold: gate.threshold,
    direction: gate.direction,
    polarity: gate.polarity,
  }
  const value = readValue(answer)
  if (value === null) return { ...base, value: null, verdict: 'unusable' }
  const [rangeMin, rangeMax] = gate.range
  if (value < rangeMin || value > rangeMax) {
    return { ...base, value, verdict: 'unusable' }
  }

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
  criterionTestable: 'criterion_not_testable',
  offScope: 'off_scope_detected',
  evidenceSufficiency: 'evidence_insufficient',
  needsDeeperVerification: 'deeper_verification_recommended',
  satisfied: 'criterion_not_satisfied',
}

/**
 * Gates whose status is decided by the criterion itself rather than by the
 * evidence. A decisive negative here outranks every evidence reading, because
 * a verdict about an undecidable criterion is a verdict about nothing.
 */
const PRECONDITION_GATES = ['criterionTestable'] as const

/**
 * Orders the reason codes of a decision: the code that decided the status
 * first, then every other decisive failure still worth reporting.
 *
 * The full list of `unmet` reasons is always reported, because a caller that
 * only learns the primary one would still be missing real findings. Only the
 * FIRST code is the routing decision, so the list is never read as a ranking.
 */
function reasonsStartingWith(unmetReasons: readonly string[], primary: string): string[] {
  const rest = unmetReasons.filter((reason) => reason !== primary)
  return [primary, ...rest]
}

export function evaluateVerifyPolicy(
  answers: Record<string, unknown>,
  policy: VerifyPolicy = DEFAULT_POLICY,
): PolicyDecision {
  const gates = policy.gates.map((gate) => classify(gate, answers[gate.id]))
  const declaredConfidence: Record<string, number | null> = {}
  for (const gate of policy.gates) declaredConfidence[gate.id] = declaredConfidenceOf(answers[gate.id])
  const base = {
    policyVersion: policy.version,
    calibrated: policy.calibrated,
    gates,
    telemetry: { declaredConfidence },
  }

  // A decisive failure stays visible even when another gate is undecided: the
  // status stays `unknown`, but the caller must still learn what is wrong.
  const unmetReasons = gates
    .filter((gate) => gate.verdict === 'unmet')
    .map((gate) => UNMET_REASON[gate.id])

  const verdictOf = (id: GateId) => gates.find((gate) => gate.id === id)?.verdict
  const unmet = (id: GateId) => verdictOf(id) === 'unmet'
  const undecided = (id: GateId) => verdictOf(id) === 'undecided'

  // 1. A malformed or self-contradictory answer carries no value. Nothing may
  //    be concluded, and nothing may be positive.
  if (gates.some((gate) => gate.verdict === 'unusable')) {
    return { ...base, status: 'unknown', reasons: ['answer_unusable', ...unmetReasons] }
  }

  // 2. An undecidable criterion is terminal, before any risk or evidence
  //    reading is trusted. A deeper pass cannot fix it; the criterion can.
  const notTestable = PRECONDITION_GATES.filter((id) => unmet(id))
  if (notTestable.length > 0) {
    return {
      ...base,
      status: 'unknown',
      reasons: reasonsStartingWith(unmetReasons, UNMET_REASON.criterionTestable),
    }
  }

  // 3. A neutral reading, or a gate whose answer is absent, is `unknown` — but
  //    a decisively unmet gate beside it still routes below, so the caller is
  //    told what is wrong rather than only that nothing is known.
  const anyUndecided = gates.some((gate) => gate.verdict === 'undecided')

  let status: VerifyStatus
  let primary: string

  if (unmet('offScope')) {
    // Unrelated behaviour is a scope failure regardless of how well the
    // criterion itself reads.
    status = 'off-scope'
    primary = UNMET_REASON.offScope
  } else if (unmet('satisfied')) {
    // The criterion is not met, on evidence that was read. The work is
    // incomplete: that is `needs-verification`, not `insufficient-evidence`,
    // because a deeper pass is exactly the follow-up that can settle it.
    status = 'needs-verification'
    primary = UNMET_REASON.satisfied
  } else if (unmet('needsDeeperVerification')) {
    // The criterion may be met, but a concrete risk of a superficial fix was
    // identified: a deeper pass is warranted.
    status = 'needs-verification'
    primary = UNMET_REASON.needsDeeperVerification
  } else if (unmet('evidenceSufficiency')) {
    // Reached only when `satisfied` did not already decide the case. An
    // insufficient-evidence verdict that overrode a decisive "not satisfied"
    // would report the wrong next action: redo the work, not gather evidence.
    status = 'insufficient-evidence'
    primary = UNMET_REASON.evidenceSufficiency
  } else if (anyUndecided) {
    status = 'unknown'
    primary = 'answer_undecided'
  } else {
    status = 'pass-candidate'
    primary = 'all_gates_met'
  }

  const reasons =
    status === 'pass-candidate' ? [] : reasonsStartingWith(unmetReasons, primary)

  if (status === 'pass-candidate' && !policy.calibrated) {
    // A positive verdict is not reachable before a measured calibration exists.
    status = 'unknown'
    reasons.push('policy_not_calibrated')
  }

  return { ...base, status, reasons }
}
