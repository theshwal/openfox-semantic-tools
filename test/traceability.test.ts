import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const TRACE = await readFile(resolve(import.meta.dirname, '../docs/TRACEABILITY.md'), 'utf8')

/**
 * Requirement rows are table lines whose first cell is an id or a label.
 *
 * A table is opted OUT by an explicit `<!-- not-requirements: ... -->` marker
 * on the line ABOVE its heading, so the exclusion is a contract in the document
 * rather than a regex over row prose: rewording a row can no longer silently
 * change the counted total, and the failure message points at the marker that
 * was removed.
 */
function requirementRows(): string[] {
  const lines = TRACE.split('\n')
  const summaryStart = lines.findIndex((l) => l.startsWith('## Summary'))
  const rows: string[] = []
  let optedOut = false
  for (let index = 0; index < summaryStart; index += 1) {
    const line = lines[index]!
    if (line.startsWith('<!-- not-requirements')) {
      optedOut = true
      continue
    }
    if (line.startsWith('#')) {
      // The marker is looked up past any blank lines, so it may sit directly
      // above the heading. A `##` always re-evaluates; a `###` only does when
      // a marker is actually attached to it, so a plain sub-heading inside an
      // opted-out section stays opted out.
      let above = index - 1
      while (above >= 0 && lines[above]!.trim() === '') above -= 1
      const marker = above >= 0 ? lines[above]! : ''
      if (line.startsWith('## ') || marker.startsWith('<!-- not-requirements')) {
        optedOut = marker.startsWith('<!-- not-requirements')
      }
      continue
    }
    if (optedOut) continue
    if (!line.startsWith('| ') || !line.endsWith('|')) continue
    if (line.startsWith('| ---')) continue
    if (line.includes('| Requirement |') || line.includes('| Verdict |')) continue
    if (line.includes('| # |') || line.includes('| Finding |')) continue
    rows.push(line)
  }
  return rows
}

test('every requirement row ends in a verdict, never an empty cell', () => {
  const rows = requirementRows()
  assert.ok(rows.length >= 40, `only ${rows.length} requirement rows found`)
  for (const row of rows) {
    const verdict = row.split('|').at(-2)?.trim()
    assert.ok(verdict && verdict.length > 0, `row without a verdict: ${row.slice(0, 60)}`)
  }
})

test('requirement ids are unique, so every anchor resolves to one requirement', async () => {
  // Two rows were once added with ids that already existed further down, so
  // `docs/TRACEABILITY.md#A17` resolved to two different requirements while
  // the build stayed green. Ids are anchors, so uniqueness is part of the contract.
  const doc = await readFile(resolve(import.meta.dirname, '../docs/TRACEABILITY.md'), 'utf8')
  const ids = [...doc.matchAll(/^\| (A\d+) \|/gm)].map((match) => match[1]!)
  const seen = new Set()
  const duplicates = new Set()
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id)
    seen.add(id)
  }
  assert.deepEqual([...duplicates], [], `duplicate requirement ids: ${[...duplicates].join(', ')}`)
})
test('the summary counts match the tables', () => {
  const rows = requirementRows()

  // Rows are classified by their final verdict cell so a requirement is counted
  // exactly once, whatever prose the proof column contains. The buckets are
  // mutually exclusive and matched by PREFIX, so a qualified verdict such as
  // "verified — see finding H2" still counts as verified.
  const verdictOf = (row: string) => row.split('|').at(-2)?.trim() ?? ''
  const classified = rows.map(verdictOf).map((v) => {
    if (v.startsWith('**unverified**')) return 'unverified'
    if (v.startsWith('verified with a documented deviation')) return 'deviation'
    if (v.startsWith('verified (code path')) return 'codePath'
    if (v.startsWith('verified (plumbing only')) return 'plumbing'
    if (v.startsWith('verified')) return 'verified'
    return 'other'
  })
  const count = (kind: string) => classified.filter((c) => c === kind).length
  const unverified = count('unverified')
  const deviation = count('deviation')
  const codePath = count('codePath')
  const plumbing = count('plumbing')
  const plain = count('verified')
  const other = count('other')
  assert.equal(other, 0, `every row must carry a known verdict, ${other} do not`)

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
    // These are upstream OpenFox paths, not repository files. `src/plugin/`
    // is the plugin API and `src/server/` is the host server (routes/plugins).
    .filter((p) => !p.startsWith('src/plugin/') && !p.startsWith('src/server/'))
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
  // The calibration study (#9) is still unmeasured: no hosted-provider run has
  // happened, so a false-pass rate is unknown by construction.
  for (const id of ['4.18', '4.19']) {
    const row = requirementRows().find((r) => r.startsWith(`| ${id} |`))
    assert.ok(row, `row ${id} missing`)
    assert.ok(row.includes('**unverified**'), `${id} must stay unverified, not be claimed`)
  }
})

test('a real-host claim must cite the E2E harness, not a unit test', () => {
  // 14.23 covers the normal `load_skill` path on a real host. It may only be
  // claimed as verified when the row points at the isolated harness, because a
  // unit test cannot exercise the host's skill loader.
  const row = requirementRows().find((r) => r.startsWith('| 14.23 |'))
  assert.ok(row, 'row 14.23 missing')
  if (row.includes('**unverified**')) {
    assert.ok(
      !row.includes('harness:agent-e2e'),
      '14.23 cannot claim harness evidence while it is still marked unverified',
    )
    return
  }
  assert.ok(
    row.includes('harness:agent-e2e'),
    '14.23 is verified, so it must cite the real-host harness as its proof',
  )
})
