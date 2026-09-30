// Use-case policy for the semantic verification experiment.
//
// This module is the ONLY place where a probability becomes a verdict. The
// provider adapter stays numeric, the OpenFox tool layer stays neutral, and the
// thresholds below are uncalibrated constants that a labelled fixture run may
// eventually inform. Nothing here is exposed as a setting: a global confidence
// slider would be exactly the kind of unjustified knob AGENTS.md forbids.

export const VERIFY_POLICY_VERSION = 'verify-0.1.0'

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
      threshold: 2,
      // Discrete rubric: "partial" is itself a meaningful routing answer.
      undecided: null,
      range: [0, EVIDENCE_SUFFICIENCY_RUBRIC.length - 1],
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
 * Minimum probability mass a rubric answer must place on the rung it claims, for
 * the claim to be internally consistent. Below this the distribution disagrees
 * with the score and the answer is unusable.
 */
const MIN_RUBRIC_AGREEMENT = 0.5

/**
 * A normalized answer is only usable if it is internally consistent.
 *
 * A score answer carries both a `score` and a `probabilities` distribution.
 * The adapter accepts whatever the runtime returns, so a response may assert
 * `score: 2` while its whole probability mass sits on rung 1. Reading the
 * score alone would turn that contradiction into a positive verdict, which is
 * the exact failure this use case exists to prevent. The score is therefore
 * only accepted when the declared distribution agrees with it.
 *
 * An explicit `confidence` is honoured the same way: a low-confidence answer
 * is unusable rather than a weak positive.
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
    if (probabilities === null || typeof probabilities !== 'object') return null
    const entries = Object.entries(probabilities as Record<string, unknown>)
    if (entries.length === 0) return null
    let best: { label: string; mass: number } | null = null
    for (const [label, mass] of entries) {
      if (typeof mass !== 'number' || !Number.isFinite(mass)) return null
      if (best === null || mass > best.mass) best = { label, mass }
    }
    // A flat distribution expresses no preference between rungs: undecided.
    if (best === null || best.mass < MIN_RUBRIC_AGREEMENT) return null
    // The declared score must be the rung the distribution actually favours.
    if (best.label !== String(score)) return null
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
