import type { PluginTool } from 'openfox/plugin'

import { ProviderError } from '../errors.js'
import { isRecord } from '../decision/validation.js'
import type { GateId, GateOutcome } from './policy.js'
import {
  runVerifyAssessment,
  type VerifyReport,
  type VerifyRunOptions,
} from './run.js'

export const MAX_COVERAGE_CRITERIA = 12

export type CoverageStatus = 'covered' | 'missing' | 'uncertain'

export interface CoverageCriterionResult {
  readonly criterionId: string
  readonly criterion: string
  readonly coverage: CoverageStatus
  readonly verificationStatus: VerifyReport['status']
  readonly reportId: string
  readonly evidenceRefs: readonly string[]
  readonly offScopeEvidence: boolean
  readonly reasons: readonly string[]
  readonly gates: readonly GateOutcome[]
}

export interface IssueCoverageReport {
  readonly issueId: string | null
  readonly advisory: true
  readonly needsFollowup: boolean
  readonly policyVersion: string
  readonly calibrated: boolean
  readonly provider: string
  readonly model?: string
  readonly latencyMs: number
  readonly criteria: readonly CoverageCriterionResult[]
  readonly counts: Readonly<Record<CoverageStatus, number>>
}

interface ParsedCriterion {
  readonly id: string
  readonly text: string
}

interface ParsedCoverageInput {
  readonly issueId?: string
  readonly task?: string
  readonly criteria: readonly ParsedCriterion[]
  readonly model?: string
  readonly evidence?: unknown
  readonly evidenceRefs?: unknown
}

const ALLOWED = new Set(['issueId', 'task', 'criteria', 'model', 'evidence', 'evidenceRefs'])
const CRITERION_ALLOWED = new Set(['id', 'text'])

function text(value: unknown, field: string, max = 24_000): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProviderError('invalid_arguments', `${field} must be a nonempty string`)
  }
  if (value.length > max) {
    throw new ProviderError('invalid_arguments', `${field} exceeds ${max} characters`)
  }
  return value
}

function parseInput(value: unknown): ParsedCoverageInput {
  if (!isRecord(value)) {
    throw new ProviderError('invalid_arguments', 'Issue coverage input must be an object')
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED.has(key)) {
      throw new ProviderError('invalid_arguments', `Unknown issue coverage field "${key}"`)
    }
  }
  if (!Array.isArray(value.criteria) || value.criteria.length === 0) {
    throw new ProviderError('invalid_arguments', 'criteria must be a nonempty array')
  }
  if (value.criteria.length > MAX_COVERAGE_CRITERIA) {
    throw new ProviderError(
      'invalid_arguments',
      `criteria accepts at most ${MAX_COVERAGE_CRITERIA} entries`,
    )
  }

  const seen = new Set<string>()
  const criteria = value.criteria.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new ProviderError('invalid_arguments', `criteria[${index}] must be an object`)
    }
    for (const key of Object.keys(raw)) {
      if (!CRITERION_ALLOWED.has(key)) {
        throw new ProviderError(
          'invalid_arguments',
          `Unknown criteria[${index}] field "${key}"`,
        )
      }
    }
    const id = text(raw.id, `criteria[${index}].id`, 200)
    const criterion = text(raw.text, `criteria[${index}].text`)
    if (seen.has(id)) {
      throw new ProviderError('invalid_arguments', `Duplicate criterion id "${id}"`)
    }
    seen.add(id)
    return { id, text: criterion }
  })

  return {
    ...(value.issueId === undefined ? {} : { issueId: text(value.issueId, 'issueId', 200) }),
    ...(value.task === undefined ? {} : { task: text(value.task, 'task') }),
    criteria,
    ...(value.model === undefined ? {} : { model: text(value.model, 'model', 200) }),
    ...(value.evidence === undefined ? {} : { evidence: value.evidence }),
    ...(value.evidenceRefs === undefined ? {} : { evidenceRefs: value.evidenceRefs }),
  }
}

function verdict(report: VerifyReport, id: GateId): GateOutcome['verdict'] | undefined {
  return report.gates.find((gate) => gate.id === id)?.verdict
}

/**
 * Coverage is intentionally a projection of the existing verification policy:
 * no second threshold system exists here.
 */
export function coverageFrom(report: VerifyReport): CoverageStatus {
  if (report.status === 'pass-candidate') return 'covered'

  if (
    verdict(report, 'criterionTestable') === 'met' &&
    verdict(report, 'evidenceSufficiency') === 'met' &&
    verdict(report, 'satisfied') === 'unmet'
  ) {
    return 'missing'
  }

  return 'uncertain'
}

export function criterionCoverage(report: VerifyReport): CoverageCriterionResult {
  return {
    criterionId: report.trace.criterionId,
    criterion: report.trace.criterionText,
    coverage: coverageFrom(report),
    verificationStatus: report.status,
    reportId: report.reportId,
    evidenceRefs: report.trace.evidenceRefs,
    offScopeEvidence: verdict(report, 'offScope') === 'unmet',
    reasons: [...report.reasons],
    gates: report.gates,
  }
}

/**
 * Advisory issue-level coverage over several explicit criteria.
 *
 * Each criterion is evaluated through the exact same verification core as
 * semantic_verify_task. A provider/egress/settings failure aborts the whole
 * assessment instead of fabricating per-criterion coverage.
 */
export function createIssueCoverageTool(
  readSettings: (projectId?: string) => Record<string, unknown>,
  options: VerifyRunOptions = {},
): PluginTool {
  return {
    name: 'semantic_issue_coverage',
    description:
      'Advisory issue-level coverage assessment over explicit acceptance criteria. Reuses semantic verification policy/calibration, never replaces deterministic checks, and never marks a task merge-safe or complete.',
    parameters: {
      type: 'object',
      required: ['criteria'],
      additionalProperties: false,
      properties: {
        issueId: { type: 'string', minLength: 1 },
        task: { type: 'string', minLength: 1 },
        model: { type: 'string', minLength: 1 },
        criteria: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_COVERAGE_CRITERIA,
          items: {
            type: 'object',
            required: ['id', 'text'],
            additionalProperties: false,
            properties: {
              id: { type: 'string', minLength: 1 },
              text: { type: 'string', minLength: 1 },
            },
          },
        },
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
        const parsed = parseInput(args)
        const criteria: CoverageCriterionResult[] = []
        let provider = ''
        let model: string | undefined
        let policyVersion = ''
        let calibrated = true
        let latencyMs = 0

        for (const criterion of parsed.criteria) {
          const report = await runVerifyAssessment(
            {
              criterionId: criterion.id,
              criterion: criterion.text,
              ...(parsed.issueId ? { issueId: parsed.issueId } : {}),
              ...(parsed.task ? { taskContext: parsed.task } : {}),
              ...(parsed.model ? { model: parsed.model } : {}),
              ...(parsed.evidence === undefined ? {} : { evidence: parsed.evidence }),
              ...(parsed.evidenceRefs === undefined ? {} : { evidenceRefs: parsed.evidenceRefs }),
            },
            context,
            readSettings,
            options,
          )
          criteria.push(criterionCoverage(report))
          provider ||= report.provider
          model ??= report.model
          policyVersion ||= report.policyVersion
          calibrated = calibrated && report.calibrated
          latencyMs += report.latencyMs
        }

        const counts: Record<CoverageStatus, number> = {
          covered: 0,
          missing: 0,
          uncertain: 0,
        }
        for (const result of criteria) counts[result.coverage] += 1

        const output: IssueCoverageReport = {
          issueId: parsed.issueId ?? null,
          advisory: true,
          needsFollowup: criteria.some(
            (result) => result.coverage !== 'covered' || result.offScopeEvidence,
          ),
          policyVersion,
          calibrated,
          provider,
          ...(model ? { model } : {}),
          latencyMs,
          criteria,
          counts,
        }
        return { success: true, output: JSON.stringify(output) }
      } catch (error) {
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
            message:
              'Issue coverage assessment failed to run. Use the normal verification path.',
          }),
        }
      }
    },
  }
}
