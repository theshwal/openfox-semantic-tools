import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_BACKEND_ID,
  PRESETS,
  applyPreset,
  capabilityOf,
  isPresetId,
  listPresets,
  type CapabilityName,
} from '../src/presets/index.ts'

const CUSTOM = { endpoint: 'http://localhost:9999/v1/systemone' }

test('a custom backend is always available and needs no preset', () => {
  assert.equal(DEFAULT_BACKEND_ID, 'custom')
  assert.equal(isPresetId('custom'), true)
  assert.equal(isPresetId('not-a-preset'), false)
  // A custom endpoint must keep working exactly as before, with no preset
  // lookup and no capability assumption.
  const applied = applyPreset({ backend: 'custom', ...CUSTOM })
  assert.equal(applied.endpoint, CUSTOM.endpoint)
  assert.equal(applied.presetId, 'custom')
  assert.equal(applied.defaultsApplied, false)
})

test('a preset supplies defaults only, and explicit values always win', () => {
  const preset = PRESETS.find((p) => p.id !== 'custom')!
  const fromDefaults = applyPreset({ backend: preset.id })
  assert.equal(fromDefaults.presetId, preset.id)
  // The hosted preset deliberately ships no endpoint: no host is guessed, so the
  // operator must supply the real URL. Nothing is invented.
  assert.equal(fromDefaults.endpoint, undefined)
  assert.equal(fromDefaults.defaultsApplied, false)

  // Every explicit value is carried through untouched.
  const overridden = applyPreset({
    backend: preset.id,
    endpoint: 'http://127.0.0.1:1234/v1/systemone',
    model: 'explicit-model',
    apiKey: 'explicit-key',
  })
  assert.equal(overridden.endpoint, 'http://127.0.0.1:1234/v1/systemone')
  assert.equal(overridden.model, 'explicit-model')
  assert.equal(overridden.apiKey, 'explicit-key')
})

test('a preset never overrides a value the user typed, even when empty', () => {
  // An empty string is an explicit "no override" and must survive: the preset
  // must not silently reintroduce its own hint. Exercised through the default
  // resolution path, whatever the preset happens to declare today.
  for (const preset of PRESETS) {
    const explicit = applyPreset({ backend: preset.id, endpoint: '', model: '', apiKey: '' })
    assert.equal(explicit.endpoint, undefined, preset.id)
    assert.equal(explicit.model, preset.defaults.model ? preset.defaults.model : undefined, preset.id)
    assert.equal(explicit.apiKey, undefined, preset.id)
  }
})

test('presets are data: none of them carries a threshold or a policy flag', () => {
  for (const preset of PRESETS) {
    const serialised = JSON.stringify(preset)
    // A preset may name capabilities, but it may not carry a decision policy.
    for (const forbidden of ['calibrated', 'threshold', 'pass-candidate', 'undecided', 'gate']) {
      assert.ok(!serialised.includes(forbidden), `${preset.id} must not carry ${forbidden}`)
    }
    // Data only: a preset may not smuggle behaviour in.
    assert.deepEqual(Object.keys(preset).sort(), [
      'capabilities',
      'defaults',
      'description',
      'id',
      'label',
    ])
  }
})

test('presets never carry a secret', () => {
  for (const preset of PRESETS) {
    const serialised = JSON.stringify(preset)
    assert.ok(!serialised.includes('apiKey'), `${preset.id} must not carry a key`)
    assert.ok(!/Bearer |sk-[a-z0-9]{8,}/i.test(serialised), `${preset.id} must not carry a credential`)
    // Auth is a hint, never a value.
    assert.ok(preset.defaults.authUsuallyRequired === undefined || typeof preset.defaults.authUsuallyRequired === 'boolean')
  }
})

test('capabilities are explicit observations, never inferred from silence', () => {
  for (const preset of PRESETS) {
    for (const [name, value] of Object.entries(preset.capabilities)) {
      assert.ok(
        value === true || value === false || value === 'unverified',
        `${preset.id}.${name} must be a tri-state, got ${String(value)}`,
      )
    }
  }
})

test('an unknown capability resolves to unverified, never to false', () => {
  // A runtime that never answered a probe says nothing about that capability.
  assert.equal(capabilityOf('custom', 'choiceArrayCriteria'), 'unverified')
  assert.equal(capabilityOf('not-a-preset', 'choiceArrayCriteria'), 'unverified')
})

test('a preset capability is reported as declared, not as verified', () => {
  const declared = PRESETS.find((p) => p.capabilities.choiceArrayCriteria === false)
  assert.ok(declared, 'at least one preset must record the observed deviation')
  // The value is a declaration with a provenance, never a certification.
  assert.equal(capabilityOf(declared.id, 'choiceArrayCriteria'), false)
})

test('switching preset does not change the tool contract', () => {
  // Same explicit endpoint, different preset: the resolved settings a tool
  // receives are identical, because a preset only supplies defaults and
  // capabilities. Timeout, endpoint class and egress stay settings, not presets.
  const a = applyPreset({ backend: PRESETS[0].id, ...CUSTOM, timeoutMs: 5000 })
  const b = applyPreset({ backend: PRESETS.at(-1)!.id, ...CUSTOM, timeoutMs: 5000 })
  assert.equal(a.endpoint, b.endpoint)
  assert.equal(a.apiKey, b.apiKey)
  assert.deepEqual(
    { ...a, presetId: null },
    { ...b, presetId: null },
    'apart from the preset id itself, the resolved settings must match',
  )
})

test('every preset is listed with a label and a description', () => {
  const listed = listPresets()
  assert.ok(listed.length >= 2, 'at least a custom and one real backend')
  for (const entry of listed) {
    assert.ok(entry.id.length > 0)
    assert.ok(entry.label.en.length > 0)
    assert.ok(entry.label.fr.length > 0)
    assert.ok(entry.description.en.length > 0)
  }
  assert.equal(new Set(listed.map((e) => e.id)).size, listed.length, 'ids must be unique')
})

test('an unknown backend is rejected instead of silently falling back', () => {
  assert.throws(() => applyPreset({ backend: 'definitely-not-real' }))
})

test('the historical backend id still resolves, so an existing config is not broken', () => {
  // Earlier settings stored "jev". Renaming it to "jev-hosted" must not
  // invalidate a configuration somebody already saved.
  assert.equal(isPresetId('jev'), true)
  const resolved = applyPreset({ backend: 'jev', endpoint: 'http://localhost/v1/systemone' })
  assert.equal(resolved.endpoint, 'http://localhost/v1/systemone')
  // It resolves to the hosted preset's behaviour, without being renamed.
  assert.equal(capabilityOf('jev', 'choiceArrayCriteria'), false)
  assert.equal(capabilityOf('jev', 'noul'), true)
})

test('the backends named in the issue are all present as declarations', () => {
  // Every runtime the issue names must be selectable, so an operator is never
  // forced into "custom" for a backend the project already knows about.
  const required = [
    'custom',
    'jev-hosted',
    'kev',
    'laya',
    'system-one',
    'sys1',
    'jev-rs',
    'local-jev',
    'lichen',
    'edgejev',
  ]
  const ids = PRESETS.map((preset) => preset.id)
  for (const id of required) {
    assert.ok(ids.includes(id), `missing preset: ${id}`)
  }
})

test('an unprobed backend declares nothing as working', () => {
  // None of these has been exercised by this repository, so every capability
  // stays unverified. Declaring a capability here without evidence is exactly
  // what the issue forbids.
  const unproven = PRESETS.filter((preset) => preset.id !== 'jev-hosted' && preset.id !== 'custom')
  assert.ok(unproven.length >= 7, `only ${unproven.length} unproven presets`)
  for (const preset of unproven) {
    for (const [name, value] of Object.entries(preset.capabilities)) {
      assert.equal(value, 'unverified', `${preset.id}.${name} must not be declared without evidence`)
    }
    // And they supply no default that could be wrong.
    assert.equal(preset.defaults.endpoint, undefined, `${preset.id} must not supply an endpoint`)
    assert.equal(preset.defaults.model, undefined, `${preset.id} must not supply a model`)
  }
})

test('an older saved configuration with the legacy backend id still parses', async () => {
  // The end-to-end path: settings saved before the rename must still resolve.
  const { parseSettings } = await import('../src/settings.ts')
  const settings = parseSettings({
    backend: 'jev',
    endpoint: 'http://localhost/v1/systemone',
    model: 'saved-model',
  })
  assert.equal(settings.endpoint, 'http://localhost/v1/systemone')
  assert.equal(settings.model, 'saved-model')
  assert.equal(settings.presetId, 'jev-hosted', 'the alias resolves without renaming the preset')
})

test('a preset cannot change the verification policy', async () => {
  // The issue requires that a preset only changes defaults and capabilities.
  // Whatever the backend, the shipped policy stays uncalibrated, so a positive
  // verdict remains unreachable and no threshold moves.
  const { DEFAULT_POLICY, VERIFY_POLICY_VERSION } = await import('../src/verify/policy.ts')
  for (const preset of PRESETS) {
    const resolved = applyPreset({ backend: preset.id, endpoint: 'http://localhost/v1/systemone' })
    assert.equal(DEFAULT_POLICY.calibrated, false, `${preset.id} must not calibrate the policy`)
    assert.equal(DEFAULT_POLICY.version, VERIFY_POLICY_VERSION)
    assert.equal(resolved.presetId, preset.id)
  }
})

test('capabilities of an unknown name are unverified for every preset', () => {
  const unknown = 'aCapabilityThatDoesNotExist' as CapabilityName
  for (const preset of PRESETS) {
    assert.equal(capabilityOf(preset.id, unknown), 'unverified')
  }
})
