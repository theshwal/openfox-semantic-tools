import type { DecisionAnswer, DecisionResponse } from '../decision/types.js'
import {
  buildRelevanceEnvelope,
  thresholdReason,
  thresholdStatus,
  type RelevanceEnvelope,
  type SkipReasonCode,
  type ThresholdVerdict,
} from '../relevance/envelope.js'
import { discoveryQuestionId } from './request.js'
import type { LocalRecallCandidate, LocalRecallResult } from './recall.js'

/**
 * A ranked result is a CANDIDATE, never a verdict. The caller must confirm it
 * with deterministic tools before acting on it.
 */
/**
 * A candidate before the operator dial is applied.
 *
 * `applyThreshold` is the ONLY way a `RankedCandidate` comes into existence,
 * so the threshold fields cannot be forgotten: the type system refuses a
 * reported candidate that was never classified.
 */
export interface RankedCandidateBase {
  readonly path: string
  /** Semantic expectation E[level], null when semantic ranking was unavailable. */
  readonly score: number | null
  readonly probabilities: Record<string, number> | null
  readonly confidence: number | null
  readonly usable: boolean
  readonly rankingSource: 'semantic' | 'local-recall'
  readonly localRecallScore?: number
}

export interface RankedCandidate extends RankedCandidateBase {
  /** The operator dial, echoed so the caller reads the same number. */
  readonly threshold: number
  /**
   * Where this candidate falls against that dial. `unknown` whenever no usable
   * number exists: a threshold classifies, it never promotes.
   */
  readonly thresholdStatus: ThresholdVerdict
  /**
   * Why it landed there, in words.
   *
   * A2-8 requires a below-threshold candidate to stay visible AND carry its
   * reason. Reading `thresholdStatus` alone forces the caller to reconstruct
   * the comparison from two numbers, and `unknown` is indistinguishable
   * from "discarded" unless the reason spells out that nothing was judged.
   */
  readonly thresholdReason: string
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
  readonly advisory: true
  /**
   * The mandatory honesty contract: what was looked at, what was not, what the
   * number is worth and what it does not guarantee. Every report carries one;
   * there is no code path that builds a discovery result without it.
   */
  readonly relevance: RelevanceEnvelope
  readonly candidates: readonly RankedCandidate[]
  readonly semanticApplied: boolean
  readonly provider: string | null
  readonly model?: string
  readonly latencyMs: number
  readonly evidenceBytes: number
  readonly reasons: readonly string[]
  readonly recall?: {
    readonly used: true
    readonly scannedFiles: number
    readonly scoredFiles: number
    readonly ignoredDirectories: number
    readonly candidates: readonly LocalRecallCandidate[]
  }
}

const RUBRIC_LENGTH = 3
const TOP_LEVEL = RUBRIC_LENGTH - 1

function readNumber(answer: unknown, key: 'score' | 'confidence'): number | null {
  if (answer === null || typeof answer !== 'object') return null
  const value = (answer as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function rankOne(
  path: string,
  answer: DecisionAnswer | undefined,
): { candidate: RankedCandidateBase; reasons: string[] } {
  const typed = answer as
    | { type?: string; score?: unknown; probabilities?: unknown; confidence?: unknown }
    | undefined
  if (!typed || typed.type !== 'score') {
    return {
      candidate: { path, score: null, probabilities: null, confidence: null, usable: false, rankingSource: 'semantic' },
      reasons: ['answer_unusable'],
    }
  }

  const score = readNumber(typed, 'score')
  const confidence = readNumber(typed, 'confidence')
  const raw = typed.probabilities
  if (score === null || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      candidate: { path, score: null, probabilities: null, confidence, usable: false, rankingSource: 'semantic' },
      reasons: ['answer_unusable'],
    }
  }

  const probabilities: Record<string, number> = {}
  let sum = 0
  let expectation = 0
  let decisiveMass = 0
  for (const [level, mass] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof mass !== 'number' || !Number.isFinite(mass) || mass < 0 || mass > 1 || !/^\d+$/.test(level)) {
      return {
        candidate: { path, score: null, probabilities: null, confidence, usable: false, rankingSource: 'semantic' },
        reasons: ['answer_unusable'],
      }
    }
    probabilities[level] = mass
    sum += mass
    expectation += Number(level) * mass
    decisiveMass = Math.max(decisiveMass, mass)
  }

  const reasons: string[] = []
  const levels = Object.keys(probabilities).map(Number).sort((a, b) => a - b)
  if (levels.length !== RUBRIC_LENGTH || levels.some((level, i) => level !== i)) {
    reasons.push('rubric_shape_mismatch')
  }
  if (Math.abs(sum - 1) > 0.02) reasons.push('distribution_does_not_sum_to_one')
  if (Math.abs(score - expectation) > 0.01 + 1e-9) reasons.push('score_contradicts_distribution')
  if (score < 0 || score > TOP_LEVEL) reasons.push('score_outside_rubric_range')
  if (decisiveMass <= 0.5) reasons.push('no_decisive_level')

  const usable = reasons.length === 0
  return {
    candidate: {
      path,
      score: usable ? score : null,
      probabilities: usable ? probabilities : null,
      confidence,
      usable,
      rankingSource: 'semantic',
    },
    reasons,
  }
}

/**
 * Applies the operator's dial to an already-ranked list.
 *
 * It runs as a separate pass so the ranking itself stays independent of the
 * presentation policy: changing the threshold never reorders anything, it only
 * relabels. A `local-recall` entry has no provider confidence, so it is
 * classified `unknown` rather than handed a number it never had.
 */
export function applyThreshold(
  candidates: readonly RankedCandidateBase[],
  threshold: number,
): RankedCandidate[] {
  return candidates.map((candidate) => {
    const value =
      candidate.rankingSource === 'semantic' && candidate.usable ? candidate.confidence : null
    return {
      ...candidate,
      threshold,
      thresholdStatus: thresholdStatus(value, threshold),
      thresholdReason: thresholdReason(
        candidate.confidence,
        threshold,
        candidate.usable,
        candidate.rankingSource,
      ),
    }
  })
}

/** Parse one per-file answer from a single batched request and sort best-first. */
export function rankCandidates(
  files: readonly { path: string; content: string }[],
  answers: Record<string, DecisionAnswer | undefined>,
  questionId: string,
): { candidates: RankedCandidateBase[]; reasons: string[] } {
  const candidates: RankedCandidateBase[] = []
  const reasons: string[] = []
  files.forEach((file, index) => {
    const ranked = rankOne(file.path, answers[discoveryQuestionId(questionId, index)])
    candidates.push(ranked.candidate)
    for (const reason of ranked.reasons) reasons.push(`${file.path}:${reason}`)
  })
  candidates.sort((a, b) => {
    if (a.usable !== b.usable) return a.usable ? -1 : 1
    return (b.score ?? -1) - (a.score ?? -1) || a.path.localeCompare(b.path)
  })
  return { candidates, reasons: [...new Set(reasons)] }
}

export function localFallbackCandidates(
  recall: LocalRecallResult,
  threshold: number,
): RankedCandidate[] {
  return recall.candidates.map((candidate) => ({
    path: candidate.path,
    score: null,
    probabilities: null,
    confidence: null,
    usable: true,
    rankingSource: 'local-recall',
    localRecallScore: candidate.score,
    threshold,
    // A deterministic lexical score is NOT a provider confidence, so it is
    // deliberately left unclassified rather than compared to the dial.
    thresholdStatus: 'unknown' as const,
    thresholdReason: thresholdReason(null, threshold, true, 'local-recall'),
  }))
}

export function buildReport(
  tool: 'semantic_search' | 'semantic_scan',
  reportId: string,
  questionId: string,
  question: string,
  read: {
    files: readonly { path: string; content: string }[]
    bytes: number
    skipped: readonly { path: string; reason: SkipReasonCode }[]
  },
  response: DecisionResponse,
  ranked: { candidates: RankedCandidateBase[]; reasons: string[] },
  recall: LocalRecallResult | undefined,
  threshold: number,
): DiscoveryReport {
  return {
    reportId,
    trace: {
      tool,
      questionId,
      question,
      candidatePaths: read.files.map((file) => file.path),
      skippedPaths: read.skipped.map((entry) => entry.path),
    },
    advisory: true,
    relevance: buildRelevanceEnvelope({
      searched: {
        filesScanned: recall?.scannedFiles ?? read.files.length,
        candidatesScored: read.files.length,
        ...(recall ? { ignoredDirectories: recall.ignoredDirectories } : {}),
      },
      skipped: [
        ...(recall?.skipped ?? []),
        ...read.skipped,
      ],
      numberKind: 'provider-confidence',
      threshold,
    }),
    candidates: applyThreshold(ranked.candidates, threshold),
    semanticApplied: true,
    provider: response.provider,
    ...(response.model ? { model: response.model } : {}),
    latencyMs: response.latencyMs ?? 0,
    evidenceBytes: read.bytes,
    reasons: ranked.reasons,
    ...(recall
      ? {
          recall: {
            used: true,
            scannedFiles: recall.scannedFiles,
            scoredFiles: recall.scoredFiles,
            ignoredDirectories: recall.ignoredDirectories,
            candidates: recall.candidates,
          },
        }
      : {}),
  }
}

export function buildLocalFallbackReport(
  reportId: string,
  questionId: string,
  question: string,
  read: {
    files: readonly { path: string; content: string }[]
    bytes: number
    skipped: readonly { path: string; reason: SkipReasonCode }[]
  },
  recall: LocalRecallResult,
  reason: string,
  threshold: number,
): DiscoveryReport {
  return {
    reportId,
    trace: {
      tool: 'semantic_search',
      questionId,
      question,
      candidatePaths: read.files.map((file) => file.path),
      skippedPaths: read.skipped.map((entry) => entry.path),
    },
    advisory: true,
    relevance: buildRelevanceEnvelope({
      searched: {
        filesScanned: recall.scannedFiles,
        // No provider number exists on this path, so nothing was scored
        // SEMANTICALLY. Reporting a count here would be a bare lexical
        // shortlist wearing a semantic label.
        candidatesScored: 0,
        ignoredDirectories: recall.ignoredDirectories,
      },
      skipped: [...recall.skipped, ...read.skipped],
      numberKind: 'none',
      threshold,
    }),
    candidates: localFallbackCandidates(recall, threshold),
    semanticApplied: false,
    provider: null,
    latencyMs: 0,
    evidenceBytes: 0,
    reasons: [reason],
    recall: {
      used: true,
      scannedFiles: recall.scannedFiles,
      scoredFiles: recall.scoredFiles,
      ignoredDirectories: recall.ignoredDirectories,
      candidates: recall.candidates,
    },
  }
}
