import type { DecisionAnswer, DecisionResponse } from '../decision/types.js'
import { ProviderError } from '../errors.js'

/**
 * A ranked result is a CANDIDATE, never a verdict. The caller must confirm it
 * with deterministic tools before acting on it.
 */
export interface RankedCandidate {
  readonly path: string
  /** The expectation E[level] the provider reported, or null when unusable. */
  readonly score: number | null
  /** The distribution, kept so the caller can judge the spread itself. */
  readonly probabilities: Record<string, number> | null
  readonly confidence: number | null
  /** False when the answer was missing, unusable or internally inconsistent. */
  readonly usable: boolean
}

export interface DiscoveryReport {
  readonly reportId: string
  readonly trace: {
    readonly tool: 'semantic_search' | 'semantic_scan'
    readonly questionId: string
    readonly question: string
    readonly candidatePaths: readonly string[]
    readonly skippedPaths: readonly string[]
  }
  /** Always true: a ranking is advice, it never accepts or rejects anything. */
  readonly advisory: true
  readonly candidates: readonly RankedCandidate[]
  readonly provider: string
  readonly model?: string
  readonly latencyMs: number
  readonly evidenceBytes: number
  readonly reasons: readonly string[]
}

/**
 * The discovery rubric has three levels, so a conforming distribution carries
 * exactly the keys "0", "1" and "2", and the score is the expectation E[level]
 * over that range: a value in [0, 2].
 */
const RUBRIC_LENGTH = 3
const TOP_LEVEL = RUBRIC_LENGTH - 1

/** Returns the uniform "nothing was ranked" outcome. */
function unusable(
  files: readonly { path: string }[],
  confidence: number | null,
  reasons: string[] = ['answer_unusable'],
): { candidates: RankedCandidate[]; reasons: string[] } {
  return {
    candidates: files.map((file) => ({
      path: file.path,
      score: null,
      probabilities: null,
      confidence,
      usable: false,
    })),
    reasons,
  }
}

function readNumber(answer: unknown, key: 'score' | 'confidence'): number | null {
  if (answer === null || typeof answer !== 'object') return null
  const value = (answer as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Turns one batched answer into ranked candidates.
 *
 * A score answer is the expectation E[level] over the caller's rubric. The
 * distribution is validated against it here, and a file whose answer is
 * missing, inconsistent or self-contradictory is reported as `usable: false`
 * rather than being ranked. An unusable entry is never presented as relevant.
 */
export function rankCandidates(
  files: readonly { path: string; content: string }[],
  answers: Record<string, DecisionAnswer | undefined>,
  questionId: string,
): { candidates: RankedCandidate[]; reasons: string[] } {
  const answer = answers[questionId] as
    | { type?: string; score?: unknown; probabilities?: unknown; confidence?: unknown }
    | undefined
  const reasons: string[] = []

  if (!answer || answer.type !== 'score') {
    return unusable(files, null)
  }

  const score = readNumber(answer, 'score')
  const confidence = readNumber(answer, 'confidence')
  const raw = answer.probabilities
  if (score === null || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return unusable(files, confidence)
  }

  const probabilities: Record<string, number> = {}
  let sum = 0
  let expectation = 0
  let decisiveMass = 0
  for (const [level, mass] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof mass !== 'number' || !Number.isFinite(mass) || mass < 0 || mass > 1 || !/^\d+$/.test(level)) {
      return unusable(files, confidence)
    }
    probabilities[level] = mass
    sum += mass
    expectation += Number(level) * mass
    if (mass > decisiveMass) decisiveMass = mass
  }
  // The rubric the tool declared has exactly three levels, so the answer must
  // carry exactly those three. A provider answering a five-level rubric would
  // otherwise pass, and its score would mean something different.
  const levels = Object.keys(probabilities).map(Number).sort((a, b) => a - b)
  if (levels.length !== RUBRIC_LENGTH || levels.some((level, i) => level !== i)) {
    return unusable(files, confidence, ['rubric_shape_mismatch'])
  }
  if (Math.abs(sum - 1) > 0.02) {
    reasons.push('distribution_does_not_sum_to_one')
  }
  // The declared score must match the expectation its own distribution implies.
  const consistent = Math.abs(score - expectation) <= 0.01 + 1e-9
  if (!consistent) reasons.push('score_contradicts_distribution')
  if (score < 0 || score > TOP_LEVEL) reasons.push('score_outside_rubric_range')
  // A tie asserts no level, so it is not ranked as if it had.
  if (decisiveMass <= 0.5) reasons.push('no_decisive_level')

  const usable = consistent && score >= 0 && score <= TOP_LEVEL && decisiveMass > 0.5
  return {
    candidates: files.map((file) => ({
      path: file.path,
      score: usable ? score : null,
      probabilities: usable ? probabilities : null,
      confidence,
      usable,
    })),
    reasons: usable ? [] : [...new Set(reasons.length ? reasons : ['answer_unusable'])],
  }
}

export function buildReport(
  tool: 'semantic_search' | 'semantic_scan',
  reportId: string,
  questionId: string,
  question: string,
  read: { files: readonly { path: string; content: string }[]; bytes: number; skipped: readonly string[] },
  response: DecisionResponse,
  ranked: { candidates: RankedCandidate[]; reasons: string[] },
): DiscoveryReport {
  return {
    reportId,
    trace: {
      tool,
      questionId,
      question,
      candidatePaths: read.files.map((file) => file.path),
      skippedPaths: read.skipped,
    },
    advisory: true,
    // Best first, and the unusable ones last so they cannot be mistaken for
    // relevant candidates.
    candidates: [...ranked.candidates].sort((a, b) => {
      if (a.usable !== b.usable) return a.usable ? -1 : 1
      return (b.score ?? -1) - (a.score ?? -1)
    }),
    provider: response.provider,
    ...(response.model ? { model: response.model } : {}),
    latencyMs: response.latencyMs ?? 0,
    evidenceBytes: read.bytes,
    reasons: ranked.reasons,
  }
}
