import type { PluginTool } from 'openfox/plugin'

import { ProviderError } from '../errors.js'
import type { TransformStatusStore } from './status.js'

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
export function createTransformStatusTool(status: TransformStatusStore): PluginTool {
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