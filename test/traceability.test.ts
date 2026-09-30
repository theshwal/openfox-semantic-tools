import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const TRACE = await readFile(resolve(import.meta.dirname, '../docs/TRACEABILITY.md'), 'utf8')

/**
 * Requirement rows are table lines whose first cell is an id or a label. The
 * header rows of each table are skipped, as is the `## Scope discipline` table,
 * which records invariants rather than issue requirements.
 */
function requirementRows(): string[] {
  const lines = TRACE.split('\n')
  const scopeStart = lines.findIndex((l) => l.startsWith('## Scope discipline'))
  const summaryStart = lines.findIndex((l) => l.startsWith('## Summary'))
  return lines
    .slice(0, summaryStart)
    .filter(
      (line, index) =>
        index < scopeStart &&
        line.startsWith('| ') &&
        line.endsWith('|') &&
        !line.startsWith('| ---') &&
        !line.includes('| Requirement |') &&
        !line.includes('| Verdict |') &&
        !line.includes('| # |'),
    )
}

test('every requirement row ends in a verdict, never an empty cell', () => {
  const rows = requirementRows()
  assert.ok(rows.length >= 40, `only ${rows.length} requirement rows found`)
  for (const row of rows) {
    const verdict = row.split('|').at(-2)?.trim()
    assert.ok(verdict && verdict.length > 0, `row without a verdict: ${row.slice(0, 60)}`)
  }
})

test('the summary counts match the tables', () => {
  const rows = requirementRows()
  const verdictOf = (row: string) => row.split('|').at(-2)?.trim() ?? ''

  // Rows are classified by their final verdict cell so a requirement is counted
  // exactly once, whatever prose the proof column contains.
  const unverified = rows.filter((r) => verdictOf(r).startsWith('**unverified**')).length
  const deviation = rows.filter((r) => verdictOf(r).includes('documented deviation')).length
  const codePath = rows.filter((r) => verdictOf(r).includes('verified (code path')).length
  const plain = rows.filter((r) => verdictOf(r) === 'verified').length
  const plumbing = rows.filter((r) => verdictOf(r).includes('verified (plumbing only')).length

  const summary = TRACE.slice(TRACE.indexOf('## Summary'))
  const claimed = {
    verified: Number(/Verified: (\d+) requirements/.exec(summary)?.[1]),
    deviation: Number(/deviation: (\d+)/.exec(summary)?.[1]),
    unverified: Number(/\*\*Unverified: (\d+)\*\*/.exec(summary)?.[1]),
  }

  assert.equal(claimed.unverified, unverified, 'unverified count drifted')
  assert.equal(claimed.deviation, deviation, 'deviation count drifted')
  assert.equal(claimed.verified, plain + codePath + plumbing, 'verified count drifted')
  assert.equal(
    rows.length,
    plain + codePath + plumbing + deviation + unverified,
    'every requirement row must be counted exactly once',
  )
})

test('no proof is cited without the file or test that carries it', async () => {
  const root = resolve(import.meta.dirname, '..')
  const testFiles = new Set(await readdir(resolve(root, 'test')))
  const srcEntries = await readdir(resolve(root, 'src'), { withFileTypes: true })
  const scriptFiles = new Set(await readdir(resolve(root, 'scripts')))
  const fixtureFiles = new Set(await readdir(resolve(root, 'fixtures/verify')))
  const docFiles = new Set(await readdir(resolve(root, 'docs')))

  const cited = [...TRACE.matchAll(/`((?:test|src|scripts|docs|fixtures)\/[A-Za-z0-9._/-]+)`/g)]
    .map((m) => m[1])
    // `src/plugin/index.ts` is an upstream OpenFox path, not a repository file.
    .filter((p) => !p.startsWith('src/plugin/'))
  assert.ok(cited.length > 20, `only ${cited.length} proof references found`)

  for (const path of new Set(cited)) {
    const parts = path.split('/')
    if (parts[0] === 'test') {
      assert.ok(testFiles.has(parts[1]), `cited test does not exist: ${path}`)
    } else if (parts[0] === 'src') {
      const exists = srcEntries.some(
        (e) => e.name === parts[1] || (e.isDirectory() && e.name === parts[1]),
      )
      assert.ok(exists, `cited source does not exist: ${path}`)
    } else if (parts[0] === 'scripts') {
      assert.ok(scriptFiles.has(parts[1]), `cited script does not exist: ${path}`)
    } else if (parts[0] === 'fixtures') {
      assert.ok(fixtureFiles.has(parts[2]), `cited fixture does not exist: ${path}`)
    } else {
      assert.ok(docFiles.has(parts[1]), `cited doc does not exist: ${path}`)
    }
  }
})

test('every quoted test name exists in the cited test file', async () => {
  const dir = resolve(import.meta.dirname)
  const sources = new Map<string, string>()
  for (const file of await readdir(dir)) {
    if (file.endsWith('.test.ts')) sources.set(file, await readFile(resolve(dir, file), 'utf8'))
  }
  // Pattern: T: `test/foo.test.ts` "the exact test name"
  const quotes = [...TRACE.matchAll(/`test\/([A-Za-z0-9._-]+\.test\.ts)`\s*"([^"]+)"/g)]
  assert.ok(quotes.length >= 20, `only ${quotes.length} quoted test names found`)
  for (const [, file, name] of quotes) {
    const source = sources.get(file)
    assert.ok(source, `quoted test file is not a test file: ${file}`)
    assert.ok(
      source.includes(name),
      `test "${name}" is cited in TRACEABILITY.md but not found in ${file}`,
    )
  }
})

test('the unverified requirements are the ones that genuinely need external evidence', () => {
  for (const id of ['4.18', '4.19', '14.23']) {
    const row = requirementRows().find((r) => r.startsWith(`| ${id} |`))
    assert.ok(row, `row ${id} missing`)
    assert.ok(row.includes('**unverified**'), `${id} must stay unverified, not be claimed`)
  }
})
