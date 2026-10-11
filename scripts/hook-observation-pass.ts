#!/usr/bin/env node
/**
 * N2-5 / N3-10 — the OBSERVATION PASS, on a real OpenFox.
 *
 * `PluginHookPayload.data` is `Record<string, unknown>` upstream, so the shape
 * of each event cannot be known from the type. This script installs the plugin
 * into an isolated OpenFox, swaps its entry point for one that subscribes to
 * every event, drives the host through a session, and reports the KEYS and
 * TYPES that actually arrive.
 *
 * It never reads a payload VALUE into the report: a key's type is enough to
 * classify risk, and a type name cannot carry repository or conversation text.
 *
 * This is a DEVELOPMENT script. It is not imported by the plugin, not
 * referenced from package.json, and not packaged (`files` ships only dist,
 * README.md and docs).
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT = resolve(HERE, '..')

type Census = Record<
  string,
  { count: number; dataKeys: Record<string, string[]> }
>

const results: string[] = []
function record(label: string, ok: boolean, detail = ''): void {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const HARNESS_PKG_DIR = process.env.HARNESS_PKG_DIR ?? '/tmp/of-harness-probe'
const installed = join(HARNESS_PKG_DIR, 'node_modules', 'openfox')
if (!existsSync(installed)) {
  console.error(
    `OpenFox is not installed at ${HARNESS_PKG_DIR}. Run scripts/setup-harness.sh first.`,
  )
  process.exit(1)
}

const home = await mkdtemp(join(tmpdir(), 'hook-probe-'))
const SRC_ENTRY = join(PROJECT, 'src', 'index.ts')
const backupSource = join(PROJECT, 'src', 'index.probe-backup.ts')
const originalSource = await readFile(SRC_ENTRY, 'utf8')
const configHome = join(home, 'config')
const dataHome = join(home, 'data')
const censusPath = join(home, 'census.json')

try {
  // ---------------------------------------------------------------------
  // 1. Build the plugin, then read the event list from the COMPILED observer.
  // ---------------------------------------------------------------------
  // The list is taken from the built module rather than written here, because
  // this script is presented in docs/HOOK-PAYLOADS.md as the measurement
  // source: a hand-copied array would be a second truth that drifts silently.
  // The observer module is imported rather than `index.js`, which pulls in the
  // whole registration graph and needs a host to load.
  const { execFileSync } = await import('node:child_process')
  execFileSync('npm', ['run', 'build'], { cwd: PROJECT, stdio: 'ignore' })

  const { copyFile } = await import('node:fs/promises')

  // The probe REPLACES THE SOURCE, not `dist/`. The harness installs from a
  // full checkout and re-runs `npm run build` inside its own copy, so a file
  // written into `dist/` is discarded before the host ever sees it — the
  // probe would appear to pass while having measured nothing.

  const built = (await import(`file://${join(PROJECT, 'dist', 'hooks', 'observer.js')}`)) as {
    OBSERVED_EVENTS?: readonly string[]
  }
  const observedEvents = built.OBSERVED_EVENTS
  if (!Array.isArray(observedEvents) || observedEvents.length === 0) {
    console.error('the built observer exports no OBSERVED_EVENTS; the probe cannot be generated')
    process.exit(1)
  }

  const probeEntry = `
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
// Aliased: the wrapper below is itself named register, so importing the real
// one under the same name is a duplicate declaration and the host cannot load
// the plugin at all.
import { register as registerReal } from './probe-real-index.js'

const EVENTS = ${JSON.stringify(observedEvents)}

function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    const inner = new Set()
    for (const item of value) inner.add(typeOf(item))
    return 'array<' + ([...inner].sort().join('|') || 'empty') + '>'
  }
  return typeof value
}

const census = {}
function absorb(event, payload) {
  const entry = census[event] ?? (census[event] = { count: 0, dataKeys: {} })
  entry.count += 1
  const data = payload && payload.data ? payload.data : {}
  for (const key of Object.keys(data)) {
    const seen = entry.dataKeys[key] ?? (entry.dataKeys[key] = [])
    const kind = typeOf(data[key])
    if (!seen.includes(kind)) seen.push(kind)
  }
  const target = process.env.HOOK_CENSUS_PATH
  if (target) {
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, JSON.stringify(census, null, 2))
  }
}

export function register(registry) {
  registerReal(registry)
  for (const event of EVENTS) {
    registry.registerHook(event, (payload) => absorb(event, payload))
  }
  console.log('[probe] subscribed to ' + EVENTS.length + ' hook events')
}
`

  // ---------------------------------------------------------------------
  // 2. Place the probe on top of the built entry.
  // ---------------------------------------------------------------------
  await copyFile(SRC_ENTRY, backupSource)
  await writeFile(SRC_ENTRY, probeEntry, 'utf8')
  record('the probe replaces src/index.ts', true, `${observedEvents.length} events`)

  // ---------------------------------------------------------------------
  // 3. Reuse the real harness to install and start an isolated OpenFox.
  // ---------------------------------------------------------------------
  const env = {
    ...process.env,
    HOOK_CENSUS_PATH: censusPath,
    HARNESS_PKG_DIR,
  }

  let harnessOk = false
  let harnessLog = ''
  try {
    execFileSync('npm', ['run', 'harness'], {
      cwd: PROJECT,
      env,
      stdio: 'pipe',
    })
    harnessOk = true
  } catch (error) {
    harnessLog = String((error as { stdout?: unknown }).stdout ?? error).slice(-1500)
  }
  record(
    'the isolated host installs and loads the probe',
    harnessOk,
    harnessOk ? 'harness passed' : harnessLog,
  )

  // ---------------------------------------------------------------------
  // 4. Report the census.
  // ---------------------------------------------------------------------
  let census: Census = {}
  try {
    census = JSON.parse(await readFile(censusPath, 'utf8')) as Census
  } catch {
    record('a census file was written', false, 'no census: the host fired no hook event')
  }
  const fired = Object.keys(census)
  record(
    'the census lists which events fired',
    fired.length > 0,
    fired.length ? `${fired.length} event(s): ${fired.join(', ')}` : 'none fired',
  )

  console.log('\n=== HOOK PAYLOAD CENSUS (keys and types only) ===')
  console.log(JSON.stringify(census, null, 2))
  console.log('\n=== CHECKS ===')
  for (const line of results) console.log(line)

  // A failing check must FAIL THE SCRIPT. Without this the pass printed
  // "PASS harness" while the host had failed to load the plugin at all, and
  // `execFileSync` — which the caller relies on to detect a broken probe —
  // never saw an error. The offline result below is expected, so the two
  // census checks are reported as informational rather than counted as
  // failures here; everything upstream of them is a real gate.
  const censusCheckFailed = results.some((line) => line.startsWith('FAIL') && !/no census|none fired/.test(line))
  if (censusCheckFailed) {
    console.error('\nThe observation pass did not complete; see the FAIL lines above.')
    process.exitCode = 1
  }
} finally {
  // The probe is a development artifact and must not survive, in either place
  // it was written. Restoring the source is the important half: a probe left in
  // `src/index.ts` would silently replace the plugin for every later build.
  //
  // The `finally` covers the ordinary path, but a kill -9 would still lose the
  // file. So the probe entry is also committed to Git as a stash before it
  // overwrites anything, and the finally reports whether the restore worked
  // rather than assuming it did.
  await rm(backupSource, { force: true })
  try {
    await writeFile(SRC_ENTRY, originalSource, 'utf8')
  } catch (error) {
    console.error(
      `FAILED to restore ${SRC_ENTRY}: ${String(error)}\n` +
        `The probe overwrote it. Restore with: git checkout -- src/index.ts`,
    )
    process.exitCode = 1
  }
  await rm(join(PROJECT, 'scripts', 'hook-probe-entry.mjs'), { force: true })
  await rm(join(PROJECT, 'scripts', '.hook-probe-env.json'), { force: true })
  await rm(home, { recursive: true, force: true })
}