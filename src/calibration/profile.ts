import type { GateId, VerifyGate, VerifyPolicy } from '../verify/policy.js'

export type CalibrationProfileStatus =
  | 'observed'
  | 'provisional'
  | 'user-calibrated'
  | 'stale'
  | 'unverified'

export interface GateCalibrationOverride {
  threshold?: number
  undecided?: readonly [number, number] | null
}

export interface GateObservation {
  readonly min: number
  readonly max: number
  readonly median: number
  readonly count: number
}

export interface CalibrationProfile {
  readonly schemaVersion: 1
  readonly id: string
  readonly provider: {
    readonly presetId: string
    readonly model?: string
    readonly runtimeVersion?: string
  }
  readonly policyVersion: string
  readonly fixtureSetVersion?: string
  readonly testedAt: string
  readonly status: CalibrationProfileStatus
  readonly provenance: string
  readonly environmentNotes?: readonly string[]
  /** A profile never affects policy until the operator explicitly activates it. */
  readonly active: boolean
  readonly calibrated?: boolean
  readonly gateOverrides?: Partial<Record<GateId, GateCalibrationOverride>>
  readonly gateObservations?: Partial<Record<GateId, GateObservation>>
}

export interface PolicyCalibrationOverrides {
  readonly calibrated?: boolean
  readonly gates?: Partial<Record<GateId, GateCalibrationOverride>>
}

export interface ProviderIdentity {
  readonly presetId: string
  readonly model?: string
  readonly runtimeVersion?: string
}

export type ProfileFreshness = 'matched' | 'stale' | 'unverified'

const GATE_IDS: readonly GateId[] = [
  'criterionTestable',
  'satisfied',
  'evidenceSufficiency',
  'offScope',
  'needsDeeperVerification',
]

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function parseGateOverride(value: unknown): GateCalibrationOverride {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Calibration gate override must be an object')
  }
  const record = value as Record<string, unknown>
  const out: { threshold?: number; undecided?: readonly [number, number] | null } = {}
  if (record.threshold !== undefined) {
    if (!finite(record.threshold)) throw new Error('Calibration threshold must be finite')
    out.threshold = record.threshold
  }
  if (record.undecided !== undefined) {
    if (record.undecided === null) out.undecided = null
    else if (
      Array.isArray(record.undecided) &&
      record.undecided.length === 2 &&
      finite(record.undecided[0]) &&
      finite(record.undecided[1]) &&
      record.undecided[0] <= record.undecided[1]
    ) out.undecided = [record.undecided[0], record.undecided[1]]
    else throw new Error('Calibration undecided band must be null or [low, high]')
  }
  return out
}

function parseGateOverrides(value: unknown): Partial<Record<GateId, GateCalibrationOverride>> {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Calibration gates must be an object')
  }
  const out: Partial<Record<GateId, GateCalibrationOverride>> = {}
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!GATE_IDS.includes(id as GateId)) throw new Error(`Unknown calibration gate "${id}"`)
    out[id as GateId] = parseGateOverride(raw)
  }
  return out
}

function parseJsonish(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'string') {
    try { return JSON.parse(value) }
    catch { throw new Error('Calibration JSON is invalid') }
  }
  return value
}

export function parseCalibrationProfile(value: unknown): CalibrationProfile | null {
  const parsed = parseJsonish(value)
  if (parsed === undefined) return null
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Calibration profile must be an object')
  }
  const record = parsed as Record<string, unknown>
  if (record.schemaVersion !== 1) throw new Error('Unsupported calibration profile schemaVersion')
  for (const key of ['id', 'policyVersion', 'testedAt', 'status', 'provenance']) {
    if (typeof record[key] !== 'string' || !String(record[key]).trim()) {
      throw new Error(`Calibration profile ${key} is required`)
    }
  }
  if (record.provider === null || typeof record.provider !== 'object' || Array.isArray(record.provider)) {
    throw new Error('Calibration profile provider is required')
  }
  const provider = record.provider as Record<string, unknown>
  if (typeof provider.presetId !== 'string' || !provider.presetId.trim()) {
    throw new Error('Calibration profile provider.presetId is required')
  }
  const allowedStatuses: CalibrationProfileStatus[] = [
    'observed', 'provisional', 'user-calibrated', 'stale', 'unverified',
  ]
  if (!allowedStatuses.includes(record.status as CalibrationProfileStatus)) {
    throw new Error('Unsupported calibration profile status')
  }
  if (typeof record.active !== 'boolean') throw new Error('Calibration profile active must be boolean')
  if (record.calibrated !== undefined && typeof record.calibrated !== 'boolean') {
    throw new Error('Calibration profile calibrated must be boolean')
  }
  const gateOverrides = parseGateOverrides(record.gateOverrides)
  return {
    schemaVersion: 1,
    id: record.id as string,
    provider: {
      presetId: provider.presetId as string,
      ...(typeof provider.model === 'string' && provider.model ? { model: provider.model } : {}),
      ...(typeof provider.runtimeVersion === 'string' && provider.runtimeVersion
        ? { runtimeVersion: provider.runtimeVersion }
        : {}),
    },
    policyVersion: record.policyVersion as string,
    ...(typeof record.fixtureSetVersion === 'string' && record.fixtureSetVersion
      ? { fixtureSetVersion: record.fixtureSetVersion }
      : {}),
    testedAt: record.testedAt as string,
    status: record.status as CalibrationProfileStatus,
    provenance: record.provenance as string,
    ...(Array.isArray(record.environmentNotes) &&
    record.environmentNotes.every((entry) => typeof entry === 'string')
      ? { environmentNotes: record.environmentNotes as string[] }
      : {}),
    active: record.active as boolean,
    ...(typeof record.calibrated === 'boolean' ? { calibrated: record.calibrated } : {}),
    ...(Object.keys(gateOverrides).length ? { gateOverrides } : {}),
    ...(record.gateObservations && typeof record.gateObservations === 'object'
      ? { gateObservations: record.gateObservations as CalibrationProfile['gateObservations'] }
      : {}),
  }
}

export function parseCalibrationOverrides(value: unknown): PolicyCalibrationOverrides {
  const parsed = parseJsonish(value)
  if (parsed === undefined) return {}
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Calibration overrides must be an object')
  }
  const record = parsed as Record<string, unknown>
  if (record.calibrated !== undefined && typeof record.calibrated !== 'boolean') {
    throw new Error('Calibration override calibrated must be boolean')
  }
  return {
    ...(typeof record.calibrated === 'boolean' ? { calibrated: record.calibrated } : {}),
    gates: parseGateOverrides(record.gates),
  }
}

function mergeGate(gate: VerifyGate, ...layers: Array<GateCalibrationOverride | undefined>): VerifyGate {
  let threshold = gate.threshold
  let undecided = gate.undecided
  for (const layer of layers) {
    if (!layer) continue
    if (layer.threshold !== undefined) threshold = layer.threshold
    if (layer.undecided !== undefined) undecided = layer.undecided
  }
  const [min, max] = gate.range
  if (threshold < min || threshold > max) throw new Error(`Calibration threshold for ${gate.id} is outside its range`)
  if (undecided) {
    const [low, high] = undecided
    if (low < min || high > max || low > high) throw new Error(`Calibration band for ${gate.id} is outside its range`)
  }
  return { ...gate, threshold, undecided }
}

/**
 * Numeric calibration is data. Semantic routing/order remains in verify/policy.
 *
 * Precedence is deliberate:
 *   explicit operator override > explicitly active profile > conservative defaults.
 */
export function resolveVerifyPolicy(
  defaults: VerifyPolicy,
  profile: CalibrationProfile | null,
  explicit: PolicyCalibrationOverrides = {},
): VerifyPolicy {
  const useProfile = profile?.active === true
  const gates = defaults.gates.map((gate) =>
    mergeGate(
      gate,
      useProfile ? profile?.gateOverrides?.[gate.id] : undefined,
      explicit.gates?.[gate.id],
    ),
  )
  const calibrated =
    explicit.calibrated ??
    (useProfile && profile?.calibrated !== undefined ? profile.calibrated : defaults.calibrated)
  return {
    version: defaults.version,
    calibrated,
    gates,
  }
}

export function assessProfileFreshness(
  profile: CalibrationProfile | null,
  identity: ProviderIdentity,
): ProfileFreshness {
  if (!profile) return 'unverified'
  if (profile.status === 'stale' || profile.status === 'unverified') return profile.status
  if (profile.provider.presetId !== identity.presetId) return 'stale'
  if (profile.provider.model && profile.provider.model !== identity.model) return 'stale'
  if (profile.provider.runtimeVersion) {
    if (!identity.runtimeVersion) return 'unverified'
    if (profile.provider.runtimeVersion !== identity.runtimeVersion) return 'stale'
  }
  return 'matched'
}

export interface LabelledCalibrationCase {
  readonly id: string
  readonly expectedStatus: string
  readonly gates: Readonly<Record<GateId, number>>
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!
}

/**
 * Produces an advisory candidate from a user-owned labelled set.
 *
 * It intentionally derives observations, not permissive thresholds. An operator
 * may turn those observations into explicit overrides later and must then set
 * active=true themselves.
 */
export function deriveCandidateProfile(
  input: {
    id: string
    provider: ProviderIdentity
    policyVersion: string
    testedAt: string
    cases: readonly LabelledCalibrationCase[]
  },
): CalibrationProfile {
  if (!input.cases.length) throw new Error('At least one labelled calibration case is required')
  const gateObservations: Partial<Record<GateId, GateObservation>> = {}
  for (const id of GATE_IDS) {
    const values = input.cases.map((entry) => entry.gates[id])
    if (values.some((value) => !finite(value))) throw new Error(`Invalid gate value for ${id}`)
    gateObservations[id] = {
      min: Math.min(...values),
      max: Math.max(...values),
      median: median(values),
      count: values.length,
    }
  }
  return {
    schemaVersion: 1,
    id: input.id,
    provider: input.provider,
    policyVersion: input.policyVersion,
    testedAt: input.testedAt,
    status: 'user-calibrated',
    provenance: 'user-labelled-set',
    active: false,
    calibrated: false,
    gateObservations,
  }
}
