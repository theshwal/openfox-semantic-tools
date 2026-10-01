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
 * - NOT a tool execution. The OpenFox release under test exposes no HTTP route
 *   to invoke a plugin tool: tools run inside the agent loop, which needs a
 *   live model turn and therefore a configured LLM provider.
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

import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

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

// openfox resolves configDir as `${XDG_CONFIG_HOME}/openfox`. The host copies a
// local-path install to `{configDir}/plugins/<basename(sourcePath)>`, so the
// target follows the project directory name and is NOT created here: letting the
// installer create it is the point.
const pluginRoot = join(configHome, 'openfox', 'plugins', basename(PROJECT))
await mkdir(join(configHome, 'openfox', 'plugins'), { recursive: true })

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

  // 2. Read the manifest from the real project directory, so the assertions
  //    below are about the tree a user would install, not a copy of it.
  const manifest = JSON.parse(await readFile(join(PROJECT, 'package.json'), 'utf8'))
  record(
    'manifest declares skills capability',
    manifest.openfox?.capabilities?.includes('skills') === true,
    `capabilities=${JSON.stringify(manifest.openfox?.capabilities)}`,
  )
  record(
    'the project directory carries the build config the installer needs',
    existsSync(join(PROJECT, 'tsconfig.json')) && typeof manifest.scripts?.build === 'string',
    `scripts.build=${JSON.stringify(manifest.scripts?.build)}`,
  )
  // The installer must build from source, so it needs a source tree. Installing
  // the PACKED artifact instead would prove nothing about the local-path recipe:
  // `npm pack` ships only `dist`/`README.md`/`docs`, with no `src/` and no
  // `tsconfig.json`. See docs/INSTALLATION.md.
  record(
    'the install source is a full checkout, not a packed tarball',
    existsSync(join(PROJECT, 'src')) && existsSync(join(PROJECT, 'tsconfig.json')),
    `PROJECT=${PROJECT}`,
  )

  // 3. Configure plugin settings for the stub endpoint, in the isolated DB only.
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    // The installer's `npm install` / `npm run build` inherit this environment.
    // An inherited prefix points npm at a real installation tree, so the build
    // would write outside the temporary HOME it is supposed to be confined to.
    // Both spellings are dropped (npm lowercases its config env); nothing else
    // is read, and no value is printed. This is isolation of the trial only.
    npm_config_prefix: undefined,
    NPM_CONFIG_PREFIX: undefined,
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
    {
      env: {
        ...env,
        // Without this the CLI re-executes itself with a larger heap, and that
        // grandchild outlives a kill aimed at the direct child.
        OPENFOX_HEAP_INCREASED: '1',
        // Explicit loopback override. The released host already resolves
        // `env.server.host ?? globalConfig.server.host ?? "127.0.0.1"` and the
        // seeded config sets server.host, so this is defence in depth, not a
        // fix for an observed exposure. The listener assertion below is what
        // actually proves the bind.
        OPENFOX_HOST: '127.0.0.1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
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

  // The real bind address is inspected, not inferred: a non-loopback bind would
  // publish this run's port beyond the machine. Fails closed when the listener
  // cannot be read, so a missing `ss` stops the run instead of passing it.
  const listener = await readListenerForPort(port)
  const loopbackOnly =
    listener !== null &&
    listener.length > 0 &&
    listener.every((e) => e.address === '127.0.0.1' || e.address === '::1')
  record(
    'the isolated host is bound to loopback only',
    loopbackOnly,
    listener === null
      ? `could not read the listener for port ${port}`
      : listener.length === 0
        ? `no listening socket found for port ${port}`
        : `listening on ${listener.map((e) => `${e.address}:${e.port}`).join(', ')}`,
  )
  if (!loopbackOnly) {
    server.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 500))
    server.kill('SIGKILL')
    throw new Error('refusing to continue: the isolated host is not loopback-only')
  }

  // 4. Install through the host's OWN public install route, from the full
  //    checkout at an absolute path. This is `POST /api/plugins/install` with
  //    `{ path }` (src/server/routes/plugins.ts), which calls
  //    `host.installFromPath()` -> `installPluginFromPath()` -> the copy plus
  //    `buildIfNeeded()` rebuild. Copying dist/ into the plugins directory by
  //    hand would skip the installer and prove nothing about it.
  const installRes = await fetch(`${base}/api/plugins/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: PROJECT }),
  })
  const installBody = (await installRes.json().catch(() => ({}))) as Record<string, any>
  record(
    'the host installer accepts a full checkout by absolute path',
    installRes.ok && installBody.success === true,
    `status=${installRes.status}${installBody.error ? ` error=${String(installBody.error).slice(0, 200)}` : ''}`,
  )
  if (!installRes.ok || installBody.success !== true) {
    throw new Error(`local-path install failed: ${JSON.stringify(installBody).slice(0, 500)}`)
  }
  // `installFromDirectory()` loads the package and calls `applyContributions()`
  // itself, so a loaded plugin needs no enable call and no host restart. This
  // asserts that end state rather than assuming it: the contributions below
  // must already be visible.
  record(
    'no enable step or host restart is needed after the install',
    installBody.plugin?.loaded === true,
    `diagnostic.loaded=${String(installBody.plugin?.loaded)}`,
  )
  // The installer must have produced the build itself. `buildIfNeeded()` runs
  // `npm install` then `npm run build` inside the COPY, so the built entry has
  // to exist under the plugins directory, not in the project we started from.
  const installedEntry = join(pluginRoot, 'dist', 'index.js')
  record(
    'the installer rebuilt the plugin inside its own copy',
    await exists(installedEntry),
    `entry=${installedEntry}`,
  )
  if (!(await exists(installedEntry))) {
    throw new Error(`the installer did not build dist/index.js at ${installedEntry}`)
  }

  const pluginsRes = await fetch(`${base}/api/plugins`)
  const pluginsBody: unknown = await pluginsRes.json()
  if (process.env.HARNESS_DEBUG) console.log('GET /api/plugins ->', JSON.stringify(pluginsBody).slice(0, 2000))
  const plugins = Array.isArray(pluginsBody)
    ? (pluginsBody as Array<Record<string, any>>)
    : ((pluginsBody as any)?.plugins ?? [])
  const listed = plugins.find(
    (p: Record<string, any>) => p.packageName === PLUGIN_NAME || p.id === PLUGIN_NAME,
  )
  // The installer names the directory after the source basename, but the host
  // keys the API by the manifest packageName. Using the reported id keeps the
  // settings/tool URLs correct whichever directory the source was cloned into.
  const pluginId = String(listed?.packageName ?? listed?.id ?? PLUGIN_NAME)
  record(
    'plugin is discovered by the real host',
    Boolean(listed),
    listed ? `source=${listed.source} id=${pluginId}` : 'not present in /api/plugins',
  )
  if (listed) {
    record('plugin is loaded by the real host', listed.loaded === true, `loaded=${listed.loaded}`)
    // Asserted as a LOWER BOUND, not an exact count: the plugin legitimately
    // gained tools in later lots, and pinning the total would fail this harness
    // for an unrelated reason. What must hold is that the four original
    // decision tools are registered (their own behaviour is covered by
    // `npm run harness:agent-e2e`) and that exactly one skill source ships.
    record(
      'host reports the tool, skill and settings contributions',
      (listed.contributions?.tools ?? 0) >= 4 &&
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

  // 6. Tools discovered through the host's own plugin tool registry.
  //    `GET /api/plugins/tools` is `{ tools: host.getPluginTools() }`
  //    (src/server/routes/plugins.ts), and each entry carries the owning
  //    `pluginId`. `/api/tools` reads a different, session-scoped registry, so
  //    it is not evidence that a plugin contributed anything. Filtering on the
  //    `pluginId` the host actually reported avoids attributing another
  //    plugin's tools to this one, whatever the checkout directory is named.
  const toolsRes = await fetch(`${base}/api/plugins/tools`)
  const toolsBody: unknown = await toolsRes.json()
  if (process.env.HARNESS_DEBUG) console.log('GET /api/plugins/tools ->', JSON.stringify(toolsBody).slice(0, 2000))
  const tools = Array.isArray(toolsBody)
    ? (toolsBody as Array<Record<string, any>>)
    : ((toolsBody as any)?.tools ?? [])
  const ownTools = tools.filter((t: Record<string, any>) => t.pluginId === pluginId)
  const toolNames = ownTools.map((t: Record<string, any>) => t.name ?? t.id)
  record(
    'semantic tools are registered by the real host',
    toolNames.includes('semantic_decide') && toolNames.includes('semantic_verify_task'),
    `pluginId=${pluginId} tools=${toolNames.join(',') || 'none'}`,
  )

  // 7. A real tool invocation through the host, against the local stub.
  //    Configuration is written into the isolated store only.
  const configured = await configureEndpoint(base, env, stub.url, apiKey, pluginId)
  record('plugin settings stored in the isolated instance', configured.ok, configured.detail)

  if (configured.ok) {
    // A plugin tool is executed by the agent loop, not by an HTTP route: the
    // real host exposes no `/tools/:name` endpoint. Invoking it here would need
    // a live model turn, which needs a configured LLM provider. That is out of
    // scope, so the harness records what it can actually prove and says so.
    const hasToolRoute = await fetch(
      `${base}/api/plugins/${pluginId}/tools/semantic_verify_task`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    )
      .then((r) => r.ok)
      .catch(() => false)
    record(
      'tool execution is not reachable over HTTP (expected: agent loop only)',
      hasToolRoute === false,
      `no /tools/:name route exists in OpenFox ${installedVersion}; executing the tool requires a live model turn`,
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
        // Read back from the installed tree, never hardcoded, so the report can
        // only ever name the release the host actually ran.
        openfoxVersion: installedVersion,
        isolation: {
          // No personal config, auth or session DB was read or written.
          home: 'temporary tree',
          configHome: 'temporary tree',
          dataHome: 'temporary tree',
          productionConfigTouched: false,
        },
        scope:
          `Real OpenFox ${installedVersion} host: manifest validation, ESM import of the built entry, register(), skill and tool discovery, settings persistence. ` +
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
 * Reads the real listening socket for a port, so the bind address is observed
 * rather than assumed. `ss` is not guaranteed to exist, so this is best-effort:
 * when it cannot be read the caller fails closed rather than assuming loopback.
 * Same approach as `scripts/agent-e2e.ts`.
 */
async function readListenerForPort(port: number): Promise<Array<{ address: string; port: number }> | null> {
  const stdout = await new Promise<string>((resolveOut) => {
    execFile('ss', ['-ltnpH'], { encoding: 'utf8', timeout: 10_000 }, (err, out) =>
      resolveOut(err ? '' : String(out)),
    )
  })
  if (!stdout) return null
  return stdout
    .split('\n')
    .filter((line) => new RegExp(`:${port}\\s`).test(line) || new RegExp(`:${port}$`).test(line.trim()))
    .map((line) => {
      const local = line.trim().split(/\s+/)[3] ?? ''
      const [address, portText] = local.startsWith('[')
        ? [local.slice(1, local.indexOf(']')), local.slice(local.indexOf(']') + 2)]
        : local.split(':')
      return { address: address || 'unknown', port: Number(portText) }
    })
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
  pluginId: string,
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
  const res = await fetch(`${base}/api/plugins/${pluginId}/settings`, {
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
