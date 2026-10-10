// Multi-runtime conformance campaign: runs the SAME declared case list against
// several System One-compatible runtimes and persists sanitized evidence.
//
// It is opt-in and never part of ordinary CI. Endpoints, keys and models are
// read only from a local, git-ignored campaign file (or from the environment)
// and are never written to the persisted evidence: the endpoint is always
// recorded as `redacted` and only the syntactic URL classification survives.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { classifyEndpoint } from '../src/egress.ts'
import { runConformanceSuite, type ConformanceReport } from './conformance-suite.ts'

/** A runtime the operator wants to probe. */
export interface CampaignTarget {
  /** Operator-chosen slug; used for the persisted file name only. */
  readonly id: string
  /** Full POST endpoint. Never persisted. */
  readonly endpoint: string
  /** Optional model id exercised by the `model-supplied` case. Never persisted. */
  readonly model?: string
  /** Optional deliberately invalid model id, for the negative case. */
  readonly unsupportedModel?: string
  readonly apiKey?: string
  /** Version string the operator observed out of band. Persisted as-is. */
  readonly runtimeVersion?: string
}

export interface CampaignEvidenceEntry {
  /** Which runtime this run targeted, as typed by the operator. */
  readonly target: string
  /** The version identity the operator observed, when they supplied one. */
  readonly runtimeVersion: string | null
  /** The exact reproducible command, with every secret replaced. */
  readonly command: string
  /** How the endpoint URL classified syntactically. The URL itself is dropped. */
  readonly endpointClassification: string
  /**
   * Model ids the runtime reported answering with, in the order first seen.
   * This is an **observation**: the runtime names its own model, which is not
   * the same thing as a model the operator configured and sent. An empty list
   * means the runtime named none.
   */
  readonly modelsObserved: string[]
  readonly compatible: boolean
  readonly strictCompatible: boolean
  readonly matchedCases: number
  readonly totalCases: number
  readonly capabilities: Record<string, boolean | 'unverified'>
  readonly deviations: Array<{ id: string; detail: string }>
  readonly unverified: string[]
}

export interface CampaignEvidence {
  schemaVersion: 1
  /** Fixed: a protocol probe never certifies decision quality. */
  scope: string
  runs: CampaignEvidenceEntry[]
}

/**
 * The exact command an operator re-runs, with every credential removed. The
 * endpoint is passed through the environment, so the persisted command names
 * only the environment variables and never a host, an IP or a key.
 */
export function campaignCommand(target: CampaignTarget): string {
  return [
    'SEMANTIC_ENDPOINT=<redacted>',
    ...(target.apiKey ? ['SEMANTIC_API_KEY=<redacted>'] : []),
    ...(target.model ? [`SEMANTIC_MODEL=${target.model}`] : []),
    ...(target.unsupportedModel ? [`SEMANTIC_UNSUPPORTED_MODEL=${target.unsupportedModel}`] : []),
    `SEMANTIC_PROVIDER_ID=${target.id}`,
    'npm run conformance -- benchmark/results/conformance',
  ].join(' ')
}

/**
 * Reduces a full report to the evidence that may be committed: no endpoint, no
 * response payload, no latency, nothing derived from a host or a key.
 */
export function toEvidenceEntry(target: CampaignTarget, report: ConformanceReport): CampaignEvidenceEntry {
  return {
    target: target.id,
    runtimeVersion: target.runtimeVersion ?? null,
    command: campaignCommand(target),
    endpointClassification: report.endpointClassification,
    // What the runtime said it was, which is not what the operator sent.
    modelsObserved: [
      ...new Set(
        report.results
          .map((result) => result.response?.model)
          .filter((model): model is string => typeof model === 'string' && model.length > 0),
      ),
    ],
    compatible: report.compatible,
    strictCompatible: report.strictCompatible,
    matchedCases: report.matchedCases,
    totalCases: report.totalCases,
    capabilities: report.capabilities,
    deviations: report.deviations,
    unverified: report.unverified,
  }
}

/**
 * Classifies a URL syntactically, tolerating a URL that is not one. A target
 * whose endpoint is malformed is exactly the case the campaign must survive, so
 * classification never throws here: an unparsable URL is reported as
 * `unclassified` rather than taking the run down with it.
 */
function safeClassification(endpoint: string): string {
  try {
    return classifyEndpoint(endpoint)
  } catch {
    return 'unclassified'
  }
}

/**
 * Rejects evidence that would leak a secret or a private endpoint. Applied to
 * every entry before it is written, so an operator mistake fails the run rather
 * than committing a host address or a key.
 */
const FORBIDDEN = [
  /https?:\/\//i,
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/,
  /Bearer\s/i,
  // Provider-prefixed keys (`sk-`, `hf_`, `glpat-`, ...) are only the shapes
  // this project has already seen. The generic patterns below are what
  // actually hold the line: a secret is a secret whatever it is called.
  /\b(?:sk|hf|glpat|ghp|gho|xoxb|api)[-_][A-Za-z0-9_-]{6,}/i,
  // Generic credential material: a name that reads like a secret, assigned a
  // value. The assignment is what makes it a leak rather than a field name.
  /\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|secret|password|passwd|credential[s]?)\b\s*[:=]\s*["']?[^\s"'<>,{}[\]]{3,}/i,
  /\b[a-z0-9-]+\.(?:ts\.net|ngrok\.(?:io|app)|trycloudflare\.com)\b/i,
]

export function findLeak(entry: CampaignEvidenceEntry): string | null {
  const serialised = JSON.stringify(entry)
  for (const pattern of FORBIDDEN) {
    const match = pattern.exec(serialised)
    if (match) return `forbidden pattern ${pattern} matched "${match[0]}"`
  }
  return null
}

export async function runCampaign(
  targets: readonly CampaignTarget[],
): Promise<{ evidence: CampaignEvidence; leaks: Array<{ target: string; detail: string }> }> {
  const runs: CampaignEvidenceEntry[] = []
  const leaks: Array<{ target: string; detail: string }> = []
  for (const target of targets) {
    /**
     * One unusable target must never destroy the evidence for the others. A
     * typo'd endpoint, a mistyped timeout or a credential the runtime refuses
     * all surface as a throw here, and the runs already collected are the
     * campaign's real output: they are persisted, with this target recorded as
     * unanswered rather than silently dropped from the totals.
     */
    let report: ConformanceReport
    try {
      report = await runConformanceSuite({
        endpoint: target.endpoint,
        ...(target.apiKey ? { apiKey: target.apiKey } : {}),
        ...(target.model ? { model: target.model } : {}),
        ...(target.unsupportedModel ? { unsupportedModel: target.unsupportedModel } : {}),
        providerId: target.id,
      })
    } catch {
      runs.push({
        target: target.id,
        runtimeVersion: target.runtimeVersion ?? null,
        command: campaignCommand(target),
        // The URL never survives, not even here: only its syntactic class.
        endpointClassification: safeClassification(target.endpoint),
        // Nothing was observed, so nothing is claimed.
        modelsObserved: [],
        // Nothing was observed, so nothing is claimed. `compatible: false` is
        // the truth for a run that produced no report at all.
        compatible: false,
        strictCompatible: false,
        matchedCases: 0,
        totalCases: 0,
        capabilities: {},
        deviations: [
          {
            id: 'campaign-run',
            // No raw error text: it can echo the endpoint or the credential.
            detail: 'the run produced no report; the target configuration was not usable',
          },
        ],
        unverified: [],
      })
      continue
    }
    const entry = toEvidenceEntry(target, report)
    const leak = findLeak(entry)
    if (leak) leaks.push({ target: target.id, detail: leak })
    runs.push(entry)
  }
  return {
    evidence: {
      schemaVersion: 1,
      scope: 'protocol conformance across runtimes; not decision quality, latency, calibration, provider identity or OpenFox end-to-end evidence',
      runs,
    },
    leaks,
  }
}

/**
 * Loads the opt-in campaign file. It is git-ignored, so an operator's private
 * endpoints and keys never reach the repository.
 */
async function loadTargets(): Promise<CampaignTarget[]> {
  const file = process.env.SEMANTIC_CAMPAIGN_FILE ?? 'benchmark/campaign.local.json'
  const path = resolve(file)
  if (!existsSync(path)) {
    throw new Error(
      `No campaign file at ${file}. Copy benchmark/campaign.example.json, fill in endpoints and keys locally, and keep the file out of git.`,
    )
  }
  const parsed = JSON.parse(await readFile(path, 'utf8')) as { targets?: CampaignTarget[] }
  const targets = parsed.targets ?? []
  if (targets.length === 0) throw new Error('The campaign file lists no targets')
  return targets
}

const isDirectRun = process.argv[1]?.endsWith('conformance-campaign.ts')
if (isDirectRun) {
  const { evidence, leaks } = await runCampaign(await loadTargets())
  // Defaults to the path docs/PROVIDERS.md points at and the repository already
  // commits, so an operator who follows the documentation refreshes the real
  // evidence file instead of writing a second, undocumented one.
  const out = resolve(process.argv[2] ?? 'benchmark/evidence')
  await mkdir(out, { recursive: true })
  if (leaks.length > 0) {
    for (const leak of leaks) console.error(`Refusing to persist ${leak.target}: ${leak.detail}`)
    process.exitCode = 1
  } else {
    await writeFile(resolve(out, 'conformance-campaign.json'), `${JSON.stringify(evidence, null, 2)}\n`)
    for (const run of evidence.runs) {
      console.log(`${run.target}: ${run.matchedCases}/${run.totalCases} matched; compatible=${run.compatible}; strictCompatible=${run.strictCompatible}; ${run.deviations.length} deviation(s)`)
    }
  }
}
