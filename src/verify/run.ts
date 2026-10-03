import { SystemOneHttpProvider } from '../providers/system-one.js'
import { parseSettings } from '../settings.js'
import { buildVerifyState } from './state.js'
import { buildVerifyRequest } from './questions.js'
import { DEFAULT_POLICY, evaluateVerifyPolicy, type VerifyPolicy, type VerifyStatus } from './policy.js'
import {
  assessProfileFreshness,
  parseCalibrationOverrides,
  parseCalibrationProfile,
  resolveVerifyPolicy,
} from '../calibration/profile.js'
import type { DecisionAnswer, DecisionResponse, DecisionRequest } from '../decision/types.js'

export interface VerifyReport {
  reportId: string
  trace: {
    issueId: string | null
    criterionId: string
    criterionText: string
    evidenceRefs: readonly string[]
  }
  status: VerifyStatus
  /** Always true: the result is advice, never a gate. */
  advisory: true
  policyVersion: string
  calibrated: boolean
  provider: string
  model?: string
  latencyMs: number
  evidenceBytes: number
  answers: Record<string, DecisionAnswer>
  gates: ReturnType<typeof evaluateVerifyPolicy>['gates']
  reasons: string[]
  /**
   * Numbers the runtime declared about its own certainty. Reported for later
   * analysis and never used to decide the status.
   */
  telemetry: ReturnType<typeof evaluateVerifyPolicy>['telemetry']
  calibration: {
    profileId: string | null
    freshness: 'matched' | 'stale' | 'unverified'
    applied: boolean
    explicitOverrides: boolean
  }
}

export interface VerifyRunOptions {
  policy?: VerifyPolicy
  transport?: typeof fetch
}

export interface VerifyRunContext {
  readonly projectId?: string
  readonly signal?: AbortSignal
}

/**
 * Runs the verification use-case policy without wrapping it in a PluginTool
 * result. Both the one-criterion tool and issue-level aggregation use this
 * function so settings, calibration, egress and failure semantics cannot drift.
 *
 * Provider/settings errors are deliberately allowed to throw. The OpenFox tool
 * boundary decides how to serialize them; callers must never manufacture a
 * semantic verdict from a failed run.
 */
export async function runVerifyAssessment(
  args: unknown,
  context: VerifyRunContext,
  readSettings: (projectId?: string) => Record<string, unknown>,
  options: VerifyRunOptions = {},
): Promise<VerifyReport> {
  const built = buildVerifyState(args)
  const rawArgs = args as Record<string, unknown>
  const request: DecisionRequest = buildVerifyRequest(
    built.state,
    built.trace.criterionText,
    typeof rawArgs.model === 'string' ? rawArgs.model : undefined,
  )

  const rawSettings = readSettings(context.projectId)
  const settings = parseSettings(rawSettings)
  const provider = new SystemOneHttpProvider(settings, options.transport ?? fetch)
  const profile = parseCalibrationProfile(rawSettings.calibrationProfileJson)
  const runtimeVersion =
    typeof rawSettings.runtimeVersion === 'string' && rawSettings.runtimeVersion.trim()
      ? rawSettings.runtimeVersion.trim()
      : undefined
  const freshness = assessProfileFreshness(profile, {
    presetId: settings.presetId ?? 'custom',
    ...(settings.model ? { model: settings.model } : {}),
    ...(runtimeVersion ? { runtimeVersion } : {}),
    policyVersion: DEFAULT_POLICY.version,
  })

  // A stale/unverified profile is visible but never applied. Explicit operator
  // overrides remain explicit and therefore still take priority.
  const applicableProfile =
    profile && freshness === 'matched' ? profile : profile ? { ...profile, active: false } : null
  const explicitCalibration = parseCalibrationOverrides(rawSettings.calibrationOverridesJson)
  const policy =
    options.policy ??
    resolveVerifyPolicy(DEFAULT_POLICY, applicableProfile, explicitCalibration)

  // Verification always assembles repository/session-derived content.
  const response: DecisionResponse = await provider.decide(request, {
    signal: context.signal,
    origin: 'automatic',
  })
  const decision = evaluateVerifyPolicy(response.answers, policy)

  return {
    reportId: built.reportId,
    trace: built.trace,
    status: decision.status,
    advisory: true,
    policyVersion: decision.policyVersion,
    calibrated: decision.calibrated,
    provider: response.provider,
    ...(response.model ? { model: response.model } : {}),
    latencyMs: response.latencyMs ?? 0,
    evidenceBytes: built.bytes,
    answers: response.answers,
    gates: decision.gates,
    reasons: [...decision.reasons],
    telemetry: decision.telemetry,
    calibration: {
      profileId: profile?.id ?? null,
      freshness,
      applied: Boolean(profile?.active && freshness === 'matched'),
      explicitOverrides:
        rawSettings.calibrationOverridesJson !== undefined &&
        rawSettings.calibrationOverridesJson !== '',
    },
  }
}
