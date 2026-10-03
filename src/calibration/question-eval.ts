import { createHash } from 'node:crypto'

import type { DecisionAnswer, DecisionQuestion, JsonValue } from '../decision/types.js'
import { isRecord, validateRequest } from '../decision/validation.js'
import { ProviderError } from '../errors.js'
import type { ProviderIdentity } from './profile.js'

/**
 * Generic, provider-neutral evaluation of ONE typed semantic question against
 * operator-labelled cases.
 *
 * It is deliberately NOT a policy engine and NOT a second calibration-profile
 * schema. The verification-specific `CalibrationProfile` in `./profile.ts`
 * describes the five verify gates; an arbitrary question has no such gates, so
 * this module reports per-primitive evidence and an inactive candidate
 * observation that carries the question fingerprint.
 *
 * Two invariants hold everywhere in this file:
 *
 * 1. No universal 0..1 normalization. A `noul` probability, a `choice`
 *    distribution and a `score` level are three different numbers and are
 *    reported in their own domains.
 * 2. An unmeasured metric is `null`, never `0`.
 */

/** The single question id used in the single-question provider request. */
export const QUESTION_ID = 'question'

/** Bounded inputs: a calibration set is a small, hand-labelled sample. */
export const MAX_CALIBRATION_CASES = 50
export const MAX_CALIBRATION_STATE_BYTES = 24_000
export const MAX_CALIBRATION_VERSION_LENGTH = 100

/**
 * Comparison convention for `noul`, stated once and applied identically to
 * every case: the answer reads as affirmative when the provider's probability
 * is a STRICT majority. It is a reading of the reported number, not a tuned
 * threshold, and it is reported as `comparisonBoundary` so an operator can see
 * exactly what `matched` meant.
 */
export const NOUL_COMPARISON_BOUNDARY = 0.5

/**
 * Tolerance for the documented `score = E[level]` identity. A two-decimal
 * response justifies 0.01; the rest is float slack.
 */
const SCORE_EXPECTATION_TOLERANCE = 0.01 + Number.EPSILON

export type CalibratedType = DecisionQuestion['type']

export interface LabelledCase {
  readonly id: string
  readonly state: JsonValue
  /** boolean for `noul`, a criterion key/label for `choice`, a rubric level for `score`. */
  readonly expected: boolean | string | number
}

export interface QuestionIdentity {
  readonly fingerprint: string
  readonly type: CalibratedType
  readonly version: string | null
}

export interface CaseObservation {
  readonly id: string
  /** The operator's own label. Never an inferred or provider-supplied value. */
  readonly expected: boolean | string | number
  /** The primitive's own reading, in the primitive's own domain. */
  readonly observed: boolean | string | number | null
  /** Raw `noul` probability, exactly as the provider reported it. */
  readonly probability: number | null
  /** Raw `choice`/`score` distribution, keyed by criterion key. */
  readonly distribution: Readonly<Record<string, number>> | null
  /** Raw `score` value in level units. Never divided by anything. */
  readonly score: number | null
  /** The runtime's declared certainty, when it exposes one. */
  readonly confidence: number | null
  readonly latencyMs: number
  readonly answered: boolean
  /** `null` would hide a real mismatch, so an unanswered case is `matched: false`. */
  readonly matched: boolean
  readonly error: string | null
  readonly malformed: boolean
}

export interface NoulMetrics {
  readonly positives: number
  readonly negatives: number
  readonly falsePositives: number
  readonly falseNegatives: number
  /** Null when no labelled negative case was actually answered. */
  readonly falsePositiveRate: number | null
  /** Null when no labelled positive case was actually answered. */
  readonly falseNegativeRate: number | null
  /** Null unless every answered case produced a finite probability. */
  readonly brierScore: number | null
}

export interface ChoiceMetrics {
  readonly labels: readonly string[]
  readonly matched: number
  /** Null when no case was answered: an unmeasured rate is not zero. */
  readonly accuracy: number | null
  /** `confusion[expected][observed]`. */
  readonly confusion: Readonly<Record<string, Readonly<Record<string, number>>>>
  /** Null-valued labels are listed in `perClassAgreementUnavailable`. */
  readonly perClassAgreement: Readonly<Record<string, number | null>>
  readonly perClassAgreementUnavailable: readonly string[]
}

export interface ScoreMetrics {
  readonly labels: readonly string[]
  /** The native rubric range in level units. */
  readonly rubricRange: { readonly min: number; readonly max: number }
  readonly absoluteError: Readonly<Record<string, number>>
  /** Null when no case was answered. */
  readonly meanAbsoluteError: number | null
  readonly exactMatches: number
  /** Null when no case was answered. */
  readonly exactMatchRate: number | null
}

export interface Range {
  readonly min: number
  readonly max: number
  readonly count: number
}

export interface CandidateObservations {
  /** `noul`: observed probabilities of the matched / mismatched cases. */
  readonly probabilityWhenMatched: Range | null
  readonly probabilityWhenMismatched: Range | null
  /**
   * An observed separation between labelled positives and negatives, in the
   * primitive's own domain. `separable` is `null` when either class is missing.
   * It is an observation an operator may read; it is never applied.
   */
  readonly separation: {
    readonly maxOnNegative: number | null
    readonly minOnPositive: number | null
    readonly separable: boolean | null
  }
  readonly confidenceWhenMatched: Range | null
  readonly scoreWhenMatched: Range | null
  readonly scoreWhenMismatched: Range | null
  readonly topLabelProbabilityWhenMatched: Range | null
  readonly topLabelProbabilityWhenMismatched: Range | null
}

export interface InactiveCandidate {
  readonly schemaVersion: 1
  /** Always false: a candidate never applies itself. */
  readonly active: false
  readonly provider: ProviderIdentity
  readonly question: QuestionIdentity
  readonly evaluatedAt: string
  readonly observations: CandidateObservations & { readonly answered: number }
}

export interface QuestionEvaluationReport {
  readonly advisory: true
  /** Always false: this is evidence, not an activated policy. */
  readonly active: false
  readonly question: QuestionIdentity
  readonly provider: ProviderIdentity
  readonly criteriaLabels: readonly string[] | null
  readonly rubricRange: { readonly min: number; readonly max: number } | null
  readonly comparisonBoundary: number | null
  readonly aggregate: {
    readonly total: number
    readonly answered: number
    readonly matched: number
    /** Null when nothing was answered. */
    readonly agreement: number | null
    readonly errors: number
    readonly malformed: number
  }
  readonly cases: readonly CaseObservation[]
  readonly metrics: {
    readonly noul: NoulMetrics | null
    readonly choice: ChoiceMetrics | null
    readonly score: ScoreMetrics | null
  }
  /** Cases that need a human look: provider error, malformed answer or mismatch. */
  readonly reviewCaseIds: readonly string[]
  readonly candidate: InactiveCandidate
}

const ALLOWED_INPUT_KEYS = new Set(['question', 'cases', 'questionVersion', 'model'])
const ALLOWED_CASE_KEYS = new Set(['id', 'state', 'expected'])

/** Criterion keys of a question, in the provider's own order. */
export function questionLabels(question: DecisionQuestion): readonly string[] {
  if (question.type === 'noul') return []
  // A `score` rubric is addressed by LEVEL INDEX, and a `choice` rubric by its
  // criterion VALUE when it is an array or by its KEY when it is an object.
  // This mirrors the shipped adapter exactly (`normalizeResponse`), so a
  // question System One can answer is a question this evaluator can read.
  // Using the array's own values as choice labels is what the adapter does;
  // indexing them instead would score a correct answer as malformed.
  if (question.type === 'score') return Object.keys(question.criteria as object)
  return Array.isArray(question.criteria) ? question.criteria : Object.keys(question.criteria)
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
  return `{${entries.join(',')}}`
}

/**
 * Opaque identity of the exact question definition.
 *
 * Object criteria are canonicalized (keys sorted), so a semantically identical
 * question keeps its fingerprint while any change to the instructions, the
 * type, the criteria or their order produces a different one. That is what
 * stops a candidate calibrated on one question from being read as calibration
 * for another.
 */
export function fingerprintQuestion(question: DecisionQuestion): string {
  const definition: JsonValue = {
    type: question.type,
    instructions: question.instructions,
    ...(question.type === 'noul' ? {} : { criteria: question.criteria as JsonValue }),
  }
  return `question:v1:${createHash('sha256').update(canonical(definition)).digest('hex').slice(0, 16)}`
}

/** A candidate applies only to the exact question it was measured on. */
export function questionIsApplicableTo(
  candidate: { readonly question: { readonly fingerprint: string } },
  question: DecisionQuestion,
): boolean {
  return candidate.question.fingerprint === fingerprintQuestion(question)
}

function stateBytes(state: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(state), 'utf8')
}

/**
 * Validates the operator's input before any provider call.
 *
 * Question validation is delegated to the shared request validator, so a
 * question accepted here is a question `semantic_decide` could also send.
 */
export function parseQuestionCalibrationInput(args: unknown): {
  question: DecisionQuestion
  cases: LabelledCase[]
  questionVersion?: string
  model?: string
} {
  if (!isRecord(args)) throw new ProviderError('invalid_arguments', 'Question calibration input must be an object')
  for (const key of Object.keys(args)) {
    if (!ALLOWED_INPUT_KEYS.has(key)) {
      throw new ProviderError('invalid_arguments', `Unknown question calibration field "${key}"`)
    }
  }
  if (args.question === undefined) {
    throw new ProviderError('invalid_arguments', 'question is required')
  }
  // Reuses the shipped request contract instead of restating it.
  validateRequest({ state: 'calibration-input-probe', questions: { [QUESTION_ID]: args.question } })
  const question = args.question as DecisionQuestion
  if (args.questionVersion !== undefined) {
    if (typeof args.questionVersion !== 'string' || !args.questionVersion.trim()) {
      throw new ProviderError('invalid_arguments', 'questionVersion must be a nonempty string')
    }
    if (args.questionVersion.length > MAX_CALIBRATION_VERSION_LENGTH) {
      throw new ProviderError('invalid_arguments', `questionVersion exceeds ${MAX_CALIBRATION_VERSION_LENGTH} characters`)
    }
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
    if (typeof raw.id !== 'string' || !raw.id.trim()) {
      throw new ProviderError('invalid_arguments', `cases[${index}].id is required`)
    }
    if (raw.id.length > 200) {
      throw new ProviderError('invalid_arguments', `cases[${index}].id exceeds 200 characters`)
    }
    if (seen.has(raw.id)) {
      throw new ProviderError('invalid_arguments', `Duplicate case id "${raw.id}"`)
    }
    seen.add(raw.id)
    if (raw.state === undefined) {
      throw new ProviderError('invalid_arguments', `cases[${index}].state is required`)
    }
    // Same state contract as a provider request: JSON-safe, and bounded.
    validateRequest({ state: raw.state, questions: { [QUESTION_ID]: question } })
    const bytes = stateBytes(raw.state as JsonValue)
    if (bytes > MAX_CALIBRATION_STATE_BYTES) {
      throw new ProviderError(
        'invalid_arguments',
        `cases[${index}].state (${bytes} bytes) exceeds the case size limit of ${MAX_CALIBRATION_STATE_BYTES} bytes`,
      )
    }
    return { id: raw.id, state: raw.state as JsonValue, expected: expectedLabel(question, labels, raw.expected, index) }
  })
  return {
    question,
    cases,
    ...(args.questionVersion === undefined ? {} : { questionVersion: args.questionVersion as string }),
    ...(args.model === undefined ? {} : { model: args.model as string }),
  }
}

/**
 * The operator's own label, in the primitive's own domain.
 *
 * `noul` accepts a boolean only: a probability label would hide a decision
 * boundary inside the "expected" value, which is exactly the ambiguity this
 * tool must not introduce. `score` accepts a rubric level index, never a band.
 */
function expectedLabel(
  question: DecisionQuestion,
  labels: readonly string[],
  value: unknown,
  index: number,
): boolean | string | number {
  if (question.type === 'noul') {
    if (typeof value !== 'boolean') {
      throw new ProviderError('invalid_arguments', `cases[${index}].expected must be a boolean for a noul question`)
    }
    return value
  }
  if (question.type === 'choice') {
    if (typeof value !== 'string' || !labels.includes(value)) {
      throw new ProviderError(
        'invalid_arguments',
        `cases[${index}].expected must be one of the question criteria (${labels.join(', ')})`,
      )
    }
    return value
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ProviderError(
      'invalid_arguments',
      `cases[${index}].expected must be a rubric level index for a score question`,
    )
  }
  if (value < 0 || value > labels.length - 1) {
    throw new ProviderError(
      'invalid_arguments',
      `cases[${index}].expected level ${value} is outside the rubric range 0..${labels.length - 1}`,
    )
  }
  return value
}

function rangeOf(values: readonly number[]): Range | null {
  if (!values.length) return null
  return { min: Math.min(...values), max: Math.max(...values), count: values.length }
}

function roundMetric(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

/**
 * Reads one answer in its own primitive domain.
 *
 * Returns `malformed: true` rather than throwing when the answer contradicts
 * its own contract, because a malformed answer is calibration evidence about
 * the runtime, not a reason to lose the whole report.
 */
function readAnswer(question: DecisionQuestion, answer: DecisionAnswer | undefined): {
  observed: boolean | string | number | null
  probability: number | null
  distribution: Record<string, number> | null
  score: number | null
  confidence: number | null
  error: string | null
  malformed: boolean
} {
  const empty = {
    observed: null,
    probability: null,
    distribution: null,
    score: null,
    confidence: null,
    error: 'missing_answer',
    malformed: true,
  }
  if (!answer || answer.type !== question.type) return empty
  const confidence = 'confidence' in answer && typeof answer.confidence === 'number' ? answer.confidence : null
  if (question.type === 'noul') {
    if (answer.type !== 'noul') return empty
    if (
      typeof answer.probability !== 'number' ||
      !Number.isFinite(answer.probability) ||
      // The adapter already enforces 0..1; the evaluator repeats the check so a
      // future non-HTTP transport cannot smuggle an out-of-range probability in
      // as a probability.
      answer.probability < 0 ||
      answer.probability > 1
    ) {
      return { ...empty, confidence, error: 'invalid_noul_probability' }
    }
    return {
      observed: answer.probability > NOUL_COMPARISON_BOUNDARY,
      probability: answer.probability,
      distribution: null,
      score: null,
      confidence,
      error: null,
      malformed: false,
    }
  }
  const labels = questionLabels(question)
  const distribution =
    answer.type === 'choice' || answer.type === 'score' ? answer.probabilities ?? null : null
  const coherent =
    distribution !== null &&
    Object.keys(distribution).length === labels.length &&
    labels.every((label) => typeof distribution[label] === 'number' && Number.isFinite(distribution[label]))
  if (!coherent) {
    return { ...empty, confidence, error: 'invalid_probability_distribution' }
  }
  if (question.type === 'choice') {
    if (answer.type !== 'choice' || typeof answer.choice !== 'string' || !labels.includes(answer.choice)) {
      return { ...empty, confidence, error: 'invalid_choice' }
    }
    return {
      observed: answer.choice,
      probability: null,
      distribution,
      score: null,
      confidence,
      error: null,
      malformed: false,
    }
  }
  if (answer.type !== 'score' || typeof answer.score !== 'number' || !Number.isFinite(answer.score)) {
    return { ...empty, confidence, error: 'invalid_score' }
  }
  // Documented System One contract: score is E[level] under the distribution.
  const expectedValue = labels.reduce((sum, label, index) => sum + index * (distribution as Record<string, number>)[label]!, 0)
  if (Math.abs(answer.score - expectedValue) > SCORE_EXPECTATION_TOLERANCE) {
    return {
      observed: null,
      probability: null,
      distribution,
      score: answer.score,
      confidence,
      error: 'score_distribution_mismatch',
      malformed: true,
    }
  }
  return {
    observed: answer.score,
    probability: null,
    distribution,
    score: answer.score,
    confidence,
    error: null,
    malformed: false,
  }
}

export interface CaseDecision {
  readonly answers: Record<string, DecisionAnswer>
  /**
   * The model the provider reported as actually serving the request, when it
   * declares one. Provenance only: it is never a decision input.
   */
  readonly model?: string
}

export interface EvaluateLabelledCasesOptions {
  readonly question: DecisionQuestion
  readonly cases: readonly LabelledCase[]
  readonly questionVersion?: string
  readonly provider: ProviderIdentity
  readonly evaluatedAt?: string
  /**
   * A per-call model override that the caller sent. It outranks anything the
   * provider echoes back, because it is what was actually requested.
   */
  readonly requestedModel?: string
  /**
   * Runs ONE case against the provider. A bare answer map is accepted so a
   * caller with no model provenance can stay simple.
   */
  readonly decide: (id: string) => Promise<Record<string, DecisionAnswer> | CaseDecision>
}

/**
 * Provider failures that must fail the whole run instead of becoming a
 * per-case observation: a cancellation is not a data point, and a blocked
 * egress or unusable configuration means nothing was measured at all.
 */
const FATAL_ERROR_CODES = new Set(['aborted', 'egress_blocked', 'configuration'])

/** Distinguishes the richer `CaseDecision` from a bare answer map. */
function isCaseDecision(value: Record<string, DecisionAnswer> | CaseDecision): value is CaseDecision {
  return 'answers' in value
}

/**
 * The model this run actually measured.
 *
 * Precedence is deliberate: a per-call override is what the caller demanded,
 * the provider's own echo is what it claims to have served, and the
 * configured model is the last resort. Anything less specific would stamp a
 * candidate with a model that was never evaluated, and it would then read as
 * fresh against a model it was never measured on.
 */
function effectiveProvider(
  provider: ProviderIdentity,
  requestedModel: string | undefined,
  responseModel: string | undefined,
): ProviderIdentity {
  const model = requestedModel ?? responseModel ?? provider.model
  return {
    ...provider,
    ...(model ? { model } : {}),
  }
}

export async function evaluateLabelledCases(
  options: EvaluateLabelledCasesOptions,
): Promise<QuestionEvaluationReport> {
  const { question, cases, provider } = options
  const labels = questionLabels(question)
  const questionIdentity: QuestionIdentity = {
    fingerprint: fingerprintQuestion(question),
    type: question.type,
    version: options.questionVersion ?? null,
  }
  const rubricRange =
    question.type === 'score' ? { min: 0, max: labels.length - 1 } : null

  const observations: CaseObservation[] = []
  // The model the provider actually reported serving a request, if any.
  let responseModel: string | undefined
  for (const entry of cases) {
    const started = performance.now()
    let answers: Record<string, DecisionAnswer> | null = null
    let error: string | null = null
    let malformed = false
    try {
      const decided = await options.decide(entry.id)
      if (isCaseDecision(decided)) {
        answers = decided.answers
        if (decided.model) responseModel ??= decided.model
      } else {
        answers = decided
      }
    } catch (thrown) {
      const code = thrown instanceof ProviderError ? thrown.code : 'provider_error'
      if (FATAL_ERROR_CODES.has(code)) throw thrown
      // A failed case stays visible with its code and never becomes an answer.
      error = code
    }
    const latencyMs = performance.now() - started
    const read = answers
      ? readAnswer(question, answers[QUESTION_ID])
      : {
          observed: null,
          probability: null,
          distribution: null,
          score: null,
          confidence: null,
          error: null,
          malformed: false,
        }
    if (error !== null) {
      observations.push({
        id: entry.id,
        expected: entry.expected,
        observed: null,
        probability: null,
        distribution: null,
        score: null,
        confidence: null,
        latencyMs,
        answered: false,
        matched: false,
        error,
        malformed,
      })
      continue
    }
    if (read.malformed) {
      malformed = true
      error = read.error
    }
    observations.push({
      id: entry.id,
      expected: entry.expected,
      observed: read.observed,
      probability: read.probability,
      distribution: read.distribution,
      score: read.score,
      confidence: read.confidence,
      latencyMs,
      answered: !read.malformed && read.error === null,
      matched: !read.malformed && read.error === null && read.observed === entry.expected,
      error,
      malformed,
    })
  }

  const answered = observations.filter((entry) => entry.answered)
  const matched = answered.filter((entry) => entry.matched)
  const errors = observations.filter((entry) => entry.error !== null && !entry.malformed).length
  const malformedCount = observations.filter((entry) => entry.malformed).length
  const reviewCaseIds = observations.filter((entry) => entry.error !== null || !entry.matched).map((entry) => entry.id)

  const metrics: QuestionEvaluationReport['metrics'] = {
    noul: question.type === 'noul' ? noulMetrics(answered) : null,
    choice: question.type === 'choice' ? choiceMetrics(answered, labels) : null,
    score: question.type === 'score' ? scoreMetrics(answered, labels, rubricRange!) : null,
  }

  const identity = effectiveProvider(provider, options.requestedModel, responseModel)

  return {
    advisory: true,
    active: false,
    question: questionIdentity,
    provider: identity,
    criteriaLabels: question.type === 'noul' ? null : [...labels],
    rubricRange,
    comparisonBoundary: question.type === 'noul' ? NOUL_COMPARISON_BOUNDARY : question.type === 'score' ? 0 : null,
    aggregate: {
      total: observations.length,
      answered: answered.length,
      matched: matched.length,
      agreement: answered.length ? roundMetric(matched.length / answered.length) : null,
      errors,
      malformed: malformedCount,
    },
    cases: observations,
    metrics,
    reviewCaseIds,
    candidate: {
      schemaVersion: 1,
      active: false,
      // The candidate must carry the SAME identity as the report, or a
      // candidate measured on one model would read as valid for another.
      provider: identity,
      question: questionIdentity,
      evaluatedAt: options.evaluatedAt ?? new Date().toISOString(),
      observations: {
        ...candidateObservations(question, answered),
        answered: answered.length,
      },
    },
  }
}

function noulMetrics(answered: readonly CaseObservation[]): NoulMetrics {
  const positives = answered.filter((entry) => entry.expected === true)
  const negatives = answered.filter((entry) => entry.expected === false)
  const falsePositives = negatives.filter((entry) => entry.observed === true).length
  const falseNegatives = positives.filter((entry) => entry.observed === false).length
  // The Brier score needs every answered case to carry a finite probability.
  const complete =
    answered.length > 0 && answered.every((entry) => typeof entry.probability === 'number')
  const brier = complete
    ? answered.reduce((sum, entry) => {
        const p = entry.probability as number
        return sum + (p - (entry.expected === true ? 1 : 0)) ** 2
      }, 0) / answered.length
    : null
  return {
    positives: positives.length,
    negatives: negatives.length,
    falsePositives,
    falseNegatives,
    falsePositiveRate: negatives.length ? roundMetric(falsePositives / negatives.length) : null,
    falseNegativeRate: positives.length ? roundMetric(falseNegatives / positives.length) : null,
    brierScore: brier === null ? null : roundMetric(brier),
  }
}

function choiceMetrics(
  answered: readonly CaseObservation[],
  labels: readonly string[],
): ChoiceMetrics {
  const confusion: Record<string, Record<string, number>> = {}
  for (const expected of labels) {
    confusion[expected] = {}
    for (const observed of labels) confusion[expected]![observed] = 0
  }
  for (const entry of answered) {
    const expected = String(entry.expected)
    const observed = String(entry.observed)
    if (!confusion[expected] || confusion[expected]![observed] === undefined) continue
    confusion[expected]![observed] = confusion[expected]![observed]! + 1
  }
  const perClassAgreement: Record<string, number | null> = {}
  const unavailable: string[] = []
  for (const label of labels) {
    const total = labels.reduce((sum, observed) => sum + confusion[label]![observed]!, 0)
    // No labelled case for this class: the rate is unknown, not zero.
    if (total === 0) {
      perClassAgreement[label] = null
      unavailable.push(label)
    } else {
      perClassAgreement[label] = roundMetric(confusion[label]![label]! / total)
    }
  }
  const correct = labels.reduce((sum, label) => sum + confusion[label]![label]!, 0)
  return {
    labels: [...labels],
    matched: correct,
    accuracy: answered.length ? roundMetric(correct / answered.length) : null,
    confusion,
    perClassAgreement,
    perClassAgreementUnavailable: unavailable,
  }
}

function scoreMetrics(
  answered: readonly CaseObservation[],
  labels: readonly string[],
  rubricRange: { min: number; max: number },
): ScoreMetrics {
  const absoluteError: Record<string, number> = {}
  let total = 0
  let exact = 0
  for (const entry of answered) {
    const error = Math.abs((entry.score as number) - (entry.expected as number))
    absoluteError[entry.id] = error
    total += error
    if (error === 0) exact += 1
  }
  return {
    labels: [...labels],
    rubricRange,
    absoluteError,
    // A level-unit error, never divided by the rubric length.
    meanAbsoluteError: answered.length ? roundMetric(total / answered.length) : null,
    exactMatches: exact,
    exactMatchRate: answered.length ? roundMetric(exact / answered.length) : null,
  }
}

/**
 * Advisory observations only.
 *
 * No threshold, band or score is derived here: a small labelled set can show
 * which way the provider leaned, and turning that into a permissive decision
 * boundary is the operator's explicit decision, made with their own data.
 */
function candidateObservations(
  question: DecisionQuestion,
  answered: readonly CaseObservation[],
): Omit<InactiveCandidate['observations'], 'answered'> {
  const matched = answered.filter((entry) => entry.matched)
  const mismatched = answered.filter((entry) => !entry.matched)
  const topProbability = (entry: CaseObservation): number | null => {
    if (!entry.distribution) return null
    return Math.max(...Object.values(entry.distribution))
  }
  const separation =
    question.type !== 'noul'
      ? { maxOnNegative: null, minOnPositive: null, separable: null }
      : (() => {
          const onPositive = answered.filter((entry) => entry.expected === true && entry.probability !== null).map((entry) => entry.probability as number)
          const onNegative = answered.filter((entry) => entry.expected === false && entry.probability !== null).map((entry) => entry.probability as number)
          const minOnPositive = onPositive.length ? Math.min(...onPositive) : null
          const maxOnNegative = onNegative.length ? Math.max(...onNegative) : null
          return {
            maxOnNegative,
            minOnPositive,
            separable:
              minOnPositive === null || maxOnNegative === null ? null : minOnPositive > maxOnNegative,
          }
        })()
  return {
    probabilityWhenMatched: rangeOf(matched.map((entry) => entry.probability).filter((value): value is number => value !== null)),
    probabilityWhenMismatched: rangeOf(mismatched.map((entry) => entry.probability).filter((value): value is number => value !== null)),
    separation,
    confidenceWhenMatched: rangeOf(matched.map((entry) => entry.confidence).filter((value): value is number => value !== null)),
    scoreWhenMatched: rangeOf(matched.map((entry) => entry.score).filter((value): value is number => value !== null)),
    scoreWhenMismatched: rangeOf(mismatched.map((entry) => entry.score).filter((value): value is number => value !== null)),
    topLabelProbabilityWhenMatched: rangeOf(matched.map(topProbability).filter((value): value is number => value !== null)),
    topLabelProbabilityWhenMismatched: rangeOf(mismatched.map(topProbability).filter((value): value is number => value !== null)),
  }
}
