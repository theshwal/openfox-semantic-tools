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
import { loadVerifyFixtureSet, type LoadedFixtureCase } from './verify-fixture-set.ts'
import type { DecisionAnswer, DecisionRequest } from '../src/decision/types.ts'

interface ScriptedAnswer {
  criterionTestable: number
  satisfied: number
  evidenceSufficiency: number
  offScope: number
  needsDeeperVerification: number
}

type FixtureCase = LoadedFixtureCase & { scripted: ScriptedAnswer }

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
  category: string
  issueId: string | null
  criterionId: string
  observed: VerifyStatus
  expected: VerifyStatus
  expectedUnderCalibratedPolicy: VerifyStatus | null
  observedUnderCalibratedPolicy: VerifyStatus | null
  matched: boolean
  matchedReason: boolean | null
  matchedUnderCalibratedPolicy: boolean | null
  advisory: boolean
  policyVersion: string
  calibrated: boolean
  reasons: string[]
  rationale: string
  reportId: string | null
  /**
   * Label changes, carried in the artifact so a future reader can see which
   * labels were re-examined and why. An audit that is not recorded is
   * indistinguishable from a label that was quietly adjusted.
   */
  labelAudit?: string
  /**
   * The NUMERIC answers observed for each gate, plus the provider/model the
   * runtime reported. This is what an analysis of a live run needs: the
   * previous report said "unknown" without recording the numbers that produced
   * it, so the `answer_unusable` cases could not be diagnosed from the
   * artifact at all.
   *
   * Numbers only, by construction: no state, no evidence, no criterion text,
   * no endpoint, no credential. The gate ids and the rubric are public
   * constants; the values are probabilities the runtime already returned.
   */
  observedNumbers?: ObservedNumbers
}

/** Which provider/model answered, and what each gate was told numerically. */
export interface ObservedNumbers {
  provider: string
  model: string | null
  /** Gate id -> the value the policy read, or null when the answer was unusable. */
  gateValues: Record<string, number | null>
  /** Gate id -> the raw probabilities the runtime returned for that answer. */
  probabilities: Record<string, Record<string, number>>
  /** Gate id -> the declared confidence, when the runtime stated one. */
  confidence: Record<string, number | null>
  /** Gate id -> the raw `score` the runtime returned for a `score` answer. */
  scores: Record<string, number | null>
}

/**
 * Reduces a provider answer set to the numbers an analysis needs.
 *
 * Only finite numbers and their plain maps are kept. Anything that is not a
 * number is dropped rather than stringified, so no text from a response can
 * reach the persisted artifact: a runtime echoing submitted state inside a
 * field would otherwise be persisted verbatim.
 */
function observedNumbers(
  provider: string,
  model: string | undefined,
  answers: Record<string, DecisionAnswer>,
): ObservedNumbers {
  const gateValues: Record<string, number | null> = {}
  const probabilities: Record<string, Record<string, number>> = {}
  const confidence: Record<string, number | null> = {}
  const scores: Record<string, number | null> = {}
  for (const [id, answer] of Object.entries(answers)) {
    const record = answer as unknown as Record<string, unknown>
    gateValues[id] =
      typeof record.probability === 'number' && Number.isFinite(record.probability)
        ? record.probability
        : typeof record.score === 'number' && Number.isFinite(record.score)
          ? record.score
          : null
    scores[id] =
      typeof record.score === 'number' && Number.isFinite(record.score) ? record.score : null
    confidence[id] =
      typeof record.confidence === 'number' && Number.isFinite(record.confidence) ? record.confidence : null
    const masses = record.probabilities
    if (masses !== null && typeof masses === 'object' && !Array.isArray(masses)) {
      const kept: Record<string, number> = {}
      for (const [level, mass] of Object.entries(masses as Record<string, unknown>)) {
        if (typeof mass === 'number' && Number.isFinite(mass)) kept[level] = mass
      }
      probabilities[id] = kept
    }
  }
  return { provider, model: model ?? null, gateValues, probabilities, confidence, scores }
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

const fixtureSet = loadVerifyFixtureSet(JSON.parse(await readFile(FIXTURE_PATH, 'utf8')))
if (fixtureSet.problems.length > 0) {
  // A campaign run on an unbalanced or duplicated suite would produce a
  // comparison nobody could interpret, so the run stops before any call. The
  // loader names every offending fixture, so this is actionable on its own.
  for (const issue of fixtureSet.problems) {
    console.error(`fixture ${issue.caseId ?? '<file>'}: [${issue.code}] ${issue.detail}`)
  }
  throw new Error(
    `${FIXTURE_PATH} has ${fixtureSet.problems.length} schema or balance problem(s); the run was refused`,
  )
}
const fixtures = fixtureSet.cases as readonly FixtureCase[]
const parsed = { cases: fixtures }

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
      category: fixture.category,
      issueId: fixture.issueId,
      criterionId: fixture.criterionId,
      // A failed call is not a verdict. It is recorded as its own observation.
      observed: 'unknown',
      expected: fixture.expected,
      expectedUnderCalibratedPolicy: fixture.expectedUnderCalibratedPolicy ?? null,
      observedUnderCalibratedPolicy: null,
      matched: false,
      matchedReason: null,
      matchedUnderCalibratedPolicy: null,
      advisory: true,
      policyVersion: DEFAULT_POLICY.version,
      calibrated: false,
      reasons: [`provider_failure:${code}`],
      rationale: fixture.rationale,
      reportId: null,
      ...(fixture.labelAudit ? { labelAudit: fixture.labelAudit } : {}),
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
    category: fixture.category,
    issueId: fixture.issueId,
    criterionId: fixture.criterionId,
    observed: report.status,
    expected: fixture.expected,
    expectedUnderCalibratedPolicy: fixture.expectedUnderCalibratedPolicy ?? null,
    observedUnderCalibratedPolicy: calibratedReport.status,
    matched: report.status === fixture.expected,
    matchedReason:
      fixture.expectedReason === undefined ? null : report.reasons.includes(fixture.expectedReason),
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
    ...(fixture.labelAudit ? { labelAudit: fixture.labelAudit } : {}),
    // A live run is the only mode whose numbers are measurements rather than
    // authored values, so only it records them. A fixture run would persist
    // numbers this script itself wrote, which is a tautology, not evidence.
    ...(live ? { observedNumbers: observedNumbers(report.provider, report.model, report.answers) } : {}),
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
const reasonMismatches = outcomes.filter((o) => o.matchedReason === false)
const calibratedMismatches = outcomes.filter((o) => o.matchedUnderCalibratedPolicy === false)
const observedPositive = outcomes.filter((o) => o.observed === 'pass-candidate')

const report = {
  schemaVersion: live ? 2 : 1,
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
  /**
   * How the suite is built, so a reader can tell a balanced comparison from a
   * result dominated by one kind of case. Recorded on every run because the
   * balance, not the provider, is what makes the numbers readable.
   */
  fixtureFamilies: fixtureSet.familyCounts,
  expectedStatusCounts: fixtureSet.statusCounts,
  matched: outcomes.filter((o) => o.matched).length,
  mismatches: mismatches.map((o) => ({ id: o.id, expected: o.expected, observed: o.observed })),
  /**
   * A label without a reason is a label that cannot be diagnosed. In a LIVE
   * run the reason is observed, so a mismatch is a real disagreement; in a
   * fixture run it is deliberately not asserted, because the numbers that
   * produced the reason were authored by this script.
   */
  reasonMismatches: reasonMismatches.map((o) => ({
    id: o.id,
    expectedReason: (parsed.cases.find((c) => c.id === o.id) as FixtureCase | undefined)?.expectedReason,
    observedReasons: o.reasons,
  })),
  calibratedMismatches: calibratedMismatches.map((o) => ({
    id: o.id,
    expected: o.expectedUnderCalibratedPolicy,
    observed: o.observedUnderCalibratedPolicy,
  })),
  // A positive status is structurally unreachable with the shipped policy.
  observedPositiveStatuses: observedPositive.map((o) => o.id),
  cases: outcomes,
  ...(live
    ? {
        /**
         * The contract of the per-case `observedNumbers` block, stated so a
         * reader never has to infer it: numbers only, and only from a live run.
         */
        observedFields: {
          contains: ['provider', 'model', 'gateValues', 'probabilities', 'confidence', 'scores'],
          excludes: ['state', 'evidence', 'criterion', 'endpoint', 'apiKey', 'headers'],
        },
      }
    : {}),
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
// A reason disagreement is only meaningful when the provider supplied the
// answers. A fixture run asserts nothing about the reason.
if (live && reasonMismatches.length > 0) {
  process.exitCode = 1
}
