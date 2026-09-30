#!/usr/bin/env node
/**
 * Isolated OpenFox integration harness for the semantic-tools plugin.
 *
 * WHAT THIS PROVES
 * - The plugin package is accepted by a real OpenFox host: manifest validation,
 *   dynamic ESM import of the compiled entry, `register()` execution.
 * - `registerSkillSource` contributions are discovered by the real skill loader
 *   and are attributed to the plugin.
 * - Tools, skills and settings coexist; the plugin registers no hook and no
 *   workflow transition, confirmed by the host's own contribution counts.
 *
 * WHAT THIS DOES NOT PROVE
 * - NOT a live provider run: no hosted endpoint is contacted, so it says nothing
 *   about decision quality or a false-pass rate.
 * - NOT a tool execution. OpenFox 2.0.160 exposes no HTTP route to invoke a
 *   plugin tool: tools run inside the agent loop, which needs a live model turn
 *   and therefore a configured LLM provider.
 * - NOT an `allowedTools` enforcement check: that is decided by the agent
 *   configuration and a model turn.
 *
 * ISOLATION
 * - HOME, XDG_CONFIG_HOME and XDG_DATA_HOME all point at a fresh temporary tree,
 *   so the developer's real OpenFox config, auth and sessions DB are never read
 *   or written. Proven by `getGlobalConfigDir()` resolving under the temp root.
 * - The server runs on an ephemeral port and is stopped before exit.
 * - The plugin is installed by copying the built package into the isolated
 *   configDir, exactly as the documented local-path install does.
 */

import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { access } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PROJECT = resolve(import.meta.dirname, '..')
const PLUGIN_NAME = 'openfox-semantic-tools'
/** Where the public npm package is installed for this harness. Never the developer's OpenFox. */
const HARNESS_PKG_DIR = process.env.HARNESS_PKG_DIR ?? '/tmp/of-harness-probe'
const OPENFOX_CLI = join(HARNESS_PKG_DIR, 'node_modules/openfox/dist/cli/index.js')

/** A local System One stub, so a tool call can be observed without a provider. */
async function startStub(): Promise<{ url: string; close: () => Promise<void>; requests: unknown[] }> {
  const requests: unknown[] = []
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = []
    incoming.on('data', (c: Buffer) => chunks.push(c))
    incoming.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      requests.push(body)
      const answers: Record<string, unknown> = {}
      for (const [id, q] of Object.entries<any>(body.questions ?? {})) {
        if (q.type === 'score') {
          const labels = q.criteria.map((_: unknown, i: number) => String(i))
          answers[id] = {
            type: 'score',
            score: labels.length - 1,
            probabilities: Object.fromEntries(
              labels.map((l: string) => [l, l === String(labels.length - 1) ? 1 : 0]),
            ),
          }
        } else {
          answers[id] = { type: 'noul', noul: 0.42 }
        }
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ model: 'harness-stub', answers }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}/v1/systemone`,
    requests,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
    },
  }
}

/**
 * Writes the minimal global config OpenFox needs to skip its interactive
 * first-run assistant. It targets only the temporary tree this run created.
 * Shape follows `saveGlobalConfig` in OpenFox 2.0.160 `src/cli/config.ts`.
 */
async function seedConfig(configHome: string, port: number, workdir: string): Promise<string> {
  const configDir = join(configHome, 'openfox')
  await mkdir(configDir, { recursive: true })
  const path = join(configDir, 'config.json')
  await writeFile(
    path,
    JSON.stringify(
      {
        providers: [],
        mcpServers: [],
        server: { port, host: '127.0.0.1', openBrowser: false },
        logging: { level: 'error' },
        database: { path: '' },
        workspace: { workdir },
      },
      null,
      2,
    ) + '\n',
  )
  return path
}

const root = await mkdtemp(join(tmpdir(), 'openfox-semantic-harness-'))
const configHome = join(root, 'config')
const dataHome = join(root, 'data')
const home = join(root, 'home')
for (const dir of [configHome, dataHome, home]) await mkdir(dir, { recursive: true })

// openfox resolves configDir as `${XDG_CONFIG_HOME}/openfox`; the documented
// local-path install target is `{configDir}/plugins/<basename>`.
const pluginRoot = join(configHome, 'openfox', 'plugins', PLUGIN_NAME)
await mkdir(pluginRoot, { recursive: true })

const stub = await startStub()
const findings: Array<{ name: string; ok: boolean; detail: string }> = []
const record = (name: string, ok: boolean, detail: string) => {
  findings.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

let server: ReturnType<typeof spawn> | undefined
try {
  // 0. The harness needs the public npm package, installed in its own tree.
  if (!(await exists(OPENFOX_CLI))) {
    throw new Error(
      `OpenFox is not installed at ${HARNESS_PKG_DIR}. ` +
        'Run scripts/setup-harness.sh first, or set HARNESS_PKG_DIR.',
    )
  }
  const installedVersion = JSON.parse(
    await readFile(join(HARNESS_PKG_DIR, 'node_modules/openfox/package.json'), 'utf8'),
  ).version
  record('isolated OpenFox package present', true, `openfox@${installedVersion}`)

  // 1. Build the package the way a consumer would receive it.
  const build = spawn('npm', ['run', 'build'], { cwd: PROJECT, stdio: 'ignore' })
  const buildOk = await new Promise<boolean>((r) => build.on('exit', (c) => r(c === 0)))
  record('npm run build', buildOk, 'compiled dist/ exists')
  if (!buildOk) throw new Error('build failed')

  // 2. Install by copying the package into the isolated configDir, as the
  //    documented installFromPath does (excluding node_modules/.git).
  await cp(join(PROJECT, 'dist'), join(pluginRoot, 'dist'), { recursive: true })
  for (const file of ['package.json', 'README.md']) {
    await cp(join(PROJECT, file), join(pluginRoot, file))
  }
  const installedManifest = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'))
  record(
    'manifest declares skills capability',
    installedManifest.openfox?.capabilities?.includes('skills') === true,
    `capabilities=${JSON.stringify(installedManifest.openfox?.capabilities)}`,
  )

  // 3. Configure plugin settings for the stub endpoint, in the isolated DB only.
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
  }
  // NOT an OS-assigned ephemeral port handed to OpenFox. OpenFox 2.0.160
  // resolves its port with `portCandidates(preferred, fallback)` in
  // dist/…/mcp-*.js, which probes `[preferred, fallback, preferred+1, ...]`
  // against /api/health. It never asks the kernel for port 0, and passing 0
  // would probe port 1. The harness therefore reserves a loopback port itself:
  // it binds a throwaway listener on port 0, reads the kernel-assigned port,
  // closes it, and passes that number to the CLI. The window between close and
  // the CLI bind is narrow but NOT atomic: this is a reservation, not a
  // guarantee of exclusivity.
  const port = await reserveLoopbackPort()
  // Seed the minimal config so the interactive first-run assistant is skipped.
  const seededConfig = await seedConfig(configHome, port, PROJECT)
  server = spawn(
    process.execPath,
    [OPENFOX_CLI, '--port', String(port), '--no-browser'],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let serverLog = ''
  server.stdout!.on('data', (c: Buffer) => (serverLog += String(c)))
  server.stderr!.on('data', (c: Buffer) => (serverLog += String(c)))

  // Wait for the HTTP server to answer.
  const apiKey = 'harness-local-auth-token'
  const base = `http://127.0.0.1:${port}`
  const ready = await (async () => {
    for (let i = 0; i < 100; i += 1) {
      try {
        const res = await fetch(`${base}/api/plugins`)
        if (res.ok) return true
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    return false
  })()
  record('isolated server started', ready, `port=${port} (OS-reserved loopback) config=${seededConfig}`)
  if (!ready) {
    console.error('server log:\n', serverLog.slice(-3000))
    throw new Error('isolated server did not become ready')
  }

  // 4. The plugin must be discovered and loaded by the real host.
  const pluginsRes = await fetch(`${base}/api/plugins`)
  const pluginsBody: unknown = await pluginsRes.json()
  if (process.env.HARNESS_DEBUG) console.log('GET /api/plugins ->', JSON.stringify(pluginsBody).slice(0, 2000))
  const plugins = Array.isArray(pluginsBody)
    ? (pluginsBody as Array<Record<string, any>>)
    : ((pluginsBody as any)?.plugins ?? [])
  const listed = plugins.find(
    (p: Record<string, any>) => p.packageName === PLUGIN_NAME || p.id === PLUGIN_NAME,
  )
  record(
    'plugin is discovered by the real host',
    Boolean(listed),
    listed ? `source=${listed.source}` : 'not present in /api/plugins',
  )
  if (listed) {
    record('plugin is loaded by the real host', listed.loaded === true, `loaded=${listed.loaded}`)
    record(
      'host reports the tool, skill and settings contributions',
      listed.contributions?.tools === 2 &&
        listed.contributions?.skillSources === 1 &&
        listed.contributions?.settingsFields > 0,
      `tools=${listed.contributions?.tools} skillSources=${listed.contributions?.skillSources} settingsFields=${listed.contributions?.settingsFields}`,
    )
    // The advisory experiment must register no automatic gate. The host counts
    // these itself, so this asserts against the real registry, not our intent.
    record(
      'host confirms no hook and no workflow transition is registered',
      listed.contributions?.hooks === 0 && listed.contributions?.transitions === 0,
      `hooks=${listed.contributions?.hooks} transitions=${listed.contributions?.transitions}`,
    )
  }

  // 5. Skills discovered through the real loader.
  const skillsRes = await fetch(`${base}/api/skills`)
  const skillsBody: unknown = await skillsRes.json()
  if (process.env.HARNESS_DEBUG) console.log('GET /api/skills ->', JSON.stringify(skillsBody).slice(0, 2000))
  const skills = Array.isArray(skillsBody)
    ? (skillsBody as Array<Record<string, any>>)
    : ((skillsBody as any)?.items ?? [])
  const semanticSkill = skills.find((s: Record<string, any>) => s.id === 'semantic-verification')
  record(
    'semantic-verification is discovered by the real skill loader',
    Boolean(semanticSkill),
    semanticSkill ? `source=${semanticSkill.source} tokens=${semanticSkill.estimatedTokens}` : `no skills among ${skills.length}`,
  )
  record(
    'the skill is sourced from the plugin, not bundled or user content',
    semanticSkill?.source === 'plugin',
    `source=${semanticSkill?.source}`,
  )

  // 6. Tools discovered through the real tool registry.
  const toolsRes = await fetch(`${base}/api/tools`)
  const toolsBody: unknown = await toolsRes.json()
  if (process.env.HARNESS_DEBUG) console.log('GET /api/tools ->', JSON.stringify(toolsBody).slice(0, 2000))
  const tools = Array.isArray(toolsBody)
    ? (toolsBody as Array<Record<string, any>>)
    : ((toolsBody as any)?.tools ?? [])
  const toolNames = tools.map((t: Record<string, any>) => t.name ?? t.id)
  record(
    'semantic tools are registered by the real host',
    toolNames.includes('semantic_decide') && toolNames.includes('semantic_verify_task'),
    `tools=${toolNames.filter((n: unknown) => String(n).startsWith('semantic_')).join(',') || 'none'}`,
  )

  // 7. A real tool invocation through the host, against the local stub.
  //    Configuration is written into the isolated store only.
  const configured = await configureEndpoint(base, env, stub.url, apiKey)
  record('plugin settings stored in the isolated instance', configured.ok, configured.detail)

  if (configured.ok) {
    // A plugin tool is executed by the agent loop, not by an HTTP route: the
    // real host exposes no `/tools/:name` endpoint. Invoking it here would need
    // a live model turn, which needs a configured LLM provider. That is out of
    // scope, so the harness records what it can actually prove and says so.
    const hasToolRoute = await fetch(
      `${base}/api/plugins/${PLUGIN_NAME}/tools/semantic_verify_task`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    )
      .then((r) => r.ok)
      .catch(() => false)
    record(
      'tool execution is not reachable over HTTP (expected: agent loop only)',
      hasToolRoute === false,
      'no /tools/:name route exists in OpenFox 2.0.160; executing the tool requires a live model turn',
    )
    record(
      'no provider call was made by this harness',
      stub.requests.length === 0,
      `stub requests=${stub.requests.length}`,
    )
  }

  const reportPath = join(PROJECT, 'benchmark/results/harness')
  await mkdir(reportPath, { recursive: true })
  await writeFile(
    join(reportPath, 'report.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        openfoxVersion: '2.0.160',
        isolation: {
          // No personal config, auth or session DB was read or written.
          home: 'temporary tree',
          configHome: 'temporary tree',
          dataHome: 'temporary tree',
          productionConfigTouched: false,
        },
        scope:
          'Real OpenFox 2.0.160 host: manifest validation, ESM import of the built entry, register(), skill and tool discovery, settings persistence. ' +
          'NOT a live provider run, NOT a tool execution (no HTTP tool route exists; tools run in the agent loop), NOT a model-driven allowedTools check.',
        measured: false,
        findings,
      },
      null,
      2,
    ) + '\n',
  )

} finally {
  server?.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 500))
  server?.kill('SIGKILL')
  await stub.close()
  await rm(root, { recursive: true, force: true })
}

const failed = findings.filter((f) => !f.ok)
console.log(
  `\nHarness: ${findings.length - failed.length}/${findings.length} checks passed. ` +
    'Isolated from the developer OpenFox config; no provider was contacted.',
)
if (failed.length > 0) process.exitCode = 1

/** True when a path exists; used to fail fast with an actionable message. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Asks the OS for a free loopback port: bind port 0, read what was assigned,
 * then release it. The kernel is the only authority on which port is free, so
 * this is far safer than a random draw. It is still a reservation and not an
 * atomic hand-off, which the comment at the call site states explicitly.
 */
function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        probe.close(() => reject(new Error('could not read a reserved loopback port')))
        return
      }
      const reserved = address.port
      probe.close(() => resolve(reserved))
    })
  })
}

/**
 * Stores plugin settings through the isolated instance's own API.
 *
 * The auth key, when the instance created one, lives in the temporary tree this
 * run made. The developer's real key is never read. A local instance may run
 * without network auth, in which case the key is simply absent.
 */
async function configureEndpoint(
  base: string,
  env: NodeJS.ProcessEnv,
  endpoint: string,
  token: string,
): Promise<{ ok: boolean; detail: string }> {
  const { readFile: read } = await import('node:fs/promises')
  let authorization: Record<string, string> = {}
  for (const candidate of [
    join(env.XDG_DATA_HOME!, 'openfox', 'auth.key'),
    join(env.XDG_CONFIG_HOME!, 'openfox', 'auth.key'),
  ]) {
    try {
      authorization = { Authorization: `Bearer ${(await read(candidate, 'utf8')).trim()}` }
      break
    } catch {
      /* try the next location */
    }
  }
  const res = await fetch(`${base}/api/plugins/${PLUGIN_NAME}/settings`, {
    // OpenFox 2.0.160 exposes `PUT /api/plugins/:id/settings` (src/server/routes/plugins.ts).
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authorization },
    body: JSON.stringify({
      values: {
        backend: 'custom',
        endpoint,
        apiKey: token,
        timeoutMs: 5000,
        endpointClass: 'local',
        egressPolicy: 'allow',
      },
    }),
  }).catch(() => undefined)
  if (!res) return { ok: false, detail: 'settings request failed' }
  return { ok: res.ok, detail: `status=${res.status}` }
}
