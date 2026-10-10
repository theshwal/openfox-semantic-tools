import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * `docs/INSTALLATION.md` once stated flatly that "the packed tarball cannot be
 * installed at all". That was true of `installFromPath` and false of the host's
 * npm route, which never calls `buildIfNeeded()` — a reader comparing the two
 * sources would have drawn the wrong conclusion about a published package.
 *
 * These tests keep the two routes described separately, so the correction
 * cannot be quietly reverted by an edit written from memory.
 */
const DOC = resolve(import.meta.dirname, '../docs/INSTALLATION.md')

const doc = await readFile(DOC, 'utf8')

test('the npm route is described as build-free, because the host never builds it', () => {
  // The host's own implementation, read from the pinned release.
  assert.match(
    doc,
    /does not call\s+`?buildIfNeeded\(\)`?/i,
    'INSTALLATION.md must state that the npm route skips buildIfNeeded()',
  )
  assert.match(
    doc,
    /prebuilt `dist\/`/i,
    'INSTALLATION.md must say the npm route loads the built entry directly',
  )
})

test('the local-path failure is scoped to the route that actually builds', () => {
  // The failure is real for a hand-unpacked tarball, and must not be
  // generalised into "a published package would fail".
  assert.match(doc, /Recipe B/i, 'the hand-unpacked case must stay documented')
  assert.match(
    doc,
    /specific to the route that\s+copies a directory and builds it/i,
    'the failure must be attributed to the copying-and-building route',
  )
  assert.doesNotMatch(
    doc,
    /cannot be installed at all/i,
    'the blanket claim must not come back',
  )
})

test('the document does not claim the package is on npm', () => {
  // Until #52 is decided, no route may promise an install that does not exist.
  assert.match(
    doc,
    /not currently\s+published to npm/i,
    'INSTALLATION.md must not imply an npm install is available today',
  )
})

test('the supported path is still stated as the local path, not npm', () => {
  assert.match(doc, /One supported way to install this plugin/i)
  assert.match(doc, /absolute\s+local path/i)
})