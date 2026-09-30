import type { PluginTool } from 'openfox/plugin'

import { ProviderError, SystemOneHttpProvider } from '../providers/system-one.js'
import { parseSettings } from '../settings.js'
import { buildVerifyState } from './state.js'
import { buildVerifyRequest } from './questions.js'
import { DEFAULT_POLICY, evaluateVerifyPolicy, type VerifyPolicy, type VerifyStatus } from './policy.js'
import type { DecisionAnswer, DecisionResponse, DecisionRequest } from '../decision/types.js'

export interface VerifyReport {
  reportId: string
  trace: {
    issueId: string | null
    criterionId: string
    criterionText: string
    evidenceRefs: readonly string[]
  }
  status: VerifyStatus
  /** Always true in this experiment: the result is advice, never a gate. */
  advisory: true
  policyVersion: string
  calibrated: boolean
  provider: string
  model?: string
  latencyMs: number
  evidenceBytes: number
  answers: Record<string, DecisionAnswer>
  gates: ReturnType<typeof evaluateVerifyPolicy>['gates']
  reasons: string[]
}

export interface VerifyToolOptions {
  policy?: VerifyPolicy
  transport?: typeof fetch
}

/**
 * `semantic_verify_task` is an advisory post-build check on ONE acceptance
 * criterion. It reuses the shipped transport, settings and egress policy rather
 * than reimplementing them, and it always declares an `automatic` origin
 * because it assembles repository/session-derived evidence: the egress policy
 * must be able to block it on a remote endpoint before anything is sent.
 *
 * It registers no workflow transition, no hook and no completion signal. A
 * `success: true` result means the advisory report was produced, never that the
 * criterion is satisfied.
 */
export function createVerifyTool(
  readSettings: (projectId?: string) => Record<string, unknown>,
  options: VerifyToolOptions = {},
): PluginTool {
  const policy = options.policy ?? DEFAULT_POLICY
  const transport = options.transport ?? fetch
  return {
    name: 'semantic_verify_task',
    description:
      'Advisory bounded check of ONE acceptance criterion against supplied implementation evidence. Returns unknown or needs-verification unless a measured calibration exists; never replaces tests, typechecks, linters or human review, and never marks a task complete.',
    parameters: {
      type: 'object',
      required: ['criterionId', 'criterion'],
      additionalProperties: false,
      properties: {
        criterionId: { type: 'string', minLength: 1 },
        criterion: { type: 'string', minLength: 1 },
        issueId: { type: 'string', minLength: 1 },
        model: { type: 'string', minLength: 1 },
        evidenceRefs: { type: 'array', items: { type: 'string' } },
        evidence: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: { type: 'string' },
            diffExcerpts: { type: 'array', items: { type: 'string' } },
            deterministicTestResults: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    async execute(args, context) {
      try {
        const built = buildVerifyState(args)
        const request: DecisionRequest = buildVerifyRequest(
          built.state,
          args.criterion as string,
          typeof args.model === 'string' ? args.model : undefined,
        )
        const provider = new SystemOneHttpProvider(parseSettings(readSettings(context.projectId)), transport)
        // Repository/session-derived content: always automatic, never explicit.
        const response: DecisionResponse = await provider.decide(request, {
          signal: context.signal,
          origin: 'automatic',
        })
        const decision = evaluateVerifyPolicy(response.answers, policy)
        const report: VerifyReport = {
          reportId: built.reportId,
          trace: built.trace,
          status: decision.status,
          advisory: true,
          policyVersion: decision.policyVersion,
          calibrated: decision.calibrated,
          provider: response.provider,
          ...(response.model ? { model: response.model } : {}),
          latencyMs: response.latencyMs ?? 0,
          evidenceBytes: built.bytes,
          answers: response.answers,
          gates: decision.gates,
          reasons: [...decision.reasons],
        }
        return { success: true, output: JSON.stringify(report) }
      } catch (error) {
        if (error instanceof ProviderError) {
          return { success: false, error: JSON.stringify({ code: error.code, message: error.message }) }
        }
        // A non-ProviderError is not the caller's fault: it is either an
        // internal defect or a settings access failure. Reporting
        // `invalid_arguments` here would send the agent to fix arguments that
        // are fine. The message stays generic because settings access can throw
        // secret-bearing errors.
        return {
          success: false,
          error: JSON.stringify({
            code: 'internal',
            message: 'Semantic verification failed to run. Use the normal verification path.',
          }),
        }
      }
    },
  }
}
