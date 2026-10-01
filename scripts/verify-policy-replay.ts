// Offline replay of the OBSERVED numbers recorded by the two live verify-0.2.1
// campaigns, under the policy as it stands. It performs NO network call and
// needs NO credential.
//
// Purpose: the live reports recorded `observed` statuses but not which policy
// reading produced them, so a change to the verdict vocabulary could not be
// separated from a change in provider behaviour. This script takes the numbers
// that ARE recorded (gate values, probabilities, confidence, scores), rebuilds
// the exact answer set the transport would have normalized, and evaluates it
// under BOTH policies:
//
//   - `baseline`: the frozen `verify-0.2.1` rules, which must reproduce the
//     status the live run recorded. If it does not, the replay is invalid and
//     its "new" column means nothing.
//   - `current`: the shipped policy, whose verdict vocabulary and routing are
//     the change under review.
//
// The replay is only a re-derivation: it is NOT a measurement, so it never
// writes a rate, never claims a false-pass count, and cannot promote a policy.
// The labels it compares against are the ones already recorded in the campaign
// reports; this script reads them and never edits them.
//
// Usage:
// The two recorded campaigns are committed as sanitized number-only snapshots
// under `benchmark/snapshots/verify-0.2.1/`, so the replay runs on a clean
// clone. They are trimmed to exactly what a re-derivation reads: the observed
// status, the reasons, and the numbers. No state, no evidence, no criterion
// text, no endpoint, no credential.
//
//   npm run verify:replay                     # both recorded campaigns
//   npm run verify:replay -- benchmark/results/verify/laya/report.json
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { DEFAULT_POLICY, evaluateVerifyPolicy, type GateId, type GateVerdict, type VerifyStatus } from '../src/verify/policy.ts'
import { BASELINE_POLICY_VERSION, evaluateBaselinePolicy } from './verify-policy-baseline-0.2.1.ts'

/**
 * Gates the recorded campaigns never asked. A replay must not invent an answer
 * for them, so the effect of the precedence change is measured on the gates the
 * runtime did answer.
 */
const GATES_ADDED_AFTER_THE_CAMPAIGN = new Set<GateId>(['criterionTestable'])

interface ObservedNumbers {
  provider: string
  model: string | null
  gateValues: Record<string, number | null>
  probabilities: Record<string, Record<string, number>>
  confidence: Record<string, number | null>
  scores: Record<string, number | null>
}

interface CampaignCase {
  id: string
  expected: VerifyStatus
  expectedUnderCalibratedPolicy: VerifyStatus | null
  observed: VerifyStatus
  reasons: string[]
  observedNumbers?: ObservedNumbers
}

interface CampaignReport {
  policyVersion: string
  cases: CampaignCase[]
}

const DEFAULT_CAMPAIGNS = [
  'benchmark/snapshots/verify-0.2.1/laya-report.json',
  'benchmark/snapshots/verify-0.2.1/kev-report.json',
] as const

const args = process.argv.slice(2)
const paths = args.length > 0 ? args : [...DEFAULT_CAMPAIGNS]

/**
 * Rebuilds the answer set the provider adapter would have produced.
 *
 * The recorded numbers are exactly what the transport normalized: a `score`
 * answer for the rubric gate with its distribution and its declared confidence,
 * a `noul` probability for the rest. A gate with no recorded score is a `noul`
 * answer, which is what the runtime returned for those three questions.
 *
 * Nothing is invented: a missing number stays missing, so the policy still sees
 * the same absence it saw live and must reject it the same way.
 */
function rebuildAnswers(numbers: ObservedNumbers): Record<string, unknown> {
  const answers: Record<string, unknown> = {}
  for (const [id, value] of Object.entries(numbers.gateValues)) {
    if (typeof value !== 'number') continue
    const score = numbers.scores[id]
    const probabilities = numbers.probabilities[id]
    const confidence = numbers.confidence[id]
    if (typeof score === 'number' && probabilities) {
      answers[id] = {
        type: 'score',
        score,
        probabilities,
        ...(typeof confidence === 'number' ? { confidence } : {}),
      }
    } else {
      answers[id] = {
        type: 'noul',
        probability: value,
        ...(typeof confidence === 'number' ? { confidence } : {}),
      }
    }
  }
  return answers
}

interface ReplayCase {
  id: string
  recorded: VerifyStatus
  baseline: VerifyStatus
  current: VerifyStatus
  /**
   * The same recorded answers, read by a policy declaring ONLY the four gates
   * the campaigns covered. This isolates the effect of the routing change from
   * the effect of a gate those runs never asked.
   */
  currentOnRecordedGatesOnly: VerifyStatus
  currentUnderCalibratedPolicy: VerifyStatus
  expected: VerifyStatus
  gateVerdicts: Record<string, GateVerdict>
  gateValues: Record<string, number | null>
  reasons: string[]
  /** The frozen 0.2.1 rules reproduce the status the live run recorded. */
  baselineReproducesRecorded: boolean
  /** The shipped policy changes the status relative to the baseline. */
  changedByPolicy: boolean
  /** ...and changes it on the gates those runs actually answered. */
  changedOnRecordedGates: boolean
  matched: boolean
  matchedUnderCalibratedPolicy: boolean | null
}

interface ReplayCampaign {
  path: string
  provider: string
  model: string | null
  caseCount: number
  /** Statuses recorded by the live run, in case order. */
  recorded: VerifyStatus[]
  /** The same numbers under the frozen verify-0.2.1 rules. */
  baseline: VerifyStatus[]
  /** The same numbers under the shipped policy. */
  current: VerifyStatus[]
  /** ...restricted to the gates those runs answered. */
  currentOnRecordedGatesOnly: VerifyStatus[]
  baselineReproducedCount: number
  matched: number
  nonUnknownCount: number
  nonUnknownOnRecordedGatesCount: number
  positiveCount: number
  cases: ReplayCase[]
}

const campaigns: ReplayCampaign[] = []

for (const path of paths) {
  const file = resolve(path)
  const raw = JSON.parse(await readFile(file, 'utf8')) as CampaignReport
  if (raw.policyVersion !== BASELINE_POLICY_VERSION) {
    throw new Error(`${path}: recorded under ${raw.policyVersion}, not ${BASELINE_POLICY_VERSION}`)
  }
  const cases: ReplayCase[] = []

  for (const entry of raw.cases) {
    const numbers = entry.observedNumbers
    if (!numbers) {
      throw new Error(`${path}:${entry.id} has no observedNumbers; a live campaign report is required for a replay`)
    }
    const answers = rebuildAnswers(numbers)
    // Those campaigns were recorded with the four questions shipped at the
    // time. `criterionTestable` did not exist yet, so no answer for it was
    // ever recorded. The replay therefore evaluates twice, and never
    // substitutes a value the runtime never gave:
    //
    //   - `current`: the four recorded answers, exactly as observed. The gate
    //     added since is simply absent, which the policy reads as unusable.
    //   - `currentWithoutNewGates`: the four recorded answers read by a policy
    //     that declares only the four gates they cover, which is the only way
    //     to see what the change did to the SAME evidence.
    const withoutNewGates = {
      ...DEFAULT_POLICY,
      gates: DEFAULT_POLICY.gates.filter((gate) => !GATES_ADDED_AFTER_THE_CAMPAIGN.has(gate.id)),
    }
    const baseline = evaluateBaselinePolicy(answers, DEFAULT_POLICY)
    const decision = evaluateVerifyPolicy(answers, DEFAULT_POLICY)
    const onRecordedGatesOnly = evaluateVerifyPolicy(answers, withoutNewGates)
    const calibrated = evaluateVerifyPolicy(answers, { ...DEFAULT_POLICY, calibrated: true })
    const gateVerdicts: Record<string, GateVerdict> = {}
    for (const gate of decision.gates) gateVerdicts[gate.id] = gate.verdict

    cases.push({
      id: entry.id,
      recorded: entry.observed,
      baseline: baseline.status,
      current: decision.status,
      currentOnRecordedGatesOnly: onRecordedGatesOnly.status,
      currentUnderCalibratedPolicy: calibrated.status,
      expected: entry.expected,
      gateVerdicts,
      gateValues: Object.fromEntries(decision.gates.map((gate) => [gate.id, gate.value])),
      reasons: [...decision.reasons],
      baselineReproducesRecorded: baseline.status === entry.observed,
      changedByPolicy: decision.status !== baseline.status,
      changedOnRecordedGates: onRecordedGatesOnly.status !== baseline.status,
      matched: decision.status === entry.expected,
      matchedUnderCalibratedPolicy:
        entry.expectedUnderCalibratedPolicy === null
          ? null
          : calibrated.status === entry.expectedUnderCalibratedPolicy,
    })
  }

  campaigns.push({
    path,
    provider: raw.cases[0]?.observedNumbers?.provider ?? 'unknown',
    model: raw.cases[0]?.observedNumbers?.model ?? null,
    caseCount: cases.length,
    recorded: cases.map((entry) => entry.recorded),
    baseline: cases.map((entry) => entry.baseline),
    current: cases.map((entry) => entry.current),
    currentOnRecordedGatesOnly: cases.map((entry) => entry.currentOnRecordedGatesOnly),
    baselineReproducedCount: cases.filter((entry) => entry.baselineReproducesRecorded).length,
    matched: cases.filter((entry) => entry.matched).length,
    nonUnknownCount: cases.filter((entry) => entry.current !== 'unknown').length,
    nonUnknownOnRecordedGatesCount: cases.filter((entry) => entry.currentOnRecordedGatesOnly !== 'unknown')
      .length,
    positiveCount: cases.filter((entry) => entry.current === 'pass-candidate').length,
    cases,
  })
}

const report = {
  schemaVersion: 1,
  mode: 'replay',
  measured: false,
  scope:
    'Offline re-derivation of the recorded live numbers under the frozen verify-0.2.1 rules and under the shipped policy. Not a provider measurement, not a new live run, and not a false-pass rate.',
  sourcePolicyVersion: BASELINE_POLICY_VERSION,
  currentPolicyVersion: DEFAULT_POLICY.version,
  calibratedPolicyApplied: true,
  gatesNotAskedByTheseRuns: [...GATES_ADDED_AFTER_THE_CAMPAIGN],
  gatesNotAskedReason:
    'Those campaigns predate the gate, so no answer for it was ever recorded. The replay never substitutes a value: `current` reads the gate as absent, and `currentOnRecordedGatesOnly` measures the routing change on the gates the runtime did answer.',
  falsePassRate: null,
  falsePassRateReason:
    'A replay of recorded numbers is arithmetic, not inference. It cannot observe a false pass, so the rate stays null and is never reported as zero.',
  campaigns,
}

const OUTPUT_PATH = resolve('benchmark/results/verify/replay.json')
// `benchmark/results/` is ignored on purpose, so it does not exist on a clean
// clone. The replay has to create its own output directory rather than assume a
// previous live run left it behind.
await mkdir(dirname(OUTPUT_PATH), { recursive: true })
await writeFile(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`)

let invalid = false
for (const campaign of campaigns) {
  const reproduced = campaign.baselineReproducedCount === campaign.caseCount
  if (!reproduced) invalid = true
  console.log(
    `${campaign.path} (${campaign.model ?? 'unknown model'}): ` +
      `baseline ${campaign.baselineReproducedCount}/${campaign.caseCount} reproduce the recorded status; ` +
      `matched ${campaign.matched}/${campaign.caseCount}; ` +
      `${campaign.nonUnknownCount} non-unknown (${campaign.nonUnknownOnRecordedGatesCount} on the recorded gates); ` +
      `${campaign.positiveCount} positive.`,
  )
  for (const entry of campaign.cases) {
    console.log(
      `  ${entry.id}: recorded=${entry.recorded} baseline=${entry.baseline} current=${entry.current} ` +
        `onRecordedGates=${entry.currentOnRecordedGatesOnly} expected=${entry.expected}` +
        `${entry.baselineReproducesRecorded ? '' : ' (BASELINE REPRODUCTION MISMATCH)'}` +
        `${entry.changedOnRecordedGates ? ' [changed]' : ''}`,
    )
  }
}
console.log('Replay is arithmetic on recorded numbers, not a measurement. No rate is claimed.')
if (invalid) {
  console.error('The frozen baseline does not reproduce the recorded statuses: the replay is invalid.')
  process.exitCode = 1
}
