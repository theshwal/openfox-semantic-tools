import assert from 'node:assert/strict'
import test from 'node:test'

import { SKILL_SOURCE } from '../src/skills/source.ts'
import type { PluginSkill, PluginSkillSource } from 'openfox/plugin'
import { compatibilityBaseline, readManifest } from './helpers/baseline.ts'

/**
 * Guards the compatibility claim made in the docs: `registerSkillSource` must be
 * part of the released Plugin API v2 baseline, otherwise this lot would need a
 * minimum-version bump that has not been requested.
 *
 * The expected upstream shape is pinned here rather than fetched, so the test
 * stays offline and deterministic. If upstream ever changes the contract, this
 * file is where the claim is re-checked.
 *
 * The baseline is READ from `package.json` rather than written here, so the
 * harness, the peer range and the docs cannot disagree about it.
 */
const UPSTREAM_BASELINE = await compatibilityBaseline()

test('the skill source matches the released Plugin API v2 shape', () => {
  // Upstream `PluginSkillSource` in v2.0.161:
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
  const manifest = await readManifest()
  // The peer range must name the SAME baseline, or an install would be told it
  // supports a release the plugin has not actually been checked against.
  assert.equal(manifest.peerDependencies?.openfox, `>=${UPSTREAM_BASELINE}`)
})

test('the baseline is declared in exactly one place', async () => {
  const { readdir, readFile: read } = await import('node:fs/promises')
  const { resolve: resolvePath, join } = await import('node:path')
  const baseline = await compatibilityBaseline()

  // `setup-harness.sh` reads the field rather than repeating the literal.
  const setup = await read(resolvePath(import.meta.dirname, '../scripts/setup-harness.sh'), 'utf8')
  assert.ok(
    setup.includes('openfox.compatibilityBaseline'),
    'setup-harness.sh must read the declared baseline',
  )
  assert.equal(
    /OPENFOX_VERSION:-2\.0\.\d+/.test(setup),
    false,
    'setup-harness.sh must not hard-code a version fallback',
  )

  // No source or script file may carry its own literal.
  const offenders: string[] = []
  for (const dir of ['scripts', 'src', 'test']) {
    const base = resolvePath(import.meta.dirname, `../${dir}`)
    for (const entry of await readdir(base, { recursive: true })) {
      if (typeof entry !== 'string' || !entry.endsWith('.ts')) continue
      const text = await read(join(base, entry), 'utf8')
      // A historical mention in a comment is fine; a declared default is not.
      for (const line of text.split('\n')) {
        const code = line.replace(/\/\/.*$/, '')
        if (/['"`]>=?2\.0\.\d+/.test(code) && !line.includes('compatibilityBaseline')) {
          offenders.push(`${dir}/${entry}: ${line.trim()}`)
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `hard-coded OpenFox versions found: ${offenders.join(' | ')}`)
})
