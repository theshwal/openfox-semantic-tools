import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MAX_CANDIDATE_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  readBoundedCandidates,
} from '../src/discovery/read.ts'
import { MAX_STATE_TOKENS } from '../src/presets/token-budget.ts'
import { ProviderError } from '../src/errors.ts'

async function tree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'semantic-discovery-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1\n')
  await writeFile(join(root, 'src', 'b.ts'), 'export const b = 2\n')
  await writeFile(join(root, 'notes.md'), '# notes\n')
  return root
}

test('reads only the requested files that exist inside the root', async () => {
  const root = await tree()
  const { files, bytes, skipped } = await readBoundedCandidates(root, ['src/a.ts', 'notes.md'])

  assert.deepEqual(files.map((f) => f.path), ['src/a.ts', 'notes.md'])
  assert.equal(files[0].content, 'export const a = 1\n')
  assert.ok(bytes > 0)
  // The other file in src/ was not swept in: discovery is not a repository scan.
  assert.deepEqual(skipped, [], 'an empty skip list stays explicit')
})

test('a missing file is reported as skipped, never silently replaced', async () => {
  const root = await tree()
  const { files, skipped } = await readBoundedCandidates(root, ['src/a.ts', 'src/ghost.ts'])

  assert.deepEqual(files.map((f) => f.path), ['src/a.ts'])
  // A1-2: the skipped file is NAMED with a reason, not merely counted.
  assert.deepEqual(skipped, [{ path: 'src/ghost.ts', reason: 'missing' }])
})

test('too many candidates is refused rather than truncated', async () => {
  const root = await tree()
  const many = Array.from({ length: MAX_CANDIDATE_FILES + 1 }, (_v, i) => `f${i}.ts`)
  await assert.rejects(
    () => readBoundedCandidates(root, many),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError)
      assert.equal(error.code, 'invalid_arguments')
      assert.match(error.message, /at most/)
      return true
    },
  )
})

test('a file above the per-file bound is refused, not cut', async () => {
  const root = await tree()
  await writeFile(join(root, 'big.ts'), 'x'.repeat(MAX_FILE_BYTES + 1))
  await assert.rejects(
    () => readBoundedCandidates(root, ['big.ts']),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError)
      assert.equal(error.code, 'invalid_arguments')
      assert.match(error.message, /exceeds the per-file limit/)
      return true
    },
  )
})

test('a total above the token budget drops the surplus by name', async () => {
  // This test used to assert a REFUSAL. The behaviour changed deliberately:
  // refusing blamed the caller for a limit it never saw, and it killed the whole
  // call before the rerank stage — so a search on a normal repository returned
  // an error instead of a ranking. The surplus is now named instead.
  const root = await tree()
  const chunk = 'x'.repeat(MAX_FILE_BYTES)
  // 16 000 bytes is ~4 000 tokens at the conservative estimate, so the 24 000
  // budget holds exactly six of them. Offering twelve makes the BUDGET the
  // binding constraint rather than the 40-file candidate cap, which is what this
  // test is about.
  const count = 12
  const paths: string[] = []
  for (let i = 0; i < count; i += 1) {
    await writeFile(join(root, `f${i}.ts`), chunk)
    paths.push(`f${i}.ts`)
  }

  const read = await readBoundedCandidates(root, paths)
  assert.ok(read.files.length > 0, 'the budget must leave usable evidence')
  assert.ok(read.files.length < paths.length, 'the surplus must be reported')
  for (const entry of read.skipped) {
    assert.equal(entry.reason, 'evidence-budget')
  }
})

test('a path escaping the root is refused', async () => {
  const root = await tree()
  for (const escape of ['../outside.ts', 'src/../../outside.ts', '/etc/passwd', '']) {
    await assert.rejects(
      () => readBoundedCandidates(root, [escape]),
      ProviderError,
      `must refuse ${escape}`,
    )
  }
})

test('a symlink pointing outside the root is refused', async () => {
  const root = await tree()
  const outside = await mkdtemp(join(tmpdir(), 'semantic-outside-'))
  await writeFile(join(outside, 'secret.ts'), 'export const secret = 1\n')
  await symlink(join(outside, 'secret.ts'), join(root, 'link.ts'))

  await assert.rejects(
    () => readBoundedCandidates(root, ['link.ts']),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError)
      assert.equal(error.code, 'invalid_arguments')
      return true
    },
  )
})

test('an empty result is a refusal, never an empty "no match" answer', async () => {
  const root = await tree()
  await assert.rejects(
    () => readBoundedCandidates(root, ['ghost.ts']),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError)
      assert.equal(error.code, 'insufficient_evidence')
      assert.match(error.message, /No readable file content/)
      return true
    },
  )
})

test('an empty file alone is not evidence', async () => {
  const root = await tree()
  await writeFile(join(root, 'empty.ts'), '')
  await assert.rejects(
    () => readBoundedCandidates(root, ['empty.ts']),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError)
      assert.equal(error.code, 'insufficient_evidence')
      return true
    },
  )
})
