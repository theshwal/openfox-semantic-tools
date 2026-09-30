/**
 * Provider presets.
 *
 * A preset is **data**, never a second transport. It supplies defaults and
 * declared capabilities, and nothing else:
 *
 * - it owns no HTTP client, so `SystemOneHttpProvider` stays the only adapter;
 * - it carries no semantic policy: no threshold, no score, no calibration flag;
 * - it carries no credential, only a hint about whether auth is usually needed;
 * - its capabilities are **declarations with a provenance**, not certifications.
 *   A capability is only `true` or `false` when it was actually observed; every
 *   other case is `unverified`, so nothing is ever inferred from silence.
 *
 * The point of a preset is configuration ergonomics, and a custom endpoint must
 * keep working exactly as before.
 */

import { ProviderError } from '../errors.js'

export type CapabilityName =
  | 'noul'
  | 'choiceObjectCriteria'
  | 'choiceArrayCriteria'
  | 'score'
  | 'batchedQuestions'

/** The capability map shape a preset declares. */
export type PresetCapabilities = Partial<Record<CapabilityName, CapabilityValue>>

/**
 * Tri-state on purpose: `true`/`false` mean "observed", `unverified` means
 * "nobody asked". Absence of evidence is never evidence of absence.
 */
export type CapabilityValue = true | false | 'unverified'

export interface PresetDefaults {
  /** Endpoint shape only. No host is guessed at request time. */
  readonly endpoint?: string
  /** Model hint. A user-entered model always wins. */
  readonly model?: string
  /** Whether this kind of backend usually needs a credential. Never the value. */
  readonly authUsuallyRequired?: boolean
}

export interface ProviderPreset {
  readonly id: string
  readonly label: { en: string; fr: string }
  readonly description: { en: string; fr: string }
  readonly defaults: PresetDefaults
  readonly capabilities: Partial<Record<CapabilityName, CapabilityValue>>
}

export const DEFAULT_BACKEND_ID = 'custom'

/**
 * `custom` is always present and is the default: the generic adapter needs no
 * preset. The hosted preset records the one deviation this repository actually
 * observed against the official endpoint (see docs/LIVE-JEV-FINDINGS.md); every
 * capability not probed stays `unverified`.
 */
export const PRESETS: readonly ProviderPreset[] = [
  {
    id: 'custom',
    label: { en: 'Custom / local System One', fr: 'System One personnalisé / local' },
    description: {
      en: 'Any System One-compatible endpoint. No preset assumptions are applied.',
      fr: 'Tout endpoint compatible System One. Aucune hypothèse de preset appliquée.',
    },
    defaults: {},
    capabilities: {
      noul: 'unverified',
      choiceObjectCriteria: 'unverified',
      choiceArrayCriteria: 'unverified',
      score: 'unverified',
      batchedQuestions: 'unverified',
    },
  },
  {
    id: 'jev-hosted',
    label: { en: 'Jev (hosted)', fr: 'Jev (hébergé)' },
    description: {
      en: 'Hosted Jev endpoint. Configure the full POST URL; no host is guessed.',
      fr: 'Endpoint Jev hébergé. Configurez l\'URL POST complète ; aucun hôte n\'est deviné.',
    },
    defaults: {
      // Shape only: the operator supplies the real URL in settings.
      endpoint: '',
      authUsuallyRequired: true,
    },
    capabilities: {
      noul: true,
      choiceObjectCriteria: true,
      // Observed: this runtime rejected array criteria with a targeted error
      // while object criteria worked. Declared from a conformance run, not from
      // a guess, and not a certification of future behaviour.
      choiceArrayCriteria: false,
      score: true,
      batchedQuestions: true,
    },
  },
]

export function isPresetId(value: unknown): boolean {
  return typeof value === 'string' && PRESETS.some((preset) => preset.id === value)
}

export function listPresets(): readonly ProviderPreset[] {
  return PRESETS
}

/**
 * Reads a declared capability. Anything not declared — and any preset that
 * does not exist — is `unverified`. This function never guesses and never
 * turns a missing declaration into `false`.
 */
export function capabilityOf(presetId: unknown, capability: CapabilityName): CapabilityValue {
  if (!isPresetId(presetId)) return 'unverified'
  const preset = PRESETS.find((entry) => entry.id === presetId)!
  return preset.capabilities[capability] ?? 'unverified'
}

export interface ResolvedProviderSettings {
  readonly presetId: string
  readonly endpoint?: string
  readonly model?: string
  readonly apiKey?: string
  /** True when the preset actually contributed a default. */
  readonly defaultsApplied: boolean
}

/**
 * Resolves preset defaults against the operator's own values.
 *
 * A preset only ever **fills in what is missing**: an explicit endpoint, model
 * or key always wins, including an empty string, which means "no override".
 */
export function applyPreset(values: Record<string, unknown>): ResolvedProviderSettings {
  const presetId = values.backend === undefined ? DEFAULT_BACKEND_ID : String(values.backend)
  if (!isPresetId(presetId)) {
    // Reuse the controlled configuration error so the tool layer can report it
    // without leaking an unexpected exception type.
    throw new ProviderError('configuration', `Unsupported backend "${presetId}"`)
  }
  const preset = PRESETS.find((entry) => entry.id === presetId)!

  const explicit = (key: string): string | undefined => {
    const value = values[key]
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  }
  const endpoint = explicit('endpoint') ?? preset.defaults.endpoint
  const model = explicit('model') ?? preset.defaults.model
  const apiKey = explicit('apiKey')

  return {
    presetId,
    ...(endpoint ? { endpoint } : {}),
    ...(model ? { model } : {}),
    ...(apiKey ? { apiKey } : {}),
    defaultsApplied: Boolean(preset.defaults.endpoint || preset.defaults.model),
  }
}
