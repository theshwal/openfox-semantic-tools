import type { SkipReason } from './index.js'

/**
 * A bounded, non-sensitive record of what the transform last did.
 *
 * The transform emits `semantic.reason` on every outcome, but metadata goes to
 * the host, not to a human — so an operator who enables `contextReduce` would
 * otherwise see nothing at all and could not tell "the provider never drops
 * anything" from "the endpoint is blocked" or "the setting never fired". This
 * store is the read path for that signal.
 *
 * It deliberately holds COUNTS AND A REASON ONLY. No message text, no segment
 * content, no endpoint and no credential is ever recorded, so it is safe to
 * persist and to print.
 */
export interface TransformStatus {
  /** When the transform last ran, as an ISO timestamp. */
  at: string
  applied: boolean
  reason: SkipReason | null
  segmentsOffered: number | null
  segmentsDropped: number | null
  /** Whether the provider's answer left any segment genuinely undecided. */
  uncertain: boolean | null
  /**
   * Size of the reduction in CHARACTERS, not tokens.
   *
   * Issue #6 asked for the "estimated token effect". A token figure would need
   * the host's tokenizer for whatever model is configured, which this plugin
   * does not have; inventing one would be a guess wearing a precise label.
   * Characters are exact, and the two scale together for the comparison the
   * status is read for.
   */
  charsRemoved: number | null
  charsBefore: number | null
  charsAfter: number | null
  /** Roles that were dropped. Roles only — never any message text. */
  droppedRoles: string[] | null
  /** How many turns have been reduced since the plugin loaded. */
  appliedTurns: number
}

const MAX_RETAINED = 20

/**
 * Records transform outcomes and exposes a snapshot for the status tool.
 *
 * Bounded on purpose: only the most recent outcomes are kept, so a long
 * session cannot grow this without limit.
 */
export class TransformStatusStore {
  #recent: TransformStatus[] = []
  #appliedTurns = 0

  record(
    result: PluginMessageTransformResultLike,
    now: () => Date = () => new Date(),
  ): void {
    const status: TransformStatus = {
      at: now().toISOString(),
      applied: result.applied,
      reason: result.reason,
      segmentsOffered: result.segmentsOffered ?? null,
      segmentsDropped: result.segmentsDropped ?? null,
      uncertain: result.uncertain ?? null,
      charsRemoved: result.charsRemoved ?? null,
      charsBefore: result.charsBefore ?? null,
      charsAfter: result.charsAfter ?? null,
      droppedRoles: result.droppedRoles ?? null,
      appliedTurns: this.#appliedTurns,
    }
    if (result.applied) this.#appliedTurns += 1
    // The counter is stamped AFTER the increment on the next call, so the
    // stored value is the count of reductions completed before this one.
    status.appliedTurns = this.#appliedTurns
    this.#recent.unshift(status)
    if (this.#recent.length > MAX_RETAINED) this.#recent.length = MAX_RETAINED
  }

  /** Newest first. Returns a copy, so a caller cannot mutate the store. */
  snapshot(): TransformStatus[] {
    return this.#recent.map((entry) => ({ ...entry }))
  }

  get appliedTurns(): number {
    return this.#appliedTurns
  }
}

interface PluginMessageTransformResultLike {
  applied: boolean
  reason: SkipReason | null
  segmentsOffered?: number | null
  segmentsDropped?: number | null
  uncertain?: boolean | null
  charsRemoved?: number | null
  charsBefore?: number | null
  charsAfter?: number | null
  droppedRoles?: string[] | null
}

/**
 * Reads the transform's metadata into the shape the store records.
 *
 * Kept beside the transform so the metadata keys are defined once. Anything
 * missing is reported as "unknown" rather than a default that could read like a
 * real measurement.
 */
export function readTransformMetadata(
  metadata: Record<string, unknown> | undefined,
): PluginMessageTransformResultLike | null {
  if (!metadata || metadata['semantic.contextReduce'] !== true) return null
  const numberOrNull = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null
  const reason = metadata['semantic.reason']
  return {
    applied: metadata['semantic.applied'] === true,
    reason: typeof reason === 'string' ? (reason as SkipReason) : null,
    segmentsOffered: numberOrNull(metadata['semantic.segmentsOffered']),
    segmentsDropped: numberOrNull(metadata['semantic.segmentsDropped']),
    uncertain: typeof metadata['semantic.uncertain'] === 'boolean' ? metadata['semantic.uncertain'] : null,
    charsRemoved: numberOrNull(metadata['semantic.charsRemoved']),
    charsBefore: numberOrNull(metadata['semantic.charsBefore']),
    charsAfter: numberOrNull(metadata['semantic.charsAfter']),
    droppedRoles: Array.isArray(metadata['semantic.droppedRoles'])
      ? (metadata['semantic.droppedRoles'] as unknown[]).filter(
          (role): role is string => typeof role === 'string',
        )
      : null,
  }
}

/** Metadata keys, defined once so the transform and the reader cannot drift. */
export const TRANSFORM_METADATA_KEYS = {
  enabled: 'semantic.contextReduce',
  applied: 'semantic.applied',
  reason: 'semantic.reason',
  segmentsOffered: 'semantic.segmentsOffered',
  segmentsDropped: 'semantic.segmentsDropped',
  uncertain: 'semantic.uncertain',
  charsRemoved: 'semantic.charsRemoved',
  charsBefore: 'semantic.charsBefore',
  charsAfter: 'semantic.charsAfter',
  droppedRoles: 'semantic.droppedRoles',
} as const