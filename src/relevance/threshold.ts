/**
 * The operator's confidence dial.
 *
 * This is the single knob that decides whether a discovery result is shown as
 * usable or shown as a lead. It is deliberately a plain number the operator
 * picks, not something derived from a model or a hidden policy: the plugin's
 * whole claim is that the caller knows what it is looking at.
 *
 * The threshold only CLASSIFIES. It never gates a pass, never filters a
 * candidate away, and never rescues a technical failure.
 */

/**
 * The registered default, in PERCENT.
 *
 * One source of truth: `src/index.ts` registers this value in the settings
 * schema, and the field descriptions interpolate it. A second literal "75" in a
 * description would silently drift from the dial it documents.
 */
export const DEFAULT_CONFIDENCE_THRESHOLD_PERCENT = 75

export const MIN_CONFIDENCE_THRESHOLD = 0
export const MAX_CONFIDENCE_THRESHOLD = 1

export function resolveConfidenceThreshold(values: Record<string, unknown>): number {
  const raw = values.confidenceThreshold
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return DEFAULT_CONFIDENCE_THRESHOLD_PERCENT / 100
  }

  // A value in 0..1 is already a probability. Anything above that can only be
  // a percentage, so it is divided by 100.
  //
  // The guard matters: dividing a value in 1..2 by 100 turns an operator who
  // typed "1.5" into a 1.5% dial, and every candidate then reads `below` with
  // no visible explanation. A fraction just above 1 is far more likely to be a
  // typo or a stray unit than a deliberate 1%-and-a-bit setting, so the small
  // out-of-range band is clamped to the maximum instead.
  const scaled = raw > 1 && raw < 2 ? MAX_CONFIDENCE_THRESHOLD : raw > 1 ? raw / 100 : raw
  if (scaled < MIN_CONFIDENCE_THRESHOLD) return MIN_CONFIDENCE_THRESHOLD
  if (scaled > MAX_CONFIDENCE_THRESHOLD) return MAX_CONFIDENCE_THRESHOLD
  return scaled
}

/** Human-readable form, for messages that quote the dial. */
export function formatThreshold(threshold: number): string {
  const percent = Math.round(threshold * 100)
  return `${percent}%`
}

/** Setting description, in both shipped locales, derived from the constant. */
export const THRESHOLD_DESCRIPTION_EN =
  `Operator dial, default ${DEFAULT_CONFIDENCE_THRESHOLD_PERCENT}. A discovery candidate at or above it is ` +
  'labelled "above", the others "below". It only labels: a below-threshold candidate stays visible, and a ' +
  'missing, unusable or failed answer stays "unknown", so the dial can never turn a technical failure ' +
  'into a pass. Accepts 0-100 or 0-1.'

export const THRESHOLD_DESCRIPTION_FR =
  `Cadran operateur, defaut ${DEFAULT_CONFIDENCE_THRESHOLD_PERCENT}. Un candidat de decouverte au-dessus est etiquete ` +
  '"above", les autres "below". Il ne fait qu etiqueter : un candidat sous le seuil reste visible, et une ' +
  'reponse absente, inutilisable ou en echec reste "unknown" : le cadran ne transforme jamais une panne ' +
  'en succes. Accepte 0-100 ou 0-1.'