/**
 * The relevance envelope.
 *
 * Every advisory discovery result leaves the plugin through this shape. It is
 * deliberately explicit about four things a bare list of scores hides:
 *
 * 1. what was actually looked at;
 * 2. what was NOT looked at, and in what quantity;
 * 3. what the returned number is actually worth;
 * 4. what the number does NOT guarantee.
 *
 * The fourth point is the load-bearing one. A provider confidence is a
 * concentration over the model's own answer distribution; it is not a
 * measured probability that the file is correct, and no tool here has been
 * calibrated against ground truth. Saying so is what makes the number usable
 * rather than misleading.
 *
 * The fixed sentences are emitted ONCE per report, not once per candidate. A
 * 40-file scan would otherwise repeat ~570 characters of boilerplate 40 times
 * in the agent's context, which is the most expensive place to waste tokens.
 * The `version` key lets a consumer cache the text rather than re-read it.
 */

/** Why a file was not examined. */
export type SkipReasonCode =
  | 'missing'
  | 'not-a-file'
  | 'empty'
  | 'too-large'
  | 'binary'
  | 'unreadable'
  /**
   * Matched the query but did not fit the evidence budget assembled for the
   * rerank stage. Distinct from `candidate-limit`: this file lost on size, not
   * on rank, so a caller raising the budget can win it back.
   */
  | 'evidence-budget'
  /** Matched, ranked, but fell outside the shortlist size. */
  | 'candidate-limit'

export interface SkippedEntry {
  /** Repository-relative path, POSIX-style, safe to display and to log. */
  readonly path: string
  readonly reason: SkipReasonCode
}

/** What the number attached to a candidate is. */
export type NumberKind = 'provider-confidence' | 'provider-score' | 'local-recall-score' | 'none'

/**
 * Bumped when the fixed texts change, so a caller may key a cache on it.
 */
export const CAVEAT_VERSION = 1

/** What the number is worth. Fixed text: it must not vary per call site. */
export const SCORE_MEANS =
  'Provider confidence: how concentrated the model distribution was over its own answer. It is not a measured probability that the file is correct.'

/**
 * What the number does NOT guarantee. Also fixed, and present on every report
 * without exception.
 */
export const SCORE_UNVERIFIED_MEANS =
  'It does NOT guarantee correctness, exhaustiveness or completeness: the value is uncalibrated, no ground-truth check backs it, and a candidate below it may still be the right one. Confirm with deterministic code tools before acting.'

/**
 * Shown next to every coverage figure. An empty result means "nothing was
 * found among what could be read", which is a very different statement from
 * "the code does not exist".
 */
export const COVERAGE_CAVEAT =
  'An empty or partial result does not prove absence: files that were skipped, filtered or unreadable were never judged. Absence of a candidate here is never evidence that the code does not exist.'

/** Used when a call produced no number at all (blocked, errored, empty). */
export const NO_NUMBER_MEANS =
  'No semantic number was produced for this call, so nothing here should be read as a relevance judgement.'

export interface SearchedScope {
  /** Files the local stage actually read. */
  readonly filesScanned: number
  /** Files that reached the semantic stage. */
  readonly candidatesScored: number
  /** Directories the walk deliberately pruned. */
  readonly ignoredDirectories?: number
}

export type ThresholdVerdict = 'above' | 'below' | 'unknown'

/** The fixed sentences, carried once per report. */
export interface Caveats {
  readonly version: number
  readonly scoreMeans: string
  readonly scoreUnverifiedMeans: string
  readonly coverageCaveat: string
}

export interface RelevanceEnvelope {
  readonly searched: SearchedScope
  /**
   * Files not read, counted by reason with a named sample.
   *
   * Bounded: the walk may see thousands of files, and naming each one would
   * dominate the result. `relevance.skippedByReason` carries the counts, which
   * is the fact a caller actually needs.
   */
  readonly skipped: readonly { path: string; reason: SkipReasonCode }[]
  readonly skippedByReason: readonly {
    readonly reason: SkipReasonCode
    readonly count: number
    readonly sample: readonly string[]
    readonly notShown: number
  }[]
  readonly skippedTotal: number
  readonly skippedTruncated: boolean
  readonly threshold: number
  /** The fixed sentences, once. See `CAVEAT_VERSION`. */
  readonly caveats: Caveats
}

export interface EnvelopeInput {
  readonly searched: SearchedScope
  readonly skipped: readonly SkippedEntry[]
  readonly numberKind: NumberKind
  readonly threshold: number
}

/** How many sample paths `skippedByReason` keeps per reason. */
const MAX_SAMPLE_PER_REASON = 10

/**
 * Builds the envelope. There is no "omit the envelope" option: a caller that
 * wants a report always gets all four parts.
 */
export function buildRelevanceEnvelope(input: EnvelopeInput): RelevanceEnvelope {
  const scoreMeans = input.numberKind === 'none' ? NO_NUMBER_MEANS : SCORE_MEANS
  const reasons = new Map<SkipReasonCode, string[]>()
  for (const entry of input.skipped) {
    const bucket = reasons.get(entry.reason)
    if (bucket === undefined) reasons.set(entry.reason, [entry.path])
    else bucket.push(entry.path)
  }
  const skippedByReason = [...reasons.entries()]
    .map(([reason, paths]) => ({
      reason,
      count: paths.length,
      sample: paths.slice(0, MAX_SAMPLE_PER_REASON),
      notShown: Math.max(0, paths.length - MAX_SAMPLE_PER_REASON),
    }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))

  return {
    searched: input.searched,
    skipped: input.skipped.slice(0, MAX_SAMPLE_PER_REASON),
    skippedByReason,
    skippedTotal: input.skipped.length,
    skippedTruncated: input.skipped.length > MAX_SAMPLE_PER_REASON,
    threshold: input.threshold,
    caveats: {
      version: CAVEAT_VERSION,
      scoreMeans,
      scoreUnverifiedMeans: SCORE_UNVERIFIED_MEANS,
      coverageCaveat: COVERAGE_CAVEAT,
    },
  }
}

/**
 * Classifies one candidate number against the operator's threshold.
 *
 * A null number is `unknown`, never `above`. A threshold is a presentation
 * dial, not a pass gate: it may not convert an unusable, unavailable or
 * unverified answer into a success.
 */
export function thresholdStatus(value: number | null, threshold: number): ThresholdVerdict {
  if (value === null || !Number.isFinite(value)) return 'unknown'
  return value >= threshold ? 'above' : 'below'
}

/**
 * Why a candidate landed where it did, in words.
 *
 * A below-threshold candidate stays visible AND carries its reason, so a
 * caller reading one field learns why. `unknown` deliberately does not read
 * like a rejection: it means nothing was judged, which is a different
 * conclusion from judged-and-weak.
 */
export function thresholdReason(
  value: number | null,
  threshold: number,
  usable: boolean,
  rankingSource: 'semantic' | 'local-recall',
): string {
  const verdict = thresholdStatus(usable ? value : null, threshold)
  switch (verdict) {
    case 'above':
      return `confidence ${formatNumber(value ?? 0)} is at or above the threshold ${formatNumber(threshold)}`
    case 'below':
      return `confidence ${formatNumber(value ?? 0)} is below the threshold ${formatNumber(threshold)}; still worth confirming by reading it`
    default:
      return rankingSource === 'local-recall'
        ? 'ranked by local lexical recall, not by a provider confidence, so it is not classified against the threshold'
        : 'no usable provider confidence was returned, so this is not classified against the threshold'
  }
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}