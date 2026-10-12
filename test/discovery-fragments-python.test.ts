import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildFragments, extractDeclarations } from '../src/discovery/fragments.ts'
import { estimateTokens } from '../src/presets/token-budget.ts'

/**
 * Python is not a nice-to-have: on a real 137-file repository, 15 335 of its
 * files are Python and none are JavaScript or TypeScript. With the extractor
 * limited to JS/TS, every file scored came back as a `preview` — the top two
 * hits in the PR #55 measurement included none.
 *
 * The contract is unchanged, only the language table widens:
 *   - one fragment per declaration;
 *   - the body elided, so it is materially cheaper than the source;
 *   - the line range locates it;
 *   - `kind` always says how the fragment was produced.
 */

const PY_SOURCE = `"""Accounting helpers for invoice expiry."""

from datetime import date


class InvoiceExporter:
    """Exports invoices for a tenant."""

    def __init__(self, tenant_id: str):
        self.tenant_id = tenant_id
        self.exported = []

    def export_due(self, as_of: date) -> list[str]:
        due = [i for i in self.exported if i.due_before(as_of)]
        return due

    def export_all(self) -> list[str]:
        return list(self.exported)


def is_archived(invoice, as_of: date) -> bool:
    return invoice.archived_at is not None and invoice.archived_at < as_of


def exclude_archived(total: float, invoices: list) -> float:
    kept = [i for i in invoices if not is_archived(i, date.today())]
    return sum(i.amount for i in kept)


ARCHIVE_GRACE_DAYS = 90


def _iter_archived(invoices, as_of: date):
    for invoice in invoices:
        if is_archived(invoice, as_of):
            yield invoice


def summarise_archived(invoices, as_of: date) -> dict[str, int]:
    archived = list(_iter_archived(invoices, as_of))
    return {"archived": len(archived), "kept": len(invoices) - len(archived)}


def tenant_scope_clause(tenant_id: str) -> str:
    """Every query touching invoices must be scoped to one tenant."""
    return "tenant_id = :tenant_id"


def build_expiry_query(as_of: date, grace_days: int = ARCHIVE_GRACE_DAYS) -> str:
    cutoff = as_of - timedelta(days=grace_days)
    return "WHERE archived_at IS NULL AND due_at < :cutoff"
`

async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pyfrag-'))
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, content, 'utf8')
  }
  return root
}

test('Python declarations are found at module and class level', () => {
  const found = extractDeclarations(PY_SOURCE)
  const heads = found.map((d) => d.head)

  assert.ok(
    heads.some((h) => h.startsWith('class InvoiceExporter')),
    `expected the class, got ${JSON.stringify(heads)}`,
  )
  assert.ok(
    heads.some((h) => h.startsWith('def is_archived')),
    'expected the module-level function',
  )
  assert.ok(
    heads.some((h) => h.startsWith('def exclude_archived')),
    'expected every module-level function, not just the first',
  )
  // A method inside a class is a declaration too: it is what a caller may
  // actually need to open.
  assert.ok(
    heads.some((h) => h.includes('def export_due')),
    'expected a method to be found',
  )
})

test('an import or a docstring is never mistaken for a declaration', () => {
  const found = extractDeclarations(PY_SOURCE)
  for (const declaration of found) {
    assert.equal(
      /^[\s]*(import|from)\s/.test(declaration.head),
      false,
      `an import was read as a declaration: ${declaration.head}`,
    )
    assert.equal(declaration.head.trimStart().startsWith('"""'), false)
  }
})

test('a module-level assignment is a declaration too', () => {
  const found = extractDeclarations(PY_SOURCE)
  assert.ok(
    found.some((d) => d.head.startsWith('ARCHIVE_GRACE_DAYS')),
    'expected the constant to be found',
  )
})

test('a Python file yields fragments, not a preview', async () => {
  const root = await repo({ 'billing/archive.py': PY_SOURCE })
  const fragments = await buildFragments(root, ['billing/archive.py'])

  assert.ok(fragments.length >= 4, `expected several fragments, got ${fragments.length}`)
  assert.equal(
    fragments.every((f) => f.kind === 'declaration'),
    true,
    `every fragment must be a declaration, got ${fragments.map((f) => f.kind).join(',')}`,
  )
})

test('a Python fragment elides the body and keeps the signature', async () => {
  const root = await repo({ 'billing/archive.py': PY_SOURCE })
  const fragments = await buildFragments(root, ['billing/archive.py'])

  const exported = fragments.find((f) => f.text.includes('export_due'))
  assert.ok(exported, 'the method fragment must exist')
  assert.match(exported.text, /def export_due/)
  assert.equal(
    exported.text.includes('self.exported if i.due_before'),
    false,
    'a Python fragment must not carry its body',
  )
  assert.ok(exported.startLine >= 1 && exported.endLine >= exported.startLine)
})

test('Python fragments are materially cheaper than the file', async () => {
  const root = await repo({ 'billing/archive.py': PY_SOURCE })
  const fragments = await buildFragments(root, ['billing/archive.py'])

  const wholeFile = estimateTokens(PY_SOURCE)
  const fragmentTokens = estimateTokens(fragments.map((f) => f.text).join('\n'))
  assert.ok(
    fragmentTokens * 2 < wholeFile,
    `fragments must be materially cheaper (${fragmentTokens} vs ${wholeFile} tokens)`,
  )
})

test('a .pyi stub is treated like Python', async () => {
  const root = await repo({ 'billing/archive.pyi': PY_SOURCE })
  const fragments = await buildFragments(root, ['billing/archive.pyi'])
  assert.ok(
    fragments.every((f) => f.kind === 'declaration'),
    'a type stub is as parseable as the module it describes',
  )
})

test('a file with no declaration still falls back to a declared preview', async () => {
  const root = await repo({ 'notes.txt': 'x'.repeat(30_000) })
  const fragments = await buildFragments(root, ['notes.txt'])
  assert.equal(fragments[0]?.kind, 'preview')
  assert.match(fragments[0]!.source, /not fragmentable/i)
})