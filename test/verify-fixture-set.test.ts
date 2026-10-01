import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  FIXTURE_SCHEMA_VERSIONS,
  VERIFY_CASE_FAMILIES,
  VERIFY_STATUSES,
  MAX_CASES_PER_FAMILY_SHARE,
  MIN_CASES_PER_FAMILY,
  loadVerifyFixtureSet,
  type FixtureSetProblem,
} from '../scripts/verify-fixture-set.ts'

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/verify/cases.json')

async function readRaw(): Promise<unknown> {
  return JSON.parse(await readFile(FIXTURE_PATH, 'utf8'))
}

/** A minimal well-formed set, so each rule can be violated in isolation. */
function baseCase(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    group: 'negative',
    category: 'criterion-not-implemented',
    criterionId: `ac-${id}`,
    issueId: '#4',
    criterion: `Criterion ${id} is not implemented.`,
    evidence: {
      summary: `Wired up the ${id} path and asserted it.`,
      diffExcerpts: [`+ const ${id} = 1`],
    },
    evidenceRefs: [`src/x-${id}.ts`],
    scripted: {
      criterionTestable: 0.9,
      satisfied: 0.1,
      evidenceSufficiency: 0,
      offScope: 0.05,
      needsDeeperVerification: 0.2,
    },
    expected: 'needs-verification',
    rationale: `Rationale ${id}.`,
    ...overrides,
  }
}

function baseSet(cases: unknown[]): Record<string, unknown> {
  return { schemaVersion: 2, cases }
}

function codes(problems: readonly FixtureSetProblem[]): string[] {
  return problems.map((problem) => problem.code)
}

test('the shipped fixture set loads, and is balanced, unique and justified', async () => {
  const loaded = loadVerifyFixtureSet(await readRaw())
  assert.deepEqual(loaded.problems, [], JSON.stringify(loaded.problems, null, 2))
  assert.ok(loaded.cases.length >= 30, `only ${loaded.cases.length} fixtures`)
  // The seven original fixtures are conserved, byte for byte in content.
  const ids = loaded.cases.map((entry) => entry.id)
  for (const original of [
    'positive-direct-evidence',
    'positive-under-calibrated-policy',
    'negative-criterion-not-implemented',
    'adversarial-assertive-summary-without-code',
    'adversarial-test-log-for-another-test',
    'adversarial-off-scope-change',
    'adversarial-ambiguous-criterion',
  ]) {
    assert.ok(ids.includes(original), `the original fixture ${original} was lost`)
  }
  for (const entry of loaded.cases) {
    assert.ok(VERIFY_CASE_FAMILIES.includes(entry.category), entry.id)
    assert.ok(VERIFY_STATUSES.includes(entry.expected), entry.id)
    assert.ok(entry.rationale.length > 0, entry.id)
  }
})

test('every family is populated, and no family takes over the suite', async () => {
  const loaded = loadVerifyFixtureSet(await readRaw())
  const counts = new Map<string, number>()
  for (const entry of loaded.cases) {
    counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1)
  }
  for (const family of VERIFY_CASE_FAMILIES) {
    assert.ok((counts.get(family) ?? 0) >= MIN_CASES_PER_FAMILY, `family ${family} is under-represented`)
  }
  const total = loaded.cases.length
  for (const [family, count] of counts) {
    assert.ok(
      count <= Math.ceil(total * MAX_CASES_PER_FAMILY_SHARE),
      `family ${family} holds ${count}/${total} cases, above the balance share`,
    )
  }
})

test('the suite covers every status the uncalibrated policy can emit', async () => {
  const loaded = loadVerifyFixtureSet(await readRaw())
  const seen = new Set(loaded.cases.map((entry) => entry.expected))
  // `pass-candidate` is structurally unreachable while the policy is
  // uncalibrated, so it is asserted absent rather than merely rare.
  for (const status of ['unknown', 'insufficient-evidence', 'needs-verification', 'off-scope']) {
    assert.ok(seen.has(status as never), `no fixture expects ${status}`)
  }
  assert.ok(!seen.has('pass-candidate' as never), 'no pass-candidate label is allowed before calibration')
  // A few cases must stay meaningful under a calibrated policy, so a future
  // calibration run has positives to measure against.
  const calibrated = loaded.cases.filter((entry) => entry.expectedUnderCalibratedPolicy === 'pass-candidate')
  assert.ok(calibrated.length >= 3, `only ${calibrated.length} fixtures would be positive under calibration`)
})

test('an unknown schema version is refused rather than half-read', async () => {
  const raw = baseSet([baseCase('1')]) as Record<string, unknown>
  raw.schemaVersion = 99
  const loaded = loadVerifyFixtureSet(raw)
  assert.ok(codes(loaded.problems).includes('unsupported_schema_version'))
  assert.equal(loaded.cases.length, 0, 'no case may be accepted from an unknown schema')
  assert.ok(FIXTURE_SCHEMA_VERSIONS.includes(1 as never))
})

test('duplicate case ids and duplicate criterion ids are refused', () => {
  const loaded = loadVerifyFixtureSet(baseSet([baseCase('1'), baseCase('1')]))
  assert.ok(codes(loaded.problems).includes('duplicate_id'))
  const clash = loadVerifyFixtureSet(
    baseSet([baseCase('1'), baseCase('2', { criterionId: 'ac-1' })]),
  )
  assert.ok(codes(clash.problems).includes('duplicate_criterion_id'))
})

test('a case missing its category or its rationale is refused', () => {
  const noCategory = baseCase('1')
  delete noCategory.category
  delete noCategory.rationale
  const missing = loadVerifyFixtureSet(baseSet([noCategory]))
  assert.ok(codes(missing.problems).includes('missing_category'))
  assert.ok(codes(missing.problems).includes('missing_rationale'))
  // An absent family is reported once, as absent: it is not also "unknown".
  assert.ok(!codes(missing.problems).includes('unknown_family'))
})

test('an unknown family, group or status is refused by name', () => {
  const loaded = loadVerifyFixtureSet(
    baseSet([
      baseCase('1', { category: 'vibes-based' }),
      baseCase('2', { group: 'maybe' }),
      baseCase('3', { expected: 'probably-fine' }),
    ]),
  )
  assert.ok(codes(loaded.problems).includes('unknown_family'))
  assert.ok(codes(loaded.problems).includes('unknown_group'))
  assert.ok(codes(loaded.problems).includes('invalid_status'))
})

test('a scripted answer missing a gate, or out of range, is refused', () => {
  const shortGate = baseCase('1')
  delete (shortGate.scripted as Record<string, unknown>).offScope
  assert.ok(codes(loadVerifyFixtureSet(baseSet([baseCase('1', { scripted: { satisfied: 0.1 } })])).problems).includes('invalid_scripted'))

  const outOfRange = baseCase('2', {
    scripted: {
      criterionTestable: 0.9,
      satisfied: 1.4,
      evidenceSufficiency: 0,
      offScope: 0.05,
      needsDeeperVerification: 0.2,
    },
  })
  assert.ok(codes(loadVerifyFixtureSet(baseSet([outOfRange])).problems).includes('invalid_scripted'))

  // The rubric gate runs 0..2 in level units, not 0..1.
  const tooHigh = baseCase('3', {
    scripted: {
      criterionTestable: 0.9,
      satisfied: 0.1,
      evidenceSufficiency: 2.5,
      offScope: 0.05,
      needsDeeperVerification: 0.2,
    },
  })
  assert.ok(codes(loadVerifyFixtureSet(baseSet([tooHigh])).problems).includes('invalid_scripted'))
})

test('a pass-candidate label is refused while the policy is uncalibrated', () => {
  const loaded = loadVerifyFixtureSet(baseSet([baseCase('1', { expected: 'pass-candidate' })]))
  assert.ok(codes(loaded.problems).includes('positive_label_before_calibration'))
})

test('a calibrated-policy label must be a status and must add information', () => {
  const notAStatus = loadVerifyFixtureSet(
    baseSet([baseCase('1', { expectedUnderCalibratedPolicy: 'yes' })]),
  )
  assert.ok(codes(notAStatus.problems).includes('invalid_status'))

  const redundant = loadVerifyFixtureSet(
    baseSet([baseCase('1', { expectedUnderCalibratedPolicy: 'needs-verification' })]),
  )
  assert.ok(codes(redundant.problems).includes('redundant_calibrated_label'))
})

test('a lexically duplicated criterion is refused, so the suite cannot be padded', () => {
  const loaded = loadVerifyFixtureSet(
    baseSet([
      baseCase('1', { criterion: 'Every response is checked against the request question count.' }),
      baseCase('2', { criterion: 'Every response is checked against the request question count exactly.' }),
    ]),
  )
  assert.ok(codes(loaded.problems).includes('lexical_duplicate_criterion'))
  assert.ok(loaded.problems.some((problem) => problem.detail.includes('ac-1')))
})

test('a lexically duplicated evidence summary is refused too', () => {
  const loaded = loadVerifyFixtureSet(
    baseSet([
      baseCase('1', {
        criterion: 'The retry budget is clamped to three attempts.',
        evidence: { summary: 'Added the response parser, and wired it in.' },
      }),
      baseCase('2', {
        criterion: 'The archive writer refuses to overwrite an existing file.',
        evidence: { summary: 'Added the response parser and wired it in.' },
      }),
    ]),
  )
  assert.ok(codes(loaded.problems).includes('lexical_duplicate_evidence'))
})

test('a duplicated label on unrelated content is NOT a duplicate', () => {
  // Two different criteria may legitimately expect the same status. Only the
  // wording, never the label, is deduplicated.
  const loaded = loadVerifyFixtureSet(
    baseSet([
      baseCase('1', {
        criterion: 'The retry budget is clamped to three attempts.',
        evidence: { summary: 'The loop stops at the configured maximum.' },
      }),
      baseCase('2', {
        criterion: 'The archive writer refuses to overwrite an existing file.',
        evidence: { summary: 'The writer checks that the target path is absent.' },
      }),
    ]),
  )
  assert.deepEqual(codes(loaded.problems), [])
})

test('the evidence structures vary, so the suite does not test one shape only', async () => {
  const loaded = loadVerifyFixtureSet(await readRaw())
  const shapes = new Set<string>()
  for (const entry of loaded.cases) {
    const evidence = entry.evidence as Record<string, unknown> | undefined
    if (evidence === undefined || Object.keys(evidence).length === 0) {
      shapes.add('no-evidence')
      continue
    }
    const diffs = Array.isArray(evidence.diffExcerpts) ? evidence.diffExcerpts.length : 0
    const tests = Array.isArray(evidence.deterministicTestResults)
      ? evidence.deterministicTestResults.length
      : 0
    shapes.add(`diffs-${diffs > 2 ? 'many' : diffs === 0 ? 'none' : 'few'}`)
    shapes.add(`tests-${tests === 0 ? 'none' : tests > 1 ? 'many' : 'one'}`)
    if (typeof evidence.summary === 'string' && evidence.summary.length > 120) shapes.add('long-summary')
  }
  for (const shape of [
    'no-evidence',
    'diffs-none',
    'diffs-few',
    'diffs-many',
    'tests-none',
    'tests-one',
    'tests-many',
    'long-summary',
  ]) {
    assert.ok(shapes.has(shape), `the suite never exercises evidence shape ${shape}`)
  }
})

test('every fixture is traceable to an issue and a criterion id', async () => {
  const loaded = loadVerifyFixtureSet(await readRaw())
  const criterionIds = new Set<string>()
  for (const entry of loaded.cases) {
    assert.match(entry.criterionId, /^ac-\d+$/, entry.id)
    assert.match(entry.issueId, /^#\d+$/, entry.id)
    assert.ok(!criterionIds.has(entry.criterionId), `criterion id reused: ${entry.criterionId}`)
    criterionIds.add(entry.criterionId)
  }
})
