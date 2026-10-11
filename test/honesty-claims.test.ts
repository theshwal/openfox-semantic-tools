import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { readFileSync } from 'node:fs'

import { register, SETTINGS } from '../src/index.ts'
import { fakeRegistry } from './helpers/registry.ts'

/**
 * A4-14 / A4-15 / A4-16: the promises this work is NOT allowed to make.
 *
 * This lot added a dial and a counter. The tempting failure is to narrate what
 * they are "worth" — a percentage saved, a speedup, a skill that helps — with
 * nothing measured behind it. That is the exact claim the repository has always
 * refused to make, and these tests are what keep the refusal mechanical.
 */

const ROOT = resolve(import.meta.dirname, '..')

const DOCS = ['README.md', 'docs/USER-GUIDE.md', 'docs/EVALUATION.md', 'docs/QUICKSTART.md']

/**
 * Claims that would need a measurement behind them. Matched case-insensitively
 * across the operator-facing documents, so a new doc is covered too.
 */
const UNMEASURED_CLAIMS: readonly [RegExp, string][] = [
  [/\bsaves?\s+(?:about\s+)?\d/i, 'a quantified saving'],
  [/\breduces?\s+tokens?\s+by\s+\d/i, 'a quantified token reduction'],
  [/\b\d+\s*%\s*(?:faster|quicker|cheaper)/i, 'a quantified speedup'],
  [/\b\d+\s*x\s+(?:faster|cheaper)\b/i, 'a quantified speedup'],
  [/improves?\s+(?:accuracy|quality|pass\s+rate)\s+by\s+\d/i, 'a quantified quality gain'],
  [/\b(?:skills?|tools?)\s+(?:are|is)\s+\d+\s*%\s+(?:faster|better|more)/i, 'a quantified skill claim'],
]

test('A4-14 no operator document states a quantified saving or gain', async () => {
  for (const doc of DOCS) {
    const text = await readFile(resolve(ROOT, doc), 'utf8')
    for (const [pattern, label] of UNMEASURED_CLAIMS) {
      assert.equal(
        pattern.test(text),
        false,
        `${doc} asserts ${label}; this repository ships no measurement behind one`,
      )
    }
  }
})

test('A4-14 the dial is documented as a label, never as an improvement', async () => {
  const readme = await readFile(resolve(ROOT, 'README.md'), 'utf8')
  // The dial's own section must state that it only labels.
  assert.match(readme, /only labels/i)
  // And the number it labels must be disclaimed, not sold.
  // The README renders emphasis as `**not**`, so the bold markers are optional here.
  assert.match(readme, /\*\*not\*\*\s+a measured/i)
})

test('A4-14 the user guide repeats the two standing caveats', async () => {
  const guide = await readFile(resolve(ROOT, 'docs/USER-GUIDE.md'), 'utf8')
  assert.match(guide, /empty result does not prove absence/i)
  assert.match(guide, /nothing here has been\s+calibrated|nothing here is\s+calibrated|has been calibrated against ground\s+truth/i)
})

test('A4-15 the usage ledger records names and counts only', async () => {
  // The ledger's own source must not be able to hold content: no file reads,
  // no paths, no credential fields.
  const source = await readFile(resolve(ROOT, 'src/usage/ledger.ts'), 'utf8')
  // Every read the ledger performs must target its OWN file. Any read whose
  // argument is not `usageLedgerPath(...)` would be reading something else.
  const reads = [...source.matchAll(/readFileSync\(([^)]*)\)/g)].map((m) => m[1]!.trim())
  assert.ok(reads.length > 0, 'the ledger is expected to read its own file')
  for (const argument of reads) {
    assert.match(
      argument,
      /^usageLedgerPath\(/,
      `the ledger must only ever read its own file, got: ${argument}`,
    )
  }
  // And it never walks a directory, so it cannot discover repository content.
  assert.equal(
    /readdir|opendir|glob\(|readFile\(/.test(source),
    false,
    'the ledger must never enumerate or read repository files',
  )
  // Structurally: no field of the stored shape may be named after content or
  // a credential. The prose above names them only to say they are absent, so
  // the check runs against the INTERFACE declarations, not the whole file.
  const shape = /interface Usage\w*[^}]*\}/g
  const declared = [...source.matchAll(shape)].map((m) => m[0]).join('\n')
  // `catalogue` holds capability and skill NAMES, which is the point. What
  // must never be stored is a credential, a URL, or any repository content.
  for (const forbidden of ['apiKey', 'authorization', 'endpoint', 'diffExcerpts', 'filePath', 'content']) {
    assert.equal(
      new RegExp(`\\b${forbidden}\\b`).test(declared),
      false,
      `the stored shape must not carry a ${forbidden} field`,
    )
  }
  // The only string the ledger ever stores is a capability or skill id, and
  // that is asserted against the real catalogue rather than trusted.
  assert.match(source, /#catalogue = new Set<string>/)
  // And the values actually stored are integers under known keys.
  assert.match(source, /offered: \d+/i)
  assert.match(source, /used: \d+/i)
})

test('A4-16 the shipped test suite needs no credential', () => {
  // A regression that made the suite require an API key would be invisible in
  // CI, so the rule is asserted from package.json rather than trusted.
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
  }
  const check = pkg.scripts.check ?? ''
  assert.match(check, /typecheck/)
  assert.match(check, /\btest\b/)
  assert.match(check, /build/)
  // No credential is threaded into the check script.
  assert.equal(/API_KEY|SEMANTIC_|OPENFOX_KEY/.test(check), false)
})

test('A4-16 the offline evaluation entry point still runs', async () => {
  const scripts = await readdir(resolve(ROOT, 'scripts'))
  assert.ok(scripts.includes('evaluate.ts'), 'the evaluation entry point must stay')
})

test('the new setting is documented with a plain default a reader can verify', async () => {
  const field = SETTINGS.fields.find((f) => f.key === 'confidenceThreshold')
  assert.ok(field, 'confidenceThreshold must exist')
  assert.equal(field.default, 75)
  assert.equal(field.type, 'number')
  // Non-secret by construction: it holds a number and names no host.
  assert.notEqual(field.type, 'password')
  assert.notEqual(field.secret, true)
  // The label must not be a lie about the unit.
  assert.match(String(field.label.en), /%/)
})

test('the new tool is registered and is advisory by construction', async () => {
  const { registry, tools } = fakeRegistry()
  register(registry)
  const tool = tools.get('semantic_usage_report')
  assert.ok(tool, 'semantic_usage_report must be registered')
  assert.match(tool.description, /contacts no provider/i)
  assert.match(tool.description, /advisory/i)
  assert.deepEqual(tool.parameters, {
    type: 'object',
    required: [],
    additionalProperties: false,
    properties: {},
  })
})

test('the ledger keeps a bounded window rather than growing without limit', async () => {
  const source = await readFile(resolve(ROOT, 'src/usage/ledger.ts'), 'utf8')
  assert.match(source, /maxDays/)
  assert.match(source, /maxNames/)
  assert.match(source, /#prune/)
})