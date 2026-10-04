import type { DecisionAnswer, DecisionQuestion, JsonValue } from '../decision/types.js'
import { isRecord, validateRequest } from '../decision/validation.js'
import { ProviderError } from '../errors.js'
import {
  MAX_CALIBRATION_CASES,
  MAX_CALIBRATION_STATE_BYTES,
  MAX_CALIBRATION_VERSION_LENGTH,
  NOUL_COMPARISON_BOUNDARY,
  QUESTION_ID,
  evaluateLabelledCases,
  questionLabels,
  type CaseDecision,
  type CaseObservation,
  type LabelledCase,
  type QuestionEvaluationReport,
} from './question-eval.js'
import type { ProviderIdentity } from './profile.js'

/**
 * Reference agreement: compare the configured semantic provider against a
 * reference judgment on a frozen question and case set.
 *
 * Three properties shape this module.
 *
 * 1. The reference judgment crosses a CALLER boundary. OpenFox exposes no
 *    plugin API for invoking the active main LLM, so the judgments are input,
 *    taken before this module runs. Nothing here calls an LLM, and the
 *    semantic answer cannot flow backwards into a reference judgment because
 *    the reference is already frozen when the module is entered.
 * 2. The metric is agreement/concordance against a reference, NOT accuracy.
 *    Only a human-labelled reference may be called accuracy, and the report
 *    says which of the two the reader is looking at.
 * 3. The report is evidence. It activates nothing, recommends no decision
 *    boundary and ranks no provider. An unmeasured number is `null`.
 *
 * The semantic side reuses `evaluateLabelledCases` unchanged, so a reference
 * judgment is compared exactly the way an operator label is: same primitive
 * domains, same `noul` comparison boundary, same fatal/per-case error split.
 */

export type ReferenceSource = 'llm' | 'human'

export type ReferenceDisposition = 'clear' | 'ambiguous'

export interface ReferenceProvenance {
  readonly source: ReferenceSource
  /** Null for a human reference: there is no model to name. */
  readonly model: string | null
  /** The prompt/question wording the reference was produced from. */
  readonly promptVersion: string
  /** Date or version of the reference pass. Null when not recorded. */
  readonly recordedAt: string | null
}

export interface ReferenceCase {
  readonly id: string
  readonly state: JsonValue
  /** The reference judgment, in the primitive's own domain. */
  readonly referenceAnswer: boolean | string | number
  /** Optional operator disposition on the reference, not on the provider. */
  readonly disposition?: ReferenceDisposition
}

export interface ReviewedLabel {
  readonly id: string
  /** The human-reviewed label, in the primitive's own domain. */
  readonly expected: boolean | string | number
}

export interface DisagreementItem {
  readonly id: string
  readonly referenceAnswer: boolean | string | number
  readonly observed: boolean | string | number | null
  /** Raw provider numbers, kept so a reviewer sees WHY it disagreed. */
  readonly probability: number | null
  readonly distribution: Readonly<Record<string, number>> | null
  readonly score: number | null
  readonly confidence: number | null
  readonly latencyMs: number
  readonly reason: 'mismatch' | 'provider_error' | 'malformed_answer'
  readonly error: string | null
  readonly disposition: ReferenceDisposition | null
}

export interface LowConfidenceAgreementItem {
  readonly id: string
  readonly referenceAnswer: boolean | string | number
  readonly observed: boolean | string | number
  readonly probability: number | null
  readonly distribution: Readonly<Record<string, number>> | null
  readonly score: number | null
  readonly confidence: number | null
  readonly reason: 'near_decision_boundary' | 'flat_distribution' | 'low_declared_confidence'
}

export interface ReferenceAgreementReport {
  readonly advisory: true
  /** Always false: this run never activates anything. */
  readonly active: false
  /**
   * Names the metric so a reader cannot mistake concordance for correctness.
   * With an LLM reference the name is `agreement`; only a human reference may
   * be called `accuracy`.
   */
  readonly metric: {
    readonly name: 'agreement' | 'accuracy'
    readonly kind: 'concordance' | 'accuracy'
    readonly note: string
  }
  readonly question: QuestionEvaluationReport['question']
  readonly provider: ProviderIdentity
  readonly reference: ReferenceProvenance
  readonly criteriaLabels: readonly string[] | null
  readonly rubricRange: { readonly min: number; readonly max: number } | null
  readonly comparisonBoundary: number | null
  /** Stated once so a reader knows how a low-confidence flag was decided. */
  readonly lowConfidencePolicy: {
    /** A declared confidence strictly below this is low confidence. */
    readonly minDeclaredConfidence: number
    /** A distribution whose top probability is below this is flat. */
    readonly minDistributionPeak: number
    /** A `noul` probability this close to the boundary is undecided. */
    readonly noulBoundaryMargin: number
  }
  readonly aggregate: {
    readonly total: number
    readonly answered: number
    readonly agreed: number
    /** Null when nothing was answered: an unmeasured rate is not zero. */
    readonly agreement: number | null
    readonly errors: number
    readonly malformed: number
    /** Null when no case carries a reference disposition at all. */
    readonly ambiguous: number | null
    readonly latencyMs: {
      readonly total: number
      readonly mean: number | null
      readonly max: number | null
    }
  }
  /** Per-class agreement for a `choice` question; null for other primitives. */
  readonly perClassAgreement: Readonly<Record<string, number | null>> | null
  readonly perClassAgreementUnavailable: readonly string[]
  /**
   * Every case, in input order, with the semantic raw numbers exactly as the
   * provider reported them. Agreements appear here too, so a reader never has
   * to infer an answer the provider gave explicitly.
   *
   * These are the evaluator's own observations with `expected` RENAMED to
   * `referenceAnswer`. On this surface `expected` would read as an operator
   * ground-truth label, which is precisely what the reference is NOT; the
   * rename keeps `semantic_question_calibration`'s meaning intact and stops an
   * operator reading the two reports backwards.
   */
  readonly cases: readonly (Omit<CaseObservation, 'expected'> & {
    readonly referenceAnswer: boolean | string | number
    /**
     * The operator's own disposition on the REFERENCE judgment, not on the
     * provider. Null when the operator declared none.
     */
    readonly disposition: ReferenceDisposition | null
  })[]
  /**
   * Cases whose reference judgment the operator themselves called ambiguous.
   *
   * Their agreement is still counted in `aggregate.agreement`, so without this
   * list a reader cannot tell how much of the rate rests on judgments the
   * operator did not trust. It mirrors `lowConfidenceAgreements`, which is the
   * provider-side equivalent: uncertainty gets first-class visibility on both
   * sides of the comparison.
   */
  readonly referenceAmbiguous: readonly string[]
  /** Every case that needs a human look, in case order. */
  readonly review: readonly DisagreementItem[]
  /** Agreements the provider itself was unsure about. Never hidden. */
  readonly lowConfidenceAgreements: readonly LowConfidenceAgreementItem[]
  /**
   * When this run happened. A report without a date cannot be compared with a
   * later one, which is the whole point of a reference-agreement measurement.
   */
  readonly runAt: string
  /**
   * The labelled cases `semantic_question_calibration` accepts, built from the
   * reviewed labels. Null when the operator reviewed nothing, because an
   * unreviewed disagreement is not a labelled case.
   */
  readonly promotion: {
    readonly reviewed: number
    readonly labelledCases: readonly LabelledCase[] | null
  }
}

/**
 * A declared confidence below this is treated as low confidence. It is a
 * reading convention stated in the report, not a decision boundary.
 */
export const LOW_CONFIDENCE_MIN_DECLARED = 0.6
/** A distribution flatter than this is ambiguous between criteria/levels. */
const LOW_CONFIDENCE_MIN_PEAK = 0.6
/** A `noul` probability this close to the boundary has not decided. */
export const LOW_CONFIDENCE_NOUL_MARGIN = 0.15

const ALLOWED_INPUT_KEYS = new Set(['question', 'cases', 'reference', 'reviewed', 'questionVersion', 'model'])
const ALLOWED_CASE_KEYS = new Set(['id', 'state', 'referenceAnswer', 'disposition'])
const ALLOWED_REFERENCE_KEYS = new Set(['source', 'model', 'promptVersion', 'recordedAt'])
const ALLOWED_REVIEWED_KEYS = new Set(['id', 'expected'])
const DISPOSITIONS = new Set<ReferenceDisposition>(['clear', 'ambiguous'])

/**
 * The cut-offs are published in the report, so an operator reads them from
 * their own run rather than importing a constant from plugin source.
 */
function referenceLowConfidencePolicy(): ReferenceAgreementReport['lowConfidencePolicy'] {
  return {
    minDeclaredConfidence: LOW_CONFIDENCE_MIN_DECLARED,
    minDistributionPeak: LOW_CONFIDENCE_MIN_PEAK,
    noulBoundaryMargin: LOW_CONFIDENCE_NOUL_MARGIN,
  }
}

function nonemptyString(value: unknown, field: string, max = MAX_CALIBRATION_VERSION_LENGTH): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProviderError('invalid_arguments', `${field} must be a nonempty string`)
  }
  if (value.length > max) {
    throw new ProviderError('invalid_arguments', `${field} exceeds ${max} characters`)
  }
  return value.trim()
}

/**
 * Reference provenance, validated rather than assumed.
 *
 * An LLM reference without a model identifier would read as a repeatable
 * measurement when it is not, so it is rejected here rather than defaulted.
 */
function parseReference(raw: unknown): ReferenceProvenance {
  if (!isRecord(raw)) {
    throw new ProviderError('invalid_arguments', 'reference is required')
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_REFERENCE_KEYS.has(key)) {
      throw new ProviderError('invalid_arguments', `Unknown reference field "${key}"`)
    }
  }
  if (raw.source !== 'llm' && raw.source !== 'human') {
    throw new ProviderError('invalid_arguments', 'reference.source must be "llm" or "human"')
  }
  const promptVersion = nonemptyString(raw.promptVersion, 'reference.promptVersion')
  // An explicit `null` means the SAME as omitted: the report publishes
  // `model: null` for a human reference and `recordedAt: null` when no date was
  // recorded, so the tool's own output has to be a valid input for the next
  // run — that is how the same frozen reference is re-measured against a newer
  // provider.
  const recordedAt =
    raw.recordedAt === undefined || raw.recordedAt === null
      ? null
      : nonemptyString(raw.recordedAt, 'reference.recordedAt')
  if (raw.source === 'llm') {
    if (raw.model === undefined) {
      throw new ProviderError(
        'invalid_arguments',
        'reference.model is required when reference.source is "llm": an LLM reference without a model is not a repeatable measurement',
      )
    }
    return {
      source: 'llm',
      model: nonemptyString(raw.model, 'reference.model'),
      promptVersion,
      recordedAt,
    }
  }
  // `null` and "omitted" mean the same thing here, for the same round-trip
  // reason: a human reference has no model to name.
  if (raw.model !== undefined && raw.model !== null) {
    throw new ProviderError('invalid_arguments', 'reference.model must be omitted when reference.source is "human"')
  }
  return { source: 'human', model: null, promptVersion, recordedAt }
}

/**
 * The reference answer, read with exactly the primitive's own contract.
 *
 * `field` is the fully qualified input path of the value being read, so an
 * invalid reviewed label is reported against `reviewed[0].expected` rather than
 * against a frozen case the operator never got wrong.
 */
function referenceAnswer(
  question: DecisionQuestion,
  labels: readonly string[],
  value: unknown,
  field: string,
): boolean | string | number {
  if (question.type === 'noul') {
    if (typeof value !== 'boolean') {
      throw new ProviderError('invalid_arguments', `${field} must be a boolean for a noul question`)
    }
    return value
  }
  if (question.type === 'choice') {
    if (typeof value !== 'string' || !labels.includes(value)) {
      throw new ProviderError(
        'invalid_arguments',
        `${field} must be one of the question criteria (${labels.join(', ')})`,
      )
    }
    return value
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ProviderError('invalid_arguments', `${field} must be a rubric level index for a score question`)
  }
  if (value < 0 || value > labels.length - 1) {
    throw new ProviderError(
      'invalid_arguments',
      `${field} level ${value} is outside the rubric range 0..${labels.length - 1}`,
    )
  }
  return value
}

/**
 * Parses the frozen input BEFORE any provider call.
 *
 * Only the four case fields are accepted, so a case cannot carry a semantic
 * answer: there is no field for one. The reference judgment is therefore
 * structurally unable to be contaminated by the provider result, which is
 * computed later and never travels back into this input.
 */
export function parseReferenceAgreementInput(args: unknown): {
  question: DecisionQuestion
  cases: ReferenceCase[]
  reference: ReferenceProvenance
  reviewed: ReviewedLabel[]
  questionVersion?: string
  model?: string
} {
  if (!isRecord(args)) {
    throw new ProviderError('invalid_arguments', 'Reference agreement input must be an object')
  }
  for (const key of Object.keys(args)) {
    if (!ALLOWED_INPUT_KEYS.has(key)) {
      throw new ProviderError('invalid_arguments', `Unknown reference agreement field "${key}"`)
    }
  }
  if (args.question === undefined) {
    throw new ProviderError('invalid_arguments', 'question is required')
  }
  // Same shared contract as a provider request, so a question accepted here is
  // a question `semantic_decide` could also send.
  validateRequest({ state: 'reference-agreement-input-probe', questions: { [QUESTION_ID]: args.question } })
  const question = args.question as DecisionQuestion
  const reference = parseReference(args.reference)
  if (args.questionVersion !== undefined) {
    nonemptyString(args.questionVersion, 'questionVersion')
  }
  if (args.model !== undefined && (typeof args.model !== 'string' || !args.model.trim())) {
    throw new ProviderError('invalid_arguments', 'model must be a nonempty string')
  }
  if (!Array.isArray(args.cases) || args.cases.length === 0) {
    throw new ProviderError('invalid_arguments', 'cases must be a nonempty array')
  }
  if (args.cases.length > MAX_CALIBRATION_CASES) {
    throw new ProviderError('invalid_arguments', `cases accepts at most ${MAX_CALIBRATION_CASES} entries`)
  }
  const labels = questionLabels(question)
  const seen = new Set<string>()
  const cases = args.cases.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new ProviderError('invalid_arguments', `cases[${index}] must be an object`)
    }
    for (const key of Object.keys(raw)) {
      if (!ALLOWED_CASE_KEYS.has(key)) {
        throw new ProviderError('invalid_arguments', `Unknown cases[${index}] field "${key}"`)
      }
    }
    const id = nonemptyString(raw.id, `cases[${index}].id`, 200)
    if (seen.has(id)) {
      throw new ProviderError('invalid_arguments', `Duplicate case id "${id}"`)
    }
    seen.add(id)
    if (raw.state === undefined) {
      throw new ProviderError('invalid_arguments', `cases[${index}].state is required`)
    }
    validateRequest({ state: raw.state, questions: { [QUESTION_ID]: question } })
    const bytes = Buffer.byteLength(JSON.stringify(raw.state), 'utf8')
    if (bytes > MAX_CALIBRATION_STATE_BYTES) {
      throw new ProviderError(
        'invalid_arguments',
        `cases[${index}].state (${bytes} bytes) exceeds the case size limit of ${MAX_CALIBRATION_STATE_BYTES} bytes`,
      )
    }
    if (raw.referenceAnswer === undefined) {
      throw new ProviderError('invalid_arguments', `cases[${index}].referenceAnswer is required`)
    }
    if (raw.disposition !== undefined && !DISPOSITIONS.has(raw.disposition as ReferenceDisposition)) {
      throw new ProviderError('invalid_arguments', `cases[${index}].disposition must be "clear" or "ambiguous"`)
    }
    return {
      id,
      state: raw.state as JsonValue,
      referenceAnswer: referenceAnswer(
        question,
        labels,
        raw.referenceAnswer,
        `cases[${index}].referenceAnswer`,
      ),
      ...(raw.disposition === undefined
        ? {}
        : { disposition: raw.disposition as ReferenceDisposition }),
    }
  })
  if (args.reviewed !== undefined) {
    if (!Array.isArray(args.reviewed)) {
      throw new ProviderError('invalid_arguments', 'reviewed must be an array')
    }
  }
  // A duplicate reviewed id would be promoted as a duplicate labelled case and
  // then rejected by `parseQuestionCalibrationInput`, so it is refused here,
  // with the same wording as the frozen cases.
  const reviewedIds = new Set<string>()
  const reviewed = (args.reviewed ?? []).map((raw, index) => {
    if (!isRecord(raw)) {
      throw new ProviderError('invalid_arguments', `reviewed[${index}] must be an object`)
    }
    for (const key of Object.keys(raw)) {
      if (!ALLOWED_REVIEWED_KEYS.has(key)) {
        throw new ProviderError('invalid_arguments', `Unknown reviewed[${index}] field "${key}"`)
      }
    }
    const id = nonemptyString(raw.id, `reviewed[${index}].id`, 200)
    if (!seen.has(id)) {
      throw new ProviderError('invalid_arguments', `reviewed[${index}].id "${id}" is not one of the frozen cases`)
    }
    if (reviewedIds.has(id)) {
      throw new ProviderError('invalid_arguments', `Duplicate reviewed id "${id}"`)
    }
    reviewedIds.add(id)
    if (raw.expected === undefined) {
      throw new ProviderError('invalid_arguments', `reviewed[${index}].expected is required`)
    }
    return { id, expected: referenceAnswer(question, labels, raw.expected, `reviewed[${index}].expected`) }
  })
  return {
    question,
    cases,
    reference,
    reviewed,
    ...(args.questionVersion === undefined ? {} : { questionVersion: nonemptyString(args.questionVersion, 'questionVersion') }),
    ...(args.model === undefined ? {} : { model: args.model as string }),
  }
}

export interface ReferenceAgreementOptions {
  readonly question: DecisionQuestion
  readonly cases: readonly ReferenceCase[]
  readonly reference: ReferenceProvenance
  readonly provider: ProviderIdentity
  readonly reviewed?: readonly ReviewedLabel[]
  readonly questionVersion?: string
  readonly requestedModel?: string
  /**
   * When this run happened. Reported as `runAt`. Defaults to now, so the
   * caller never has to supply it, but a reproducible run pins it.
   */
  readonly evaluatedAt?: string
  /** Runs ONE case against the semantic provider. */
  readonly decide: (id: string) => Promise<Record<string, DecisionAnswer> | CaseDecision>
}

function roundMetric(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

/**
 * Why an agreement is still worth looking at.
 *
 * An agreement the provider itself was unsure about is not evidence of a
 * reliable answer, so it is surfaced next to the rate instead of being
 * absorbed into it. Ordered so the most specific reason is reported.
 */
function lowConfidenceReason(entry: {
  readonly probability: number | null
  readonly distribution: Readonly<Record<string, number>> | null
  readonly confidence: number | null
}): LowConfidenceAgreementItem['reason'] | null {
  if (entry.confidence !== null && entry.confidence < LOW_CONFIDENCE_MIN_DECLARED) {
    return 'low_declared_confidence'
  }
  if (entry.probability !== null && Math.abs(entry.probability - NOUL_COMPARISON_BOUNDARY) < LOW_CONFIDENCE_NOUL_MARGIN) {
    return 'near_decision_boundary'
  }
  if (entry.distribution !== null) {
    const peak = Math.max(...Object.values(entry.distribution))
    if (peak < LOW_CONFIDENCE_MIN_PEAK) return 'flat_distribution'
  }
  return null
}

/**
 * Builds the labelled cases the generic arbitrary-question flow already
 * accepts, so reviewed disagreements are reusable without reformatting.
 *
 * An unreviewed case is deliberately not promoted: promoting the provider's
 * own answer as a label would make the next run agree with itself.
 */
export function promotionCases(
  cases: readonly ReferenceCase[],
  reviewed: readonly ReviewedLabel[],
): LabelledCase[] | null {
  if (!reviewed.length) return null
  const stateById = new Map(cases.map((entry) => [entry.id, entry.state]))
  return reviewed.map((entry) => {
    const state = stateById.get(entry.id)
    /* c8 ignore next 3 -- the parser only accepts ids from the frozen set */
    if (state === undefined) throw new ProviderError('invalid_arguments', `Unknown reviewed case id "${entry.id}"`)
    return { id: entry.id, state, expected: entry.expected }
  })
}

export async function evaluateReferenceAgreement(
  options: ReferenceAgreementOptions,
): Promise<ReferenceAgreementReport> {
  const { question, cases, reference } = options
  // The reference judgment becomes the label the provider is compared against,
  // so the whole comparison runs through the shipped evaluator unchanged.
  const labelled: LabelledCase[] = cases.map((entry) => ({
    id: entry.id,
    state: entry.state,
    expected: entry.referenceAnswer,
  }))
  const evaluation = await evaluateLabelledCases({
    question,
    cases: labelled,
    provider: options.provider,
    ...(options.questionVersion === undefined ? {} : { questionVersion: options.questionVersion }),
    ...(options.requestedModel === undefined ? {} : { requestedModel: options.requestedModel }),
    ...(options.evaluatedAt === undefined ? {} : { evaluatedAt: options.evaluatedAt }),
    decide: options.decide,
  })

  const dispositionById = new Map<string, ReferenceDisposition | undefined>(
    cases.map((entry) => [entry.id, entry.disposition]),
  )
  const review: DisagreementItem[] = []
  const lowConfidenceAgreements: LowConfidenceAgreementItem[] = []
  for (const entry of evaluation.cases) {
    const disposition = dispositionById.get(entry.id) ?? null
    if (!entry.answered) {
      review.push({
        id: entry.id,
        referenceAnswer: entry.expected,
        observed: entry.observed,
        probability: entry.probability,
        distribution: entry.distribution,
        score: entry.score,
        confidence: entry.confidence,
        latencyMs: entry.latencyMs,
        reason: entry.malformed ? 'malformed_answer' : 'provider_error',
        error: entry.error,
        disposition,
      })
      continue
    }
    if (!entry.matched) {
      review.push({
        id: entry.id,
        referenceAnswer: entry.expected,
        observed: entry.observed,
        probability: entry.probability,
        distribution: entry.distribution,
        score: entry.score,
        confidence: entry.confidence,
        latencyMs: entry.latencyMs,
        reason: 'mismatch',
        error: entry.error,
        disposition,
      })
      continue
    }
    const reason = lowConfidenceReason(entry)
    if (reason) {
      lowConfidenceAgreements.push({
        id: entry.id,
        referenceAnswer: entry.expected,
        observed: entry.observed as boolean | string | number,
        probability: entry.probability,
        distribution: entry.distribution,
        score: entry.score,
        confidence: entry.confidence,
        reason,
      })
    }
  }

  // Null, not zero: no disposition supplied means the question was not asked,
  // which is different from "no reference was ambiguous".
  const disposed = cases.filter((entry) => entry.disposition !== undefined)
  const ambiguous = disposed.length ? disposed.filter((entry) => entry.disposition === 'ambiguous').length : null
  const latencies = evaluation.cases.map((entry) => entry.latencyMs)
  const totalLatency = latencies.reduce((sum, value) => sum + value, 0)
  const choiceMetrics = evaluation.metrics.choice

  return {
    advisory: true,
    active: false,
    metric:
      reference.source === 'human'
        ? {
            name: 'accuracy',
            kind: 'accuracy',
            note: 'Human-labelled ground truth: the reference is a deliberate human label, so agreement is accuracy.',
          }
        : {
            name: 'agreement',
            kind: 'concordance',
            note: 'An LLM reference is a second opinion, not ground truth: this is concordance, not correctness.',
          },
    question: evaluation.question,
    provider: evaluation.provider,
    reference,
    criteriaLabels: evaluation.criteriaLabels,
    rubricRange: evaluation.rubricRange,
    comparisonBoundary: evaluation.comparisonBoundary,
    lowConfidencePolicy: referenceLowConfidencePolicy(),
    aggregate: {
      total: evaluation.aggregate.total,
      answered: evaluation.aggregate.answered,
      agreed: evaluation.aggregate.matched,
      agreement: evaluation.aggregate.agreement,
      errors: evaluation.aggregate.errors,
      malformed: evaluation.aggregate.malformed,
      ambiguous,
      latencyMs: {
        total: Math.round(totalLatency),
        mean: latencies.length ? roundMetric(totalLatency / latencies.length) : null,
        max: latencies.length ? Math.round(Math.max(...latencies)) : null,
      },
    },
    perClassAgreement: choiceMetrics ? choiceMetrics.perClassAgreement : null,
    perClassAgreementUnavailable: choiceMetrics ? choiceMetrics.perClassAgreementUnavailable : [],
    // The reference judgment is the label, so the case row is published under
    // the name that says so, with the raw provider numbers beside it.
    cases: evaluation.cases.map((entry) => {
      const { expected, ...rest } = entry
      return {
        ...rest,
        referenceAnswer: expected,
        disposition: dispositionById.get(entry.id) ?? null,
      }
    }),
    runAt: options.evaluatedAt ?? new Date().toISOString(),
    // The reference-side mirror of `lowConfidenceAgreements`: the operator
    // declared these judgments ambiguous, so the reader is told which ones.
    referenceAmbiguous: cases
      .filter((entry) => entry.disposition === 'ambiguous')
      .map((entry) => entry.id),
    review,
    lowConfidenceAgreements,
    promotion: {
      reviewed: options.reviewed?.length ?? 0,
      labelledCases: promotionCases(cases, options.reviewed ?? []),
    },
  }
}
