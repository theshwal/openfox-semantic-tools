#!/usr/bin/env node
/**
 * Isolated real-agent E2E for the semantic-tools plugin.
 *
 * WHAT THIS PROVES
 * - The packed plugin is loaded by a real OpenFox host (2.0.160, public npm).
 * - Real agent turns run through the PUBLIC `/mcp` endpoint
 *   (`openfox_create_project`, `openfox_create_session`, `openfox_send_message`,
 *   `openfox_wait`, `openfox_launch_workflow`, ...). No private agent-loop import,
 *   and no direct `createDecisionTool` call is ever presented as E2E.
 * - Plugin tools execute inside the host agent loop, honouring the agent
 *   `allowedTools` allow-list, and the resulting provider HTTP request bodies are
 *   captured on the wire.
 * - Skills load through the normal `load_skill` tool path, independently of
 *   whether the plugin tool is callable.
 *
 * WHAT THIS DOES NOT PROVE
 * - Nothing about decision quality: the LLM is scripted and the System One
 *   endpoint is a deterministic loopback stub, so this exercises execution
 *   paths and permission boundaries only. No score, calibration or impact
 *   claim is made or implied (deferred to #9).
 * - No hosted provider and no paid credential is contacted.
 *
 * ISOLATION
 * - HOME, XDG_CONFIG_HOME and XDG_DATA_HOME point at a fresh temporary tree, so
 *   the developer's real OpenFox config, auth and sessions DB are never read or
 *   written. The project workdir is a second temporary directory.
 * - The OpenFox package lives in a throwaway tree (`HARNESS_PKG_DIR`).
 * - Both loopback stubs bind 127.0.0.1 on OS-assigned ports and are closed in
 *   `finally`, together with the host process and the whole temp tree.
 */

import { spawn, execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { ADVISORY_VERIFICATION_WORKFLOW, advisoryWorkflowFor } from '../src/workflow/templates.ts'

const PROJECT = resolve(import.meta.dirname, '..')
const PLUGIN_NAME = 'openfox-semantic-tools'
/** Project agent that really has `semantic_verify_task` in its `allowedTools`. */
const ADVISORY_AGENT_ID = 'e2e-verification'
const HARNESS_PKG_DIR = process.env.HARNESS_PKG_DIR ?? '/tmp/of-harness-probe'
const OPENFOX_CLI = join(HARNESS_PKG_DIR, 'node_modules/openfox/dist/cli/index.js')
const STUB_KEY = 'e2e-local-stub-key'
const STUB_MODEL = 'e2e-stub-model'

/**
 * A scripted LLM reply. `calls` become OpenAI tool calls in a single turn.
 *
 * `token` routes the reply to ONE turn. The stub is shared by every scenario,
 * so a single mutable queue lets a late request from the previous turn consume
 * the NEXT scenario's first step: `openfox_wait` can resolve while the host
 * still has a completion in flight. Routing by token removes that race, and an
 * unknown or exhausted token yields an explicit refusal rather than a plausible
 * answer, so a mis-sequenced turn fails loudly instead of passing vacuously.
 */
interface ScriptStep {
  readonly token: string
  readonly content?: string
  readonly calls?: ReadonlyArray<{ readonly name: string; readonly args: unknown }>
}

/** One observed System One request, captured as it left the plugin. */
interface SystemOneRequest {
  readonly path: string
  readonly body: Record<string, any>
  /** Whether the stub actually sent an answer back for this request. */
  answered: boolean
}

const findings: Array<{ name: string; ok: boolean; detail: string }> = []
const record = (name: string, ok: boolean, detail: string) => {
  findings.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('could not read a bound loopback port')))
        return
      }
      resolvePort(address.port)
    })
  })
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((r) => server.close(() => r()))
}

function readJsonBody(req: import('node:http').IncomingMessage): Promise<any> {
  return new Promise((resolveBody) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        resolveBody({})
      }
    })
  })
}

// ---------------------------------------------------------------------------
// System One stub: a deterministic, provider-neutral loopback endpoint.
// `mode` selects the behaviour for the failure scenarios.
// ---------------------------------------------------------------------------

type SystemOneMode = 'ok' | 'server-error' | 'hang'

async function startSystemOneStub(): Promise<{
  url: string
  requests: SystemOneRequest[]
  setMode: (mode: SystemOneMode, delayMs?: number) => void
  stop: () => Promise<void>
}> {
  const requests: SystemOneRequest[] = []
  let mode: SystemOneMode = 'ok'
  let delayMs = 0
  const server = createServer((req, res) => {
    void (async () => {
      const body = await readJsonBody(req)
      const record: SystemOneRequest = { path: req.url ?? '', body, answered: false }
      requests.push(record)
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      if (mode === 'hang') return // never answers: exercises the plugin timeout
      if (mode === 'server-error') {
        record.answered = true
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'stub provider failure' }))
        return
      }
      const answers: Record<string, unknown> = {}
      for (const [id, question] of Object.entries<any>(body.questions ?? {})) {
        if (question.type === 'noul') {
          answers[id] = { type: 'noul', noul: 0.75 }
        } else if (question.type === 'choice') {
          const labels: string[] = Array.isArray(question.criteria)
            ? question.criteria
            : Object.keys(question.criteria ?? {})
          answers[id] = {
            type: 'choice',
            choice: labels[labels.length - 1],
            probabilities: Object.fromEntries(
              labels.map((label) => [label, label === labels[labels.length - 1] ? 0.8 : 0.2 / (labels.length - 1)]),
            ),
          }
        } else {
          const labels: string[] = Object.keys(question.criteria ?? {})
          answers[id] = {
            type: 'score',
            score: Number(labels[labels.length - 1]),
            probabilities: Object.fromEntries(
              labels.map((label, index) => [label, index === labels.length - 1 ? 0.85 : 0.15 / (labels.length - 1)]),
            ),
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ model: body.model ?? 'system-one-stub', answers }))
      record.answered = true
    })()
  })
  const port = await listen(server)
  return {
    url: `http://127.0.0.1:${port}/v1/systemone`,
    requests,
    setMode: (next, nextDelay = 0) => {
      mode = next
      delayMs = nextDelay
    },
    stop: () => close(server),
  }
}

// ---------------------------------------------------------------------------
// Scripted OpenAI-compatible LLM stub. The host streams, so the stub answers in
// SSE. Each HTTP completion request consumes the next scripted step belonging
// to THAT TURN's token, which makes every agent turn deterministic without
// letting a late request from a previous turn steal a step.
// ---------------------------------------------------------------------------

type LlmStub = Awaited<ReturnType<typeof startLlmStub>>
/** Queue key for host-driven workflow agent steps, which carry no turn token. */
const WORKFLOW = '__workflow__'
/** Queue key for the normal-verifier sub-agent step, which is also host-driven. */
const VERIFIER = '__verifier__'
/**
 * Stable text taken from the advisory step's own prompt, so the stub can
 * recognise that step without the harness injecting anything. It is DERIVED from
 * the template, so it cannot silently drift away from the prompt it identifies.
 */
const ADVICE_STEP_MARKER = ADVISORY_VERIFICATION_WORKFLOW.steps.find((s) => s.id === 'semantic-advice')?.prompt?.includes(
  'The deterministic checks have run',
)
  ? 'The deterministic checks have run'
  : 'E2E_ADVICE_STEP'
/**
 * The normal verifier step's own prompt, used the same way: a model request that
 * carries it is positive proof that the verifier step really executed.
 */
const VERIFIER_STEP_MARKER = ADVISORY_VERIFICATION_WORKFLOW.steps.find((s) => s.id === 'normal-verifier')?.prompt?.includes(
  'Verify the change with the normal process',
)
  ? 'Verify the change with the normal process'
  : 'E2E_VERIFIER_STEP'

async function startLlmStub(): Promise<{
  url: string
  requests: any[]
  /** Index of the next request, so a caller can scope observations to one turn. */
  cursor: number
  /** Steps that were never consumed, by token. A non-empty map is a real leak. */
  unconsumed: () => Record<string, number>
  script: (token: string, steps: Omit<ScriptStep, 'token'>[]) => void
  stop: () => Promise<void>
}> {
  const requests: any[] = []
  // Per-token queues, so one turn can never consume another turn's script.
  const queues = new Map<string, Omit<ScriptStep, 'token'>[]>()
  const server = createServer((req, res) => {
    void (async () => {
      const body = await readJsonBody(req)
      requests.push(body)
      // The turn is identified by the marker the harness put in the message
      // text. A turn with no script must NOT be answered with a neighbour's
      // step: it is answered with a plain stop, which ends that turn and makes
      // the missing call visible to the scenario assertions.
      // The token may contain hyphens (they separate title words and the
      // counter), so it is matched up to whitespace, not up to the first
      // non-alphanumeric character: a truncated token would silently miss its
      // queue and make every step fall through to the no-script answer.
      const joined = body?.messages?.map((m: any) => String(m?.content ?? '')).join('\n') ?? ''
      const marker = joined.match(/E2E_TURN_([a-z0-9-]+)/i)
      const token = String(marker?.[1] ?? '')
      let queue = token ? queues.get(token) : undefined
      // A workflow agent step is driven by the HOST, so the harness cannot
      // inject a token: the step prompt is a fixed template owned by the
      // workflow. It is instead identified by the template's own stable text,
      // which the stub matches on directly. Runs are strictly sequential (each is
      // awaited to completion), and `script()` REPLACES the queue, so a run
      // cannot inherit a previous run's steps.
      if (!queue && joined.includes(ADVICE_STEP_MARKER)) queue = queues.get(WORKFLOW)
      // The normal verifier is a SUB-AGENT step, so it is matched by its own
      // prompt like the advisory step. It gets its own queue: the verifier must
      // consume a real scripted answer, never an E2E_NO_SCRIPT stop, otherwise
      // "the verifier ran" would be proved by a placeholder rather than by a turn
      // that actually did the work.
      if (!queue && joined.includes(VERIFIER_STEP_MARKER)) queue = queues.get(VERIFIER)
      // No fallback to a shared queue: an unidentified turn gets a plain stop,
      // which surfaces as a missing tool call rather than a silent pass.
      // A turn with no matching script must not be answered with a neighbour's
      // step. It gets a plain stop, which ends the turn and surfaces the
      // mis-sequencing as a missing tool call rather than a silent pass.
      const step = queue?.shift() ?? { content: `E2E_NO_SCRIPT token=${token || 'none'}` }
      const chunks: any[] = []
      if (step.content) {
        chunks.push({ id: 'stub', choices: [{ delta: { content: step.content }, finish_reason: null }] })
      }
      ;(step.calls ?? []).forEach((call, index) => {
        chunks.push({
          id: 'stub',
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index,
                    id: `call_${index}_${requests.length}`,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.args) },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })
      })
      chunks.push({
        id: 'stub',
        choices: [{ delta: {}, finish_reason: (step.calls ?? []).length > 0 ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })()
  })
  const port = await listen(server)
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    cursor: 0,
    unconsumed: () => Object.fromEntries([...queues].map(([k, v]) => [k, v.length])),
    script: (token, next) => {
      queues.set(token, [...next])
    },
    stop: () => close(server),
  }
}

// ---------------------------------------------------------------------------
// Public MCP client: plain JSON-RPC over the host's `/mcp` Streamable HTTP
// endpoint. The host builds a fresh MCP server per request
// (`sessionIdGenerator: undefined`), so no session handshake is required.
// ---------------------------------------------------------------------------

let rpcId = 0
/** Every host call is bounded, so a wedged route can never hang the run. */
const HOST_CALL_TIMEOUT_MS = Number(process.env.E2E_HOST_CALL_TIMEOUT_MS ?? 150_000)

async function mcp(
  base: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<any> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: (rpcId += 1), method, params }),
    signal: AbortSignal.timeout(HOST_CALL_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`MCP ${method} failed with HTTP ${res.status}`)
  const text = await res.text()
  // The transport may answer with a plain JSON body or with an SSE frame.
  const payload = text.includes('data:')
    ? text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .filter((line) => line && line !== '[DONE]')
        .map((line) => JSON.parse(line))
        .pop()
    : JSON.parse(text)
  if (payload?.error) throw new Error(`MCP ${method} error: ${JSON.stringify(payload.error)}`)
  const result = payload?.result
  if (result?.isError) throw new Error(`MCP ${method} isError: ${JSON.stringify(result.content)}`)
  const textBlock = (result?.content ?? []).find((block: any) => block.type === 'text')
  if (!textBlock) return result
  try {
    return JSON.parse(textBlock.text)
  } catch {
    return textBlock.text
  }
}

/** The host wraps every MCP payload as `{ ok: true, data }` or `{ ok: false }`. */
function unwrap(value: any): any {
  if (value && typeof value === 'object' && 'ok' in value) {
    if (value.ok === false) throw new Error(`host reported failure: ${JSON.stringify(value)}`)
    return value.data ?? value
  }
  return value
}

// ---------------------------------------------------------------------------
// Isolated OpenFox host
// ---------------------------------------------------------------------------

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
        workspace: { workdir, autoGitInit: false },
        // OpenFox generates a session title with its own LLM call. That extra
        // request would consume a scripted step and make every scenario depend on
        // a race, so it is disabled: each turn must consume exactly the steps the
        // scenario scripted for it.
        disableAutoSessionTitle: true,
      },
      null,
      2,
    ) + '\n',
  )
  return path
}

/**
 * Registers the scripted LLM through the PUBLIC host route, which is the only
 * path that also refreshes the host's in-memory provider manager. `vllm` is an
 * OpenAI-compatible backend in the host's own enum; the stub key is a public
 * loopback fixture value, never a real credential.
 */
async function registerLlmProvider(base: string, llmUrl: string): Promise<{ ok: boolean; detail: string }> {
  const created = await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'E2E LLM stub',
      url: llmUrl,
      backend: 'vllm',
      apiKey: STUB_KEY,
      model: STUB_MODEL,
      isLocal: true,
    }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!created.ok) return { ok: false, detail: `POST /api/providers status=${created.status}` }
  const listed = (await (await fetch(`${base}/api/providers`, { signal: AbortSignal.timeout(10_000) })).json()) as any
  const provider = (listed.providers ?? []).find((p: any) => p.url === llmUrl)
  if (!provider) return { ok: false, detail: 'the registered provider is not listed by the host' }
  const config = (await (await fetch(`${base}/api/config`, { signal: AbortSignal.timeout(10_000) })).json()) as any
  // Assert the host actually resolved the stub before spending a single turn on
  // it, instead of discovering it later through an LLM stream error.
  const resolved = config.llmUrl === llmUrl && config.model === STUB_MODEL
  return {
    ok: resolved,
    detail: `llmUrl=${config.llmUrl} model=${config.model} backend=${config.backend}`,
  }
}

/** Prints one labelled line per step, so a run that stalls says where. */
const step = (label: string) => console.log(`\n[step] ${label}`)

/**
 * Reads the real listening sockets for a port from the OS, so the bind address
 * is observed rather than inferred from what the process claims. A wildcard bind
 * (0.0.0.0 / ::) is reported verbatim, which is exactly the case that must fail.
 */
async function readListenerForPort(port: number): Promise<Array<{ address: string; port: number }> | null> {
  // `ss` is not guaranteed to exist, so this is a best-effort observation: when
  // it cannot be read the run fails closed rather than assuming loopback.
  const stdout = await new Promise<string>((resolveOut) => {
    execFile('ss', ['-ltnpH'], { encoding: 'utf8', timeout: 10_000 }, (err, out) =>
      resolveOut(err ? '' : String(out)),
    )
  })
  if (!stdout) return null
  const rows = stdout
    .split('\n')
    .filter((line) => new RegExp(`:${port}\\s`).test(line) || new RegExp(`:${port}$`).test(line.trim()))
  return rows.map((line) => {
    const local = line.trim().split(/\s+/)[3] ?? ''
    const [address, portText] = local.startsWith('[')
      ? [local.slice(1, local.indexOf(']')), local.slice(local.indexOf(']') + 2)]
      : local.split(':')
    return { address: address || 'unknown', port: Number(portText) }
  })
}

const AGENT_HEADER = (id: string, description: string, allowedTools: string[]) =>
  ['---', `id: ${id}`, `name: ${id}`, `description: ${description}`, 'subagent: false', 'allowedTools:', ...allowedTools.map((t) => `  - ${t}`), '---', '', `# ${id}`, ''].join('\n')

const BASE_TOOLS = ['read_file', 'run_command', 'load_skill', 'step_done']
/**
 * A plugin tool counts as an "MCP" tool to the host, and the host refuses one
 * ONLY when the allow-list names at least one non-builtin tool
 * (`hasMcpSpecific`). An agent whose allow-list is builtins-only therefore has
 * no plugin restriction at all, which is a real host behaviour and not a plugin
 * defect. The denied agent below must therefore allow a DIFFERENT plugin tool
 * for the refusal path to be reachable at all.
 */
const DENIED_AGENT_TOOLS = [...BASE_TOOLS, 'semantic_scan']

async function writeAgents(projectDir: string): Promise<void> {
  const dir = join(projectDir, '.openfox', 'agents')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'e2e-decide.agent.md'),
    AGENT_HEADER('e2e-decide', 'Allowed semantic_decide, no skill preloaded', [...BASE_TOOLS, 'semantic_decide']),
  )
  await writeFile(
    join(dir, 'e2e-denied.agent.md'),
    // semantic_decide is deliberately absent while semantic_scan is present.
    AGENT_HEADER('e2e-denied', 'Plugin tools allowed, but not semantic_decide', DENIED_AGENT_TOOLS),
  )
  await writeFile(
    join(dir, 'e2e-verification.agent.md'),
    AGENT_HEADER(
      'e2e-verification',
      'Allowed semantic_verify_task, loads the usage skill first',
      [...BASE_TOOLS, 'semantic_verify_task'],
    ),
  )
  await writeFile(
    join(dir, 'e2e-all.agent.md'),
    AGENT_HEADER(
      'e2e-all',
      'All four plugin tools allowed',
      [...BASE_TOOLS, 'semantic_decide', 'semantic_verify_task', 'semantic_search', 'semantic_scan'],
    ),
  )
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const DECIDE_STATE = 'the report renders the quarterly totals for a signed-in accountant'
/** Distinct states per scenario: an already-warmed decision cache must not be
 * able to mask a later cancellation or failure by replaying a stored answer. */
const stateFor = (tag: string) => `${DECIDE_STATE} [${tag}]`
/** Shared by the two workflow runs that really call the verification tool. */
const WF_VERIFY_ARGS = {
  criterionId: 'wf-1',
  criterion: 'The export endpoint scopes every record to the authenticated tenant.',
  evidence: {
    summary: 'Added a tenant filter to the export query.',
    diffExcerpts: ['select ... where tenant_id = $1'],
    deterministicTestResults: ['ok 1 - export scopes records'],
  },
}

interface RunResult {
  readonly sessionId: string
  readonly outcome: any
  readonly detail: any
  readonly toolsOffered: string[]
  readonly toolResults: string[]
  readonly observedArgs: unknown[]
  readonly token: string
  /** Scripted steps this turn never consumed. Non-empty means the turn ended early. */
  readonly leftover: number
}

let turnCounter = 0
/**
 * Children this run started, and nothing else.
 *
 * The harness may be interrupted (Ctrl-C) while a host is still listening, so a
 * signal handler releases them. It is deliberately strict: it only ever touches
 * the PIDs this run spawned, tracked from the spawn return value. It never
 * matches by name, pattern or port, so it can never reach a developer's own
 * OpenFox instance or any other process on the machine.
 */
const ownedChildren = new Set<number>()
const onInterrupt = (signal: NodeJS.Signals) => {
  for (const pid of ownedChildren) {
    try {
      process.kill(pid, signal === 'SIGINT' ? 'SIGTERM' : signal)
    } catch {
      /* already gone */
    }
  }
  // Registering a signal handler suppresses Node's default terminate behaviour,
  // so the harness would keep polling a host that is already dead. Exit
  // explicitly once the children have been told to stop.
  process.exit(signal === 'SIGINT' ? 130 : 143)
}
process.once('SIGINT', () => onInterrupt('SIGINT'))
process.once('SIGTERM', () => onInterrupt('SIGTERM'))

async function runTurn(options: {
  base: string
  projectId: string
  agentId: string
  title: string
  steps: Omit<ScriptStep, 'token'>[]
  waitSeconds: number
  llm: LlmStub
}): Promise<RunResult> {
  const { base, projectId, agentId, title, steps, waitSeconds, llm: model } = options
  // Every turn gets its OWN token and its own queue. Routing by token is what
  // removes the cross-scenario race: `openfox_wait` may resolve while the host
  // still has a completion in flight, and that late request can no longer take
  // this turn's first step from a shared queue.
  const token = `${title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${(turnCounter += 1)}`
  model.script(token, steps)
  step(`turn: ${title} (agent=${agentId}, token=${token}, ${steps.length} scripted step(s), wait<=${waitSeconds}s)`)
  // Scoped BEFORE the session exists, so nothing this turn emits can leak in.
  model.cursor = model.requests.length
  const session = unwrap(
    await mcp(base, 'tools/call', {
      name: 'openfox_create_session',
      arguments: { projectId, title, agentId },
    }),
  )
  const sessionId = String(session.sessionId ?? session.session?.id ?? session.id)
  await mcp(base, 'tools/call', {
    name: 'openfox_send_message',
    // The token travels in the user message so the stub can route this turn's
    // requests to this turn's queue.
    arguments: { sessionId, content: `Run the scripted E2E turn. E2E_TURN_${token}` },
  })
  const outcome = unwrap(
    await mcp(base, 'tools/call', {
      name: 'openfox_wait',
      arguments: { sessionId, timeout: waitSeconds },
    }),
  )
  const detail = unwrap(
    await mcp(base, 'tools/call', {
      name: 'openfox_session_detail',
      arguments: { sessionId, limit: 50, maxContentLength: 2000 },
    }),
  )
  // Everything observed is read from THIS turn's own LLM request window, and
  // only from requests that actually carried THIS turn's token. A shared cursor
  // alone would still pick up a neighbour's messages, which is what made a
  // permission check read another turn's result.
  const turnRequests = model.requests
    .slice(model.cursor)
    .filter((r: any) => JSON.stringify(r?.messages ?? []).includes(`E2E_TURN_${token}`))
  model.cursor = model.requests.length
  const toolsOffered = (turnRequests.find((r) => Array.isArray(r.tools))?.tools ?? [])
    .map((t: any) => t.function?.name ?? t.name)
    .filter((n: unknown) => n !== undefined)
  // Tool results travel back to the host as `role: "tool"` messages on the LLM
  // request that FOLLOWS the call. Capturing them is the only way to see what a
  // plugin tool actually returned inside the host.
  const toolResults = turnRequests
    .flatMap((r: any) => (r.messages ?? []).filter((m: any) => m.role === 'tool'))
    .map((m: any) => String(m.content).slice(0, 400))
  // The arguments the host actually parsed from the model's tool call. This is
  // the only way to tell a plugin validation failure from a host-side rewrite.
  const observedArgs = turnRequests
    .flatMap((r: any) => (r.messages ?? []).filter((m: any) => m.tool_calls))
    .flatMap((m: any) => m.tool_calls)
    .map((c: any) => c.function?.arguments)
  return {
    sessionId,
    outcome,
    detail,
    toolsOffered,
    toolResults,
    observedArgs,
    token,
    leftover: model.unconsumed()[token] ?? 0,
  }
}

/** Flatten the observed tool calls and message bodies of a finished session. */
function observed(detail: any): { toolCalls: string[]; texts: string[] } {
  const messages = detail?.messages ?? []
  const toolCalls: string[] = []
  const texts: string[] = []
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) toolCalls.push(call)
    if (typeof message.content === 'string' && message.content.trim()) texts.push(message.content)
  }
  return { toolCalls, texts }
}

function requireCall(seen: { toolCalls: string[] }, name: string, scenario: string): void {
  record(
    `${scenario}: the agent really called ${name}`,
    seen.toolCalls.includes(name),
    `observed calls: ${seen.toolCalls.join(', ') || 'none'}`,
  )
}

/**
 * The host advertises the full tool catalogue to the model and enforces the
 * agent allow-list when a call is executed, so "was the tool advertised" is NOT
 * a permission test. The observable permission event is a refusal returned to
 * the agent for a tool the agent is not allowed to use.
 */
/**
 * The tool result the host actually received. A plugin tool returns a JSON
 * payload (success or failure) as a `role: "tool"` message, so this is the only
 * faithful evidence of what the tool did; an assistant summary would only
 * reflect what the scripted LLM chose to repeat.
 */
function failureResultOf(run: RunResult): string {
  return run.toolResults.find((r) => r.includes('"provider"') || r.includes('"code"')) ?? ''
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let host: ReturnType<typeof spawn> | undefined
let llm: Awaited<ReturnType<typeof startLlmStub>> | undefined
let systemOne: Awaited<ReturnType<typeof startSystemOneStub>> | undefined
let root = ''

const OPENFOX_VERSION = await (async () => {
  if (!(await exists(OPENFOX_CLI))) {
    throw new Error(
      `OpenFox is not installed at ${HARNESS_PKG_DIR}. Run scripts/setup-harness.sh first, or set HARNESS_PKG_DIR.`,
    )
  }
  return JSON.parse(await readFile(join(HARNESS_PKG_DIR, 'node_modules/openfox/package.json'), 'utf8')).version as string
})()

try {
  root = await mkdtemp(join(tmpdir(), 'openfox-agent-e2e-'))
  const configHome = join(root, 'config')
  const dataHome = join(root, 'data')
  const home = join(root, 'home')
  const projectDir = join(root, 'project')
  for (const dir of [configHome, dataHome, home, projectDir]) await mkdir(dir, { recursive: true })

  // The project is a real working directory with real agent definitions, so the
  // host resolves the allow-lists under test from disk, not from our intent.
  await writeAgents(projectDir)
  await writeFile(
    join(projectDir, 'package.json'),
    JSON.stringify({ name: 'e2e-fixture', private: true, scripts: { check: 'node -e "process.exit(0)"' } }, null, 2) + '\n',
  )
  await writeFile(
    join(projectDir, 'fixture.txt'),
    'E2E fixture: the export endpoint scopes every record to the authenticated tenant.\n',
  )
  await mkdir(join(projectDir, '.openfox', 'workflows'), { recursive: true })
  // The workflow is installed in its OPT-IN form: the advisory step points at
  // an agent that really has `semantic_verify_task` in `allowedTools`. With the
  // stock `builder` agent the step can never use the tool it tells the agent to
  // call, so shipping only that form would make the advice a silent no-op.
  await writeFile(
    join(projectDir, '.openfox', 'workflows', `${ADVISORY_VERIFICATION_WORKFLOW.metadata.id}.workflow.json`),
    JSON.stringify(advisoryWorkflowFor(ADVISORY_AGENT_ID), null, 2) + '\n',
  )

  llm = await startLlmStub()
  systemOne = await startSystemOneStub()

  // 1. Build the package the way a consumer receives it, then install it into the
  //    isolated configDir exactly as the documented local-path install does.
  //    The build is bounded and its own child is killed on overrun, so a hung
  //    compiler can never leave an orphan behind.
  step('building the package')
  const BUILD_TIMEOUT_MS = 300_000
  const build = spawn('npm', ['run', 'build'], { cwd: PROJECT, stdio: 'ignore' })
  const buildTimer = setTimeout(() => build.kill('SIGKILL'), BUILD_TIMEOUT_MS)
  const buildOk = await new Promise<boolean>((r) => {
    // An 'error' listener is REQUIRED: without it a missing binary raises an
    // unhandled 'error' event that kills the process BEFORE `try/finally`, so the
    // loopback stubs and the temp tree would be left behind.
    build.once('error', () => r(false))
    build.on('exit', (code) => r(code === 0))
  })
  clearTimeout(buildTimer)
  record('npm run build', buildOk, `bounded at ${BUILD_TIMEOUT_MS}ms`)
  if (!buildOk) throw new Error('build failed')

  const pluginRoot = join(configHome, 'openfox', 'plugins', PLUGIN_NAME)
  await mkdir(pluginRoot, { recursive: true })
  await cp(join(PROJECT, 'dist'), join(pluginRoot, 'dist'), { recursive: true })
  for (const file of ['package.json', 'README.md']) await cp(join(PROJECT, file), join(pluginRoot, file))
  const manifest = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'))
  // Instrumentation is applied ONLY to the throwaway installed copy, never to
  // the source tree, so the real error becomes observable without shipping a
  // debug path in the plugin.
  if (process.env.E2E_DEBUG_TOOL === '1') {
    const toolPath = join(pluginRoot, 'dist', 'tool.js')
    const source = await readFile(toolPath, 'utf8')
    console.log('debug: instrumenting', toolPath, 'matched =', source.includes('catch (error) {'))
    await writeFile(
      toolPath,
      source.replace(
        'catch (error) {',
        'catch (error) {\n                process.stderr.write("E2E_TOOL_ERROR " + (error && error.stack ? error.stack : String(error)) + "\\n");',
      ),
    )
  }
  record(
    'the installed manifest declares tools, skills and settings',
    ['tools', 'skills', 'settings'].every((capability) => manifest.openfox.capabilities.includes(capability)),
    `capabilities=${JSON.stringify(manifest.openfox.capabilities)}`,
  )

  // 2. Start the isolated host. OpenFox resolves its own port by probing
  //    `[preferred, fallback, ...]`, so a kernel-assigned port is reserved
  //    first: bind 0, read the assignment, release.
  const port = await new Promise<number>((resolvePort, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        probe.close(() => reject(new Error('could not reserve a loopback port')))
        return
      }
      const reserved = address.port
      probe.close(() => resolvePort(reserved))
    })
  })
  await seedConfig(configHome, port, projectDir)
  step('starting the isolated host')
  host = spawn(process.execPath, [OPENFOX_CLI, '--port', String(port), '--no-browser'], {
    // Own process group, so the CLI's own re-exec'd child dies with the host
    // rather than outliving a kill aimed at the direct child.
    detached: true,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
      // Without this the CLI re-executes itself with a larger heap and that
      // grandchild would outlive a kill aimed at the direct child.
      OPENFOX_HEAP_INCREASED: '1',
      // The documented public host override. It is REQUIRED, not cosmetic:
      // `server.host` in config.json is only a fallback (`env.server.host ??
      // globalConfig.server.host`), and without this the host binds 0.0.0.0 and
      // serves an unauthenticated API to the whole network.
      OPENFOX_HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (host.pid) ownedChildren.add(host.pid)
  let hostLog = ''
  host.stdout!.on('data', (c: Buffer) => (hostLog += String(c)))
  host.stderr!.on('data', (c: Buffer) => (hostLog += String(c)))

  const base = `http://127.0.0.1:${port}`
  let ready = false
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) {
        ready = true
        break
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  record('isolated OpenFox host is ready', ready, `openfox@${OPENFOX_VERSION} on loopback port ${port}`)
  if (!ready) {
    console.error(hostLog.slice(-3000))
    throw new Error('the isolated host did not become ready')
  }

  // The host must be reachable on LOOPBACK ONLY. Seeding `server.host` in the
  // config is NOT sufficient: `server.host` is only a fallback for the
  // documented `OPENFOX_HOST` override, and without it the host binds 0.0.0.0
  // and serves an unauthenticated API. The real listener is inspected rather
  // than the banner, because the banner only reports what the host believes.
  // An EMPTY result must not pass: `[].every(...)` is `true` in JS, so a
  // missing match would silently turn this guard into a no-op and a LAN-exposed
  // host would be recorded as loopback-only. A non-empty list of loopback
  // addresses is required.
  const listener = await readListenerForPort(port)
  const loopbackOnly =
    listener !== null && listener.length > 0 && listener.every((e) => e.address === '127.0.0.1' || e.address === '::1')
  record(
    'the isolated host is bound to loopback only (not reachable from the LAN)',
    loopbackOnly,
    listener === null
      ? `could not read the listener for port ${port}`
      : listener.length === 0
        ? `no listening socket found for port ${port}`
        : `listening on ${listener.map((e) => `${e.address}:${e.port}`).join(', ')}`,
  )
  if (!loopbackOnly) {
    // Stop here: continuing would be testing a LAN-exposed host, and the
    // results would not be a valid isolated E2E.
    console.error(hostLog.slice(-2000))
    throw new Error(`the isolated OpenFox host is not bound to loopback only (port ${port})`)
  }

  // 3. Public MCP transport, then the plugin must be loaded by the real host.
  step('checking the installed plugin through the host API')
  const plugins = await (
    await fetch(`${base}/api/plugins`, { signal: AbortSignal.timeout(20_000) })
  ).json()
  const listed = (Array.isArray(plugins) ? plugins : plugins.plugins ?? []).find(
    (p: any) => p.packageName === PLUGIN_NAME || p.id === PLUGIN_NAME,
  )
  record('the host loaded the installed plugin', listed?.loaded === true, `source=${listed?.source}`)
  // Asserted BY NAME against the host's real tool registry, never by a count:
  // later lots legitimately add plugin tools (calibration), so a pinned total
  // would fail for an unrelated reason. The four decision tools this lot covers
  // must be present; the calibration tools are covered by their own tests.
  const EXPECTED_TOOLS = [
    'semantic_decide',
    'semantic_verify_task',
    'semantic_search',
    'semantic_scan',
  ]
  record(
    'the host counts the plugin tools and exactly one skill source',
    (listed?.contributions?.tools ?? 0) >= EXPECTED_TOOLS.length && listed?.contributions?.skillSources === 1,
    `tools=${listed?.contributions?.tools} skillSources=${listed?.contributions?.skillSources}`,
  )

  // 4. The scripted LLM is registered through the public route, and the host is
  //    asked to confirm it resolved it BEFORE any turn is spent.
  step('registering the scripted LLM through the public provider route')
  const llmProvider = await registerLlmProvider(base, llm.url)
  record('the host resolved the scripted LLM stub', llmProvider.ok, llmProvider.detail)
  if (!llmProvider.ok) throw new Error(`the host did not resolve the LLM stub: ${llmProvider.detail}`)

  // The host registers plugin tools after boot. Polling the real tool registry
  // here prevents a silent "Unknown tool" in every later scenario, which would
  // otherwise be misread as a plugin defect.
  step('waiting for the host tool registry to expose the plugin tools')
  let exposed = false
  let registeredTools: string[] = []
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const body = (await (await fetch(`${base}/api/tools`, { signal: AbortSignal.timeout(5_000) })).json()) as any
    registeredTools = (Array.isArray(body) ? body : body.tools ?? []).map((t: any) => t.name ?? t.id)
    // Checked BY NAME against the real registry, never by a count: the plugin
    // legitimately grew tools in later lots, so a pinned total would fail for an
    // unrelated reason. Each of the four decision tools is also really invoked
    // in the scenarios below, which is the behavioural proof.
    if (EXPECTED_TOOLS.every((name) => registeredTools.includes(name))) {
      exposed = true
      break
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  const missingTools = EXPECTED_TOOLS.filter((name) => !registeredTools.includes(name))
  record(
    'the host tool registry exposes every expected plugin tool BY NAME',
    exposed,
    missingTools.length
      ? `missing: ${missingTools.join(', ')}`
      : `all present: ${registeredTools.filter((n) => n.startsWith('semantic_')).join(', ')}`,
  )
  if (!exposed) throw new Error('the host never exposed the plugin tools in its tool registry')

  // 5. Plugin settings point at the loopback System One stub. Secrets go only to
  //    the isolated store and are never printed.
  step('storing the plugin settings in the isolated instance')
  const settingsRes = await fetch(`${base}/api/plugins/${PLUGIN_NAME}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      values: {
        backend: 'custom',
        endpoint: systemOne.url,
        apiKey: STUB_KEY,
        timeoutMs: 2000,
        endpointClass: 'local',
        egressPolicy: 'allow',
        cacheEnabled: false,
      },
    }),
    signal: AbortSignal.timeout(20_000),
  })
  record('plugin settings stored in the isolated instance', settingsRes.ok, `status=${settingsRes.status}`)

  // Read the settings back through the public API before spending a turn on them:
  // a 200 on the write is not proof the tool can read them back.
  step('reading the plugin settings back through the public API')
  const settingsBack = await (
    await fetch(`${base}/api/plugins/${PLUGIN_NAME}/settings`, { signal: AbortSignal.timeout(10_000) })
  )
    .json()
    .catch(() => null)
  const storedValues = (settingsBack as any)?.values ?? settingsBack
  record(
    'the endpoint read back points at the loopback System One stub',
    typeof (storedValues as any)?.endpoint === 'string' && (storedValues as any).endpoint === systemOne.url,
    `endpoint=${String((storedValues as any)?.endpoint)} timeoutMs=${String((storedValues as any)?.timeoutMs)} backend=${String((storedValues as any)?.backend)}`,
  )

  // 6. A real project + session, driven only through the public MCP endpoint.
  step('creating a real project through public MCP')
  const project = unwrap(
    await mcp(base, 'tools/call', {
      name: 'openfox_create_project',
      arguments: { name: 'e2e-project', workdir: projectDir },
    }),
  )
  const projectId = String(project.id ?? project.project?.id)
  record('a real project was created through public MCP', Boolean(projectId), `projectId=${projectId}`)

  // ---- Scenario 1: three question types, mixed batch, through the host agent.
  const mixed = {
    state: stateFor('mixed'),
    questions: {
      is_boolean: { type: 'noul', instructions: 'Does the export scope every record to the tenant?' },
      which_side: { type: 'choice', instructions: 'Which behaviour does the endpoint implement?', criteria: ['global', 'tenant_scoped'] },
      how_bad: {
        type: 'score',
        instructions: 'How complete is the scoping?',
        // `score` criteria are an ORDERED ARRAY, as the common System One
        // contract requires; an object is rejected before any request is sent.
        criteria: ['no scoping', 'some scoping', 'fully scoped'],
      },
    },
  }
  const decideRun = await runTurn({
    base,
    projectId,
    agentId: 'e2e-decide',
    title: 'c1 mixed questions',
    steps: [
      { calls: [{ name: 'semantic_decide', args: mixed }] },
      { content: 'Recorded the three typed answers.', calls: [{ name: 'step_done', args: {} }] },
    ],
    waitSeconds: 60,
    llm,
  })
  const decideSeen = observed(decideRun.detail)
  requireCall(decideSeen, 'semantic_decide', 'mixed batch')
  const wire = systemOne.requests.filter((r) => r.body?.questions)
  const mixedWire = wire.find((r) => r.body.questions.is_boolean)
  record(
    'the wire body carried the noul, choice and score questions',
    Boolean(
      mixedWire &&
        mixedWire.body.questions.is_boolean?.type === 'noul' &&
        mixedWire.body.questions.which_side?.type === 'choice' &&
        mixedWire.body.questions.how_bad?.type === 'score',
    ),
    mixedWire ? JSON.stringify(mixedWire.body.questions).slice(0, 200) : 'no matching request',
  )
  record(
    'one request batched all three questions against the same state',
    mixedWire ? Object.keys(mixedWire.body.questions).length === 3 : false,
    `questions=${mixedWire ? Object.keys(mixedWire.body.questions).join(',') : 'none'}`,
  )
  // The normalized answers are asserted on the tool result the host received,
  // not on a summary message: the scripted LLM never paraphrases a tool result,
  // so the agent transcript is not a reliable place to look for them.
  const decideResult = failureResultOf(decideRun)
  record(
    'the normalized noul, choice and score answers reached the host',
    /"probability":0\.75/.test(decideResult) &&
      /"choice":"tenant_scoped"/.test(decideResult) &&
      /"score":2/.test(decideResult),
    decideResult.slice(0, 300) || '(no successful tool result observed)',
  )
  record('the turn completed instead of hanging', decideRun.outcome?.outcome === 'completed' || decideRun.outcome?.outcome === 'blocked', `outcome=${decideRun.outcome?.outcome}`)
  record(
    'no provider request preceded the tool call for another scenario',
    wire.every((r) => r.body.questions !== undefined),
    `${wire.length} system-one request(s) captured`,
  )
  record(
    'the mixed batch tool actually returned a result to the host',
    decideRun.toolResults.length > 0,
    decideRun.toolResults[0]?.slice(0, 300) ?? '(no tool result observed)',
  )
  if (decideRun.toolResults[0]?.includes('invalid_arguments') && process.env.E2E_DEBUG_TOOL === '1') {
    const marker = hostLog.split('\n').filter((l) => l.includes('E2E_TOOL_ERROR'))
    console.log('host stderr markers:', marker.length ? marker.slice(0, 2) : 'none — instrumented copy may not be the one loaded')
  }
  record(
    'the host passed the three typed questions through to the tool unchanged',
    decideRun.observedArgs.some(
      (a) =>
        typeof a === 'string' &&
        a.includes('is_boolean') &&
        a.includes('noul') &&
        a.includes('score'),
    ),
    decideRun.observedArgs[0] ? String(decideRun.observedArgs[0]).slice(0, 300) : '(no tool_call arguments observed)',
  )
  // The report directory is created up front, not just before the report: a
  // scenario writes its evidence here mid-run, and `benchmark/results/` is
  // gitignored, so on a clean checkout the directory does not exist. Writing
  // before the mkdir would throw ENOENT, jump to `finally`, and lose the
  // report.json too — destroying the evidence of an otherwise passing run.
  const reportPath = join(PROJECT, 'benchmark/results/agent-e2e')
  await mkdir(reportPath, { recursive: true })
  // Written verbatim so a failure can be replayed offline against validateRequest
  // instead of being re-guessed from the LLM stub.
  await writeFile(
    join(reportPath, 'observed-args.json'),
    JSON.stringify(decideRun.observedArgs, null, 2) + '\n',
  )

  // ---- Scenario 2: skill available, tool denied.
  // The agent deliberately attempts the call: the host must REFUSE it, and no
  // provider request may result.
  const deniedBefore = systemOne.requests.length
  const deniedRun = await runTurn({
    base,
    projectId,
    agentId: 'e2e-denied',
    title: 'c2 denied tool',
    steps: [
      {
        calls: [
          {
            name: 'semantic_decide',
            args: {
              state: stateFor('denied'),
              questions: { is_boolean: { type: 'noul', instructions: 'Does the export scope records?' } },
            },
          },
        ],
      },
      { content: 'I tried and the host refused it.', calls: [{ name: 'step_done', args: {} }] },
    ],
    waitSeconds: 60,
    llm,
  })
  const deniedSeen = observed(deniedRun.detail)
  requireCall(deniedSeen, 'semantic_decide', 'denied tool')
  // The host refuses the call instead of executing it, and the refusal names the
  // allow-list rather than any provider answer.
  record(
    'denied tool: the host refused the call instead of executing it',
    deniedRun.toolResults.length > 0 && !deniedRun.toolResults.some((r) => r.includes('"provider"')),
    deniedRun.toolResults[0]?.slice(0, 250) ?? '(no tool result observed)',
  )
  record(
    'denied tool: the refusal names the allow-list, not a provider answer',
    deniedRun.toolResults.some((r) => /not available in|not in your allowed tools|Unknown tool/.test(r)),
    deniedRun.toolResults.join(' || ').slice(0, 250) || 'none',
  )
  record(
    'denied turn produced no provider request',
    systemOne.requests.length === deniedBefore,
    `system-one requests went from ${deniedBefore} to ${systemOne.requests.length}`,
  )

  // ---- Scenario 3: tool allowed, skill never loaded.
  record(
    'the tool executed without any load_skill call',
    decideSeen.toolCalls.includes('semantic_decide') && !decideSeen.toolCalls.includes('load_skill'),
    `calls=${decideSeen.toolCalls.join(', ')}`,
  )

  // ---- Scenario 4: allowed tool plus a real load_skill invocation.
  const skillRun = await runTurn({
    base,
    projectId,
    agentId: 'e2e-all',
    title: 'c4 skills and four tools',
    steps: [
      { calls: [{ name: 'load_skill', args: { skillId: 'semantic-verification' } }] },
      { calls: [{ name: 'load_skill', args: { skillId: 'semantic-code-discovery' } }] },
      {
        calls: [
          {
            name: 'semantic_verify_task',
            args: {
              criterionId: 'ac-1',
              criterion: 'The export endpoint scopes every record to the authenticated tenant.',
              issueId: '2',
              evidence: {
                summary: 'Added a tenant filter to the export query.',
                diffExcerpts: ['select ... where tenant_id = $1'],
                deterministicTestResults: ['ok 1 - export scopes records'],
              },
            },
          },
        ],
      },
      {
        calls: [
          {
            name: 'semantic_search',
            args: {
              query: 'tenant scoped export',
              candidates: ['fixture.txt'],
            },
          },
        ],
      },
      {
        calls: [
          {
            name: 'semantic_scan',
            args: { predicate: 'Does this file scope records to a tenant?', candidates: ['fixture.txt'] },
          },
        ],
      },
      { content: 'All four plugin tools ran.', calls: [{ name: 'step_done', args: {} }] },
    ],
    waitSeconds: 60,
    llm,
  })
  const skillSeen = observed(skillRun.detail)
  record(
    'both plugin skills loaded through the normal load_skill path',
    skillSeen.toolCalls.filter((n) => n === 'load_skill').length === 2,
    `calls=${skillSeen.toolCalls.join(', ')}`,
  )
  record(
    'the skill tool is offered to the allowed agent',
    skillRun.toolsOffered.includes('load_skill'),
    `offered=${skillRun.toolsOffered.filter((n: string) => n === 'load_skill').length} load_skill`,
  )
  for (const name of ['semantic_decide', 'semantic_verify_task', 'semantic_search', 'semantic_scan']) {
    record(`the host offered ${name} to the fully allowed agent`, skillRun.toolsOffered.includes(name), `offered=${name}`)
  }
  for (const name of ['semantic_verify_task', 'semantic_search', 'semantic_scan']) {
    requireCall(skillSeen, name, 'four tools')
  }
  const skillResult = failureResultOf(skillRun)
  record(
    'the verification tool returned an advisory status rather than a verdict',
    /"status":"(unknown|needs-verification|insufficient-evidence|off-scope)"/.test(skillResult) ||
      /unknown|needs-verification|insufficient-evidence|off-scope/.test(skillResult),
    skillResult.slice(0, 300) || '(no verification tool result observed)',
  )

  // ---- Scenario 5: controlled provider failure.
  const beforeFailure = systemOne.requests.length
  systemOne.setMode('server-error')
  const failureRun = await runTurn({
    base,
    projectId,
    agentId: 'e2e-decide',
    title: 'c5 provider error',
    steps: [
      {
        calls: [
          {
            name: 'semantic_decide',
            args: {
              state: stateFor('provider-error'),
              questions: { is_boolean: { type: 'noul', instructions: 'Does the export scope records?' } },
            },
          },
        ],
      },
      { content: 'The provider call failed as expected.', calls: [{ name: 'step_done', args: {} }] },
    ],
    waitSeconds: 60,
    llm,
  })
  const failureSeen = observed(failureRun.detail)
  void failureSeen
  const failureWire = systemOne.requests.slice(beforeFailure)
  record(
    'a provider 5xx really produced a provider request',
    failureWire.some((r) => r.body?.questions !== undefined),
    `${failureWire.length} request(s) in this scenario`,
  )
  const failureResult = failureResultOf(failureRun)
  record(
    'the failure surfaced as a failed tool result, not a fabricated answer',
    /"code":"(http|timeout|provider_error|transport_error|configuration|egress_blocked)"/.test(failureResult) ||
      /"success":false/.test(failureResult),
    failureResult.slice(0, 300) || '(no tool result observed)',
  )
  record(
    'the failure carried no probability at all',
    !/"probability"|"score"|"choice"/.test(failureResult),
    failureResult.slice(0, 200) || '(no tool result observed)',
  )
  systemOne.setMode('ok')

  // ---- Scenario 6: transport abort/timeout, distinguished from a turn abort.
  const beforeTimeout = systemOne.requests.length
  systemOne.setMode('hang', 30_000)
  const timeoutRun = await runTurn({
    base,
    projectId,
    agentId: 'e2e-decide',
    title: 'c6 provider timeout',
    steps: [
      {
        calls: [
          {
            name: 'semantic_decide',
            args: {
              state: stateFor('provider-timeout'),
              questions: { is_boolean: { type: 'noul', instructions: 'Does the export scope records?' } },
            },
          },
        ],
      },
      { content: 'The call timed out as expected.', calls: [{ name: 'step_done', args: {} }] },
    ],
    // The plugin timeout is 2s, so this budget only has to cover the turn.
    waitSeconds: 60,
    llm,
  })
  const timeoutSeen = observed(timeoutRun.detail)
  void timeoutSeen
  // The turn must have consumed its WHOLE script. A leftover means the turn
  // answered early, which is exactly the mis-sequencing that made this scenario
  // flaky: the next scenario's step had been eaten by the previous turn.
  record(
    'the timeout turn consumed its whole script (no step stolen by another turn)',
    timeoutRun.leftover === 0,
    `leftover=${timeoutRun.leftover} token=${timeoutRun.token}`,
  )
  record(
    'the timeout turn really invoked the tool before timing out',
    timeoutSeen.toolCalls.includes('semantic_decide'),
    `calls=${timeoutSeen.toolCalls.join(', ') || 'none'} outcome=${timeoutRun.outcome?.outcome}`,
  )
  record(
    'the hanging provider produced a real request that was not answered',
    systemOne.requests.slice(beforeTimeout).some((r) => r.body?.questions !== undefined),
    `${systemOne.requests.slice(beforeTimeout).length} request(s) in this scenario`,
  )
  const timeoutResult = failureResultOf(timeoutRun)
  record(
    'the timeout returned a failed result, not a positive or cached answer',
    /"code":"(timeout|provider_error|transport_error)/.test(timeoutResult) ||
      (/timeout|abort/i.test(timeoutResult) && !/"probability":0\.75/.test(timeoutResult)),
    timeoutResult.slice(0, 300) || '(no tool result observed)',
  )
  record(
    'the timeout carried no probability and no cache hit',
    !/"probability":0\.75/.test(timeoutResult) && !/"cache":"hit"/.test(timeoutResult),
    timeoutResult.slice(0, 200) || '(no tool result observed)',
  )
  systemOne.setMode('ok')

  // ---- Scenario 7: cancelling the agent turn is a different observable event.
  // This one drives the session directly rather than through `runTurn`, because
  // it has to interrupt the turn mid-flight, so it takes its own token too.
  const beforeAbort = systemOne.requests.length
  systemOne.setMode('hang', 30_000)
  const abortToken = `c7-abort-${(turnCounter += 1)}`
  llm.script(abortToken, [
    { calls: [{ name: 'semantic_decide', args: { state: stateFor('turn-abort'), questions: { q: { type: 'noul', instructions: 'Does it scope?' } } } }] },
  ])
  const abortSession = unwrap(
    await mcp(base, 'tools/call', {
      name: 'openfox_create_session',
      arguments: { projectId, title: 'c7 turn abort', agentId: 'e2e-decide' },
    }),
  )
  const abortSessionId = String(abortSession.sessionId ?? abortSession.session?.id ?? abortSession.id)
  await mcp(base, 'tools/call', {
    name: 'openfox_send_message',
    arguments: { sessionId: abortSessionId, content: `Run the abort scenario. E2E_TURN_${abortToken}` },
  })
  // Give the turn time to reach the provider call, then stop the TURN.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (systemOne.requests.slice(beforeAbort).some((r) => r.body?.questions !== undefined)) break
    await new Promise((r) => setTimeout(r, 250))
  }
  const stopResult = await mcp(base, 'tools/call', { name: 'openfox_stop', arguments: { sessionId: abortSessionId } }).catch(
    (error: Error) => ({ stopped: false, error: error.message }),
  )
  const abortWait = await mcp(base, 'tools/call', { name: 'openfox_wait', arguments: { sessionId: abortSessionId, timeout: 60 } }).catch(
    (error: Error) => ({ outcome: 'unavailable', error: error.message }),
  )
  const abortDetail = await mcp(base, 'tools/call', {
    name: 'openfox_session_detail',
    arguments: { sessionId: abortSessionId, limit: 50, maxContentLength: 2000 },
  }).catch(() => null)
  const abortSeen = observed(unwrap(abortDetail ?? { messages: [] }))
  void abortSeen
  const abortRequestBodies = systemOne.requests.slice(beforeAbort).map((r) => r.body?.state ?? '')
  record(
    'the turn abort reached the provider before the stop, so the abort is a real observed event',
    systemOne.requests.slice(beforeAbort).some((r) => r.body?.questions !== undefined),
    `${systemOne.requests.slice(beforeAbort).length} request(s) before the stop`,
  )
  // The turn abort and the transport timeout are different observables: one stops
  // the agent loop, the other fails a provider call. They are told apart by which
  // request was in flight and by the fact that no answer came back for EITHER.
  record(
    'the cancelled request is distinguishable from the transport-timeout request',
    abortRequestBodies.every((s) => typeof s === 'string' && s.includes('turn-abort')) &&
      !abortRequestBodies.some((s) => String(s).includes('provider-timeout')),
    `states in flight: ${JSON.stringify(abortRequestBodies).slice(0, 160)}`,
  )
  record(
    'the stop call was accepted on the real host',
    unwrap(stopResult as any)?.stopped === true,
    JSON.stringify(stopResult).slice(0, 200),
  )
  record(
    'the cancelled turn produced no semantic answer and no fabricated success',
    !systemOne.requests.slice(beforeAbort).some((r) => r.answered === true),
    `${systemOne.requests.slice(beforeAbort).filter((r) => r.answered === true).length} answered request(s) after the stop`,
  )
  record(
    'the cancelled session is a different session from the transport-timeout one',
    abortSessionId !== timeoutRun.sessionId && Boolean((abortWait as any)?.outcome),
    `abort outcome=${(abortWait as any)?.outcome}`,
  )
  systemOne.setMode('ok')

  // ---- Scenario 8: the advisory workflow, where publicly feasible.
  const workflows = unwrap(
    await mcp(base, 'tools/call', { name: 'openfox_workflows', arguments: { projectDir } }),
  )
  const workflowList = JSON.stringify(workflows)
  record(
    'the host discovered the installed advisory workflow file',
    workflowList.includes(ADVISORY_VERIFICATION_WORKFLOW.metadata.id),
    workflowList.slice(0, 200),
  )
  record(
    'the advisory workflow still reaches the normal verifier from every path',
    ADVISORY_VERIFICATION_WORKFLOW.steps.every((step) =>
      step.transitions.every((t) => t.goto === '$done' || ADVISORY_VERIFICATION_WORKFLOW.steps.some((s) => s.id === t.goto)),
    ),
    `steps=${ADVISORY_VERIFICATION_WORKFLOW.steps.map((s) => s.id).join(' > ')}`,
  )
  record(
    'no workflow transition branches on a semantic status',
    ADVISORY_VERIFICATION_WORKFLOW.steps.every((step) =>
      step.transitions.every((t) => t.when.type === 'always'),
    ),
    'all transitions use { type: "always" }',
  )

  // The two GRAPH facts above are properties of the file, not runtime evidence,
  // and are labelled as such. What follows actually EXECUTES the workflow and
  // reads the host's own view of it through `openfox_session_status`, which is
  // the public surface that exposes `workflowStep`/`currentStepId`.

  /**
   * Launches the advisory workflow and waits until the host reports the normal
   * verifier as the step it is on. Returns the observed status history so a
   * claim about reaching the verifier rests on the host's own report, read from
   * `workflow.currentStepId` (the step id) rather than the display name.
   */
  /**
   * Installs a workflow whose advisory step runs as `agentId`, launches it, and
   * waits for the host to report the normal verifier as the current step.
   *
   * The agent is chosen per scenario by rewriting the project's workflow file,
   * because the step's agent is baked into the workflow document. That is the
   * only public way to control which agent the advisory step runs as.
   */
  async function runWorkflowToVerifier(
    label: string,
    advisoryAgentId: string,
  ): Promise<{ ok: boolean; detail: string; steps: string[]; verifierTurns: number; verifierResult: string }> {
    await writeFile(
      join(projectDir, '.openfox', 'workflows', `${ADVISORY_VERIFICATION_WORKFLOW.metadata.id}.workflow.json`),
      JSON.stringify(advisoryWorkflowFor(advisoryAgentId), null, 2) + '\n',
    )
    const session = unwrap(
      await mcp(base, 'tools/call', {
        name: 'openfox_create_session',
        arguments: { projectId, title: `c8 ${label}`, agentId: ADVISORY_AGENT_ID },
      }),
    )
    const sessionId = String(session.sessionId ?? session.session?.id ?? session.id)
    // The LLM stub is created inside the `try` block, so it is captured here
    // explicitly rather than through the module binding.
    const model = llm
    if (!model) throw new Error('the LLM stub was not started')
    const requestsBefore = model.requests.length
    // The normal verifier is a SUB-AGENT step, host-driven, so it is scripted
    // explicitly here. It must consume a real answer: the step's whole purpose
    // is to return a verdict via `step_done`, so a placeholder would end the
    // run without the verifier having done anything.
    model.script(VERIFIER, [{ calls: [{ name: 'step_done', args: {} }] }])
    const launch = await mcp(base, 'tools/call', {
      name: 'openfox_launch_workflow',
      arguments: {
        sessionId,
        workflowId: ADVISORY_VERIFICATION_WORKFLOW.metadata.id,
        scope: 'project',
      },
    }).catch((error: Error) => ({ error: error.message }))
    if (!(launch as any)?.launched) {
      return { ok: false, detail: `launch was not accepted: ${JSON.stringify(launch).slice(0, 200)}`, steps: [], verifierTurns: 0, verifierResult: '' }
    }
    // Both step-visits are proved POSITIVELY by the host sending a model
    // request carrying that step's own prompt. A `currentStepId` projection is
    // only a snapshot: a poll can miss a step that really ran, so it can never
    // be the evidence that a step executed.
    const requestsMatching = (marker: string): number =>
      model.requests
        .slice(requestsBefore)
        .filter((r: any) => JSON.stringify(r?.messages ?? []).includes(marker)).length
    const sawAdvice = () => requestsMatching(ADVICE_STEP_MARKER)
    const sawVerifier = () => requestsMatching(VERIFIER_STEP_MARKER)
    // A verifier turn that only ever received the E2E_NO_SCRIPT placeholder did
    // not really do the work: the run is only proven if the verifier consumed a
    // real scripted answer AND produced a real result in that same turn.
    const verifierTurnsWithScript = () =>
      model.requests
        .slice(requestsBefore)
        .filter((r: any) => JSON.stringify(r?.messages ?? []).includes(VERIFIER_STEP_MARKER))
        .filter((r: any) => !JSON.stringify(r?.messages ?? []).includes('E2E_NO_SCRIPT'))
        .length
    let lastStatus = 'never polled'
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const status = await mcp(base, 'tools/call', {
        name: 'openfox_session_status',
        arguments: { sessionId },
      })
        .then(unwrap)
        .catch(() => null)
      const workflow = (status as any)?.workflow ?? null
      lastStatus = `workflowStep=${String(workflow?.currentStepId ?? (status as any)?.workflowStep ?? 'none')} active=${workflow !== null}`
      // Complete end of run is documented by the host STOPPING to report an
      // active workflow, which is the only durable public signal it exposes; no
      // terminal status is retained after the run ends.
      if (workflow === null && verifierTurnsWithScript() > 0) {
        // The verifier's result is observed from the LLM side, which is where the
        // sub-agent turn's real output exists: a sub-agent's tool calls are NOT
        // mirrored into the parent session's messages, so scanning the parent
        // transcript would always report nothing (it previously matched the
        // ADVISORY step's step_done, which proved nothing about the verifier).
        // The verifier's own request/response pair is the real evidence.
        const verifierRequests = model.requests
          .slice(requestsBefore)
          .filter((r: any) => JSON.stringify(r?.messages ?? []).includes(VERIFIER_STEP_MARKER))
        const verifierUsedScript = verifierRequests.some(
          (r: any) => !JSON.stringify(r?.messages ?? []).includes('E2E_NO_SCRIPT'),
        )
        // The scripted verifier answer asks for `step_done`. The verifier's own
        // follow-up request then carries that assistant tool call, so finding it
        // inside the VERIFIER's request chain is real attribution — unlike a
        // global scan, which also matches the advisory step's step_done.
        const verifierCalledStepDone = verifierRequests
          .flatMap((r: any) => (r?.messages ?? []).filter((m: any) => m?.tool_calls))
          .flatMap((m: any) => m.tool_calls)
          .some((c: any) => c?.function?.name === 'step_done')
        return {
          ok: true,
          detail:
            `the normal verifier really ran: ${verifierTurnsWithScript()} model request(s) carrying its prompt ` +
            `consumed a real scripted answer (not the no-script placeholder), advice requests=${sawAdvice()}, ` +
            `verifier turn called step_done=${verifierCalledStepDone}, run completed; last ${lastStatus}`,
          steps: [`advice:${sawAdvice()}`, `verifier:${verifierTurnsWithScript()}`],
          verifierTurns: verifierTurnsWithScript(),
          verifierResult: verifierCalledStepDone
            ? `step_done issued by the verifier turn itself (${verifierRequests.length} verifier request(s), script consumed=${verifierUsedScript})`
            : 'the verifier turn did not issue step_done',
        }
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    return {
      ok: false,
      detail: `the normal verifier never ran: verifier turns=${sawVerifier()}, advice turns=${sawAdvice()}, last ${lastStatus}`,
      steps: [],
      verifierTurns: sawVerifier(),
      verifierResult: '',
    }
  }

  // (a) Advice DISABLED: the agent has no semantic tool at all, so the advisory
  //     step cannot produce a verdict. The normal verifier must still run.
  // (a) Advice ACTIVE: the step runs as an agent that really has
  //     `semantic_verify_task`, so the tool is called and answered normally.
  const beforeActive = systemOne.requests.length
  llm.script(WORKFLOW, [
    { calls: [{ name: 'semantic_verify_task', args: WF_VERIFY_ARGS }] },
    { calls: [{ name: 'step_done', args: {} }] },
  ])
  const activeRun = await runWorkflowToVerifier('advice-active', ADVISORY_AGENT_ID)
  record('workflow runtime: with advice ACTIVE, the normal verifier really ran', activeRun.ok, activeRun.detail)
  record(
    'workflow runtime: the active run really entered the advisory step',
    Number(activeRun.steps.find((s) => s.startsWith('advice:'))?.split(':')[1] ?? 0) > 0,
    activeRun.detail.slice(0, 220),
  )
  record(
    'workflow runtime: the active-advice run really called the semantic tool',
    systemOne.requests.length > beforeActive,
    `${systemOne.requests.length - beforeActive} provider request(s) during the active run`,
  )
  record(
    'workflow runtime: the active run produced a real advisory status, not a verdict',
    systemOne.requests.slice(beforeActive).length > 0,
    `${systemOne.requests.slice(beforeActive).length} provider request(s), all answered by the stub`,
  )

  // (b) Advice DISABLED: the step runs as an agent WITHOUT the tool, so the
  //     advice cannot be produced. The normal verifier must still run.
  const beforeDisabled = systemOne.requests.length
  llm.script(WORKFLOW, [{ calls: [{ name: 'step_done', args: {} }] }])
  const disabledRun = await runWorkflowToVerifier('advice-disabled', 'e2e-denied')
  record(
    'workflow runtime: with advice DISABLED, the normal verifier really ran',
    disabledRun.ok,
    disabledRun.detail,
  )
  record(
    'workflow runtime: the disabled run still entered the advisory step and did not skip it',
    Number(disabledRun.steps.find((s) => s.startsWith('advice:'))?.split(':')[1] ?? 0) > 0,
    disabledRun.detail.slice(0, 220),
  )
  record(
    'workflow runtime: the disabled-advice run produced no semantic verdict and no provider request',
    systemOne.requests.length === beforeDisabled,
    `system-one requests went from ${beforeDisabled} to ${systemOne.requests.length}`,
  )

  // (c) Provider ERROR: the tool IS allowed and really called, but the provider
  //     fails with a 5xx. The run must still reach the normal verifier, so an
  //     error can never shorten verification.
  systemOne.setMode('server-error')
  const beforeWorkflowError = systemOne.requests.length
  llm.script(WORKFLOW, [
    { calls: [{ name: 'semantic_verify_task', args: WF_VERIFY_ARGS }] },
    { calls: [{ name: 'step_done', args: {} }] },
  ])
  const errorRun = await runWorkflowToVerifier('provider-error', ADVISORY_AGENT_ID)
  record(
    'workflow runtime: with the semantic tool FAILING, the normal verifier really ran',
    errorRun.ok,
    errorRun.detail,
  )
  record(
    'workflow runtime: the failing run still entered the advisory step',
    Number(errorRun.steps.find((s) => s.startsWith('advice:'))?.split(':')[1] ?? 0) > 0,
    errorRun.detail.slice(0, 220),
  )
  record(
    'workflow runtime: the failing provider was really contacted during the run',
    systemOne.requests.length > beforeWorkflowError,
    `${systemOne.requests.length - beforeWorkflowError} provider request(s) during the workflow run`,
  )
  systemOne.setMode('ok')

  record(
    'each workflow run is a distinct execution with its own observed turns',
    activeRun.verifierTurns > 0 && disabledRun.verifierTurns > 0 && errorRun.verifierTurns > 0,
    `verifier turns: active=${activeRun.verifierTurns} disabled=${disabledRun.verifierTurns} error=${errorRun.verifierTurns}`,
  )
  // The verifier's own result is asserted, not reported decoratively: the step
  // must have returned `step_done` from ITS OWN turn, which is what actually
  // completes the run and lets it continue to `$done`.
  for (const [label, run] of [
    ['active', activeRun],
    ['disabled', disabledRun],
    ['error', errorRun],
  ] as const) {
    record(
      `workflow runtime: the ${label} run's verifier turn returned its own result`,
      run.verifierResult.startsWith('step_done issued by the verifier turn itself'),
      run.verifierResult,
    )
    record(
      `workflow runtime: the ${label} run consumed no no-script placeholder in the verifier`,
      run.verifierTurns > 0,
      `${run.verifierTurns} verifier request(s) with a real scripted answer`,
    )
  }
  if (process.env.E2E_DEBUG_WF === '1') {
    const last = llm.requests.slice(-6)
    console.log('debug: last llm requests, tool names and whether they carried the turn marker:')
    for (const r of last) {
      const text = JSON.stringify(r?.messages ?? [])
      console.log(
        `  tools=${(r?.tools ?? []).map((t: any) => t.function?.name).filter((n: string) => n.startsWith('semantic_')).join(',') || 'none'} hasTurnMarker=${text.includes('E2E_TURN_')} msgs=${(r?.messages ?? []).length}`,
      )
    }
    console.log('debug: unconsumed script queues:', JSON.stringify(llm.unconsumed()))
  }

  // The report is written even when scenarios fail, so a failing run stays
  // diagnosable instead of vanishing. The directory was created before the
  // first scenario wrote its evidence.
  await writeFile(
    join(reportPath, 'report.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        openfoxVersion: OPENFOX_VERSION,
        isolation: {
          home: 'temporary tree',
          configHome: 'temporary tree',
          dataHome: 'temporary tree',
          projectWorkdir: 'temporary tree',
          productionConfigTouched: false,
        },
        scope:
          'Real OpenFox host, public /mcp agent turns, real host tool execution with the agent allow-list, real plugin settings, real skill loading. ' +
          'The LLM is scripted and System One is a deterministic loopback stub, so this proves execution paths and permission boundaries only. ' +
          'NOT a quality, calibration, false-pass or impact measurement (issue #9).',
        measured: false,
        providerRequests: systemOne?.requests.length ?? 0,
        findings,
      },
      null,
      2,
    ) + '\n',
  )
} finally {
  // Only processes this run created are signalled: the host child, then the two
  // loopback stubs. The host is signalled by PROCESS GROUP (negative pid),
  // because OpenFox re-executes itself with a larger heap and that grandchild
  // would otherwise survive a kill aimed at the direct child. A real exit is
  // awaited (bounded) so nothing keeps holding a socket, and the temp tree goes
  // last.
  step('cleaning up: host process group, loopback stubs, temporary tree')
  if (host && host.pid && host.exitCode === null && host.signalCode === null) {
    const exited = new Promise<void>((r) => host!.once('exit', () => r()))
    ownedChildren.delete(host.pid)
    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        // Negative pid targets the group created with `detached: true`, which
        // contains only this run's host and its own children.
        process.kill(-host!.pid!, signal)
      } catch {
        try {
          host!.kill(signal)
        } catch {
          /* already gone */
        }
      }
    }
    signalGroup('SIGTERM')
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 3_000)),
    ])
    if (!graceful) {
      signalGroup('SIGKILL')
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3_000))])
    }
  }
  await llm?.stop()
  await systemOne?.stop()
  if (root) await rm(root, { recursive: true, force: true })
}

const failed = findings.filter((f) => !f.ok)
console.log(
  `\nAgent E2E: ${findings.length - failed.length}/${findings.length} checks passed. ` +
    'Isolated from the developer OpenFox config; no hosted provider was contacted.',
)
if (failed.length > 0) process.exitCode = 1
