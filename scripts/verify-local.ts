#!/usr/bin/env node
/**
 * Everything that can be checked without a provider, in one command.
 *
 * It exists so an operator does not have to know which of the repository's
 * scripts matter, and so the boundary between "the machine proved this" and
 * "a human must look at this" is explicit rather than implied.
 *
 * Every stage below is deterministic and offline. NOTHING here contacts a
 * hosted provider or spends a cent: the local stub answers every protocol
 * probe. That is deliberate — a green run of this script is evidence about
 * wiring and protocol shape only, never about decision quality.
 *
 * It stops at the end and prints the exact steps that remain, rather than
 * pretending those steps are automatable.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

interface Stage {
  name: string
  command: string[]
  /** Extra environment, e.g. the harness tree holding the OpenFox build. */
  env?: Record<string, string>
  /** What a pass actually proves. Printed, so the output cannot overstate it. */
  proves: string
}

const PROJECT = resolve(import.meta.dirname, '..')

function readBaseline(): string {
  const pkg = JSON.parse(
    readFileSync(resolve(PROJECT, 'package.json'), 'utf8'),
  ) as { openfox?: { compatibilityBaseline?: string } }
  return pkg.openfox?.compatibilityBaseline ?? 'unknown'
}

function run(stage: Stage): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(stage.command[0]!, stage.command.slice(1), {
      cwd: PROJECT,
      env: { ...process.env, ...(stage.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const chunks: string[] = []
    child.stdout.on('data', (c: Buffer) => chunks.push(String(c)))
    child.stderr.on('data', (c: Buffer) => chunks.push(String(c)))
    child.on('exit', (code) =>
      resolve({ ok: code === 0, output: chunks.join('').trim() }),
    )
  })
}

const baseline = readBaseline()

const stages: Stage[] = [
  {
    name: `Fetch the OpenFox build under test (openfox@${baseline})`,
    command: ['bash', 'scripts/setup-harness.sh'],
    // Installs into a throwaway /tmp tree, never the developer's own OpenFox.
    env: { HARNESS_PKG_DIR: `/tmp/of-harness-${baseline}` },
    proves: 'a private OpenFox tree exists; your own install is never touched',
  },
  {
    name: 'Offline checks (types, tests, build)',
    command: ['npm', 'run', 'check'],
    proves: 'the package compiles and every local contract test passes',
  },
  {
    name: 'Protocol conformance against a local stub',
    command: ['npm', 'run', 'conformance:smoke'],
    proves: 'the transport satisfies the documented protocol on a stub — NOT provider compatibility',
  },
  {
    name: 'Context-reduction benchmark (offline)',
    command: ['npm', 'run', 'transform:benchmark'],
    proves: 'the transform harness runs and records its own uncertainty — NOT any saving',
  },
  {
    name: `Isolated OpenFox host (openfox@${baseline})`,
    command: ['npm', 'run', 'harness'],
    // The harness reads whatever OpenFox this tree holds, so the tree is
    // named here rather than assumed.
    env: { HARNESS_PKG_DIR: `/tmp/of-harness-${baseline}` },
    proves: 'a real OpenFox loads the built package, its tools, skills and transform',
  },
]

let failed = 0
for (const stage of stages) {
  process.stdout.write(`\n=== ${stage.name}\n`)
  const result = await run(stage)
  if (result.ok) {
    const tail = result.output.split('\n').slice(-3).join('\n')
    process.stdout.write(`PASS — ${stage.proves}\n${tail}\n`)
  } else {
    failed += 1
    process.stdout.write(`FAIL — ${stage.proves}\n${result.output.split('\n').slice(-20).join('\n')}\n`)
  }
}

process.stdout.write('\n' + '='.repeat(72) + '\n')
if (failed > 0) {
  process.stdout.write(`${failed} stage(s) FAILED. Fix those before reading the manual steps below.\n`)
  process.exitCode = 1
} else {
  process.stdout.write('All automatic stages passed.\n')
}
process.stdout.write(
  [
    '',
    'REMAINING MANUAL STEPS — these need YOUR instance and a real endpoint.',
    'This script cannot do them, and no output above stands in for them.',
    '',
    `1. Install the plugin into your own OpenFox from this checkout:`,
    `     cd ${PROJECT}`,
    `     npm run build`,
    '     Then Settings -> Plugins -> install from local path, using that absolute path.',
    '',
    '2. Enable it, then check the Plugins tab:',
    '     - the icon and the author "theshwal" are shown',
    '     - capabilities include: settings, tools, skills, transforms',
    '',
    '3. Open the plugin settings and confirm the honest starting state:',
    '     - contextReduce is OFF',
    '     - its label says "no measured benefit"',
    '     - endpoint is empty (configure a full POST URL before calling anything)',
    '',
    '4. Point it at a real System One-compatible endpoint and, if that endpoint',
    '   needs one, set the API key. Then, in a session with a long conversation:',
    '     - call semantic_transform_status first (expect appliedTurns 0, verdict DEFER)',
    '     - enable contextReduce, then call it again',
    '     - expect a readable reason: no_candidates on a short turn, low_confidence',
    '       if the provider keeps everything, egress_blocked if policy forbids it',
    '',
    '5. Confirm the current request is never dropped: the newest message and',
    '   anything after the last tool_result must survive every reduction.',
    '',
    'NO CLAIM is established by this script: no token saving, no cost saving, no',
    'latency win and no task-quality result has been measured. The recorded',
    'verdict for the context-reduction transform is DEFER (docs/EVALUATION.md).',
    '',
  ].join('\n'),
)