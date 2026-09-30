import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { register } from '../src/index.ts'
import { SKILL_SOURCE, SKILL_SOURCE_ID, SEMANTIC_VERIFICATION_SKILL } from '../src/skills/source.ts'
import { fakeRegistry } from './helpers/registry.ts'

async function loadedSkills() {
  return await SKILL_SOURCE.load()
}

test('the skill source is registered through the public plugin API', () => {
  const { registry, skillSources } = fakeRegistry()
  register(registry)

  assert.equal(skillSources.length, 1)
  assert.equal(skillSources[0].id, SKILL_SOURCE_ID)
  assert.deepEqual(skillSources[0].label, { en: 'Semantic tools', fr: 'Outils sémantiques' })
})

test('skill registration never reads settings or performs a request', async () => {
  // A provider must be available for the tool, yet loading the skills must work
  // with no endpoint, no key and no network at all.
  const { registry, settingsCalls } = fakeRegistry()
  register(registry)
  assert.equal(settingsCalls.length, 0, 'registration must not consult settings')
  assert.equal((await SKILL_SOURCE.load()).length, 2)
})

test('the verification skill is discoverable with concise metadata', async () => {
  const skills = await loadedSkills()
  const found = skills.find((skill) => skill.id === 'semantic-verification')
  assert.ok(found, 'semantic-verification must be listed')
  assert.equal(found.name, 'Semantic verification')
  // The description sits in the permanent prompt: it must stay short.
  assert.ok(found.description.length <= 200, `description is ${found.description.length} chars`)
  assert.ok(found.prompt.length > found.description.length * 2, 'detail must load on demand only')
})

test('the discovery skill is published now that its tools exist', async () => {
  const skills = await loadedSkills()
  const found = skills.find((skill) => skill.id === 'semantic-code-discovery')
  assert.ok(found, 'semantic-code-discovery must ship with the discovery tools')
  assert.equal(found.name, 'Semantic code discovery')
  // The description sits in the permanent prompt: it must stay short.
  assert.ok(found.description.length <= 200, `description is ${found.description.length} chars`)
  // Detail must load on demand only, so the prompt carries substantially more.
  assert.ok(found.prompt.length > found.description.length * 2)
  // The prompt is prose and is reviewed by a human: only its non-negotiable
  // commitments are asserted here, never its exact wording.
  assert.ok(found.prompt.includes('semantic_search') && found.prompt.includes('semantic_scan'))
  assert.ok(found.prompt.includes('allowed tools'))
  assert.ok(found.prompt.includes('CANDIDATES') || found.prompt.includes('candidates'))
})

test('the skill teaches when NOT to use the tool and how to fall back', () => {
  const prompt = SEMANTIC_VERIFICATION_SKILL.prompt
  assert.match(prompt, /When NOT to use it/)
  assert.match(prompt, /tests, typechecks or linters/)
  assert.match(prompt, /human review/)
  assert.match(prompt, /normal\s+verification path|normal verifier/i)
  assert.match(prompt, /allowedTools|never grants?|does not grant/i)
})

test('the skill documents every status the tool can return', () => {
  const prompt = SEMANTIC_VERIFICATION_SKILL.prompt
  for (const status of ['unknown', 'needs-verification', 'insufficient-evidence', 'off-scope', 'pass-candidate']) {
    assert.ok(prompt.includes(status), `status ${status} must be documented`)
  }
  assert.match(prompt, /never means the task is complete/i)
})

test('the skill is provider-neutral: no provider, endpoint, URL or model id', () => {
  const text = `${SEMANTIC_VERIFICATION_SKILL.name} ${SEMANTIC_VERIFICATION_SKILL.description} ${SEMANTIC_VERIFICATION_SKILL.prompt}`
  const forbidden = [
    'jev',
    'Jev',
    'JEV',
    'kev',
    'laya',
    'system-one',
    'systemone',
    '/v1/',
    'http://',
    'https://',
    'api.',
    'localhost',
    'endpoint:',
    'Authorization',
    'Bearer',
  ]
  for (const term of forbidden) {
    assert.ok(!text.includes(term), `skill guidance must not mention "${term}"`)
  }
})

test('the skill does not hard-code thresholds without evidence', () => {
  const prompt = SEMANTIC_VERIFICATION_SKILL.prompt
  // Policy numbers live in the versioned policy module, not in prompt prose.
  assert.ok(!/\b0\.\d{2,}\b/.test(prompt), 'no numeric threshold may appear in the skill')
  assert.match(prompt, /not currently reachable/i)
})

test('the manifest declares the skills capability exactly once', async () => {
  const manifest = JSON.parse(
    await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8'),
  ) as { openfox: { apiVersion: number; capabilities: string[] } }
  const skillCount = manifest.openfox.capabilities.filter((capability) => capability === 'skills').length
  assert.equal(skillCount, 1, 'skills capability must be declared once')
  assert.ok(manifest.openfox.capabilities.includes('tools'))
  assert.equal(manifest.openfox.apiVersion, 2)
})
