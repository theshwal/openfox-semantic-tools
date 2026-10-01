// Schema and quality gate for the labelled verification fixture set.
//
// The seven original fixtures were enough to prove the plumbing and far too few
// to compare providers: every family had one or two cases, several of them
// shared wording, and a single case decided a whole family. This module is the
// only definition of what a fixture set must look like, so the suite cannot be
// padded with paraphrases or quietly re-balanced without a failing test.
//
// It is deliberately a LOADER, not a generator: it validates and reports, it
// never rewrites a label and never repairs a case. Every problem is returned
// with the id of the offending case so a failure names the fixture to fix.

import { isRecord } from '../src/decision/validation.ts'
import type { VerifyStatus } from '../src/verify/policy.ts'

/** Schema versions this loader understands. A newer file is refused outright. */
export const FIXTURE_SCHEMA_VERSIONS = [1, 2] as const

/**
 * The families the suite must cover. A family is a SHAPE of case, not a status:
 * several statuses can be reached from the same family, and a family that
 * always produced the same status would be measuring the label, not the shape.
 */
export const VERIFY_CASE_FAMILIES: readonly string[] = [
  /** The criterion is met and the evidence shows it directly. */
  'direct-positive-evidence',
  /** The work is real, but the evidence stops short of deciding the criterion. */
  'partial-evidence',
  /** The criterion is decidable and the evidence shows it was not implemented. */
  'criterion-not-implemented',
  /** The evidence contains a statement that contradicts the criterion. */
  'contradictory-evidence',
  /** A green test, but for a different assertion or a different scope. */
  'other-test-or-scope',
  /** The change is real, but it touches behaviour outside the criterion. */
  'off-scope-change',
  /** The criterion states an intention or a quality with no observable test. */
  'ambiguous-criterion',
  /** Nothing forbids a superficial fix, so a deeper pass is the right next step. */
  'needs-deeper-verification',
]

export type VerifyCaseFamily = (typeof VERIFY_CASE_FAMILIES)[number]

/** Legacy grouping, kept because the persisted reports and their tests use it. */
export const VERIFY_CASE_GROUPS = ['positive', 'negative', 'adversarial'] as const

export const VERIFY_STATUSES: readonly VerifyStatus[] = [
  'pass-candidate',
  'needs-verification',
  'insufficient-evidence',
  'off-scope',
  'unknown',
]

/**
 * Statuses the shipped, uncalibrated policy can actually emit. A fixture that
 * expects any other status would be labelling a policy that does not exist.
 */
export const UNCALIBRATED_STATUSES: readonly VerifyStatus[] = [
  'unknown',
  'insufficient-evidence',
  'needs-verification',
  'off-scope',
]

/** Every family must be represented, or the suite cannot compare providers. */
export const MIN_CASES_PER_FAMILY = 3
/**
 * A single family may never hold more than this share of the suite. Without it,
 * adding ten variants of one family would pass every other check while making
 * the comparison meaningless.
 */
export const MAX_CASES_PER_FAMILY_SHARE = 0.3

/**
 * How similar two texts must be before one is treated as a restatement of the
 * other. Chosen above paraphrase level: two fixtures that differ only by
 * rewording exercise the same discrimination, so counting them twice would
 * inflate the suite without adding evidence.
 */
const LEXICAL_DUPLICATE_THRESHOLD = 0.8

const SCRIPTED_RANGES: Record<string, readonly [number, number]> = {
  criterionTestable: [0, 1],
  satisfied: [0, 1],
  // The evidence rubric has three levels, so the scripted expectation runs
  // 0..2 in level units (see docs/SCORE-CONTRACT.md), not 0..1.
  evidenceSufficiency: [0, 2],
  offScope: [0, 1],
  needsDeeperVerification: [0, 1],
}

export interface FixtureSetProblem {
  /** Stable code, so a test can assert the rule without matching prose. */
  readonly code: string
  /** The offending case id, or the file itself for a whole-file problem. */
  readonly caseId: string | null
  readonly detail: string
}

export interface LoadedFixtureCase {
  readonly id: string
  readonly group: string
  readonly category: string
  readonly criterionId: string
  readonly issueId: string
  readonly criterion: string
  readonly evidence?: Record<string, unknown>
  readonly evidenceRefs?: readonly string[]
  readonly scripted: Record<string, number>
  readonly expected: VerifyStatus
  readonly expectedUnderCalibratedPolicy?: VerifyStatus
  readonly expectedReason?: string
  readonly rationale: string
  readonly labelAudit?: string
}

export interface LoadedFixtureSet {
  readonly cases: readonly LoadedFixtureCase[]
  readonly problems: readonly FixtureSetProblem[]
  /** Per-family counts, reported so a rebalance is visible without a diff. */
  readonly familyCounts: Readonly<Record<string, number>>
  readonly statusCounts: Readonly<Record<string, number>>
}

function problem(code: string, caseId: string | null, detail: string): FixtureSetProblem {
  return { code, caseId, detail }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Token sets for a lexical-closeness check, with the stop words removed so two
 * sentences about the same subject do not look identical purely because of
 * shared filler. A criterion that is genuinely a different requirement shares
 * very few content words; a paraphrase shares nearly all of them.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'every', 'for', 'from', 'in', 'is', 'it',
  'its', 'no', 'not', 'of', 'on', 'only', 'or', 'that', 'the', 'then', 'this', 'to', 'when',
  'which', 'with', 'must', 'may', 'each', 'all', 'any', 'one',
])

function contentTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token)),
  )
}

/** Jaccard overlap of the content words, in [0, 1]. */
function lexicalCloseness(a: string, b: string): number {
  const left = contentTokens(a)
  const right = contentTokens(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / (left.size + right.size - shared)
}

function evidenceSummary(evidence: Record<string, unknown> | undefined): string {
  const summary = evidence?.summary
  return typeof summary === 'string' ? summary : ''
}

function checkScripted(value: unknown, caseId: string, problems: FixtureSetProblem[]): Record<string, number> {
  const out: Record<string, number> = {}
  if (!isRecord(value)) {
    problems.push(problem('invalid_scripted', caseId, 'scripted answers must be an object'))
    return out
  }
  for (const [gate, [low, high]] of Object.entries(SCRIPTED_RANGES)) {
    const answer = value[gate]
    if (typeof answer !== 'number' || !Number.isFinite(answer) || answer < low || answer > high) {
      problems.push(
        problem('invalid_scripted', caseId, `scripted.${gate} must be a number in [${low}, ${high}]`),
      )
      continue
    }
    out[gate] = answer
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(SCRIPTED_RANGES, key)) {
      problems.push(problem('invalid_scripted', caseId, `scripted.${key} is not a policy gate`))
    }
  }
  return out
}

function readCase(raw: unknown, index: number, problems: FixtureSetProblem[]): LoadedFixtureCase | null {
  if (!isRecord(raw)) {
    problems.push(problem('malformed_case', null, `case at index ${index} is not an object`))
    return null
  }
  const id = isNonEmptyString(raw.id) ? raw.id : null
  if (id === null) {
    problems.push(problem('malformed_case', null, `case at index ${index} has no id`))
    return null
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_CASE_FIELDS.has(key)) {
      problems.push(problem('unknown_case_field', id, `field ${key} is not part of the fixture contract`))
    }
  }

  const category = raw.category
  if (category === undefined) {
    problems.push(problem('missing_category', id, 'a case must declare the family it belongs to'))
  } else if (!VERIFY_CASE_FAMILIES.includes(String(category))) {
    problems.push(problem('unknown_family', id, `category "${String(category)}" is not a declared family`))
  }

  const group = raw.group
  if (!VERIFY_CASE_GROUPS.includes(group as (typeof VERIFY_CASE_GROUPS)[number])) {
    problems.push(problem('unknown_group', id, `group "${String(group)}" is not one of ${VERIFY_CASE_GROUPS.join(', ')}`))
  }

  if (!isNonEmptyString(raw.criterion)) {
    problems.push(problem('missing_criterion', id, 'a case must carry the acceptance criterion text'))
  }
  if (!isNonEmptyString(raw.criterionId)) {
    problems.push(problem('missing_criterion_id', id, 'a case must carry a criterion id for traceability'))
  }
  if (!isNonEmptyString(raw.issueId)) {
    problems.push(problem('missing_issue_id', id, 'a case must carry the issue it comes from'))
  }
  if (!isNonEmptyString(raw.rationale)) {
    problems.push(problem('missing_rationale', id, 'a label without a stated reason cannot be audited'))
  }

  const expected = raw.expected
  if (!VERIFY_STATUSES.includes(expected as VerifyStatus)) {
    problems.push(problem('invalid_status', id, `expected "${String(expected)}" is not a verify status`))
  } else if (expected === 'pass-candidate') {
    // The shipped policy is uncalibrated, so a positive status is structurally
    // unreachable. A fixture may DESCRIBE such a case, but only through
    // `expectedUnderCalibratedPolicy`, which the report records separately.
    problems.push(
      problem(
        'positive_label_before_calibration',
        id,
        'the shipped policy is uncalibrated and can never emit pass-candidate; use expectedUnderCalibratedPolicy',
      ),
    )
  }

  let expectedUnderCalibratedPolicy: VerifyStatus | undefined
  if (raw.expectedUnderCalibratedPolicy !== undefined) {
    if (!VERIFY_STATUSES.includes(raw.expectedUnderCalibratedPolicy as VerifyStatus)) {
      problems.push(
        problem('invalid_status', id, `expectedUnderCalibratedPolicy "${String(raw.expectedUnderCalibratedPolicy)}" is not a verify status`),
      )
    } else {
      expectedUnderCalibratedPolicy = raw.expectedUnderCalibratedPolicy as VerifyStatus
      // A label that repeats the current one carries no information about what
      // calibration would change, so it is noise in the report.
      if (expectedUnderCalibratedPolicy === expected) {
        problems.push(
          problem(
            'redundant_calibrated_label',
            id,
            'expectedUnderCalibratedPolicy repeats expected, so it says nothing about calibration',
          ),
        )
      }
    }
  }

  const scripted = checkScripted(raw.scripted, id, problems)
  if (raw.evidence !== undefined && !isRecord(raw.evidence)) {
    problems.push(problem('invalid_evidence', id, 'evidence must be an object when present'))
  } else if (isRecord(raw.evidence)) {
    for (const key of Object.keys(raw.evidence)) {
      if (!ALLOWED_EVIDENCE_FIELDS.has(key)) {
        problems.push(
          problem('invalid_evidence', id, `evidence.${key} is not a field the verify tool accepts`),
        )
      }
    }
  }
  if (raw.evidenceRefs !== undefined && !Array.isArray(raw.evidenceRefs)) {
    problems.push(problem('invalid_evidence', id, 'evidenceRefs must be an array when present'))
  }

  return {
    id,
    group: String(group),
    category: String(category),
    criterionId: String(raw.criterionId),
    issueId: String(raw.issueId),
    criterion: String(raw.criterion),
    ...(isRecord(raw.evidence) ? { evidence: raw.evidence } : {}),
    ...(Array.isArray(raw.evidenceRefs) ? { evidenceRefs: raw.evidenceRefs as string[] } : {}),
    scripted,
    expected: expected as VerifyStatus,
    ...(expectedUnderCalibratedPolicy ? { expectedUnderCalibratedPolicy } : {}),
    ...(isNonEmptyString(raw.expectedReason) ? { expectedReason: raw.expectedReason } : {}),
    rationale: String(raw.rationale),
    ...(isNonEmptyString(raw.labelAudit) ? { labelAudit: raw.labelAudit } : {}),
  }
}

const ALLOWED_CASE_FIELDS = new Set([
  'id',
  'group',
  'category',
  'criterionId',
  'issueId',
  'criterion',
  'evidence',
  'evidenceRefs',
  'scripted',
  'expected',
  'expectedUnderCalibratedPolicy',
  'expectedReason',
  'rationale',
  'labelAudit',
])

const ALLOWED_FILE_FIELDS = new Set(['schemaVersion', 'note', 'families', 'cases'])
const ALLOWED_EVIDENCE_FIELDS = new Set(['summary', 'diffExcerpts', 'deterministicTestResults'])

function countBy<T extends string>(values: readonly T[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1
  return counts
}

/**
 * Validates a parsed fixture file. Returns the cases it could read together
 * with every problem found: a partially valid set is still reported, so a new
 * fixture batch surfaces all of its own errors in one run.
 */
export function loadVerifyFixtureSet(raw: unknown): LoadedFixtureSet {
  const problems: FixtureSetProblem[] = []
  if (!isRecord(raw)) {
    return {
      cases: [],
      problems: [problem('malformed_file', null, 'the fixture file must contain a JSON object')],
      familyCounts: {},
      statusCounts: {},
    }
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_FILE_FIELDS.has(key)) {
      problems.push(problem('unknown_file_field', null, `field ${key} is not part of the fixture contract`))
    }
  }
  const version = raw.schemaVersion
  if (!FIXTURE_SCHEMA_VERSIONS.includes(version as (typeof FIXTURE_SCHEMA_VERSIONS)[number])) {
    problems.push(
      problem(
        'unsupported_schema_version',
        null,
        `schemaVersion ${String(version)} is not one of ${FIXTURE_SCHEMA_VERSIONS.join(', ')}`,
      ),
    )
    return { cases: [], problems, familyCounts: {}, statusCounts: {} }
  }
  if (!Array.isArray(raw.cases)) {
    problems.push(problem('malformed_file', null, 'cases must be an array'))
    return { cases: [], problems, familyCounts: {}, statusCounts: {} }
  }

  const cases = raw.cases
    .map((entry, index) => readCase(entry, index, problems))
    .filter((entry): entry is LoadedFixtureCase => entry !== null)

  // Only well-formed cases take part in the cross-case checks: comparing a case
  // that was already rejected would report the same problem twice.
  const wellFormed = cases.filter((entry) => !problems.some((issue) => issue.caseId === entry.id))

  const seenIds = new Set<string>()
  const seenCriterionIds = new Set<string>()
  for (const entry of wellFormed) {
    if (seenIds.has(entry.id)) {
      problems.push(problem('duplicate_id', entry.id, 'case id appears more than once'))
    }
    seenIds.add(entry.id)
    if (seenCriterionIds.has(entry.criterionId)) {
      problems.push(
        problem('duplicate_criterion_id', entry.id, `criterion id ${entry.criterionId} is already used`),
      )
    }
    seenCriterionIds.add(entry.criterionId)
  }

  for (let i = 0; i < wellFormed.length; i += 1) {
    for (let j = i + 1; j < wellFormed.length; j += 1) {
      const left = wellFormed[i]
      const right = wellFormed[j]
      if (lexicalCloseness(left.criterion, right.criterion) >= LEXICAL_DUPLICATE_THRESHOLD) {
        problems.push(
          problem(
            'lexical_duplicate_criterion',
            right.id,
            `criterion restates ${left.id} (${left.criterionId}); reword or change the case`,
          ),
        )
      }
      const leftSummary = evidenceSummary(left.evidence)
      const rightSummary = evidenceSummary(right.evidence)
      if (
        leftSummary.length > 0 &&
        rightSummary.length > 0 &&
        lexicalCloseness(leftSummary, rightSummary) >= LEXICAL_DUPLICATE_THRESHOLD
      ) {
        problems.push(
          problem(
            'lexical_duplicate_evidence',
            right.id,
            `evidence summary restates ${left.id}; a paraphrase is not a new case`,
          ),
        )
      }
    }
  }

  const total = wellFormed.length

  return {
    cases: wellFormed,
    problems: [...problems, ...checkFixtureBalance(wellFormed)],
    familyCounts: countBy(wellFormed.map((entry) => entry.category)),
    statusCounts: countBy(wellFormed.map((entry) => entry.expected)),
  }
}

/**
 * Balance is checked separately from validity, and only for a set large enough
 * to be a suite. A two-case set used to probe one rule is not unbalanced, it is
 * just small: refusing it here would make every focused unit test of the
 * loader report a failure that has nothing to do with the rule under test.
 */
export function checkFixtureBalance(cases: readonly LoadedFixtureCase[]): FixtureSetProblem[] {
  const problems: FixtureSetProblem[] = []
  const total = cases.length
  if (total < VERIFY_CASE_FAMILIES.length * MIN_CASES_PER_FAMILY) return problems
  const familyCounts = countBy(cases.map((entry) => entry.category))
  for (const family of VERIFY_CASE_FAMILIES) {
    if ((familyCounts[family] ?? 0) < MIN_CASES_PER_FAMILY) {
      problems.push(
        problem(
          'family_under_represented',
          null,
          `family ${family} has ${familyCounts[family] ?? 0} case(s), below the minimum of ${MIN_CASES_PER_FAMILY}`,
        ),
      )
    }
  }
  const share = Math.ceil(total * MAX_CASES_PER_FAMILY_SHARE)
  for (const [family, count] of Object.entries(familyCounts)) {
    if (count > share) {
      problems.push(
        problem(
          'family_dominates_suite',
          null,
          `family ${family} holds ${count}/${total} cases, above the balance share of ${share}`,
        ),
      )
    }
  }
  return problems
}
