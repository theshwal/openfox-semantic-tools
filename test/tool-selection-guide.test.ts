import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { SETTINGS } from '../src/index.ts'
import { fakeRegistry } from './helpers/registry.ts'
import { register } from '../src/index.ts'

/**
 * Issue #51: ten-ish tools, no selection order.
 *
 * The guidance is therefore WRITTEN DOWN AND TESTED, not left as prose. A
 * selection ladder that drifts from the registry is worse than none: an agent
 * is told to reach for a tool that no longer exists.
 */

const ROOT = resolve(import.meta.dirname, '..')
const README = resolve(ROOT, 'README.md')
const GUIDE = resolve(ROOT, 'docs/USER-GUIDE.md')

/** The tools an agent may actually be steered towards. Operator-only ones are excluded. */
const AGENT_TOOLS = [
  'semantic_search',
  'semantic_scan',
  'semantic_verify_task',
  'semantic_issue_coverage',
  'semantic_transform_status',
  'semantic_hook_status',
] as const

/** Tools an operator runs, and an agent has no business calling unprompted. */
const OPERATOR_TOOLS = [
  'semantic_decide',
  'semantic_provider_self_test',
  'semantic_calibration_candidate',
  'semantic_question_calibration',
  'semantic_reference_agreement',
  'semantic_usage_report',
] as const

async function registeredTools(): Promise<string[]> {
  const { registry, tools } = fakeRegistry()
  register(registry)
  return [...tools.keys()]
}

test('every registered tool is either agent-facing or explicitly operator-only', async () => {
  const registered = await registeredTools()
  const known = [...AGENT_TOOLS, ...OPERATOR_TOOLS]
  const unknown = registered.filter((name) => !known.includes(name as never))
  assert.deepEqual(unknown, [], `a tool appeared that no guidance covers: ${unknown.join(', ')}`)

  // And the reverse: nothing declared as agent-facing has gone missing.
  const missing = AGENT_TOOLS.filter((name) => !registered.includes(name))
  assert.deepEqual(missing, [], `the ladder points at tools that do not exist: ${missing.join(', ')}`)
})

test('the README ladder covers every agent-facing tool', async () => {
  const readme = await readFile(README, 'utf8')
  for (const tool of AGENT_TOOLS) {
    assert.ok(readme.includes(tool), `the README must mention ${tool} in its selection guidance`)
  }
})

test('the README ladder states when NOT to reach for a semantic tool at all', async () => {
  const readme = await readFile(README, 'utf8')
  // The requirement is explicit: an agent must be able to be told to stop.
  assert.match(
    readme,
    /when not to use|n'a aucun outil sémantique|reach for a semantic tool at all/i,
    'the README must say when a semantic tool is the wrong answer',
  )
  // ...and name the deterministic tools that usually win.
  for (const cheaper of ['grep', 'rg']) {
    assert.ok(readme.includes(cheaper), `the ladder must name ${cheeder()} as the cheaper first move`)
  }
})

function cheeder(): string {
  return 'the deterministic alternatives'
}

test('the ladder resolves the overlapping cases with an explicit precedence', async () => {
  const readme = await readFile(README, 'utf8')
  // "If you already have a file list, scan beats search" is the exact ambiguity
  // issue #51 raised, so the precedence has to be written down.
  // Scoped to the ladder itself. The precedence is written as a TABLE row
  // ("Use X | Instead of Y"), so the assertion reads the row rather than
  // demanding a sentence that the format does not produce.
  const ladder = readme.slice(
    readme.search(/^## Which tool do I want/im),
    readme.search(/^## Tools/im),
  )
  const scanRow = ladder
    .split('\n')
    .find((line) => line.includes('semantic_scan') && line.includes('semantic_search'))
  assert.ok(scanRow, 'the ladder must have a row resolving scan vs search')
  // The "Use" column is the cell that names the winner; the row must put scan
  // there and search in the "Instead of" column.
  const cells = scanRow.split('|').map((cell) => cell.trim())
  const use = cells[2] ?? ''
  const instead = cells[3] ?? ''
  assert.match(use, /semantic_scan/, 'scan must be the tool to reach for')
  assert.match(
    instead,
    /semantic_search/,
    'the row must name search as the one it displaces when a list is already in hand',
  )

  // The "instead of" column is allowed to abbreviate (`verify_task` for
  // `semantic_verify_task`), so the row is matched on the TOOL named in the
  // "Use" column rather than on both full names appearing together.
  // BOTH names appear in two rows — one per direction — so matching the pair
  // finds the wrong one. The winner is the cell the row tells you to USE.
  const coverageRow = ladder
    .split('\n')
    .find((line) => {
      if (!/verify_task/.test(line)) return false
      const use = line.split('|').map((cell) => cell.trim())[2] ?? ''
      return use.includes('semantic_issue_coverage')
    })
  assert.ok(coverageRow, 'the ladder must have a row resolving coverage vs verify_task')
  // "several" belongs to the INTENTION column, not to the tool cells, so it is
  // asserted on that cell rather than on the whole row.
  const coverageIntent = coverageRow.split('|').map((cell) => cell.trim())[1] ?? ''
  assert.match(
    coverageIntent,
    /several|multiple/i,
    'the coverage row must state the several-criteria case',
  )
  assert.match(
    coverageRow,
    /semantic_issue_coverage/,
    'that row must name issue_coverage as the tool to reach for',
  )
})

test('no provider, endpoint, model or threshold leaks into the selection guidance', async () => {
  const readme = await readFile(README, 'utf8')
  const guide = await readFile(GUIDE, 'utf8')

  // Only the LADDER is scanned, not the whole document. The README legitimately
  // names providers in the dated conformance results, and a test that flagged
  // that would be pushing us to delete evidence rather than fix the guidance.
  const readmeLadder = readme.slice(
    readme.search(/^## Which tool do I want/im),
    readme.search(/^## Tools/im),
  )
  const guideLadder = guide.slice(
    guide.search(/^### Which tool do I want/im),
    guide.search(/^### `semantic_decide`/im),
  )
  assert.ok(readmeLadder.length > 0, 'the README ladder must be locatable')

  for (const forbidden of ['jev', 'Jev', 'kev', 'laya', 'system-one', 'v1/', 'api.typesafe']) {
    for (const [name, text] of [
      ['README', readmeLadder],
      ['USER-GUIDE', guideLadder],
    ] as const) {
      assert.equal(
        text.includes(forbidden),
        false,
        `the ${name} selection guidance mentions "${forbidden}"`,
      )
    }
  }
})

test('the guide carries the same ladder in full, with a worked example per row', async () => {
  const guide = await readFile(GUIDE, 'utf8')
  const section = guide.slice(guide.search(/which tool do I want/i))
  assert.ok(section.length > 400, 'the guide must expand the ladder, not just link it')
  for (const tool of AGENT_TOOLS) {
    assert.ok(section.includes(tool), `the guide must cover ${tool}`)
  }
})

test('the ladder is a decision procedure, not a manual', async () => {
  const readme = await readFile(README, 'utf8')
  const start = readme.search(/which tool do I want/i)
  assert.ok(start > 0, 'the README must have the ladder')
  const untilTools = readme.slice(start, readme.search(/^## Tools/im))
  // If it is longer than the tool table it is a manual, which is the failure
  // issue #51 warns about.
  const table = readme.slice(readme.search(/^## Tools/im)).length
  assert.ok(
    untilTools.length < table / 2,
    `the README ladder (${untilTools.length} chars) should be shorter than half the tool table (${table} chars)`,
  )
})

test('operator-only tools are marked as such rather than left to inference', async () => {
  const readme = await readFile(README, 'utf8')
  const table = readme.slice(readme.search(/^## Tools/im))
  for (const tool of OPERATOR_TOOLS) {
    assert.ok(table.includes(tool), `the tool table must list ${tool}`)
  }
  assert.match(
    table,
    /operator/i,
    'the table must distinguish operator instruments from agent tools',
  )
})