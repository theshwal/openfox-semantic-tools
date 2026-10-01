import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assessProfileFreshness,
  deriveCandidateProfile,
  parseCalibrationOverrides,
  parseCalibrationProfile,
  resolveVerifyPolicy,
  type CalibrationProfile,
} from '../src/calibration/profile.ts'
import { DEFAULT_POLICY } from '../src/verify/policy.ts'

const profile: CalibrationProfile = {
  schemaVersion: 1,
  id: 'kev-test',
  provider: { presetId: 'kev', model: 'kev-4b', runtimeVersion: '1' },
  policyVersion: DEFAULT_POLICY.version,
  testedAt: '2026-10-01T00:00:00.000Z',
  status: 'provisional',
  provenance: 'test',
  active: true,
  calibrated: false,
  gateOverrides: {
    satisfied: { threshold: 0.8, undecided: [0.55, 0.8] },
    offScope: { threshold: 0.3, undecided: [0.3, 0.45] },
  },
}

test('precedence is explicit override > active profile > conservative defaults', () => {
  const resolved = resolveVerifyPolicy(DEFAULT_POLICY, profile, {
    calibrated: true,
    gates: { satisfied: { threshold: 0.75 } },
  })
  const satisfied = resolved.gates.find((gate) => gate.id === 'satisfied')!
  const offScope = resolved.gates.find((gate) => gate.id === 'offScope')!
  const criterion = resolved.gates.find((gate) => gate.id === 'criterionTestable')!

  assert.equal(satisfied.threshold, 0.75, 'explicit override wins')
  assert.deepEqual(satisfied.undecided, [0.55, 0.75], 'profile supplies the low edge while the explicit threshold remains the decisive edge')
  assert.equal(offScope.threshold, 0.3, 'profile overrides the default')
  assert.equal(criterion.threshold, DEFAULT_POLICY.gates.find((gate) => gate.id === 'criterionTestable')!.threshold)
  assert.equal(resolved.calibrated, true)
})

test('inactive or absent profiles never change the conservative defaults', () => {
  assert.deepEqual(resolveVerifyPolicy(DEFAULT_POLICY, null), DEFAULT_POLICY)
  assert.deepEqual(resolveVerifyPolicy(DEFAULT_POLICY, { ...profile, active: false }), DEFAULT_POLICY)
})

test('profile freshness is visible for provider/model/version drift', () => {
  assert.equal(
    assessProfileFreshness(profile, { presetId: 'kev', model: 'kev-4b', runtimeVersion: '1', policyVersion: DEFAULT_POLICY.version }),
    'matched',
  )
  assert.equal(
    assessProfileFreshness(profile, { presetId: 'laya', model: 'kev-4b', runtimeVersion: '1', policyVersion: DEFAULT_POLICY.version }),
    'stale',
  )
  assert.equal(
    assessProfileFreshness(profile, { presetId: 'kev', model: 'kev-9b', runtimeVersion: '1', policyVersion: DEFAULT_POLICY.version }),
    'stale',
  )
  assert.equal(
    assessProfileFreshness(profile, { presetId: 'kev', model: 'kev-4b', policyVersion: DEFAULT_POLICY.version }),
    'unverified',
  )
  assert.equal(
    assessProfileFreshness(profile, { presetId: 'kev', model: 'kev-4b', runtimeVersion: '1', policyVersion: 'verify-future' }),
    'stale',
  )
})

test('JSON import rejects unknown gates and round-trips a valid profile', () => {
  assert.deepEqual(parseCalibrationProfile(JSON.stringify(profile)), profile)
  assert.throws(
    () => parseCalibrationProfile(JSON.stringify({ ...profile, gateOverrides: { nope: { threshold: 1 } } })),
    /Unknown calibration gate/,
  )
  assert.deepEqual(
    parseCalibrationOverrides(JSON.stringify({ calibrated: true, gates: { satisfied: { threshold: 0.7 } } })),
    { calibrated: true, gates: { satisfied: { threshold: 0.7 } } },
  )
})

test('a user-labelled set yields an inactive observation-only candidate', () => {
  const gates = {
    criterionTestable: 0.8,
    satisfied: 0.7,
    evidenceSufficiency: 1.2,
    offScope: 0.3,
    needsDeeperVerification: 0.6,
  }
  const candidate = deriveCandidateProfile({
    id: 'mine',
    provider: { presetId: 'custom', model: 'm' },
    policyVersion: DEFAULT_POLICY.version,
    testedAt: '2026-10-01T00:00:00.000Z',
    cases: [
      { id: 'a', expectedStatus: 'unknown', gates },
      {
        id: 'b',
        expectedStatus: 'needs-verification',
        gates: { ...gates, satisfied: 0.5, offScope: 0.4 },
      },
    ],
  })

  assert.equal(candidate.status, 'user-calibrated')
  assert.equal(candidate.active, false)
  assert.equal(candidate.calibrated, false)
  assert.equal(candidate.gateOverrides, undefined, 'derivation must not invent thresholds')
  assert.deepEqual(candidate.gateObservations?.satisfied, {
    min: 0.5,
    max: 0.7,
    median: 0.6,
    count: 2,
  })
})
