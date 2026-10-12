import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildFragments, MAX_FRAGMENT_BYTES } from '../src/discovery/fragments.ts'
import { estimateTokens, MAX_STATE_TOKENS } from '../src/presets/token-budget.ts'

/**
 * Rank at SYMBOL granularity, not file granularity.
 *
 * This is the state of the art, read rather than reinvented:
 *
 *   - aider sends SIGNATURES ONLY, bodies replaced by an ellipsis. Its cost is
 *     structurally a function of symbol COUNT, not of file size.
 *   - Continue collapses method bodies to `{ ... }` and drops methods from the
 *     end until the token count fits.
 *   - zvec-grep indexes "symbols, signatures, breadcrumbs" per language.
 *
 * What we did instead was hand the engine a whole file per question: ~4 000
 * tokens to decide whether that file deserved a read. Measured against the
 * hosted engine, that budget is what made 45 M tokens.
 *
 * The invariant these tests pin: a fragment carries enough to JUDGE a
 * declaration and enough to LOCATE it, and nothing else.
 */

async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fragments-'))
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, content, 'utf8')
  }
  return root
}

const TS_SOURCE = `import { resolve } from 'path'

export function parseEgressPolicy(value: string): Policy {
  if (value === 'block-remote-all') {
    // a remote endpoint must never be reached under this policy
    return { kind: 'all' }
  }
  if (value === 'block-remote-automatic') {
    return { kind: 'automatic' }
  }
  return { kind: 'allow' }
}

export const assertEgressAllowed = (endpointClass: string, policy: Policy) => {
  if (endpointClass !== 'remote') {
    return true
  }
  if (policy.kind === 'all') {
    throw new Error('egress_blocked')
  }
  return true
}

export const classifyEndpoint = (url: string): string => {
  const host = new URL(url).hostname
  if (host === '127.0.0.1' || host === '::1') {
    return 'local'
  }
  return 'remote'
}

export interface ResolvedEndpoint {
  readonly url: string
  readonly endpointClass: string
  readonly policy: Policy
}

export const resolveEndpoint = (
  url: string,
  settings: { endpointClass?: string; egressPolicy?: string },
): ResolvedEndpoint => {
  const endpointClass = settings.endpointClass ?? 'auto'
  const policy = parseEgressPolicy(settings.egressPolicy ?? 'allow')
  return { url, endpointClass, policy }
}

export const describeEndpoint = (endpoint: ResolvedEndpoint): string => {
  if (endpoint.endpointClass === 'local') {
    return 'a local endpoint is never blocked by egress policy'
  }
  if (endpoint.policy.kind === 'allow') {
    return 'this endpoint may be reached'
  }
  return 'this endpoint must not be reached'
}
`

test('a parseable file yields one fragment per declaration, not one per file', async () => {
  const root = await repo({ 'src/egress.ts': TS_SOURCE })
  const fragments = await buildFragments(root, ['src/egress.ts'])

  assert.ok(fragments.length >= 4, `expected a fragment per declaration, got ${fragments.length}`)
  for (const fragment of fragments) {
    // Any top-level declaration shape: function, const, interface, type.
    assert.match(
      fragment.text,
      /export\s+(async\s+)?(function|class|const|let|var|interface|type|enum)\b/,
      'a fragment must carry the head of its declaration',
    )
    // The body is elided: this is the whole point.
    assert.equal(
      fragment.text.includes("return { kind: 'all' }"),
      false,
      'a fragment must not carry the declaration body',
    )
    assert.ok(fragment.startLine >= 1, 'a fragment must locate itself in the file')
    assert.ok(fragment.endLine >= fragment.startLine)
  }
})

test('fragments are materially cheaper than the file they came from', async () => {
  const root = await repo({ 'src/egress.ts': TS_SOURCE })
  const fragments = await buildFragments(root, ['src/egress.ts'])

  const wholeFileTokens = estimateTokens(TS_SOURCE)
  const fragmentTokens = estimateTokens(fragments.map((f) => f.text).join('\n'))
  // Measured 138 vs 375 tokens on this fixture: ~2.6x. The claim is a real
  // reduction, not an order of magnitude — this file's declarations are short
  // and dense, and a longer file with fatter bodies widens the gap.
  assert.ok(
    fragmentTokens * 2 < wholeFileTokens,
    `fragments must be materially cheaper (${fragmentTokens} vs ${wholeFileTokens} tokens)`,
  )
})

test('a file with no parseable declaration falls back to a head preview, declared', async () => {
  const prose = 'a'.repeat(40_000)
  const root = await repo({ 'notes.md': prose })

  const fragments = await buildFragments(root, ['notes.md'])
  assert.equal(fragments.length, 1)
  assert.equal(fragments[0]?.kind, 'preview')
  assert.equal(
    fragments[0]?.wholeFile === true,
    false,
    'a 40 KB file must NOT be sent whole, even when it cannot be parsed',
  )
  assert.ok(
    estimateTokens(fragments[0]!.text) < MAX_STATE_TOKENS / 4,
    'the fallback preview must itself stay small',
  )
})

test('a small file is sent whole, and says so', async () => {
  // jevgrep's `wholeFileContextBytes`: below the line, the whole file is the
  // cheapest honest representation. Above it, it is not.
  const small = 'export const limit = 10\n'
  const root = await repo({ 'src/small.ts': small })

  const fragments = await buildFragments(root, ['src/small.ts'])
  assert.equal(fragments[0]?.kind, 'whole-file')
  assert.equal(fragments[0]?.wholeFile, true)
})

test('fragments never exceed the per-fragment ceiling', async () => {
  const huge = `export function giant() {\n${'  // filler\n'.repeat(5_000)}\n}\n`
  const root = await repo({ 'src/giant.ts': huge })

  const fragments = await buildFragments(root, ['src/giant.ts'])
  for (const fragment of fragments) {
    assert.ok(
      fragment.bytes <= MAX_FRAGMENT_BYTES,
      `a fragment must stay bounded (${fragment.bytes} > ${MAX_FRAGMENT_BYTES})`,
    )
  }
})

test('every fragment records how it was produced, so a caller can tell a guess from a fact', async () => {
  const root = await repo({
    'src/egress.ts': TS_SOURCE,
    'notes.md': 'x'.repeat(30_000),
    'src/tiny.ts': 'export const a = 1\n',
  })

  const fragments = await buildFragments(root, ['src/egress.ts', 'notes.md', 'src/tiny.ts'])
  const kinds = new Set(fragments.map((f) => f.kind))
  assert.ok(kinds.has('declaration'), 'a parsed file yields declarations')
  assert.ok(kinds.has('preview'), 'an unparseable file yields a declared preview')
  for (const fragment of fragments) {
    assert.ok(fragment.path.length > 0, 'every fragment names its file')
    assert.ok(fragment.source.length > 0, 'every fragment says how it was produced')
  }
})