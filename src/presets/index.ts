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
 * Ids accepted but never offered in the selector, kept so an already saved
 * configuration keeps working. `jev` is the historical id of the hosted preset:
 * renaming it outright would silently invalidate somebody's settings.
 */
const BACKEND_ALIASES: Readonly<Record<string, string>> = {
  jev: 'jev-hosted',
  'laya-compatible': 'laya',
  systemone: 'system-one',
}

/** Resolves an id or an alias to a real preset id, or null when unknown. */
function resolvePresetId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (PRESETS.some((preset) => preset.id === value)) return value
  return BACKEND_ALIASES[value] ?? null
}

/** Every capability explicitly unknown, rather than absent. */
function declaredOnly(): Record<CapabilityName, CapabilityValue> {
  return {
    noul: 'unverified',
    choiceObjectCriteria: 'unverified',
    choiceArrayCriteria: 'unverified',
    score: 'unverified',
    batchedQuestions: 'unverified',
  }
}

/**
 * The backends the issue names that this repository has **not** exercised.
 *
 * They are registered so an operator is never forced into "custom" for a
 * runtime the project already knows about, but every capability stays
 * `unverified` and no default is supplied: nothing here is a claim about the
 * runtime, only a way to select it. A capability may be promoted to `true` or
 * `false` only from an actual conformance run.
 */
const DECLARED_BACKENDS: readonly ProviderPreset[] = [
  {
    id: 'kev',
    label: { en: 'Kev', fr: 'Kev' },
    description: {
      en: 'Open decision-model family with a compatible server. Unverified here.',
      fr: 'Famille de modèles de décision ouverts avec un serveur compatible. Non vérifié ici.',
    },
    defaults: {},
    capabilities: declaredOnly(),
  },
  {
    id: 'laya',
    label: { en: 'Laya-compatible', fr: 'Compatible Laya' },
    description: {
      en: 'Laya-compatible servers. Unverified here.',
      fr: 'Serveurs compatibles Laya. Non vérifié ici.',
    },
    defaults: {},
    capabilities: declaredOnly(),
  },
  {
    id: 'system-one',
    label: { en: 'System One', fr: 'System One' },
    description: {
      en: 'Native local-first System One runtime. Unverified here.',
      fr: 'Runtime System One local-first natif. Non vérifié ici.',
    },
    defaults: {},
    capabilities: declaredOnly(),
  },
  {
    id: 'sys1',
    label: { en: 'sys1', fr: 'sys1' },
    description: {
      en: 'Rust System One server. Unverified here.',
      fr: 'Serveur System One en Rust. Non vérifié ici.',
    },
    defaults: {},
    capabilities: declaredOnly(),
  },
  {
    id: 'jev-rs',
    label: { en: 'jev-rs', fr: 'jev-rs' },
    description: {
      en: 'Rust scoring and runtime harness. Unverified here.',
      fr: 'Harnais de scoring et runtime en Rust. Non vérifié ici.',
    },
    defaults: {},
    capabilities: declaredOnly(),
  },
  {
    id: 'local-jev',
    label: { en: 'local-jev', fr: 'local-jev' },
    description: {
      en: 'Offline Jev-compatible server. Unverified here.',
      fr: 'Serveur Jev-compatible hors ligne. Non vérifié ici.',
    },
    defaults: {},
    capabilities: declaredOnly(),
  },
  {
    id: 'lichen',
    label: { en: 'Lichen', fr: 'Lichen' },
    description: {
      en: 'Jev-compatible inference over open-weight models. Unverified here.',
      fr: 'Inférence Jev-compatible sur des modèles ouverts. Non vérifié ici.',
    },
    defaults: {},
    capabilities: declaredOnly(),
  },
  {
    id: 'edgejev',
    label: { en: 'EdgeJev', fr: 'EdgeJev' },
    description: {
      en: 'Local ONNX deployment path for decision models. Unverified here.',
      fr: 'Chemin de déploiement ONNX local pour modèles de décision. Non vérifié ici.',
    },
    defaults: {},
    capabilities: declaredOnly(),
  },
]

/**
 * `custom` is always present and is the default: the generic adapter needs no
 * preset. The hosted preset records the one deviation this repository actually
 * observed against the official endpoint; every capability not probed stays
 * `unverified`.
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
    capabilities: declaredOnly(),
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
  ...DECLARED_BACKENDS,
]

export function isPresetId(value: unknown): boolean {
  return resolvePresetId(value) !== null
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
  const id = resolvePresetId(presetId)
  if (id === null) return 'unverified'
  const preset = PRESETS.find((entry) => entry.id === id)!
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
  const requested = values.backend === undefined ? DEFAULT_BACKEND_ID : values.backend
  const presetId = resolvePresetId(requested)
  if (presetId === null) {
    // Reuse the controlled configuration error so the tool layer can report it
    // without leaking an unexpected exception type.
    throw new ProviderError('configuration', `Unsupported backend "${String(requested)}"`)
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
