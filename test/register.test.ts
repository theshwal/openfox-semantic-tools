import assert from 'node:assert/strict'
import test from 'node:test'

import { register, SETTINGS } from '../src/index.ts'
import { parseSettings } from '../src/settings.ts'
import { ProviderError } from '../src/errors.ts'
import { DEFAULT_BACKEND_ID, PRESETS } from '../src/presets/index.ts'
import { fakeRegistry } from './helpers/registry.ts'

test('registers the initial settings schema', () => {
  const { registry, tools, settings } = fakeRegistry()
  register(registry)

  assert.equal(settings.length, 1)
  assert.equal(settings[0], SETTINGS)
  assert.deepEqual([...tools.keys()].sort(), [
    'semantic_calibration_candidate',
    'semantic_decide',
    'semantic_issue_coverage',
    'semantic_provider_self_test',
    'semantic_question_calibration',
    'semantic_reference_agreement',
    'semantic_scan',
    'semantic_search',
    'semantic_verify_task',
  ])

  const keys = SETTINGS.fields.map((field) => field.key)
  assert.deepEqual(keys, [
    'backend',
    'endpoint',
    'model',
    'runtimeVersion',
    'calibrationProfileJson',
    'calibrationOverridesJson',
    'apiKey',
    'timeoutMs',
    'endpointClass',
    'egressPolicy',
    'cacheEnabled',
    'cacheTtlMs',
    'cacheMaxEntries',
  ])
})

test('the decision cache is off by default and configurable', () => {
  const enabled = SETTINGS.fields.find((field) => field.key === 'cacheEnabled')
  assert.equal(enabled?.type, 'boolean')
  assert.equal(enabled?.default, false, 'caching must be a deliberate choice')

  const parse = (values: Record<string, unknown>) =>
    parseSettings({ endpoint: 'http://localhost/v1/systemone', ...values })
  const defaults = parse({})
  assert.equal(defaults.cache?.enabled, false)
  assert.equal(defaults.cache?.ttlMs, 300_000)
  assert.equal(defaults.cache?.maxEntries, 128)

  assert.equal(parse({ cacheEnabled: true }).cache?.enabled, true)
  // A zero TTL disables reuse without disabling the setting itself.
  assert.equal(parse({ cacheEnabled: true, cacheTtlMs: 0 }).cache?.ttlMs, 0)
  for (const invalid of [{ cacheTtlMs: -1 }, { cacheTtlMs: 1.5 }, { cacheMaxEntries: 0 }, { cacheMaxEntries: 999_999 }]) {
    assert.throws(() => parse(invalid), ProviderError, JSON.stringify(invalid))
  }
})

test('exposes data-egress controls and keeps the api key secret', () => {
  const endpointClass = SETTINGS.fields.find((field) => field.key === 'endpointClass')
  const egressPolicy = SETTINGS.fields.find((field) => field.key === 'egressPolicy')
  assert.deepEqual(
    endpointClass?.options?.map((option) => option.value),
    ['auto', 'local', 'private', 'remote'],
  )
  assert.deepEqual(
    egressPolicy?.options?.map((option) => option.value),
    ['allow', 'block-remote-automatic', 'block-remote-all'],
  )
  assert.equal(egressPolicy?.default, 'allow')
  const apiKey = SETTINGS.fields.find((field) => field.key === 'apiKey')
  assert.equal(apiKey?.secret, true)
})

test('the backend selector is driven by the presets and custom stays default', () => {
  const backend = SETTINGS.fields.find((field) => field.key === 'backend')
  assert.deepEqual(
    backend?.options?.map((option) => option.value),
    PRESETS.map((preset) => preset.id),
  )
  assert.equal(backend?.default, DEFAULT_BACKEND_ID, 'a custom endpoint must remain the default')
  // The endpoint stays required: a preset never supplies a host.
  const endpoint = SETTINGS.fields.find((field) => field.key === 'endpoint')
  assert.equal(endpoint?.default, '')
})

test('uses global configured credentials even in project sessions', async () => {
  const { registry, tools, settingsCalls } = fakeRegistry()
  register(registry)
  const result = await tools.get('semantic_decide')!.execute(
    { state: 'x', questions: { q: { type: 'noul', instructions: 'Check' } } },
    { sessionId: 's', workdir: '/tmp', projectId: 'p' },
  )
  assert.equal(result.success, false)
  assert.ok(settingsCalls.length > 0)
  for (const scope of settingsCalls) assert.equal(scope, 'global')
})

test('every semantic tool reads global settings only', async () => {
  const { registry, tools, settingsCalls } = fakeRegistry()
  register(registry)
  // The discovery tools read files before they build a provider, so the call
  // needs a readable candidate; the endpoint stays unset so the failure happens
  // at settings parsing, which is what proves the global scope was consulted.
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'semantic-settings-'))
  await writeFile(join(root, 'a.ts'), 'export const a = 1\n')

  const validArgs: Record<string, Record<string, unknown>> = {
    semantic_decide: { state: 'public', questions: { q: { type: 'noul', instructions: 'Check' } } },
    semantic_verify_task: { criterionId: 'ac-1', criterion: 'A criterion' },
    semantic_issue_coverage: { criteria: [{ id: 'ac-1', text: 'A criterion' }] },
    semantic_provider_self_test: {},
    semantic_question_calibration: {
      question: { type: 'noul', instructions: 'Check' },
      cases: [{ id: 'a', state: 'public', expected: true }],
    },
    semantic_search: { query: 'x', candidates: ['a.ts'], root },
    semantic_scan: { predicate: 'x', candidates: ['a.ts'], root },
  }
  for (const name of ['semantic_decide', 'semantic_verify_task', 'semantic_issue_coverage', 'semantic_provider_self_test', 'semantic_question_calibration', 'semantic_search', 'semantic_scan']) {
    settingsCalls.length = 0
    // Endpoint is unset, so the call fails during settings parsing. That is the
    // point: it proves the tool consulted the global scope, not a project one.
    await tools.get(name)!.execute(validArgs[name], {
      sessionId: 's',
      workdir: '/tmp',
      projectId: 'p',
    })
    assert.ok(settingsCalls.length > 0, `${name} must read settings`)
    for (const scope of settingsCalls) assert.equal(scope, 'global', `${name} must use the global scope`)
  }
})
