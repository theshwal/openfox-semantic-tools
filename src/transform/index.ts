import type { PluginMessageTransform, PluginMessageTransformContext } from 'openfox/plugin'

import type { DecisionRequest, DecisionResponse } from '../decision/types.js'
import { isRecord } from '../decision/validation.js'
import { ProviderError, SystemOneHttpProvider } from '../providers/system-one.js'
import { parseSettings } from '../settings.js'
import { segmentMessages } from './messages.js'
import {
  TransformStatusStore,
  readTransformMetadata,
} from './status.js'

/**
 * The question asks whether a segment is STILL NEEDED, so:
 *
 * - at or above `KEEP_PROBABILITY`, the segment is kept;
 * - at or below `DROP_PROBABILITY`, the provider is claiming the segment is
 *   obsolete, and only then MAY it be dropped.
 *
 * Anything between the two is a genuine "it depends", and keeps the segment.
 * Deleting context is irreversible from the model's point of view, so the band
 * is deliberately wide in the safe direction.
 */
export const KEEP_PROBABILITY = 0.5
export const DROP_PROBABILITY = 0.1

/**
 * The runtime's own declared certainty is a SECOND, independent gate. A model
 * may be certain about a probability it computed with no evidence, so a drop
 * requires both a confident probability and a declared confidence.
 */
export const DROP_CONFIDENCE = 0.5

/** Never send more than this much conversation text in one request. */
const MAX_STATE_CHARS = 24_000

/** Per-segment budget, so one huge message cannot crowd out the others. */
const MAX_SEGMENT_CHARS = 1200

type ReadSettings = () => Record<string, unknown>

/**
 * Why a turn was left untouched.
 *
 * Every one of these is a normal outcome, not an error, so the reason is
 * reported instead of thrown: an operator who enables the setting needs to see
 * *why* nothing happened, otherwise a silent no-op is indistinguishable from a
 * provider that simply never drops anything.
 */
export type SkipReason =
  /** `contextReduce` is not enabled. */
  | 'disabled'
  /** The settings store could not be read. */
  | 'settings_unavailable'
  /** No message in the turn is a safe reduction candidate. */
  | 'no_candidates'
  /** No endpoint is configured, so no call could be made. */
  | 'not_configured'
  /** The endpoint is blocked by the data-egress policy. */
  | 'egress_blocked'
  /** The provider did not answer, timed out or was cancelled. */
  | 'provider_unavailable'
  /** The provider answered with something this client cannot use. */
  | 'invalid_response'
  /** The answer was too weak or too unsure to authorize a deletion. */
  | 'low_confidence'
  /** A provider said "no longer needed" about literally everything. */
  | 'total_wipe_refused'

interface Verdict {
  drop: boolean
  uncertain: boolean
  /** True when nothing in the answer could be read at all. */
  unusable: boolean
}

/**
 * Asks the provider, in ONE batched call, which segments are still needed.
 *
 * The `noul` polarity is "is this segment still needed", so a LOW probability
 * is the one that authorizes a drop. That keeps a conservative provider aligned
 * with a conservative policy: an uninformative answer keeps everything.
 */
/**
 * Builds the ONE batched request for this turn.
 *
 * The character budget is enforced HERE, while questions are being built, so a
 * question id and its answer can never fall out of sync: a segment that does
 * not fit is simply not asked about, and its message stays in the conversation
 * untouched. Budgeting the serialized array afterwards (the earlier approach)
 * never truncated anything, because a character limit applied to an array
 * length is a no-op.
 *
 * `state` carries the same segments the questions describe, and is truncated
 * with the same budget rather than by an arbitrary row count.
 */
/**
 * Builds the ONE batched request for this turn.
 *
 * The character budget is enforced HERE, while questions are being built, so a
 * question id and its answer can never fall out of sync: a segment that does
 * not fit is simply not asked about, and its message stays in the conversation
 * untouched. Budgeting the serialized array afterwards (the earlier approach)
 * never truncated anything, because a character limit applied to an array
 * length is a no-op.
 *
 * `state` carries the same segments the questions describe, and is truncated
 * with the same budget rather than by an arbitrary row count.
 *
 * Returns the indices actually asked about, because the response is validated
 * against the question set and never against the full segment list: a segment
 * that did not fit has no answer, and must therefore never be dropped.
 */
function buildRequest(segments: ReturnType<typeof segmentMessages>): {
  request: DecisionRequest
  asked: number[]
} {
  const questions: DecisionRequest['questions'] = {}
  const state: Array<{ id: string; role: string; text: string }> = []
  const asked: number[] = []
  let spent = 0

  for (const [i, segment] of segments.entries()) {
    // A single enormous message still gets one truncated excerpt, so a huge
    // turn is still measured rather than skipped entirely.
    const room = MAX_STATE_CHARS - spent
    if (room <= 0) break
    const text = segment.text.slice(0, Math.min(MAX_SEGMENT_CHARS, room))
    spent += text.length
    const id = `s${i}`
    questions[id] = {
      type: 'noul',
      instructions: `SEGMENT KEEP: is this conversation segment still needed for the task? Text: ${text}`,
    }
    state.push({ id, role: segment.role, text })
    asked.push(i)
  }

  return {
    request: { state: { segments: state } as unknown as Record<string, never>, questions },
    asked,
  }
}

function readVerdict(
  response: DecisionResponse,
  index: number,
  segments: ReturnType<typeof segmentMessages>,
): Verdict {
  const answer = response.answers[`s${index}`]
  if (!isRecord(answer) || answer.type !== 'noul') {
    return { drop: false, uncertain: true, unusable: true }
  }
  const probability = (answer as { probability?: unknown }).probability
  if (typeof probability !== 'number' || !Number.isFinite(probability)) {
    return { drop: false, uncertain: true, unusable: true }
  }
  if (probability >= KEEP_PROBABILITY) {
    // Still needed. A confident, usable answer — not a skip.
    return { drop: false, uncertain: false, unusable: false }
  }
  const confidence = (answer as { confidence?: unknown }).confidence
  if (
    probability <= DROP_PROBABILITY &&
    typeof confidence === 'number' &&
    confidence >= DROP_CONFIDENCE &&
    segments[index] !== undefined
  ) {
    return { drop: true, uncertain: false, unusable: false }
  }
  return { drop: false, uncertain: true, unusable: false }
}

/** Maps a provider failure onto a stable, non-leaking skip reason. */
function reasonFor(error: unknown): SkipReason {
  if (error instanceof ProviderError) {
    if (error.code === 'egress_blocked') return 'egress_blocked'
    if (error.code === 'configuration') return 'not_configured'
    if (error.code === 'invalid_response') return 'invalid_response'
    if (error.code === 'timeout' || error.code === 'aborted') return 'provider_unavailable'
    return 'provider_unavailable'
  }
  return 'provider_unavailable'
}

/**
 * Builds the opt-in context-reduction message transform.
 *
 * Contract, in order of precedence:
 *
 * 1. **Off unless enabled.** With `contextReduce` false (the default), the
 *    transform returns the messages unchanged and contacts nothing.
 *    Registration alone changes no behaviour.
 * 2. **Fail open.** Every failure returns the ORIGINAL messages. The host also
 *    fails open on a thrown transform, but this plugin never relies on that: a
 *    throw here would be indistinguishable from a bug.
 * 3. **Always says what it did.** Every outcome carries metadata — either
 *    `applied: true` with the counts, or `applied: false` with a `reason`.
 *    Metadata holds counts and a reason only: never content, never a key.
 * 4. **Egress first.** The call is `automatic` — issued by the host on session
 *    content, not explicitly invoked by the agent — so a remote endpoint
 *    blocked for automatic calls is never contacted.
 * 5. **Only eligible segments are dropped**, and the result keeps the original
 *    ordering.
 *
 * A transform cannot veto a turn, so every outcome is advisory: at worst the
 * model sees the context it would have seen anyway.
 */
export function createContextTransform(
  readSettings: ReadSettings,
  transport: typeof fetch = fetch,
  status: TransformStatusStore = new TransformStatusStore(),
): PluginMessageTransform {
  return {
    id: 'semantic-context-reduce',
    // Runs late, so other transforms (including any core one) have already had
    // their say about the message list.
    priority: 200,
    async transform(
      messages: Array<Record<string, unknown>>,
      context: PluginMessageTransformContext,
    ) {
      /**
       * Records an outcome in the status store and returns the metadata that is
       * handed to the host. The store is written here rather than at the call
       * site, so no outcome can return without being recorded: a transform
       * whose metadata nobody reads would otherwise be a silent no-op.
       */
      const record = (metadata: Record<string, unknown>): Record<string, unknown> => {
        const parsed = readTransformMetadata(metadata)
        if (parsed) status.record(parsed)
        return metadata
      }

      /**
       * The one and only no-op shape: the ORIGINAL array, plus a reason. The
       * array identity is preserved so a caller can tell "untouched" from
       * "reduced", not just from the metadata.
       */
      const unchanged = (reason: SkipReason) => ({
        messages,
        metadata: record({
          'semantic.contextReduce': true,
          'semantic.applied': false,
          'semantic.reason': reason,
        }),
      })

      let settingsValues: Record<string, unknown>
      try {
        settingsValues = readSettings()
      } catch {
        return unchanged('settings_unavailable')
      }
      if (settingsValues.contextReduce !== true) return unchanged('disabled')

      const segments = segmentMessages(messages)
      // Nothing droppable: no call is made at all.
      if (segments.length === 0) return unchanged('no_candidates')

      let provider: SystemOneHttpProvider
      try {
        provider = new SystemOneHttpProvider(parseSettings(settingsValues), transport)
      } catch (error) {
        return unchanged(reasonFor(error))
      }

      // Only the segments that fitted the budget are asked about. The rest keep
      // their messages, because a segment nobody asked about has no answer and
      // must never be treated as droppable.
      const { request, asked } = buildRequest(segments)
      if (asked.length === 0) return unchanged('no_candidates')

      let response: DecisionResponse
      try {
        response = await provider.decide(request, {
          ...(context.signal ? { signal: context.signal } : {}),
          origin: 'automatic',
        })
      } catch (error) {
        return unchanged(reasonFor(error))
      }

      const dropped = new Set<number>()
      let uncertain = false
      let unusable = false
      // Iterates the ASKED segments only. A segment excluded by the character
      // budget has no answer, so it is neither droppable nor uncertain: it
      // simply stays in the conversation.
      for (const i of asked) {
        const segment = segments[i]
        const verdict = readVerdict(response, i, segments)
        if (verdict.uncertain) uncertain = true
        if (verdict.unusable) unusable = true
        if (verdict.drop && segment !== undefined) dropped.add(segment.index)
      }

      // Nothing was droppable. Distinguish "the provider said no to all of it"
      // from "the provider's answer could not be read at all", because those
      // point at completely different problems for an operator.
      if (dropped.size === 0) {
        return unchanged(unusable ? 'invalid_response' : 'low_confidence')
      }

      const reduced = messages.filter((_message, index) => !dropped.has(index))
      // The guard is on the RESULT, not on the count of candidates: the live
      // turn must survive, and a reduction that would leave the model with
      // nothing it was asked to answer is a failure mode, not a saving.
      // Dropping ALL of the history is legitimate — that is the whole point —
      // so this deliberately does not compare against `segments.length`.
      if (reduced.length === 0 || reduced.length >= messages.length) {
        return unchanged('total_wipe_refused')
      }

      return {
        messages: reduced,
        metadata: record({
          'semantic.contextReduce': true,
          'semantic.applied': true,
          'semantic.reason': null,
          'semantic.segmentsOffered': asked.length,
          'semantic.segmentsDropped': dropped.size,
          'semantic.uncertain': uncertain,
        }),
      }
    },
  }
}

export { MAX_REDUCED_SEGMENTS, segmentMessages } from './messages.js'
export type { Segment } from './messages.js'