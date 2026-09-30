// Offline experiment runner for the semantic_verify_task use case.
//
// It replays the labelled fixture set through the REAL tool and the REAL policy
// using a scripted transport, so it measures plumbing, wiring and label
// agreement. It performs NO network call and needs NO credential.
//
// It is therefore NOT evidence of decision quality, false-pass rate on a real
// provider, token savings or latency. Those stay `null` / `measured: false`
// until an opt-in live run exists.
//
// Usage:
//   npm run verify:experiment              # offline, fixture transport
//   SEMANTIC_ENDPOINT=... npm run verify:experiment -- --live

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { createVerifyTool, type VerifyReport } from '../src/verify/tool.ts'
import { VERIFY_QUESTION_IDS } from '../src/verify/questions.ts'
import { DEFAULT_POLICY, evaluateVerifyPolicy, type VerifyStatus } from '../src/verify/policy.ts'
import { summarize, validateRecord, type RunRecord } from '../src/evaluation/records.ts'
import { SystemOneHttpProvider } from '../src/providers/system-one.ts'
import type { DecisionRequest } from '../src/decision/types.ts'

interface ScriptedAnswer {
  satisfied: number
  evidenceSufficiency: number
  offScope: number
  needsDeeperVerification: number
}

interface FixtureCase {
  id: string
  group: string
  criterionId: string
  issueId?: string
  criterion: string
  evidence?: {
    summary?: string
    diffExcerpts?: string[]
    deterministicTestResults?: string[]
  }
  evidenceRefs?: string[]
  scripted: ScriptedAnswer
  expected: VerifyStatus
  expectedUnderCalibratedPolicy?: VerifyStatus
  rationale: string
}

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/verify/cases.json')

function scriptedTransport(scripted: ScriptedAnswer): typeof fetch {
  return (async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as DecisionRequest
    const answers: Record<string, unknown> = {}
    for (const id of Object.keys(request.questions)) {
      if (id === VERIFY_QUESTION_IDS.evidenceSufficiency) {
        // The score contract requires a normalized distribution alongside the
        // score, exactly as a real runtime must return it.
        const top = Math.max(0, Math.min(2, Math.round(scripted.evidenceSufficiency)))
        answers[id] = {
          type: 'score',
          score: top,
          probabilities: { '0': top === 0 ? 1 : 0, '1': top === 1 ? 1 : 0, '2': top === 2 ? 1 : 0 },
        }
      } else {
        answers[id] = {
          type: 'noul',
          noul: scripted[id as keyof ScriptedAnswer] as number,
        }
      }
    }
    return Response.json({ answers })
  }) as typeof fetch
}

function toolInput(fixture: FixtureCase): Record<string, unknown> {
  return {
    criterionId: fixture.criterionId,
    criterion: fixture.criterion,
    ...(fixture.issueId ? { issueId: fixture.issueId } : {}),
    ...(fixture.evidence ? { evidence: fixture.evidence } : {}),
    ...(fixture.evidenceRefs ? { evidenceRefs: fixture.evidenceRefs } : {}),
  }
}

interface CaseOutcome {
  id: string
  group: string
  issueId: string | null
  criterionId: string
  observed: VerifyStatus
  expected: VerifyStatus
  expectedUnderCalibratedPolicy: VerifyStatus | null
  observedUnderCalibratedPolicy: VerifyStatus | null
  matched: boolean
  matchedUnderCalibratedPolicy: boolean | null
  advisory: boolean
  policyVersion: string
  calibrated: boolean
  reasons: string[]
  rationale: string
  reportId: string | null
}

// Only two arguments exist. Anything else is a mistake (a mistyped flag, a
// missing `--`) and must fail loudly rather than silently change the mode.
const KNOWN_FLAGS = new Set(['--live'])
const args = process.argv.slice(2)
const unknown = args.filter((a) => a.startsWith('-') && !KNOWN_FLAGS.has(a))
if (unknown.length > 0) {
  throw new Error(`Unknown option(s): ${unknown.join(', ')}. Usage: verify-experiment [outputDir] [--live]`)
}
const live = args.includes('--live')
const endpoint = process.env.SEMANTIC_ENDPOINT
const positional = args.filter((a) => !a.startsWith('-'))
if (positional.length > 1) {
  throw new Error(`Expected at most one output directory, received ${positional.length}`)
}
const out = resolve(positional[0] ?? 'benchmark/results/verify')

const parsed = JSON.parse(await readFile(FIXTURE_PATH, 'utf8')) as { cases: FixtureCase[] }

if (live && !endpoint) {
  throw new Error('--live requires SEMANTIC_ENDPOINT to be set to a verified full POST endpoint')
}

const outcomes: CaseOutcome[] = []
const records: RunRecord[] = []
let transportFailures = 0

for (const fixture of parsed.cases) {
  // A live run replaces only the transport: the tool, state building and policy
  // under test are identical in both modes.
  const transport = live
    ? fetch
    : scriptedTransport(fixture.scripted)
  // Credentials and endpoint come from the environment only and are never
  // persisted: the report records outcomes, never settings.
  const settings = live
    ? {
        endpoint: endpoint!,
        timeoutMs: 30_000,
        ...(process.env.SEMANTIC_API_KEY ? { apiKey: process.env.SEMANTIC_API_KEY } : {}),
        ...(process.env.SEMANTIC_MODEL ? { model: process.env.SEMANTIC_MODEL } : {}),
      }
    : { endpoint: 'http://127.0.0.1:1/v1/systemone', timeoutMs: 5_000 }

  const started = performance.now()
  const tool = createVerifyTool(() => settings, { transport })
  const result = await tool.execute(toolInput(fixture), {
    sessionId: 'fixture',
    workdir: 'offline',
  })
  const wallMs = performance.now() - started

  if (!result.success) {
    transportFailures += 1
    const code = JSON.parse(result.error!).code as string
    outcomes.push({
      id: fixture.id,
      group: fixture.group,
      issueId: fixture.issueId ?? null,
      criterionId: fixture.criterionId,
      // A failed call is not a verdict. It is recorded as its own observation.
      observed: 'unknown',
      expected: fixture.expected,
      expectedUnderCalibratedPolicy: fixture.expectedUnderCalibratedPolicy ?? null,
      observedUnderCalibratedPolicy: null,
      matched: false,
      matchedUnderCalibratedPolicy: null,
      advisory: true,
      policyVersion: DEFAULT_POLICY.version,
      calibrated: false,
      reasons: [`provider_failure:${code}`],
      rationale: fixture.rationale,
      reportId: null,
    })
    records.push({
      task: `verify:${fixture.id}`,
      variant: live ? 'live-scripted-policy' : 'fixture-scripted-policy',
      mode: live ? 'live' : 'fixture',
      wallMs,
      mainInputTokens: null,
      mainOutputTokens: null,
      mainCalls: null,
      verifierCalls: null,
      semanticCalls: 1,
      semanticCost: null,
      // An aborted or failed call is not a decision; nothing was saved.
      fallbacks: 1,
      taskSuccess: null,
      falsePasses: null,
      falseNegatives: null,
    })
    continue
  }

  const report = JSON.parse(result.output!) as VerifyReport
  const calibratedReport = evaluateVerifyPolicy(report.answers, { ...DEFAULT_POLICY, calibrated: true })

  outcomes.push({
    id: fixture.id,
    group: fixture.group,
    issueId: fixture.issueId ?? null,
    criterionId: fixture.criterionId,
    observed: report.status,
    expected: fixture.expected,
    expectedUnderCalibratedPolicy: fixture.expectedUnderCalibratedPolicy ?? null,
    observedUnderCalibratedPolicy: calibratedReport.status,
    matched: report.status === fixture.expected,
    matchedUnderCalibratedPolicy:
      fixture.expectedUnderCalibratedPolicy === undefined
        ? null
        : calibratedReport.status === fixture.expectedUnderCalibratedPolicy,
    advisory: report.advisory,
    policyVersion: report.policyVersion,
    calibrated: report.calibrated,
    reasons: report.reasons,
    rationale: fixture.rationale,
    reportId: report.reportId,
  })

  records.push({
    task: `verify:${fixture.id}`,
    variant: live ? 'live-scripted-policy' : 'fixture-scripted-policy',
    mode: live ? 'live' : 'fixture',
    wallMs,
    mainInputTokens: null,
    mainOutputTokens: null,
    mainCalls: null,
    verifierCalls: null,
    semanticCalls: 1,
    semanticCost: null,
    // The production policy deliberately routes every uncalibrated result to a
    // non-positive status, so each case is a fallback to the normal verifier.
    // This counts POLICY ROUTING, not an observed fallback rate: a real fallback
    // rate only exists in an OpenFox end-to-end run, which this is not.
    fallbacks: report.status === 'pass-candidate' ? 0 : 1,
    taskSuccess: null,
    // The fixture label is about the POLICY outcome, not the scripted answer:
    // a scripted 0.99 is not a measurement, so it can never be a false pass.
    falsePasses: null,
    falseNegatives: null,
  })
}

records.forEach(validateRecord)

const mismatches = outcomes.filter((o) => !o.matched)
const calibratedMismatches = outcomes.filter((o) => o.matchedUnderCalibratedPolicy === false)
const observedPositive = outcomes.filter((o) => o.observed === 'pass-candidate')

const report = {
  schemaVersion: 1,
  mode: live ? 'live' : 'fixture',
  measured: false,
  scope:
    'policy wiring, label agreement and report shape only. Not decision quality, not a real-provider false-pass rate, not OpenFox end-to-end benefit.',
  // A scripted answer is not a provider measurement. Until an opt-in live run
  // exists, the false-pass rate is unknown and stays null, never zero.
  falsePassRate: null as number | null,
  falseNegativeRate: null as number | null,
  falsePassRateReason: measuredReason(live),
  // `fallbacks` in runs.json counts policy routing only. The real fallback rate
  // is unmeasured, and says so here rather than being inferred from that count.
  fallbackRate: null as number | null,
  fallbackRateReason:
    'runs.json fallbacks counts policy routing per fixture, not an observed fallback rate. A rate needs an OpenFox end-to-end run.',
  policyVersion: DEFAULT_POLICY.version,
  policyCalibrated: DEFAULT_POLICY.calibrated,
  transportFailures,
  caseCount: outcomes.length,
  matched: outcomes.filter((o) => o.matched).length,
  mismatches: mismatches.map((o) => ({ id: o.id, expected: o.expected, observed: o.observed })),
  calibratedMismatches: calibratedMismatches.map((o) => ({
    id: o.id,
    expected: o.expectedUnderCalibratedPolicy,
    observed: o.observedUnderCalibratedPolicy,
  })),
  // A positive status is structurally unreachable with the shipped policy.
  observedPositiveStatuses: observedPositive.map((o) => o.id),
  cases: outcomes,
}

function measuredReason(isLive: boolean): string {
  if (!isLive) {
    return 'Offline scripted transport: the answers are authored, not inferred, so no false-pass rate can be measured.'
  }
  return 'Live transport reached, but the labelled suite is too small and single-run to state a false-pass rate; the raw per-case outcomes are recorded instead.'
}

await mkdir(dirname(resolve(out, 'report.json')), { recursive: true })
await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
await writeFile(resolve(out, 'runs.json'), JSON.stringify(records, null, 2) + '\n')
await writeFile(resolve(out, 'summary.md'), summarize(records))

console.log(
  `Verification experiment (${report.mode}): ${report.matched}/${report.caseCount} fixtures matched the labelled policy status; ` +
    `${report.observedPositiveStatuses.length} positive status(es) observed; ${transportFailures} transport failure(s); ` +
    `false-pass rate: unknown. No quality or saving claim is derived.`,
)

if (mismatches.length > 0 || calibratedMismatches.length > 0 || observedPositive.length > 0) {
  process.exitCode = 1
}
