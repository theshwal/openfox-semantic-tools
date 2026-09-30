import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { access, mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { ADVISORY_VERIFICATION_WORKFLOW } from '../src/workflow/templates.ts'
import { fakeRegistry } from './helpers/registry.ts'

const PROJECT = resolve(import.meta.dirname, '..')
const HARNESS_PKG_DIR = process.env.HARNESS_PKG_DIR ?? '/tmp/of-harness-probe'
const WORKFLOW_ID = ADVISORY_VERIFICATION_WORKFLOW.metadata.id

function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const guard = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 240_000)
    child.stdout.on('data', (c: Buffer) => (stdout += String(c)))
    child.stderr.on('data', (c: Buffer) => (stderr += String(c)))
    child.on('exit', (code) => {
      clearTimeout(guard)
      done({ code: code ?? 1, stdout, stderr })
    })
  })
}

test('the workflow CLI is a compiled entry point, not a dev script', async () => {
  const manifest = JSON.parse(await readFile(join(PROJECT, 'package.json'), 'utf8')) as {
    bin?: Record<string, string>
    files?: string[]
  }
  // A public bin entry, shipped through the published files list.
  assert.equal(manifest.bin?.['openfox-semantic-workflow'], './dist/workflow/emit.js')
  assert.ok(manifest.files?.includes('dist'), 'dist must be published')
  // The emitter must live under src/ so it is compiled, not run through tsx.
  const source = await readFile(join(PROJECT, 'src', 'workflow', 'emit.ts'), 'utf8')
  assert.match(source, /^#!\/usr\/bin\/env node/, 'the compiled file needs its shebang')
  // And no dev-only runtime is imported by the shipped path.
  assert.ok(!source.includes('tsx'), 'the shipped CLI must not need a TypeScript runtime')
})

test('the installed package runs the CLI with no dev dependencies', async () => {
  // Build and pack failures must FAIL this test, never skip it: a packaging
  // regression would otherwise show up as a green suite. Only a genuinely
  // external precondition may skip, and this one cannot.
  const build = await run('npm', ['run', 'build'], { cwd: PROJECT })
  assert.equal(build.code, 0, `npm run build failed:\n${build.stderr.slice(0, 800)}`)

  const pack = await run('npm', ['pack', '--pack-destination', PROJECT], { cwd: PROJECT })
  assert.equal(pack.code, 0, `npm pack failed:\n${pack.stderr.slice(0, 800)}`)
  // npm prints the tarball name relative to the destination: resolve it, since
  // the install below runs from a different directory.
  const tarball = resolve(PROJECT, pack.stdout.trim().split('\n').filter((l) => l.endsWith('.tgz')).at(-1) ?? '')
  assert.ok(existsSync(tarball), `npm pack must produce a tarball at ${tarball}`)

  const root = await mkdtemp(join(tmpdir(), 'workflow-pkg-'))
  try {
    // A consumer directory with its own manifest and NO dev dependency at all.
    const consumer = join(root, 'consumer')
    await mkdir(consumer, { recursive: true })
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', version: '1.0.0', private: true }))
    // --omit=dev keeps the install to production dependencies only.
    const install = await run(
      'npm',
      ['install', tarball, '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'],
      { cwd: consumer, timeoutMs: 180_000 },
    )
    assert.equal(install.code, 0, install.stderr.slice(0, 800))

    const pkgDir = join(consumer, 'node_modules', 'openfox-semantic-tools')
    // The shipped tree must contain the compiled CLI and no TypeScript sources.
    await access(join(pkgDir, 'dist', 'workflow', 'emit.js'))
    const shipped = await readdir(join(pkgDir, 'dist', 'workflow'))
    assert.ok(shipped.includes('emit.js'), 'the compiled CLI must be shipped')

    // Run the real published bin, with dev dependencies absent.
    const out = join(root, 'workflows')
    const cli = await run(
      process.execPath,
      [join(pkgDir, 'dist', 'workflow', 'emit.js'), '--out', out],
      { cwd: consumer, env: { PATH: process.env.PATH ?? '' } },
    )
    assert.equal(cli.code, 0, cli.stderr.slice(0, 800))

    const emitted = JSON.parse(await readFile(join(out, `${WORKFLOW_ID}.workflow.json`), 'utf8'))
    assert.equal(emitted.metadata.id, WORKFLOW_ID)
    assert.equal(emitted.entryStep, ADVISORY_VERIFICATION_WORKFLOW.entryStep)
    assert.equal(emitted.steps.length, ADVISORY_VERIFICATION_WORKFLOW.steps.length)
    // The advisory guarantee survives packaging.
    assert.deepEqual(
      emitted.steps.at(-1)!.transitions,
      [{ when: { type: 'always' }, goto: '$done' }],
      'only the verifier may terminate the workflow',
    )
    await rm(tarball, { force: true })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a real OpenFox host loads the workflow file the packaged CLI writes', async (t) => {
  const cliPath = join(HARNESS_PKG_DIR, 'node_modules/openfox/dist/cli/index.js')
  // Skipping here is only legitimate for a genuinely external precondition:
  // the harness package tree is not part of this repository. A build or pack
  // failure must never be a skip, and never is in this file.
  try {
    await access(cliPath)
  } catch {
    t.skip('openfox not installed in the harness tree')
    return
  }

  const build = await run('npm', ['run', 'build'], { cwd: PROJECT })
  assert.equal(build.code, 0, build.stderr.slice(0, 800))

  const root = await mkdtemp(join(tmpdir(), 'openfox-workflow-'))
  const configHome = join(root, 'config')
  const dataHome = join(root, 'data')
  const home = join(root, 'home')
  for (const dir of [configHome, dataHome, home]) await mkdir(dir, { recursive: true })

  // The documented user tier: {configDir}/workflows/{id}.workflow.json
  const workflowsDir = join(configHome, 'openfox', 'workflows')
  await mkdir(workflowsDir, { recursive: true })
  const emitted = await run(
    process.execPath,
    [join(PROJECT, 'dist', 'workflow', 'emit.js'), '--out', workflowsDir],
    { cwd: PROJECT },
  )
  assert.equal(emitted.code, 0, emitted.stderr)

  const port = 12100 + Math.floor(Math.random() * 300)
  await writeFile(
    join(configHome, 'openfox', 'config.json'),
    JSON.stringify({
      providers: [],
      mcpServers: [],
      server: { port, host: '127.0.0.1', openBrowser: false },
      logging: { level: 'error' },
      database: { path: '' },
      workspace: { workdir: root },
    }),
  )
  const child = spawn(process.execPath, [cliPath, '--port', String(port), '--no-browser'], {
    env: {
      HOME: home,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
      PATH: process.env.PATH ?? '',
      // Without this the CLI re-executes itself with a larger heap, and that
      // grandchild would outlive a kill aimed at the direct child.
      OPENFOX_HEAP_INCREASED: '1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let log = ''
  child.stderr.on('data', (c: Buffer) => (log += String(c)))
  try {
    const base = `http://127.0.0.1:${port}`
    let ready = false
    for (let i = 0; i < 100; i += 1) {
      try {
        if ((await fetch(`${base}/api/workflows`)).ok) {
          ready = true
          break
        }
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    assert.ok(ready, `the isolated host did not start:\n${log.slice(-1500)}`)

    const res = await fetch(`${base}/api/workflows`)
    assert.equal(res.status, 200)
    const body = (await res.json()) as Record<string, unknown>
    // The host groups workflows by tier: defaults, userItems, projectItems.
    const userItems = (body.userItems ?? []) as Array<Record<string, any>>
    const found = userItems.find((w) => w.id === WORKFLOW_ID)
    assert.ok(found, `the host did not load the workflow; saw ${userItems.map((w) => w.id).join(',')}`)
    // Loaded means parsed into the host's own model, not merely present on disk.
    assert.equal(found.scope, 'user', 'installed into the user tier')
    assert.equal(found.version, ADVISORY_VERIFICATION_WORKFLOW.metadata.version)
  } finally {
    child.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 500))
    child.kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
  }
})

test('the plugin itself registers nothing that could branch a workflow', async () => {
  const { register } = await import('../src/index.ts')
  const fake = fakeRegistry()
  const registry = fake.registry as unknown as Record<string, unknown>
  register(fake.registry)
  // The fake only implements settings, tools and skills: a transition handler or
  // a hook registration would throw, and neither exists here.
  assert.equal(registry.registerTransitionHandler, undefined)
  assert.equal(registry.registerHook, undefined)
  assert.equal(fake.skillSources.length, 1)
})
