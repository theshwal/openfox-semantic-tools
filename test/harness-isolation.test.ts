import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PROJECT = resolve(import.meta.dirname, '..')
const HARNESS = resolve(PROJECT, 'scripts/openfox-harness.ts')
const SETUP = resolve(PROJECT, 'scripts/setup-harness.sh')
const HARNESS_PKG_DIR = process.env.HARNESS_PKG_DIR ?? '/tmp/of-harness-probe'
const openfoxInstalled = existsSync(joinPkg('node_modules/openfox/package.json'))

function joinPkg(relative: string): string {
  return resolve(HARNESS_PKG_DIR, relative)
}

test('the harness never points at the developer OpenFox install', () => {
  const source = readFileSync(HARNESS, 'utf8')
  // A harness that read or wrote the personal config, auth or sessions DB would
  // be out of bounds. Fail loudly if such a path is ever hard-coded.
  for (const forbidden of ['~/.config/openfox', '.local/share/openfox', 'sessions.db']) {
    assert.ok(!source.includes(forbidden), `harness must not reference ${forbidden}`)
  }
  // Isolation is expressed only through the XDG/HOME environment overrides.
  assert.match(source, /XDG_CONFIG_HOME/)
  assert.match(source, /XDG_DATA_HOME/)
  assert.match(source, /HOME: home/)
})

test('the harness states what it does and does not prove', () => {
  const source = readFileSync(HARNESS, 'utf8')
  assert.match(source, /WHAT THIS PROVES/)
  assert.match(source, /WHAT THIS DOES NOT PROVE/)
  // It must not claim an end-to-end run it cannot perform.
  assert.match(source, /NOT a live provider run/)
  assert.match(source, /NOT a tool execution/)
  assert.match(source, /NOT an `allowedTools` enforcement check/)
})

test('the harness removes its temporary tree even on failure', () => {
  const source = readFileSync(HARNESS, 'utf8')
  const finallyBlock = source.slice(source.indexOf('} finally {'))
  assert.match(finallyBlock, /rm\(root, \{ recursive: true, force: true \}\)/)
  assert.match(finallyBlock, /stub\.close\(\)/)
  assert.match(finallyBlock, /SIGKILL/)
})

test('the port is reserved from the OS, never a random draw', () => {
  const source = readFileSync(HARNESS, 'utf8')
  // OpenFox 2.0.160 probes `[preferred, fallback, preferred+1, ...]` and never
  // asks the kernel for port 0, so the harness must reserve the port itself.
  assert.match(source, /probe\.listen\(0, '127\.0\.0\.1'/)
  assert.ok(
    !/Math\.random\(\) \* \d+/.test(source),
    'the port must not be picked with Math.random()',
  )
})

test('the harness asserts the absence of hooks and transitions', () => {
  const source = readFileSync(HARNESS, 'utf8')
  // Asserted against the host's own contribution counts, not against intent.
  assert.match(source, /listed\.contributions\?\.hooks === 0/)
  assert.match(source, /listed\.contributions\?\.transitions === 0/)
})

test('the setup script installs OpenFox into a throwaway tree only', () => {
  const setup = readFileSync(SETUP, 'utf8')
  assert.match(setup, /HARNESS_PKG_DIR:-\/tmp\/of-harness-probe/)
  assert.match(setup, /npm rebuild better-sqlite3/)
  // The install must not run package scripts implicitly.
  assert.match(setup, /--ignore-scripts/)
  assert.ok(!setup.includes('sudo'), 'the setup must not escalate privileges')
})

test('the harness fails with an actionable message when OpenFox is absent', async () => {
  const exitCode = await new Promise<number>((done) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'scripts/openfox-harness.ts'],
      {
        cwd: PROJECT,
        env: { ...process.env, HARNESS_PKG_DIR: '/tmp/of-harness-does-not-exist' },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    )
    let stderr = ''
    child.stderr.on('data', (c: Buffer) => (stderr += String(c)))
    child.on('exit', (c) => done(c ?? 1))
    setTimeout(() => child.kill('SIGKILL'), 60_000)
  })
  assert.notEqual(exitCode, 0)
})

test(
  'the harness passes against a real isolated OpenFox host',
  { skip: openfoxInstalled ? false : 'openfox not installed in the harness tree; run scripts/setup-harness.sh' },
  async () => {
    const { code, stdout } = await new Promise<{ code: number; stdout: string }>((done) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'scripts/openfox-harness.ts'],
        {
          cwd: PROJECT,
          env: { ...process.env, HARNESS_PKG_DIR },
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      )
      let out = ''
      child.stdout.on('data', (c: Buffer) => (out += String(c)))
      child.on('exit', (c) => done({ code: c ?? 1, stdout: out }))
      setTimeout(() => child.kill('SIGKILL'), 180_000)
    })
    const failures = stdout.split('\n').filter((l) => l.startsWith('FAIL'))
    assert.deepEqual(failures, [], `harness reported failures:\n${failures.join('\n')}`)
    assert.match(stdout, /Harness: \d+\/\d+ checks passed/)
  },
)
