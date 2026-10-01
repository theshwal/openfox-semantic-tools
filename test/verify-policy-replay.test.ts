import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { DEFAULT_POLICY, VERIFY_POLICY_VERSION } from '../src/verify/policy.ts'
import { BASELINE_POLICY_VERSION } from '../scripts/verify-policy-baseline-0.2.1.ts'

const LAYA = 'benchmark/snapshots/verify-0.2.1/laya-report.json'
const KEV = 'benchmark/snapshots/verify-0.2.1/kev-report.json'

/** Runs the real replay script and returns what it persisted plus its exit code. */
async function runReplay(): Promise<{ report: any; stdout: string; exitCode: number }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/verify-policy-replay.ts'], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += String(chunk)))
    child.on('exit', (code) => resolveRun({ report: null, stdout, exitCode: code ?? 1 }))
  })
}

test('the replay is reproducible offline and the frozen baseline reproduces the recorded statuses', async () => {
  const { stdout, exitCode } = await runReplay()
  assert.equal(exitCode, 0, 'a baseline that does not reproduce the recorded statuses must fail the replay')
  const report = JSON.parse(
    await readFile(resolve('benchmark/results/verify/replay.json'), 'utf8'),
  )
  assert.equal(report.mode, 'replay')
  // The invariant of the whole exercise: the frozen 0.2.1 rules, fed the numbers
  // those campaigns recorded, reproduce the statuses those campaigns recorded.
  // Without this the "new" column would prove nothing.
  for (const campaign of report.campaigns) {
    assert.equal(
      campaign.baselineReproducedCount,
      campaign.caseCount,
      `${campaign.path}: ${campaign.baseline.join(',')}`,
    )
  }
  assert.ok(stdout.includes('not a measurement'), 'the replay must refuse to claim a measurement')
})

test('the replay separates the policy change from provider behaviour, and shows its effect', async () => {
  const report = JSON.parse(await readFile(resolve('benchmark/results/verify/replay.json'), 'utf8'))
  assert.equal(report.sourcePolicyVersion, BASELINE_POLICY_VERSION)
  assert.equal(report.currentPolicyVersion, VERIFY_POLICY_VERSION)
  assert.equal(report.measured, false)
  // A replay of arithmetic is not an observation, so no rate is ever stated.
  assert.equal(report.falsePassRate, null)
  assert.match(report.falsePassRateReason, /never reported as zero/i)

  for (const campaign of report.campaigns) {
    assert.equal(campaign.recorded.length, campaign.caseCount)
    // Before the change every live case was `unknown`: the single `unusable`
    // verdict short-circuited and erased every decisive reading.
    assert.deepEqual([...new Set(campaign.recorded)], ['unknown'])
    assert.equal(campaign.positiveCount, 0, 'a replay must not be able to produce a pass')
    for (const entry of campaign.cases) {
      // The values are always reported, whether the answer was committed or not.
      assert.ok(
        Object.values(entry.gateValues).some((value) => typeof value === 'number'),
        `${entry.id} must still report the values it read`,
      )
    }
  }
})

/**
 * The declared confidence the runtime recorded for the rubric answer of each
 * case, read from the campaign report itself. The replay report does not carry
 * it, because the policy treats it as telemetry: the point of these fixtures is
 * that it no longer decides anything.
 */
async function declaredEvidenceConfidence(): Promise<Map<string, number | null>> {
  const byCaseId = new Map<string, number | null>()
  for (const path of [LAYA, KEV]) {
    const raw = JSON.parse(await readFile(resolve(path), 'utf8'))
    for (const entry of raw.cases) {
      const value = entry.observedNumbers.confidence.evidenceSufficiency
      byCaseId.set(`${path}:${entry.id}`, typeof value === 'number' ? value : null)
    }
  }
  return byCaseId
}

test('a hesitant answer is read for what it says, not for how the runtime felt', async () => {
  const report = JSON.parse(await readFile(resolve('benchmark/results/verify/replay.json'), 'utf8'))
  const confidenceByCase = await declaredEvidenceConfidence()
  const hesitant = report.campaigns.flatMap((campaign: any) =>
    campaign.cases.filter((entry: any) => {
      const confidence = confidenceByCase.get(`${campaign.path}:${entry.id}`)
      return typeof confidence === 'number' && confidence < 0.5
    }),
  )
  // Every live case whose rubric answer the runtime declared under the old
  // confidence floor. `verify-0.2.2` called those `low-confidence` and 0.2.1
  // called them `unusable`; both discarded the value and every other gate
  // reading in the same decision. There is no confidence-derived verdict any
  // more, so every one of them is now classified by the rubric gate's own
  // threshold and band.
  assert.ok(hesitant.length >= 10, `only ${hesitant.length} hesitant answers found in the recorded numbers`)
  for (const entry of hesitant) {
    assert.notEqual(entry.gateVerdicts.evidenceSufficiency, 'unusable', entry.id)
    // The expectation is readable and is reported, not dropped.
    assert.equal(typeof entry.gateValues.evidenceSufficiency, 'number', entry.id)
    // Read as a value in [0, 2] on the shared scale of the rubric.
    const value = entry.gateValues.evidenceSufficiency
    assert.ok(value >= 0 && value <= 2, `${entry.id} reported an out-of-range value ${value}`)
    assert.ok(
      ['met', 'unmet', 'undecided'].includes(entry.gateVerdicts.evidenceSufficiency),
      `${entry.id} produced an unexpected verdict ${entry.gateVerdicts.evidenceSufficiency}`,
    )
  }
  // The floor itself is not a boundary: a case whose declared confidence is
  // exactly zero is read by the same rule as one declared at 0.49.
  const zeroConfidenceCases = [...confidenceByCase.entries()].filter(
    ([, confidence]) => confidence === 0,
  )
  assert.ok(zeroConfidenceCases.length > 0, 'the recorded numbers must contain a declared confidence of 0')
  for (const key of zeroConfidenceCases.map(([key]) => key)) {
    const [path, id] = key.split(':')
    const campaign = report.campaigns.find((entry: any) => entry.path === path)
    const entry = campaign?.cases.find((entry: any) => entry.id === id)
    assert.ok(entry, `${key} must be present in the replay report`)
    assert.notEqual(entry.gateVerdicts.evidenceSufficiency, 'unusable', key)
    assert.equal(typeof entry.gateValues.evidenceSufficiency, 'number', key)
  }
})

test('the absence of a confidence verdict is what makes the recorded evidence usable', async () => {
  const report = JSON.parse(await readFile(resolve('benchmark/results/verify/replay.json'), 'utf8'))
  // A single `unusable` verdict used to short-circuit the whole decision, so
  // every recorded case collapsed to `unknown`. Under the shipped policy the
  // only unreadable answer in these reports is the gate those runs never asked.
  const unusableGates = new Set<string>()
  for (const campaign of report.campaigns) {
    for (const entry of campaign.cases) {
      for (const [gate, verdict] of Object.entries(entry.gateVerdicts as Record<string, string>)) {
        if (verdict === 'unusable') unusableGates.add(gate)
      }
    }
  }
  assert.deepEqual(
    [...unusableGates].sort(),
    [...report.gatesNotAskedByTheseRuns].sort(),
    'a gate those runs DID ask must never be unreadable',
  )
})

test('the routing the replay now reaches is a status, never a pass', async () => {
  const report = JSON.parse(await readFile(resolve('benchmark/results/verify/replay.json'), 'utf8'))
  const changed = report.campaigns.flatMap((campaign: any) =>
    campaign.cases.filter((entry: any) => entry.changedOnRecordedGates),
  )
  // The change is observable on the gates the runtime did answer: exactly the
  // cases where a decisive reading was previously discarded now routes on it.
  assert.ok(changed.length > 0, 'the policy change must be visible in the replay')
  for (const entry of changed) {
    assert.notEqual(entry.currentOnRecordedGatesOnly, 'pass-candidate', entry.id)
    // Either a documented risk status, or `unknown` — nothing else is reachable.
    assert.ok(
      ['off-scope', 'insufficient-evidence', 'needs-verification', 'unknown'].includes(
        entry.currentOnRecordedGatesOnly,
      ),
      `${entry.id} routed to an unexpected status ${entry.currentOnRecordedGatesOnly}`,
    )
    // `current` keeps the gate those runs never asked, so the decision is
    // unreadable there and stays `unknown` rather than inventing an answer.
    assert.equal(entry.current, 'unknown', entry.id)
    assert.ok(entry.reasons.includes('answer_unusable'), entry.id)
  }
  // Across the whole replay, no recorded case can produce a pass, not even
  // under a calibrated policy: that is what makes the guarantee real rather
  // than an artefact of the shipped `calibrated: false` setting.
  for (const campaign of report.campaigns) {
    for (const entry of campaign.cases) {
      assert.notEqual(entry.currentUnderCalibratedPolicy, 'pass-candidate', `${campaign.path}:${entry.id}`)
    }
  }
})

test('the shipped gates are untouched by the verdict change', async () => {
  // Removing the confidence verdict must not have moved a single threshold, and
  // the gate added since the campaigns must be declared with its own.
  const gates = DEFAULT_POLICY.gates.map((gate) => ({
    id: gate.id,
    threshold: gate.threshold,
    undecided: gate.undecided,
    range: gate.range,
  }))
  assert.deepEqual(gates, [
    { id: 'criterionTestable', threshold: 0.8, undecided: [0.4, 0.8], range: [0, 1] },
    { id: 'satisfied', threshold: 0.9, undecided: [0.6, 0.9], range: [0, 1] },
    { id: 'evidenceSufficiency', threshold: 1.9, undecided: [1.5, 1.9], range: [0, 2] },
    { id: 'offScope', threshold: 0.2, undecided: [0.2, 0.4], range: [0, 1] },
    { id: 'needsDeeperVerification', threshold: 0.5, undecided: [0.5, 0.8], range: [0, 1] },
  ])
  assert.equal(DEFAULT_POLICY.calibrated, false, 'a new verdict does not enable a pass')
})

test('the recorded campaigns are the ones the replay was written against', async () => {
  for (const path of [LAYA, KEV]) {
    const raw = JSON.parse(await readFile(resolve(path), 'utf8'))
    assert.equal(raw.policyVersion, BASELINE_POLICY_VERSION, path)
    assert.equal(raw.measured, false, path)
    for (const entry of raw.cases) {
      assert.ok(entry.observedNumbers, `${path}:${entry.id} must record its numbers`)
    }
  }
})
