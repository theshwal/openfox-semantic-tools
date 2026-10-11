import type { PluginTool } from 'openfox/plugin'

import { ProviderError } from '../errors.js'
import { runVerifyAssessment, type VerifyRunOptions } from './run.js'
import { NULL_ACTIVITY_RECORDER, type ActivityRecorder } from '../activity/recorder.js'

export type { VerifyReport } from './run.js'

export interface VerifyToolOptions extends VerifyRunOptions {}

/**
 * `semantic_verify_task` is an advisory post-build check on ONE acceptance
 * criterion. The actual verification policy lives in runVerifyAssessment so
 * issue-level aggregation can reuse exactly the same settings, calibration,
 * egress and failure semantics.
 */
export function createVerifyTool(
  readSettings: (projectId?: string) => Record<string, unknown>,
  options: VerifyToolOptions = {},
  activity: ActivityRecorder = NULL_ACTIVITY_RECORDER,
): PluginTool {
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
        const report = await runVerifyAssessment(args, context, readSettings, options)
        activity.record({
          tool: 'semantic_verify_task',
          kind: 'verify',
          reportId: report.reportId,
          context,
          question: report.trace.criterionText,
          success: true,
          latencyMs: report.latencyMs,
          status: report.status,
          gateReasons: report.reasons,
        })
        return { success: true, output: JSON.stringify(report) }
      } catch (error) {
        activity.record({
          tool: 'semantic_verify_task',
          kind: 'verify',
          reportId: 'verify:failed',
          context,
          question: typeof args.criterion === 'string' ? args.criterion : '',
          success: false,
        })
        if (error instanceof ProviderError) {
          return {
            success: false,
            error: JSON.stringify({ code: error.code, message: error.message }),
          }
        }
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
