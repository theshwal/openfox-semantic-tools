import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { compatibilityBaseline } from './helpers/baseline.ts'

/**
 * The `openfox/plugin` types this plugin imports are a HAND-MAINTAINED mirror
 * (`src/openfox-plugin.d.ts`), because the host package is an optional peer
 * dependency and CI installs no OpenFox.
 *
 * A mirror can silently fall behind: a field added upstream simply does not
 * exist locally, so a plugin that starts using it fails to compile with a
 * confusing error instead of a clear one. This test reads the REAL
 * declarations from an installed `openfox` at the declared baseline — when
 * `scripts/setup-harness.sh` has been run — and fails if the mirror drifted.
 *
 * Skipped when no OpenFox tree is present, so the offline suite stays green
 * with no credentials and no network. It is a guard against drift, never a
 * substitute for re-reading upstream before a contribution changes.
 */

// The version under test is the DECLARED baseline, read from package.json, so
// raising the baseline needs no edit here.
const VERSION = await compatibilityBaseline()
const HARNESS_PKG_DIR = process.env.HARNESS_PKG_DIR ?? `/tmp/of-harness-${VERSION}`
const DIST = join(HARNESS_PKG_DIR, 'node_modules/openfox/dist')

/**
 * Reads the real upstream declarations.
 *
 * `openfox/plugin` resolves to `dist/plugin/index.d.ts`, which re-exports the
 * shapes from a hashed bundle. Both are searched, because the plugin entry
 * re-exports types rather than declaring them, so the actual property lists
 * live in the bundle.
 */
async function readUpstream(symbol: string): Promise<string> {
  const { readdir } = await import('node:fs/promises')
  const candidates = [
    join(DIST, 'plugin/index.d.ts'),
    ...(await readdir(DIST))
      .filter((name) => name.endsWith('.d.ts'))
      .map((name) => join(DIST, name)),
  ]
  // The plugin entry only re-exports the symbol; the bundle declares it. Both
  // are accepted, but a file that actually DECLARES the interface wins, so the
  // property list is read from the real body rather than an export list.
  let fallback: string | undefined
  for (const file of candidates) {
    if (!existsSync(file)) continue
    const text = await readFile(file, 'utf8')
    if (!text.includes(symbol)) continue
    if (new RegExp(`(interface|type)\\s+${symbol}\\b`).test(text)) return text
    fallback ??= text
  }
  if (fallback !== undefined) return fallback
  throw new Error(`no declaration file declaring ${symbol} under ${DIST}`)
}

const mirror = await readFile(
  resolve(import.meta.dirname, '../src/openfox-plugin.d.ts'),
  'utf8',
)

const available = existsSync(DIST)
const options = available ? {} : { skip: `openfox@${VERSION} is not installed in ${HARNESS_PKG_DIR}` }

test('the mirrored settings field keeps every property upstream declares', options, async () => {
  const upstream = await readUpstream('PluginSettingsField')
  // The block between the interface header and its closing brace.
  const block = /interface PluginSettingsField \{([\s\S]*?)\n\}/.exec(upstream)?.[1]
  assert.ok(block, 'upstream PluginSettingsField must be readable')

  const properties = [...block.matchAll(/^\s{4}(\w+)\??:/gm)].map((m) => m[1])
  assert.ok(properties.length > 20, `only ${properties.length} upstream properties parsed`)

  const missing = properties.filter((name) => !new RegExp(`\\b${name}\\??:`).test(mirror))
  assert.deepEqual(missing, [], `src/openfox-plugin.d.ts is missing: ${missing.join(', ')}`)
})

test('the mirrored settings field type union matches upstream exactly', options, async () => {
  const upstream = await readUpstream('PluginSettingsField')
  // Anchored on the indent of a declaration line, and stopped at the end of
  // the line. The terminator is `;` in the bundled upstream `.d.ts` and absent
  // in our own `.d.ts`, so it is matched optionally.
  const readUnion = (text: string): string | undefined =>
    /^[ \t]*type:[ \t]*((?:'[^']+'\s*\|\s*)+'[^']+')[ \t]*;?[ \t]*$/m.exec(text)?.[1]
      .replace(/\s+/g, ' ')
      .trim()
  const upstreamUnion = readUnion(upstream)
  const mirrorUnion = readUnion(mirror)
  assert.ok(upstreamUnion, 'the upstream union must be readable')
  assert.ok(mirrorUnion, 'the mirrored union must be readable')
  assert.equal(mirrorUnion, upstreamUnion)
  // Guarded explicitly because it is the one field a new setting type breaks.
  for (const type of ['list', 'status', 'button']) {
    assert.ok(mirrorUnion.includes(`'${type}'`), `the mirror must accept the '${type}' field type`)
  }
})

test('the mirrored link button keeps every property upstream declares', options, async () => {
  const upstream = await readUpstream('PluginSettingsLinkButton')
  const block = /interface PluginSettingsLinkButton \{([\s\S]*?)\n\}/.exec(upstream)?.[1]
  assert.ok(block, 'upstream PluginSettingsLinkButton must be readable')
  const properties = [...block.matchAll(/^\s{4}(\w+)\??:/gm)].map((m) => m[1])
  assert.ok(properties.length >= 4)
  const missing = properties.filter((name) => !new RegExp(`\\b${name}\\??:`).test(mirror))
  assert.deepEqual(missing, [], `missing link-button properties: ${missing.join(', ')}`)
})

test('the mirrored message transform matches the released contract', options, async () => {
  const upstream = await readUpstream('PluginMessageTransform')
  for (const symbol of [
    'PluginMessageTransformContext',
    'PluginMessageTransformResult',
    'PluginMessageTransform',
    'registerMessageTransform',
  ]) {
    assert.ok(upstream.includes(symbol), `upstream must still declare ${symbol}`)
    assert.ok(mirror.includes(symbol), `the mirror must declare ${symbol}`)
  }
  // The context fields the transform actually reads.
  for (const field of ['sessionId', 'workdir', 'model', 'systemPrompt', 'signal']) {
    assert.ok(new RegExp(`\\b${field}\\??:`).test(mirror), `context must carry ${field}`)
  }
  // A transform must be able to report metadata, or the no-op reason is lost.
  assert.match(mirror, /metadata\?: Record<string, unknown>/)
})

test('the tool context is unchanged by the transform work', () => {
  // Deliberately offline: `PluginToolContext` is the one contract every tool
  // depends on, so it is asserted here unconditionally.
  const line = /export interface PluginToolContext \{([^}]*)\}/.exec(mirror)?.[1]
  assert.ok(line, 'PluginToolContext must stay declared')
  for (const field of ['sessionId', 'workdir', 'projectId', 'signal']) {
    assert.ok(new RegExp(`\\b${field}\\??:`).test(line), `PluginToolContext must keep ${field}`)
  }
})

test('the mirrored UI and RPC contributions exist in the released host', options, async () => {
  // `PluginRegistry` lives in the plugin entry while the UI shapes live in the
  // shared bundle, so each symbol is looked up where it is actually declared
  // rather than in one combined read.
  const registryUpstream = await readUpstream('PluginRegistry')
  for (const method of ['registerUiComponent', 'registerRpc', 'registerSettingsTab']) {
    assert.ok(
      new RegExp(`\\b${method}\\s*\\(`).test(registryUpstream),
      `the released host must still expose ${method}`,
    )
    assert.ok(new RegExp(`\\b${method}\\s*\\(`).test(mirror), `the mirror must declare ${method}`)
  }
  for (const symbol of ['PluginUiComponent', 'PluginUiContentSource', 'PluginSettingsTab', 'DeclarativeNode']) {
    const upstream = await readUpstream(symbol)
    assert.ok(upstream.includes(symbol), `upstream must still declare ${symbol}`)
    assert.ok(mirror.includes(symbol), `the mirror must declare ${symbol}`)
  }
})

test('the mirrored hook surface matches the released host', options, async () => {
  const registryUpstream = await readUpstream('PluginRegistry')
  assert.match(
    registryUpstream,
    /\bregisterHook\s*\(/,
    'the released host must still expose registerHook',
  )
  assert.match(mirror, /\bregisterHook\s*\(/, 'the mirror must declare registerHook')

  // The event union is NOT part of `PluginRegistry`: it is declared in the
  // shared types bundle, so it is read from its own declaration. Compared
  // member by member, because a subset compiles and then silently never
  // fires. See docs/HOOK-PAYLOADS.md.
  // Dotted identifiers, segments may repeat: `devserver.state.changed` has two
  // dots, and a naive `a.b` pattern would drop exactly the events most likely
  // to be mis-declared.
  const EVENT_NAME = /'([a-z]+(?:\.[a-z]+)+)'/g
  const eventsUpstream = await readUpstream('PluginHookEvent')
  const upstreamEvents = [...eventsUpstream.matchAll(EVENT_NAME)].map((m) => m[1]!)
  assert.ok(upstreamEvents.length >= 15, `only ${upstreamEvents.length} events parsed upstream`)
  for (const event of new Set(upstreamEvents)) {
    assert.ok(mirror.includes(`'${event}'`), `the mirror must declare the '${event}' event`)
  }
  // A mirror that INVENTS an event compiles and then never fires either way.
  const mirrored = [...mirror.matchAll(EVENT_NAME)].map((m) => m[1]!)
  const invented = [...new Set(mirrored)].filter(
    (event) => !new Set(upstreamEvents).has(event),
  )
  assert.deepEqual(invented, [], `the mirror declares events upstream does not: ${invented}`)

  // And the handler contract that makes observation powerless: it returns void.
  const handlerUpstream = await readUpstream('PluginHookHandler')
  assert.match(
    handlerUpstream,
    /PluginHookHandler\s*=\s*\(payload[^)]*\)\s*=>\s*void/,
    'a hook handler must still return void, or the plugin could decide something',
  )
  assert.match(mirror, /PluginHookHandler\s*=\s*\(payload[^)]*\)\s*=>\s*void/)

  // `data` is untyped upstream. Narrowing it in the mirror would let the plugin
  // read a field the host never promised to send.
  const payloadUpstream = await readUpstream('PluginHookPayload')
  assert.match(payloadUpstream, /data:\s*Record<string,\s*unknown>/)
  assert.match(mirror, /data:\s*Record<string,\s*unknown>/)
})

test('the zone the activity panel targets is a zone the host declares', options, async () => {
  const upstream = await readUpstream('PluginZoneId')
  // `stats.modal` is rendered by the 2.0.161 client; a zone the host declares
  // but never mounts would make the section silently invisible.
  assert.match(upstream, /'stats\.modal'/, 'stats.modal must be a declared zone upstream')
  const mirror = await readFile(
    resolve(import.meta.dirname, '../src/openfox-plugin.d.ts'),
    'utf8',
  )
  assert.match(mirror, /zone: string/)
})

test('the manifest declares the capabilities the host enforces for these contributions', async () => {
  // Offline and unconditional: the host rejects every RPC when a non-empty
  // capability list omits `rpc`, so this is a load-time failure, not a runtime
  // one, and CI installs no OpenFox.
  const manifest = JSON.parse(
    await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8'),
  ) as { openfox: { capabilities: string[] } }
  for (const capability of ['ui', 'rpc', 'hooks']) {
    assert.ok(
      manifest.openfox.capabilities.includes(capability),
      `package.json must declare the '${capability}' capability it uses`,
    )
  }
})
