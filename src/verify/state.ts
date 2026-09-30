import { createHash } from 'node:crypto'

import { ProviderError } from '../errors.js'
import { isRecord } from '../decision/validation.js'
import type { JsonValue } from '../decision/types.js'

/**
 * Hard bound on the evidence that may be assembled into one verification state.
 * Oversized input is rejected rather than truncated: a silent truncation would
 * drop the very excerpt that contradicts the criterion and could turn a real
 * defect into a false pass.
 */
export const MAX_EVIDENCE_BYTES = 24_000

/** Bounds on the identifiers and local-only references kept out of the state. */
export const MAX_IDENTIFIER_LENGTH = 200
export const MAX_REFERENCE_COUNT = 200

export interface VerifyState {
  readonly acceptanceCriterion: string
  readonly implementationSummary?: string
  readonly diffExcerpts?: readonly string[]
  readonly deterministicTestResults?: readonly string[]
}

export interface VerifyTrace {
  readonly issueId: string | null
  readonly criterionId: string
  readonly criterionText: string
  readonly evidenceRefs: readonly string[]
}

export interface BuiltVerifyState {
  readonly state: VerifyState
  readonly trace: VerifyTrace
  readonly reportId: string
  readonly bytes: number
}

export interface VerifyInput {
  criterionId: string
  criterion: string
  issueId?: string
  model?: string
  evidence?: {
    summary?: string
    diffExcerpts?: unknown
    deterministicTestResults?: unknown
  }
  evidenceRefs?: unknown
}

const ALLOWED = new Set(['criterionId', 'criterion', 'issueId', 'model', 'evidence', 'evidenceRefs'])
const ALLOWED_EVIDENCE = new Set(['summary', 'diffExcerpts', 'deterministicTestResults'])

function readString(value: unknown, field: string, maxLength = MAX_IDENTIFIER_LENGTH): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProviderError('invalid_arguments', `${field} must be a nonempty string`)
  }
  if (value.length > maxLength) {
    throw new ProviderError('invalid_arguments', `${field} exceeds ${maxLength} characters`)
  }
  return value
}

function readStringList(value: unknown, field: string, maxCount = MAX_REFERENCE_COUNT): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new ProviderError('invalid_arguments', `${field} must be an array of strings`)
  }
  if (value.length > maxCount) {
    throw new ProviderError('invalid_arguments', `${field} accepts at most ${maxCount} entries`)
  }
  const entries: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new ProviderError('invalid_arguments', `${field} must contain only strings`)
    }
    if (entry.length > MAX_IDENTIFIER_LENGTH) {
      throw new ProviderError(
        'invalid_arguments',
        `${field} entries exceed ${MAX_IDENTIFIER_LENGTH} characters`,
      )
    }
    if (entry.trim()) entries.push(entry)
  }
  return entries
}

/**
 * Builds the bounded state sent to the provider and the local trace that stays
 * behind. The trace keeps the report auditable and aggregatable across issues
 * without widening what leaves the machine: repository paths are recorded
 * locally as references and are never part of the transmitted state.
 */
export function buildVerifyState(input: unknown): BuiltVerifyState {
  if (!isRecord(input)) {
    throw new ProviderError('invalid_arguments', 'Verification input must be an object')
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED.has(key)) {
      throw new ProviderError('invalid_arguments', `Unknown verification field "${key}"`)
    }
  }

  const criterionId = readString(input.criterionId, 'criterionId')
  // The criterion is prose, not an identifier: it gets its own, larger bound.
  const criterion = readString(input.criterion, 'criterion', MAX_EVIDENCE_BYTES)

  const issueId = input.issueId === undefined ? null : readString(input.issueId, 'issueId')
  if (input.model !== undefined) readString(input.model, 'model')

  const evidence = input.evidence
  if (evidence !== undefined && !isRecord(evidence)) {
    throw new ProviderError('invalid_arguments', 'evidence must be an object')
  }
  if (isRecord(evidence)) {
    for (const key of Object.keys(evidence)) {
      if (!ALLOWED_EVIDENCE.has(key)) {
        throw new ProviderError('invalid_arguments', `Unknown evidence field "${key}"`)
      }
    }
  }

  const summary = evidence?.summary === undefined ? undefined : readString(evidence.summary, 'evidence.summary')
  const diffExcerpts = readStringList(evidence?.diffExcerpts, 'evidence.diffExcerpts')
  const testResults = readStringList(evidence?.deterministicTestResults, 'evidence.deterministicTestResults')
  const evidenceRefs = readStringList(input.evidenceRefs, 'evidenceRefs')

  const state: VerifyState = {
    acceptanceCriterion: criterion,
    ...(summary ? { implementationSummary: summary } : {}),
    ...(diffExcerpts.length ? { diffExcerpts } : {}),
    ...(testResults.length ? { deterministicTestResults: testResults } : {}),
  }

  const bytes = Buffer.byteLength(JSON.stringify(state), 'utf8')
  if (bytes > MAX_EVIDENCE_BYTES) {
    throw new ProviderError(
      'invalid_arguments',
      `Assembled evidence (${bytes} bytes) exceeds the evidence size limit of ${MAX_EVIDENCE_BYTES} bytes`,
    )
  }

  return {
    state,
    trace: { issueId, criterionId, criterionText: criterion, evidenceRefs },
    reportId: buildReportId(criterionId, JSON.parse(JSON.stringify(state)) as JsonValue),
    bytes,
  }
}

/**
 * The report id embeds a bounded, human-readable criterion slug so a report can
 * be traced back to a requirement at a glance. The slug is sanitized and
 * length-capped here, so a criterion id can never inflate a persisted record.
 */
function buildReportId(criterionId: string, state: JsonValue): string {
  const slug = criterionId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40) || 'criterion'
  const digest = createHash('sha256')
    .update(criterionId)
    .update(' ')
    .update(JSON.stringify(state))
    .digest('hex')
    .slice(0, 16)
  return `verify:${slug}:${digest}`
}
