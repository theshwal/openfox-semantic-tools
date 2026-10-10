import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { register, SETTINGS } from '../src/index.ts'
import { fakeRegistry } from './helpers/registry.ts'

/**
 * `docs/USER-GUIDE.md` is the document an operator trusts before installing.
 * Its most damaging failure mode is not being incomplete — it is asserting a
 * guarantee the code does not actually keep.
 *
 * These tests assert the guide's load-bearing CLAIMS against the source. They
 * deliberately do not check prose or formatting.
 */
const GUIDE = resolve(import.meta.dirname, '../docs/USER-GUIDE.md')

test('every registered tool is documented in the user guide', async () => {
  const { registry, tools } = fakeRegistry()
  register(registry)
  const guide = await readFile(GUIDE, 'utf8')
  for (const name of tools.keys()) {
    assert.ok(guide.includes(name), `the user guide must document ${name}`)
  }
})

test('every documented setting key exists, and the guide names no phantom one', async () => {
  const guide = await readFile(GUIDE, 'utf8')
  const keys = new Set(SETTINGS.fields.map((field) => field.key))
  // The keys the guide tells an operator to configure.
  for (const key of ['endpoint', 'apiKey', 'endpointClass', 'egressPolicy', 'contextReduce', 'cacheEnabled']) {
    assert.ok(keys.has(key), `${key} is documented but is not a setting`)
  }
  // And no backticked `camelCase` word may be presented as a setting that does
  // not exist, which is how a guide starts sending people chasing ghosts.
  const claimed = [...guide.matchAll(/`(egressPolicy|endpointClass|contextReduce|cacheEnabled|cacheTtlMs|cacheMaxEntries|apiKey|endpoint|backend|model|runtimeVersion|allowedTools)`/g)]
    .map((match) => match[1]!)
  const known = new Set([...keys, 'allowedTools'])
  const unknown = [...new Set(claimed.filter((name) => !known.has(name)))]
  assert.deepEqual(unknown, [], `the guide names settings that do not exist: ${unknown.join(', ')}`)
})

test('the guarantees the guide advertises are the ones the code keeps', async () => {
  const guide = await readFile(GUIDE, 'utf8')
  const source = await readFile(resolve(import.meta.dirname, '../src/index.ts'), 'utf8')

  // "Never branches a workflow on a semantic result."
  assert.equal(
    /registerTransitionHandler|registerHook/.test(source),
    false,
    'the guide promises no transition handler and no hook; the plugin must register neither',
  )
  // "The current request is never deleted."
  const messages = await readFile(resolve(import.meta.dirname, '../src/transform/messages.ts'), 'utf8')
  assert.match(
    messages,
    /liveWindowStart/,
    'the guide promises the live turn is never droppable; the segmenter must anchor it',
  )
  // "Redirects are refused."
  const provider = await readFile(resolve(import.meta.dirname, '../src/providers/system-one.ts'), 'utf8')
  assert.match(provider, /redirect: 'error'/)
  // "Error bodies are never reflected back."
  assert.ok(
    !/error:\s*\$\{await response\.text\(\)/.test(provider),
    'an upstream error body must never be echoed into an error',
  )
  // "API keys are never logged."
  assert.equal(/console\.(log|info|warn|error)/.test(provider), false, 'the transport must not log')

  // And the guide must actually make those claims, or the test is vacuous.
  for (const promise of ['never', 'allowedTools', 'egressPolicy']) {
    assert.ok(guide.includes(promise), `the guide should mention ${promise}`)
  }
})

test('the guide does not promise a saving that was never measured', async () => {
  const guide = await readFile(GUIDE, 'utf8')
  // The DEFER verdict must be visible to a reader deciding whether to enable
  // the transform; a guide that omits it invites a false expectation.
  assert.match(guide, /DEFER/, 'the guide must state the recorded verdict')
  assert.match(
    guide,
    /no token, cost or latency saving is claimed/i,
    'the guide must state that no saving is measured',
  )
  // It must not advertise a saving in its own voice.
  assert.equal(
    /saves \d|reduces tokens by|is \d+ (?:x|%) faster/i.test(guide),
    false,
    'the guide must not advertise an unmeasured saving',
  )
})

test('the guide points at the deep reference docs instead of duplicating them', async () => {
  const guide = await readFile(GUIDE, 'utf8')
  for (const doc of ['PROVIDERS.md', 'EVALUATION.md', 'ARCHITECTURE.md', 'INSTALLATION.md']) {
    assert.ok(guide.includes(doc), `the guide must link ${doc} for the deep detail`)
  }
})

test('the README points readers at the user guide', async () => {
  const readme = await readFile(resolve(import.meta.dirname, '../README.md'), 'utf8')
  assert.ok(readme.includes('docs/USER-GUIDE.md'), 'the README must link the user guide')
})

test('the README documents every registered tool and every setting', async () => {
  const { registry, tools } = fakeRegistry()
  register(registry)
  const readme = await readFile(resolve(import.meta.dirname, '../README.md'), 'utf8')
  for (const name of tools.keys()) {
    assert.ok(readme.includes(name), `the README must name ${name}`)
  }
  for (const field of SETTINGS.fields) {
    assert.ok(readme.includes(field.key), `the README must document the ${field.key} setting`)
  }
})

test('the README states the defaults it claims, matching the real schema', async () => {
  const readme = await readFile(resolve(import.meta.dirname, '../README.md'), 'utf8')
  // Each row of the settings table starts `| \`key\` |` and ends with the
  // default in its LAST column. A wrong default in the README sends operators
  // to the wrong first move, so it is compared against the schema, not trusted.
  for (const field of SETTINGS.fields) {
    if (field.default === undefined) continue
    const row = readme
      .split('\n')
      // Escaped backticks: they would otherwise close the template literal.
      .find((line) => new RegExp(`^\\|\\s*\\\`${field.key}\\\`\\s*\\|`).test(line))
    assert.ok(row, `no settings-table row found for ${field.key}`)
    const cells = row.split('|').map((cell) => cell.trim())
    // `| key | required | default | what |` → the default is the third cell.
    const stated = cells[3]?.replace(/[`*]/g, '').trim() ?? ''
    const actual = String(field.default)
    // An empty schema default may be spelled more informatively in the table:
    // `(empty)` and `(backend default)` both describe "no value configured",
    // and a blank cell is unreadable in rendered Markdown. Anything else must
    // match the schema exactly.
    const acceptable =
      actual === '' ? ['', '(empty)', '(backend default)', '(unset)', 'unset'] : [actual]
    assert.ok(
      acceptable.includes(stated),
      `${field.key}: README says "${stated}", the schema says "${actual}"`,
    )
  }
})

test('the README links only files that exist', async () => {
  const { existsSync } = await import('node:fs')
  const readme = await readFile(resolve(import.meta.dirname, '../README.md'), 'utf8')
  for (const match of readme.matchAll(/\]\((\.\/[^)#]+)\)/g)) {
    const target = resolve(import.meta.dirname, '..', match[1]!)
    assert.ok(existsSync(target), `README links a missing file: ${match[1]}`)
  }
})

test('every screenshot in the README exists and is inside the packed files', async () => {
  const { existsSync, statSync } = await import('node:fs')
  const { readFile: read } = await import('node:fs/promises')
  const readme = await read(resolve(import.meta.dirname, '../README.md'), 'utf8')
  const images = [...readme.matchAll(/!\[[^\]]*\]\((?:\.\/)?([^)]+\.png)\)/g)].map((m) => m[1]!)
  assert.ok(images.length > 0, 'the README is expected to show the plugin in the UI')

  const pkg = JSON.parse(
    await read(resolve(import.meta.dirname, '../package.json'), 'utf8'),
  ) as { files?: string[] }
  const packed = pkg.files ?? []

  for (const image of images) {
    const target = resolve(import.meta.dirname, '..', image)
    assert.ok(existsSync(target), `README references a missing screenshot: ${image}`)
    // A screenshot outside the `files` allowlist would render on GitHub and
    // 404 in the published package.
    const prefix = image.split('/')[0]!
    assert.ok(
      packed.includes(prefix),
      `${image} would not be packed: package.json "files" does not include "${prefix}"`,
    )
    // And it should be a real PNG, not a placeholder.
    const size = statSync(target).size
    assert.ok(size > 5000, `${image} is only ${size} bytes — likely a blank capture`)
  }
})