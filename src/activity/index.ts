/**
 * In-memory activity registry for the semantic tools.
 *
 * The plugin can report how its own tools were used without ever observing the
 * agent: every call is recorded by the tool that produced it, from the report
 * it already returned. Nothing about the conversation, the transmitted state,
 * the endpoint or the credential is kept, and nothing is persisted — the store
 * lives as long as the session, which is exactly the lifetime the Stats panel
 * displays.
 *
 * It deliberately records COUNTS, STATUSES, TIMINGS and paths that already
 * appear in a report. Every verdict it can produce is therefore derived from
 * data the plugin already had, never from a guess about what the agent did
 * next.
 */

export const ACTIVITY_MAX_RETAINED = 50

/**
 * Hard bound on retained sessions.
 *
 * The host serves many sessions in one process and the plugin registers no
 * session-end hook, so this is what stops a finished session's entries from
 * staying reachable forever. 64 is far above any realistic number of sessions
 * open at once, and the eviction is least-recently-touched first.
 */
export const MAX_SESSIONS_RETAINED = 64

/** How a call failed to be conclusive. */
export type NonConclusiveProof =
  /** The exact same question was asked twice: the first call did not conclude. */
  | 'proven-repeated-question'
  /** The same question, asked again more narrowly after a broader attempt. */
  | 'proven-narrowed-question'
  /** A different tool was then used on what looks like the same subject. */
  | 'heuristic-same-subject'
  | 'none'

export type ActivityKind =
  | 'decide'
  | 'verify'
  | 'coverage'
  | 'discovery'

import { createHash } from 'node:crypto'

import { isRecord } from '../decision/validation.js'
export interface ActivityCall {
  /** Report id the tool already produced, or a synthetic id for a bare call. */
  readonly reportId: string
  readonly tool: string
  readonly kind: ActivityKind
  readonly sessionId: string
  /** Wall-clock time, for display only. Ordering uses `seq`. */
  readonly at: number
  /**
   * Strictly increasing insertion order, assigned by the store.
   *
   * Ordering never uses `at`: two calls inside one millisecond would tie, and
   * the repeat/narrowing rules must mark the EARLIER call, not an arbitrary one.
   */
  readonly seq?: number
  readonly success: boolean
  readonly latencyMs: number
  /**
   * A digest of the caller's question/predicate/criterion, used ONLY to detect
   * a repeat. The text itself is never stored: a digest is enough to decide
   * "asked twice", and keeping the text would make the registry a transcript
   * fragment the plugin has no reason to hold.
   */
  readonly questionKey: string | null
  /**
   * Bloom-style signature of the question's content words, used by the
   * narrowing and same-subject rules. A digest of a digest set, never text.
   */
  readonly tokenSignature: string | null
  /** How many candidates carried a usable semantic score. */
  readonly usableCandidates: number
  /** Whether the provider actually ranked anything. */
  readonly semanticApplied: boolean | null
  readonly status: string | null
  /** Every verification status this call produced, one per criterion if many. */
  readonly statuses: readonly string[]
  readonly coverageStatuses: readonly string[]
  readonly gateReasons: readonly string[]
}

export interface ActivityVerdictEntry {
  readonly reportId: string
  readonly tool: string
  readonly kind: ActivityKind
  readonly at: number
  readonly success: boolean
  readonly latencyMs: number
  readonly unusableAnswer: boolean
  readonly abandoned: boolean
  readonly nonConclusive: boolean
  readonly nonConclusiveProof: NonConclusiveProof
  /**
   * Always false. A deterministic tool call on one of our candidates is what
   * would prove it, and the plugin never observes the agent's tools, so no
   * call can be reported as conclusive.
   */
  readonly conclusive: false
  readonly conclusiveProof: 'indeterminate'
}

export interface ActivityVerdict {
  readonly advisory: true
  readonly status: 'observed-propensity'
  readonly note: string
  readonly calls: readonly ActivityVerdictEntry[]
  readonly totalCalls: number
  readonly totalLatencyMs: number
  /**
   * Each tool's share of the SEMANTIC calls in the session.
   *
   * This is the tool mix that is actually observable: the host's total
   * tool-call count lives in its session stats, which a plugin can only reach
   * through a session hook (deliberately unregistered) or an HTTP call back
   * into the server (deliberately not made). It is a real measurement, not a
   * stand-in for the semantic-vs-deterministic ratio, which stays unmeasured.
   */
  readonly toolMix: ReadonlyArray<{
    readonly tool: string
    readonly count: number
    readonly share: number
  }>
  /**
   * The call buckets below are EXHAUSTIVE and MUTUALLY EXCLUSIVE: every
   * retained call falls in exactly one, in this order, so the panel's rows add
   * up to `totalCalls` instead of leaving a reader to find the remainder.
   */
  /** The provider was never reached, or its answer was rejected. */
  readonly abandoned: number
  /** The provider failed and the deterministic local ranking was used. */
  readonly fellBackToLocal: number
  /** Reached the provider, but nothing usable came back. */
  readonly unusableAnswers: number
  /** Re-asked word for word: the earlier attempt did not settle it. */
  readonly repeatedQuestion: number
  /** Re-asked more narrowly: the earlier, broader attempt did not settle it. */
  readonly narrowedQuestion: number
  /**
   * A same-subject guess, reported apart from the proven signals above: it is
   * an approximation, and counting it with them would inflate the rate.
   */
  readonly heuristicNonConclusive: number
  /** Reached the provider and reported a pass candidate. */
  readonly passCandidate: number
  /** Reached the provider; reported unknown or insufficient evidence. */
  readonly policyUnknown: number
  /**
   * `off-scope` and `needs-verification`: definite but non-positive outcomes,
   * not the same as "no evidence", so counted apart.
   */
  readonly policyNeedsWork: number
  /**
   * Calls that succeeded and produced nothing the plugin can judge either way.
   * Never rendered as "not useful".
   */
  readonly indeterminate: number
  /**
   * Always 0. Proving an answer was USED would need a deterministic tool call
   * on one of our candidates, which the plugin never observes.
   */
  readonly conclusive: 0
  readonly coverageCovered: number
  readonly coverageMissing: number
  readonly coverageUncertain: number
  /**
   * Gate reasons the policy reported, counted by frequency and never
   * interpreted: `src/verify/policy.ts` stays the only place that decides
   * what a reason means.
   */
  readonly gateReasons: ReadonlyArray<{ readonly reason: string; readonly count: number }>
}

/** Case-folded and whitespace-collapsed, so "Is It?" and "is it" match. */
function normalizeQuestion(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Content words of a question, used only for the narrowing comparison. */
function significantTokens(value: string): string[] {
  const stop = new Set([
    'a', 'an', 'the', 'is', 'are', 'of', 'in', 'to', 'for', 'and', 'or', 'do', 'does',
    'how', 'what', 'where', 'when', 'which', 'that', 'this', 'it', 'with', 'on', 'by',
  ])
  return normalizeQuestion(value)
    .split(/[^a-z0-9_]+/)
    .filter((token) => token.length > 1 && !stop.has(token))
}

/**
 * Normalizes and digests a caller question.
 *
 * The TEXT never reaches the registry: only this digest does. A digest is all
 * that is needed to decide "this exact question was already asked", and a
 * truncation keeps a short digest from becoming a reversible encoding of a
 * common phrase.
 */
export function questionKey(value: string | undefined | null): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!normalized) return null
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

/**
 * A bloom-style signature of the question's content words.
 *
 * The narrowing and same-subject rules need set membership, not the text. This
 * is a 64-bit signature over the significant tokens, so two questions collide
 * only if they share several words — which is exactly the condition the rules
 * are about. It is an approximation, and the verdicts built on it are labelled
 * as such.
 */
export function tokenSignature(value: string | undefined | null): string | null {
  if (typeof value !== 'string') return null
  const tokens = significantTokens(value)
  if (tokens.length === 0) return null
  const bits = new Set<number>()
  for (const token of tokens) {
    // Two independent positions per token, so one word cannot fill a bit on its
    // own the way a single-hash scheme would allow.
    const a = Number.parseInt(createHash('sha256').update(token).digest('hex').slice(0, 4), 16) & 63
    const b = Number.parseInt(createHash('sha256').update(`~${token}`).digest('hex').slice(0, 4), 16) & 63
    bits.add(a)
    bits.add(b)
  }
  let signature = 0n
  for (const bit of bits) signature |= 1n << BigInt(bit)
  return signature.toString(16).padStart(16, '0')
}

/**
 * Population count, and the two comparisons the rules need, as single
 * BigInt operations.
 *
 * The obvious implementation walks 64 bits per comparison, which ran on every
 * RPC render for every retained call — measurably slow. Populating the mask once
 * per signature and then AND-ing two BigInts keeps the rules identical while
 * making the cost a handful of machine words.
 */
/** Parses a stored signature once per call, not once per comparison. */
function signatureMask(signature: string | null): bigint | null {
  if (signature === null || signature === '') return null
  return BigInt(`0x${signature}`)
}

function popcount(value: bigint): number {
  let bits = 0
  let rest = value
  while (rest !== 0n) {
    rest &= rest - 1n
    bits += 1
  }
  return bits
}

/**
 * True when `narrow` asks strictly less than `broad` about the same subject.
 *
 * With signatures this is approximate: every bit of the later question must
 * also appear in the earlier one, and the later signature must be no larger.
 * That is a subset test, so a signature collision can only ever ADD a repeat,
 * never invent one — the failure mode is a false "non conclusive", never a
 * missed one.
 */
function isStrictlyNarrowed(narrow: bigint | null, broad: bigint | null): boolean {
  if (narrow === null || broad === null || narrow === 0n || broad === 0n) return false
  if (popcount(narrow) > popcount(broad)) return false
  // Subset test: `broad & narrow === narrow`.
  return (broad & narrow) === narrow
}

/**
 * True when a decision call asks about something a discovery call covered.
 *
 * This is a HEURISTIC, not a proof: two unrelated questions can still collide
 * on the 64-bit signature, so a single shared bit is not enough — a third of
 * the later signature's bits must be present. Its verdict is reported apart
 * from the proven signals so a collision can never inflate the failure rate.
 */
function looksLikeSameSubject(first: bigint | null, second: bigint | null): boolean {
  if (first === null || second === null || first === 0n || second === 0n) return false
  return popcount(first & second) * 3 >= popcount(second)
}

/**
 * True when the provider's ranking could not be used at all.
 *
 * Only a discovery call carries candidates, so the candidate rules apply to
 * that kind alone. A verification failure is reported through its own status
 * counters instead of being folded into "unusable answer".
 *
 * A LOCAL FALLBACK is deliberately NOT counted here: it answers a different
 * question. The provider failed and the deterministic shortlist was returned
 * instead, so calling the answer "unusable" would over-claim — the agent may
 * well have used those candidates. It has its own counter.
 */
function isUnusableAnswer(call: ActivityCall): boolean {
  if (!call.success) return false
  if (call.kind !== 'discovery') return false
  if (call.semanticApplied === false) return false
  return call.usableCandidates === 0
}

/** The provider failed and the deterministic local ranking was used instead. */
function isLocalFallback(call: ActivityCall): boolean {
  return call.success && call.semanticApplied === false
}

/** Everything one pass over the calls accumulates. */
interface Tally {
  abandoned: number
  fellBackToLocal: number
  unusableAnswers: number
  repeatedQuestion: number
  narrowedQuestion: number
  heuristicNonConclusive: number
  passCandidate: number
  policyUnknown: number
  policyNeedsWork: number
  coverageCovered: number
  coverageMissing: number
  coverageUncertain: number
  totalLatencyMs: number
  gateReasons: Map<string, number>
}

function emptyTally(): Tally {
  return {
    abandoned: 0,
    fellBackToLocal: 0,
    unusableAnswers: 0,
    repeatedQuestion: 0,
    narrowedQuestion: 0,
    heuristicNonConclusive: 0,
    passCandidate: 0,
    policyUnknown: 0,
    policyNeedsWork: 0,
    coverageCovered: 0,
    coverageMissing: 0,
    coverageUncertain: 0,
    totalLatencyMs: 0,
    gateReasons: new Map(),
  }
}

const NEW_ENTRY: Omit<ActivityVerdictEntry, 'reportId' | 'tool' | 'kind' | 'at' | 'success' | 'latencyMs'> = {
  unusableAnswer: false,
  abandoned: false,
  nonConclusive: false,
  nonConclusiveProof: 'none',
  conclusive: false,
  conclusiveProof: 'indeterminate',
}

/**
 * Derives what can be concluded from recorded calls alone.
 *
 * The per-call buckets are exhaustive and mutually exclusive, so the panel's
 * rows reconcile against `totalCalls`: a call is counted once, in the first
 * bucket that applies, and `indeterminate` is what remains.
 */
export function classifyActivity(calls: readonly ActivityCall[]): ActivityVerdict {
  const ordered = [...calls].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.at - b.at)
  const entries: ActivityVerdictEntry[] = []
  const firstSeen = new Map<string, number>()
  const tally = emptyTally()

  const markNonConclusive = (
    index: number,
    proof: NonConclusiveProof,
  ): void => {
    const target = entries[index]
    if (!target || target.abandoned || target.nonConclusive) return
    entries[index] = { ...target, nonConclusive: true, nonConclusiveProof: proof }
    if (proof === 'proven-narrowed-question') tally.narrowedQuestion += 1
    else if (proof === 'heuristic-same-subject') tally.heuristicNonConclusive += 1
  }

  for (const call of ordered) {
    const abandoned = !call.success
    const fallback = isLocalFallback(call)
    const unusable = isUnusableAnswer(call)

    if (abandoned) tally.abandoned += 1
    else if (fallback) tally.fellBackToLocal += 1
    else if (unusable) tally.unusableAnswers += 1
    tally.totalLatencyMs += call.latencyMs

    for (const status of call.statuses) {
      if (status === 'unknown' || status === 'insufficient-evidence') tally.policyUnknown += 1
      else if (status === 'off-scope' || status === 'needs-verification') tally.policyNeedsWork += 1
      else if (status === 'pass-candidate') tally.passCandidate += 1
    }
    for (const status of call.coverageStatuses) {
      if (status === 'covered') tally.coverageCovered += 1
      else if (status === 'missing') tally.coverageMissing += 1
      else if (status === 'uncertain') tally.coverageUncertain += 1
    }
    for (const reason of call.gateReasons) {
      tally.gateReasons.set(reason, (tally.gateReasons.get(reason) ?? 0) + 1)
    }

    // The repeat and narrowing rules only compare calls that produced an
    // answer; a failed one is already accounted for above.
    const currentSignature = signatureMask(call.tokenSignature)
    if (call.questionKey !== null && !abandoned) {
      const exact = firstSeen.get(call.questionKey)
      if (exact !== undefined) {
        tally.repeatedQuestion += 1
        markNonConclusive(exact, 'proven-repeated-question')
      }
      for (let index = 0; index < entries.length; index += 1) {
        const earlier = entries[index]!
        if (earlier.abandoned || earlier.nonConclusive) continue
        const earlierSignature = signatureMask(ordered[index]!.tokenSignature)
        // Tested BEFORE the narrowing rule: an identical question is also a
        // strict subset of itself, and taking the weaker verdict there would
        // hide the real one.
        if (
          call.kind === 'decide' &&
          earlier.kind === 'discovery' &&
          looksLikeSameSubject(earlierSignature, currentSignature)
        ) {
          markNonConclusive(index, 'heuristic-same-subject')
          continue
        }
        if (isStrictlyNarrowed(currentSignature, earlierSignature)) {
          markNonConclusive(index, 'proven-narrowed-question')
        }
      }
      firstSeen.set(call.questionKey, entries.length)
    }

    entries.push({
      ...NEW_ENTRY,
      reportId: call.reportId,
      tool: call.tool,
      kind: call.kind,
      at: call.at,
      success: call.success,
      latencyMs: call.latencyMs,
      unusableAnswer: unusable,
      abandoned,
    })
  }

  // Anything that reached the provider, produced something, and matched no
  // other bucket: no evidence either way, which is not a negative verdict.
  const judged = new Set<number>()
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    const call = ordered[index]!
    if (entry.abandoned || entry.nonConclusive || call.semanticApplied === false) continue
    if (!isUnusableAnswer(call)) judged.add(index)
  }

  return {
    advisory: true,
    status: 'observed-propensity',
    note: 'Observed usage only: an observed propensity, not a quality judgement. It counts how often the semantic tools were called and how often their answer was not usable, and never claims they beat the deterministic path.',
    calls: entries,
    totalCalls: ordered.length,
    totalLatencyMs: tally.totalLatencyMs,
    toolMix: toolMixOf(entries),
    abandoned: tally.abandoned,
    fellBackToLocal: tally.fellBackToLocal,
    unusableAnswers: tally.unusableAnswers,
    repeatedQuestion: tally.repeatedQuestion,
    narrowedQuestion: tally.narrowedQuestion,
    heuristicNonConclusive: tally.heuristicNonConclusive,
    passCandidate: tally.passCandidate,
    policyUnknown: tally.policyUnknown,
    policyNeedsWork: tally.policyNeedsWork,
    indeterminate: ordered.length - tally.abandoned - tally.fellBackToLocal - tally.unusableAnswers - tally.repeatedQuestion - tally.narrowedQuestion - tally.heuristicNonConclusive,
    conclusive: 0,
    coverageCovered: tally.coverageCovered,
    coverageMissing: tally.coverageMissing,
    coverageUncertain: tally.coverageUncertain,
    gateReasons: [...tally.gateReasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
  }
}

/** Each tool's share of the calls, largest first. */
function toolMixOf(entries: readonly ActivityVerdictEntry[]): ActivityVerdict['toolMix'] {
  if (entries.length === 0) return []
  const counts = new Map<string, number>()
  for (const entry of entries) counts.set(entry.tool, (counts.get(entry.tool) ?? 0) + 1)
  return [...counts.entries()]
    .map(([tool, count]) => ({
      tool,
      count,
      share: Math.round((count / entries.length) * 100) / 100,
    }))
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))
}
/**
 * A monotonic insertion order.
 *
 * `Date.now()` has millisecond resolution, so two calls inside the same
 * millisecond would tie and sort arbitrarily. The repeat and narrowing rules
 * mark the EARLIER call, so ordering gets its own strictly-increasing counter
 * and never relies on the clock.
 */
let insertSequence = 0

/**
 * Bounded, per-session, in-memory activity registry.
 *
 * Nothing is persisted. Sessions are evicted WITHOUT a session-end hook, which
 * the plugin deliberately does not register: the host serves many sessions in
 * one process, so an unbounded per-session map would keep a finished session
 * reachable for the life of the process. Two bounds remove that risk on their
 * own — each session retains at most `max` calls, and at most
 * `MAX_SESSIONS_RETAINED` sessions are kept, least recently touched first.
 */
export class ActivityStore {
  readonly #max: number
  readonly #maxSessions: number
  readonly #bySession = new Map<string, ActivityCall[]>()

  constructor(max: number = ACTIVITY_MAX_RETAINED, maxSessions: number = MAX_SESSIONS_RETAINED) {
    this.#max = max
    this.#maxSessions = Math.max(1, maxSessions)
  }

  record(call: ActivityCall): void {
    // Stamped here rather than by the caller: a sequence assigned at record
    // time cannot be forged, and it is total even within one millisecond.
    const stamped: ActivityCall = { ...call, seq: (insertSequence += 1) }
    const existing = this.#bySession.get(stamped.sessionId)
    // Re-inserting moves the session to the end of the Map's insertion order,
    // which is what makes the eviction below least-recently-touched first.
    this.#bySession.delete(stamped.sessionId)
    const calls = existing ?? []
    calls.unshift(stamped)
    if (calls.length > this.#max) calls.length = this.#max
    this.#bySession.set(stamped.sessionId, calls)
    while (this.#bySession.size > this.#maxSessions) {
      const oldest = this.#bySession.keys().next()
      if (oldest.done) break
      this.#bySession.delete(oldest.value)
    }
  }

  /** Newest first, a copy: a caller cannot mutate the registry. */
  callsFor(sessionId: string): ActivityCall[] {
    return (this.#bySession.get(sessionId) ?? []).map((entry) => ({ ...entry }))
  }

  /**
   * Every retained call across sessions, newest first.
   *
   * The host opens the activity panel WITHOUT a sessionId, so a panel-level
   * reader has no session to filter on and would otherwise render nothing.
   */
  snapshot(): ActivityCall[] {
    const all: ActivityCall[] = []
    for (const calls of this.#bySession.values()) all.push(...calls)
    return all.sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0)).map((entry) => ({ ...entry }))
  }
}
/**
 * Reads the panel switch.
 *
 * Only an explicit boolean turns it off. Anything else leaves the default in
 * place, so a malformed stored value can never be read as a silent opt-out.
 */
export function parseActivityPanelEnabled(values: Record<string, unknown> | undefined): boolean {
  if (!values) return true
  return values.activityPanel !== false
}
