import type { PluginTool } from 'openfox/plugin'

import { ProviderError } from '../errors.js'
import type { HookObserver } from '../hooks/observer.js'
import { MAX_RETAINED, type TransformStatusStore } from './status.js'

/**
 * Reports what the context-reduction transform has been doing.
 *
 * Without this, `contextReduce` is a toggle with no observable effect: an
 * operator flips it, and cannot distinguish a provider that never drops
 * anything from an endpoint that is blocked, misconfigured, or never consulted
 * because the turn held no droppable history. This tool is the read path for
 * `semantic.reason`.
 *
 * It is a pure reader. It changes no setting, contacts no provider, and sends
 * nothing anywhere — every value it reports is a count, a reason or a
 * timestamp recorded by the transform itself.
 */
export function createTransformStatusTool(
  status: TransformStatusStore,
  /**
   * The host observer, when one is registered.
   *
   * Optional so the tool stays usable in tests and in an install where hooks
   * are unavailable. Absent means "no host observation", reported as
   * `complete: false` rather than silently omitted.
   */
  observer?: HookObserver,
): PluginTool {
  return {
    name: 'semantic_transform_status',
    description:
      'Report what the opt-in context-reduction transform has done in this OpenFox session: applied turns, segments offered and dropped, and why a turn was left unchanged. Reads recorded counts only; it contacts no provider and changes no setting.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    async execute() {
      try {
        const recent = status.snapshot()
        const last = recent[0] ?? null
        // Every distinct reason seen, so an operator sees the PATTERN ("always
        // egress_blocked") and not just the most recent event.
        const reasons = [...new Set(recent.map((entry) => entry.reason).filter(Boolean))] as string[]

        // The host's own COMPACTION observation, reported on its own line and
        // explicitly owned by the host. Filtered to `context.compacted`: an
        // earlier version listed every measured event here, so a plain
        // `turn.completed` was reported under `hostCompactions` and read as
        // "the host compacted a turn", which it never does. Only the one event
        // that means a context reduction belongs in this field; the full census
        // is `semantic_hook_status`.
        //
        // Read defensively: an observer that throws must not take down the
        // transform report.
        let hostCompactions: { event: string; count: number; attributedTo: string }[] | undefined
        let complete: boolean | undefined
        try {
          const snapshot = observer?.snapshot()
          hostCompactions = (snapshot?.events ?? [])
            .filter((entry) => entry.measured && entry.event === 'context.compacted')
            .map((entry) => ({
              event: entry.event,
              count: entry.count,
              attributedTo: entry.attributedTo,
            }))
          complete = snapshot?.complete
        } catch {
          hostCompactions = undefined
          complete = undefined
        }

        return {
          success: true,
          output: JSON.stringify({
            advisory: true,
            // Repeated here so the report can never be read as an endorsement.
            status: 'experimental-unmeasured',
            verdict: 'DEFER',
            note:
              'No measured token, cost or task-quality benefit. This tool reports only what the transform actually did; see docs/EVALUATION.md in the repository.',
            appliedTurns: status.appliedTurns,
            recordedTurns: recent.length,
            last,
            reasonsSeen: reasons,
            recent,
            // Our own figures, and only ours. A host compaction is a different
            // measurement taken by a different party, so it is reported apart and
            // never folded in: attributing the host's reduction to this plugin
            // would be a claim nothing here measured.
            transform: {
              attributedTo: 'plugin',
              appliedTurns: status.appliedTurns,
              // LABELLED rather than silently mixed: `recent` is capped at 20
              // entries, so this is a rolling window, while `appliedTurns` is a
              // lifetime counter. Side by side under one name they read as one
              // measurement, which is exactly the confusion this field exists to
              // prevent.
              charsRemovedLast20Turns: recent.reduce(
                (sum, entry) => sum + (entry.charsRemoved ?? 0),
                0,
              ),
              windowTurns: recent.length,
              retainedTurnsLimit: MAX_RETAINED,
            },
            hostCompactions: hostCompactions ?? [],
            // False while any subscribed host event is still unobserved, so
            // "none seen" is never confused with "not measurable".
            complete: complete ?? false,
          }),
        }
      } catch (error) {
        if (error instanceof ProviderError) {
          return { success: false, error: JSON.stringify({ code: error.code, message: error.message }) }
        }
        return {
          success: false,
          error: JSON.stringify({
            code: 'transform_status_failed',
            message: 'Could not read the context-reduction status.',
          }),
        }
      }
    },
  }
}