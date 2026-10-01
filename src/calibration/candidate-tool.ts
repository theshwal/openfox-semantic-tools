import type { PluginTool } from 'openfox/plugin'

import { deriveCandidateProfile, type LabelledCalibrationCase, type ProviderIdentity } from './profile.js'
import { VERIFY_POLICY_VERSION, type GateId } from '../verify/policy.js'

const GATE_IDS: readonly GateId[] = [
  'criterionTestable',
  'satisfied',
  'evidenceSufficiency',
  'offScope',
  'needsDeeperVerification',
]

function parseCases(value: unknown): LabelledCalibrationCase[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('cases must be a non-empty array')
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`cases[${index}] must be an object`)
    }
    const record = entry as Record<string, unknown>
    if (typeof record.id !== 'string' || !record.id.trim()) throw new Error(`cases[${index}].id is required`)
    if (typeof record.expectedStatus !== 'string' || !record.expectedStatus.trim()) {
      throw new Error(`cases[${index}].expectedStatus is required`)
    }
    if (record.gates === null || typeof record.gates !== 'object' || Array.isArray(record.gates)) {
      throw new Error(`cases[${index}].gates is required`)
    }
    const raw = record.gates as Record<string, unknown>
    const gates = {} as Record<GateId, number>
    for (const id of GATE_IDS) {
      const value = raw[id]
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`cases[${index}].gates.${id} must be finite`)
      }
      gates[id] = value
    }
    return { id: record.id, expectedStatus: record.expectedStatus, gates }
  })
}

export function createCalibrationCandidateTool(): PluginTool {
  return {
    name: 'semantic_calibration_candidate',
    description:
      'Build an inactive advisory calibration-profile candidate from a user-labelled numeric case set. Never activates or loosens policy automatically.',
    parameters: {
      type: 'object',
      required: ['id', 'provider', 'cases'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1 },
        provider: {
          type: 'object',
          required: ['presetId'],
          additionalProperties: false,
          properties: {
            presetId: { type: 'string', minLength: 1 },
            model: { type: 'string', minLength: 1 },
            runtimeVersion: { type: 'string', minLength: 1 },
          },
        },
        cases: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['id', 'expectedStatus', 'gates'],
            additionalProperties: false,
            properties: {
              id: { type: 'string', minLength: 1 },
              expectedStatus: { type: 'string', minLength: 1 },
              gates: {
                type: 'object',
                required: [...GATE_IDS],
                additionalProperties: false,
                properties: Object.fromEntries(GATE_IDS.map((id) => [id, { type: 'number' }])),
              },
            },
          },
        },
      },
    },
    async execute(args) {
      try {
        if (typeof args.id !== 'string' || !args.id.trim()) throw new Error('id is required')
        if (args.provider === null || typeof args.provider !== 'object' || Array.isArray(args.provider)) {
          throw new Error('provider is required')
        }
        const rawProvider = args.provider as Record<string, unknown>
        if (typeof rawProvider.presetId !== 'string' || !rawProvider.presetId.trim()) {
          throw new Error('provider.presetId is required')
        }
        const provider: ProviderIdentity = {
          presetId: rawProvider.presetId.trim(),
          ...(typeof rawProvider.model === 'string' && rawProvider.model.trim()
            ? { model: rawProvider.model.trim() }
            : {}),
          ...(typeof rawProvider.runtimeVersion === 'string' && rawProvider.runtimeVersion.trim()
            ? { runtimeVersion: rawProvider.runtimeVersion.trim() }
            : {}),
        }
        const profile = deriveCandidateProfile({
          id: args.id.trim(),
          provider,
          policyVersion: VERIFY_POLICY_VERSION,
          testedAt: new Date().toISOString(),
          cases: parseCases(args.cases),
        })
        return {
          success: true,
          output: JSON.stringify({
            advisory: true,
            active: false,
            profile,
            nextStep:
              'Review the observed ranges, add explicit gateOverrides if justified, then explicitly set active=true before selecting the profile. No activation was performed.',
          }),
        }
      } catch (error) {
        return {
          success: false,
          error: JSON.stringify({
            code: 'invalid_calibration_set',
            message: error instanceof Error ? error.message : 'Invalid calibration set',
          }),
        }
      }
    },
  }
}
