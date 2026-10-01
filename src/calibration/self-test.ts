import type { PluginTool } from 'openfox/plugin'

import { capabilityOf } from '../presets/index.js'
import { ProviderError, SystemOneHttpProvider } from '../providers/system-one.js'
import { parseSettings } from '../settings.js'
import { buildVerifyQuestions } from '../verify/questions.js'
import { DEFAULT_POLICY, evaluateVerifyPolicy, type GateId, type VerifyStatus } from '../verify/policy.js'
import {
  assessProfileFreshness,
  parseCalibrationOverrides,
  parseCalibrationProfile,
  resolveVerifyPolicy,
  type GateObservation,
} from './profile.js'
import type { DecisionRequest } from '../decision/types.js'

interface SmokeFixture {
  id: string
  criterion: string
  state: DecisionRequest['state']
  expected: VerifyStatus
}

const SMOKE_FIXTURES: readonly SmokeFixture[] = [
  {
    id: 'direct-evidence',
    criterion: 'The health handler returns HTTP 200 when the service is healthy.',
    state: {
      summary: 'The health handler returns 200 for the healthy state.',
      diffExcerpts: ['return healthy ? 200 : 503'],
      deterministicTestResults: ['PASS health endpoint returns 200 when healthy'],
    },
    expected: 'unknown',
  },
  {
    id: 'insufficient-evidence',
    criterion: 'The retry loop stops after three failed attempts.',
    state: {
      summary: 'Retry handling was adjusted.',
      deterministicTestResults: [],
    },
    expected: 'insufficient-evidence',
  },
  {
    id: 'off-scope',
    criterion: 'The parser rejects an empty identifier.',
    state: {
      summary: 'The parser change also rewrites unrelated cache eviction behaviour.',
      diffExcerpts: ['cache.clear()', 'if (!identifier) throw new Error("missing identifier")'],
      deterministicTestResults: ['PASS parser rejects empty identifier'],
    },
    expected: 'off-scope',
  },
]

function observations(
  rows: ReadonlyArray<ReturnType<typeof evaluateVerifyPolicy>['gates']>,
): Partial<Record<GateId, GateObservation>> {
  const out: Partial<Record<GateId, GateObservation>> = {}
  for (const id of DEFAULT_POLICY.gates.map((gate) => gate.id)) {
    const values = rows
      .flatMap((row) => row.filter((gate) => gate.id === id).map((gate) => gate.value))
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
      .sort((a, b) => a - b)
    if (!values.length) continue
    const middle = Math.floor(values.length / 2)
    const median =
      values.length % 2 === 0
        ? (values[middle - 1]! + values[middle]!) / 2
        : values[middle]!
    out[id] = {
      min: values[0]!,
      max: values[values.length - 1]!,
      median,
      count: values.length,
    }
  }
  return out
}

/**
 * Small operator-triggered smoke test. Inputs are embedded and synthetic:
 * repository/session content is never read or persisted.
 */
export function createProviderSelfTestTool(
  readSettings: (projectId?: string) => Record<string, unknown>,
  transport: typeof fetch = fetch,
): PluginTool {
  return {
    name: 'semantic_provider_self_test',
    description:
      'Run a small synthetic advisory smoke test against the configured semantic provider and report protocol/calibration warnings. Never changes settings or activates a profile.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    async execute(_args, context) {
      try {
        const raw = readSettings(context.projectId)
        const settings = parseSettings(raw)
        const profile = parseCalibrationProfile(raw.calibrationProfileJson)
        const explicit = parseCalibrationOverrides(raw.calibrationOverridesJson)
        const runtimeVersion =
          typeof raw.runtimeVersion === 'string' && raw.runtimeVersion.trim()
            ? raw.runtimeVersion.trim()
            : undefined
        const freshness = assessProfileFreshness(profile, {
          presetId: settings.presetId ?? 'custom',
          ...(settings.model ? { model: settings.model } : {}),
          ...(runtimeVersion ? { runtimeVersion } : {}),
          policyVersion: DEFAULT_POLICY.version,
        })
        const applicableProfile =
          profile && freshness === 'matched' ? profile : profile ? { ...profile, active: false } : null
        const policy = resolveVerifyPolicy(DEFAULT_POLICY, applicableProfile, explicit)
        const provider = new SystemOneHttpProvider(settings, transport)
        const runs = []
        for (const fixture of SMOKE_FIXTURES) {
          const response = await provider.decide(
            {
              state: fixture.state,
              ...(settings.model ? { model: settings.model } : {}),
              questions: buildVerifyQuestions(fixture.criterion),
            },
            { signal: context.signal, origin: 'explicit' },
          )
          const decision = evaluateVerifyPolicy(response.answers, policy)
          const expected = fixture.id === 'direct-evidence' && policy.calibrated
            ? 'pass-candidate'
            : fixture.expected
          runs.push({
            id: fixture.id,
            expected,
            observed: decision.status,
            matched: decision.status === expected,
            reasons: decision.reasons,
            gates: decision.gates,
          })
        }

        const choiceCapability = capabilityOf(settings.presetId, 'choiceObjectCriteria')
        let choiceProbe: { attempted: boolean; supported: boolean | 'unverified'; ok: boolean | null } = {
          attempted: false,
          supported: choiceCapability,
          ok: null,
        }
        const deviations: string[] = []
        if (choiceCapability === true) {
          const response = await provider.decide(
            {
              state: 'Synthetic provider self-test. No repository content.',
              ...(settings.model ? { model: settings.model } : {}),
              questions: {
                choiceProbe: {
                  type: 'choice',
                  instructions: 'Which label best describes a successful self-test response?',
                  criteria: { ok: 'A valid provider response', bad: 'A malformed provider response' },
                },
              },
            },
            { signal: context.signal, origin: 'explicit' },
          )
          choiceProbe = {
            attempted: true,
            supported: true,
            ok: response.answers.choiceProbe?.type === 'choice',
          }
          if (!choiceProbe.ok) deviations.push('choice_probe_unexpected_shape')
        } else if (choiceCapability === false) {
          deviations.push('choice_object_criteria_declared_unsupported')
        } else {
          deviations.push('choice_capability_unverified')
        }

        const gateObservations = observations(runs.map((run) => run.gates))
        const warnings: string[] = []
        if (freshness !== 'matched') warnings.push(`profile_${freshness}`)
        if (profile && !profile.active) warnings.push('profile_inactive')
        for (const run of runs) {
          if (!run.matched) warnings.push(`smoke_mismatch:${run.id}`)
          if (run.gates.some((gate) => gate.verdict === 'unusable')) {
            warnings.push(`unusable_answer:${run.id}`)
          }
        }

        const fallbackCategories = runs
          .filter((run) => !run.matched || run.observed === 'unknown' || run.observed === 'needs-verification')
          .map((run) => run.id)

        return {
          success: true,
          output: JSON.stringify({
            advisory: true,
            syntheticOnly: true,
            protocol: {
              reachable: true,
              noul: true,
              score: true,
              choice: choiceProbe,
              deviations,
            },
            activeProfile: profile
              ? {
                  id: profile.id,
                  status: profile.status,
                  active: profile.active,
                  freshness,
                }
              : { id: null, status: 'unverified', active: false, freshness },
            semanticSmoke: {
              matched: runs.filter((run) => run.matched).length,
              total: runs.length,
              cases: runs.map(({ gates, ...run }) => run),
            },
            gateObservations,
            warnings: [...new Set(warnings)],
            fallbackCategories: [...new Set(fallbackCategories)],
            recommendation:
              warnings.length || fallbackCategories.length
                ? 'Keep conservative fallback for flagged categories. Review or replace the calibration profile before relying on positive automation.'
                : 'Smoke test matched the configured profile. Keep normal deterministic checks and fallback paths.',
          }),
        }
      } catch (error) {
        if (error instanceof ProviderError) {
          return { success: false, error: JSON.stringify({ code: error.code, message: error.message }) }
        }
        return {
          success: false,
          error: JSON.stringify({
            code: 'self_test_failed',
            message: error instanceof Error ? error.message : 'Provider self-test failed',
          }),
        }
      }
    },
  }
}
