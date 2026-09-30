import assert from 'node:assert/strict'
import test from 'node:test'

import { SKILL_SOURCE } from '../src/skills/source.ts'
import type { PluginSkill, PluginSkillSource } from 'openfox/plugin'

/**
 * Guards the compatibility claim made in the docs: `registerSkillSource` must be
 * part of the released Plugin API v2 baseline, otherwise this lot would need a
 * minimum-version bump that has not been requested.
 *
 * The expected upstream shape is pinned here rather than fetched, so the test
 * stays offline and deterministic. If upstream ever changes the contract, this
 * file is where the claim is re-checked.
 */
const UPSTREAM_BASELINE = '2.0.157'

test('the skill source matches the released Plugin API v2 shape', () => {
  // Upstream `PluginSkillSource` in v2.0.157 and v2.0.160:
  //   { id: string; label: LocalizedString; load(): PluginSkill[] | Promise<PluginSkill[]> }
  const source: PluginSkillSource = SKILL_SOURCE
  assert.equal(typeof source.id, 'string')
  assert.ok(source.id.length > 0)
  assert.equal(typeof source.label.en, 'string')
  assert.equal(typeof source.label.fr, 'string')
  assert.equal(typeof source.load, 'function')
})

test('every loaded skill satisfies the released PluginSkill contract', async () => {
  const skills: PluginSkill[] = await SKILL_SOURCE.load()
  assert.ok(Array.isArray(skills))
  for (const skill of skills) {
    assert.equal(typeof skill.id, 'string')
    assert.ok(skill.id.length > 0)
    assert.equal(typeof skill.name, 'string')
    assert.ok(skill.name.length > 0)
    assert.equal(typeof skill.description, 'string')
    assert.ok(skill.description.trim().length > 0)
    assert.equal(typeof skill.prompt, 'string')
    assert.ok(skill.prompt.trim().length > 0)
  }
})

test('the skill ids are unique and stable', async () => {
  const first = (await SKILL_SOURCE.load()).map((s) => s.id)
  const second = (await SKILL_SOURCE.load()).map((s) => s.id)
  assert.deepEqual(first, second)
  assert.equal(new Set(first).size, first.length, 'skill ids must be unique')
})

test('the compatibility baseline recorded in the docs is unchanged', async () => {
  const { readFile } = await import('node:fs/promises')
  const { resolve } = await import('node:path')
  const docs = await readFile(resolve(import.meta.dirname, '../docs/IMPLEMENTATION.md'), 'utf8')
  assert.ok(
    docs.includes(UPSTREAM_BASELINE),
    `docs/IMPLEMENTATION.md must keep referencing the verified baseline ${UPSTREAM_BASELINE}`,
  )
  const manifest = JSON.parse(
    await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8'),
  ) as { peerDependencies?: Record<string, string> }
  assert.equal(manifest.peerDependencies?.openfox, '>=2.0.157')
})
