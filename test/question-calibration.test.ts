import assert from 'node:assert/strict'
import test from 'node:test'

import {
  evaluateLabelledCases,
  fingerprintQuestion,
  parseQuestionCalibrationInput,
  questionIsApplicableTo,
  questionLabels,
  type LabelledCase,
} from '../src/calibration/question-eval.ts'
import { ProviderError } from '../src/errors.ts'
import type { DecisionQuestion } from '../src/decision/types.ts'

const ctx = { projectId: 'p' }
const PROVIDER = { presetId: 'kev', model: 'kev-4b' }

function provider(answers: Record<string, any>, extra: Record<string, unknown> = {}) {
  const seen: any[] = []
  const transport: typeof fetch = async (_url, init) => {
    seen.push(JSON.parse(String(init?.body)))
    return Response.json({ model: 'fixture-model', answers, ...extra })
  }
  return { transport, seen }
}

const NOUL: DecisionQuestion = { type: 'noul', instructions: 'Does the report contain a precise diagnosis?' }

test('noul cases report false positives, false negatives and a Brier score', async () => {
  const cases: LabelledCase[] = [
    { id: 'clear', state: 'diagnosis: pulmonary embolism', expected: true },
    { id: 'weak-positive', state: 'possible thrombosis, unclear', expected: true },
    { id: 'vague', state: 'patient feels unwell', expected: false },
    { id: 'weak-negative', state: 'nothing conclusive, needs workup', expected: false },
  ]
  const seen: string[] = []
  const report = await evaluateLabelledCases({
    question: NOUL,
    cases,
    provider: PROVIDER,
    decide: async (caseId) => {
      seen.push(caseId)
      // `weak-positive` is labelled true but answered 0.1: a false negative.
      // `weak-negative` is labelled false but answered 0.8: a false positive.
      const answer: Record<string, number> = {
        clear: 0.9,
        'weak-positive': 0.1,
        vague: 0.2,
        'weak-negative': 0.8,
      }
      return { question: { type: 'noul', probability: answer[caseId]! } } as never
    },
  })
  assert.deepEqual(
    seen,
    ['clear', 'weak-positive', 'vague', 'weak-negative'],
    'each case is asked exactly once, in order',
  )
  const noul = report.metrics.noul!
  assert.equal(noul.falsePositives, 1, 'a 0.8 answer on a negative-labelled case is a false positive')
  assert.equal(noul.falseNegatives, 1, 'a 0.1 answer on a positive-labelled case is a false negative')
  assert.equal(noul.positives, 2)
  assert.equal(noul.negatives, 2)
  assert.equal(noul.falsePositiveRate, 0.5)
  assert.equal(noul.falseNegativeRate, 0.5)
  // Brier over (p, label) pairs: 0.01 + 0.81 + 0.04 + 0.64 = 1.5 / 4
  assert.equal(noul.brierScore, 0.375)
  assert.equal(report.metrics.choice, null)
  assert.equal(report.metrics.score, null)
  assert.equal(report.aggregate.matched, 2)
  assert.equal(report.aggregate.agreement, 0.5)
  assert.deepEqual(report.reviewCaseIds, ['weak-positive', 'weak-negative'])
  // Declared confidence is telemetry: it is reported, never a policy input.
  assert.equal(report.cases[0]!.confidence, null)
})

test('a provider error on one case stays visible and never becomes an answer', async () => {
  const calls: string[] = []
  const report = await evaluateLabelledCases({
    question: NOUL,
    provider: PROVIDER,
    cases: [
      { id: 'ok', state: 'a', expected: true },
      { id: 'broken', state: 'b', expected: false },
    ],
    decide: async (caseId) => {
      calls.push(caseId)
      if (caseId === 'broken') throw new ProviderError('http', 'System One HTTP 500', 500)
      return { question: { type: 'noul', probability: 0.95 } } as never
    },
  })
  assert.equal(calls.length, 2, 'a failed case must not stop the remaining cases')
  assert.equal(report.cases.length, 2)
  const failed = report.cases.find((entry) => entry.id === 'broken')!
  assert.equal(failed.matched, false)
  assert.equal(failed.observed, null)
  assert.equal(failed.error, 'http')
  assert.equal(failed.malformed, false)
  assert.equal(report.aggregate.answered, 1)
  assert.equal(report.aggregate.total, 2)
  assert.equal(report.aggregate.errors, 1)
  // A single class has no meaningful one-vs-rest rate, so nothing is invented.
  assert.equal(report.metrics.noul!.falsePositiveRate, null)
  assert.deepEqual(report.reviewCaseIds, ['broken'])
})

test('an unmeasured rate is null, never zero, for every primitive', async () => {
  // Nothing is answered, so nothing was measured: every rate is unknown.
  // A 0 here would read as "every answer was wrong" and hide a total failure.
  const choice: DecisionQuestion = {
    type: 'choice',
    instructions: 'Which severity applies?',
    criteria: ['low', 'high'],
  }
  const choiceReport = await evaluateLabelledCases({
    question: choice,
    provider: PROVIDER,
    cases: [
      { id: 'a', state: 'x', expected: 'low' },
      { id: 'b', state: 'y', expected: 'high' },
    ],
    decide: async () => {
      throw new ProviderError('http', 'System One HTTP 500', 500)
    },
  })
  assert.equal(choiceReport.aggregate.answered, 0)
  assert.equal(choiceReport.aggregate.agreement, null, 'no answered case, no agreement')
  assert.equal(choiceReport.metrics.choice!.accuracy, null, 'no answered case, no accuracy')
  assert.equal(choiceReport.metrics.choice!.matched, 0, 'the raw count is still a real count')
  assert.deepEqual(choiceReport.metrics.choice!.perClassAgreement, { low: null, high: null })
  assert.deepEqual(choiceReport.metrics.choice!.perClassAgreementUnavailable, ['low', 'high'])

  const noulReport = await evaluateLabelledCases({
    question: NOUL,
    provider: PROVIDER,
    cases: [{ id: 'a', state: 'x', expected: true }],
    decide: async () => {
      throw new ProviderError('http', 'System One HTTP 500', 500)
    },
  })
  assert.equal(noulReport.aggregate.agreement, null)
  assert.equal(noulReport.metrics.noul!.brierScore, null, 'no finite probability, no Brier score')
  assert.equal(noulReport.metrics.noul!.falsePositiveRate, null)
  assert.equal(noulReport.metrics.noul!.falseNegativeRate, null)
  assert.equal(noulReport.candidate.observations.probabilityWhenMatched, null)

  const scoreReport = await evaluateLabelledCases({
    question: { type: 'score', instructions: 'Level?', criteria: ['low', 'high', 'severe'] },
    provider: PROVIDER,
    cases: [{ id: 'a', state: 'x', expected: 1 }],
    decide: async () => {
      throw new ProviderError('http', 'System One HTTP 500', 500)
    },
  })
  assert.equal(scoreReport.aggregate.agreement, null)
  assert.equal(scoreReport.metrics.score!.meanAbsoluteError, null, 'no answered case, no MAE')
  assert.equal(scoreReport.metrics.score!.exactMatchRate, null)
  assert.equal(scoreReport.metrics.score!.rubricRange.min, 0, 'the rubric range is a property of the question, not a measurement')
})

test('choice cases report a confusion matrix and per-class agreement', async () => {
  const question: DecisionQuestion = {
    type: 'choice',
    instructions: 'Which severity applies?',
    criteria: { low: 'Low', high: 'High' },
  }
  const report = await evaluateLabelledCases({
    question,
    provider: PROVIDER,
    cases: [
      { id: 'a', state: 'x', expected: 'low' },
      { id: 'b', state: 'y', expected: 'high' },
      { id: 'c', state: 'z', expected: 'low' },
      { id: 'd', state: 'w', expected: 'high' },
    ],
    decide: async (id) => ({
      question: {
        type: 'choice',
        choice: id === 'c' ? 'high' : id === 'd' ? 'low' : id === 'b' ? 'high' : 'low',
        probabilities: id === 'c' ? { low: 0.4, high: 0.6 } : id === 'd' ? { low: 0.6, high: 0.4 } : id === 'b' ? { low: 0.2, high: 0.8 } : { low: 0.9, high: 0.1 },
      },
    }) as never,
  })
  const choice = report.metrics.choice!
  assert.deepEqual(choice.labels, ['low', 'high'])
  assert.equal(choice.matched, 2)
  assert.equal(choice.accuracy, 0.5)
  assert.deepEqual(choice.confusion, {
    low: { low: 1, high: 1 },
    high: { low: 1, high: 1 },
  })
  assert.equal(choice.perClassAgreement.low, 0.5)
  assert.equal(choice.perClassAgreement.high, 0.5)
  assert.deepEqual(choice.perClassAgreementUnavailable, [])
  assert.equal(report.metrics.noul, null)
  assert.equal(report.metrics.score, null)
})

test('choice labels outside the rubric are rejected before any provider call', async () => {
  let calls = 0
  assert.throws(
    () =>
      parseQuestionCalibrationInput({
        question: { type: 'choice', instructions: 'Which one?', criteria: ['a', 'b'] },
        cases: [{ id: 'c1', state: 's', expected: 'c' }],
      }),
    (error: unknown) => error instanceof ProviderError && error.code === 'invalid_arguments',
  )
  assert.equal(calls, 0)
})

test('score cases keep the native rubric range and report the absolute error', async () => {
  const question: DecisionQuestion = {
    type: 'score',
    instructions: 'How severe is the incident?',
    criteria: ['none', 'minor', 'major', 'critical'],
  }
  const report = await evaluateLabelledCases({
    question,
    provider: PROVIDER,
    cases: [
      { id: 'a', state: 'x', expected: 0 },
      { id: 'b', state: 'y', expected: 2 },
      { id: 'c', state: 'z', expected: 3 },
    ],
    // Documented contract: score is E[level] under the distribution.
    //   a: all mass on level 0           -> 0.0, error 0
    //   b: 0.4/0.6 on levels 1/2         -> 1.6, error 0.4
    //   c: all mass on level 3           -> 3.0, error 0
    decide: async (id) => ({
      question: {
        type: 'score',
        score: id === 'a' ? 0 : id === 'b' ? 1.6 : 3,
        probabilities:
          id === 'b' ? { 0: 0, 1: 0.4, 2: 0.6, 3: 0 } : id === 'a' ? { 0: 1, 1: 0, 2: 0, 3: 0 } : { 0: 0, 1: 0, 2: 0, 3: 1 },
      },
    }) as never,
  })
  const score = report.metrics.score!
  assert.deepEqual(score.rubricRange, { min: 0, max: 3 }, 'the native level range is preserved')
  assert.equal(score.labels.length, 4)
  assert.equal(score.meanAbsoluteError, 0.133333, '(0 + 0.4 + 0) / 3, rounded')
  assert.equal(Math.round((score.absoluteError.b ?? 0) * 1e9) / 1e9, 0.4)
  assert.equal(score.exactMatches, 2)
  assert.equal(score.exactMatchRate, 0.666667, 'two of three answers landed on the labelled level')
  // No 0..1 normalized field may exist anywhere in the report.
  assert.ok(!JSON.stringify(report).includes('normalized'))
  assert.equal(report.metrics.noul, null)
})

test('a score answer that contradicts its own distribution is reported as malformed', async () => {
  const question: DecisionQuestion = { type: 'score', instructions: 'Level?', criteria: ['low', 'high'] }
  const report = await evaluateLabelledCases({
    question,
    provider: PROVIDER,
    cases: [{ id: 'a', state: 'x', expected: 0 }],
    decide: async () => ({ question: { type: 'score', score: 1, probabilities: { 0: 0.5, 1: 0.5 } } }) as never,
  })
  const entry = report.cases[0]!
  assert.equal(entry.malformed, true)
  assert.equal(entry.matched, false)
  assert.equal(entry.error, 'score_distribution_mismatch')
})

test('a malformed answer is reported per case and the other cases still count', async () => {
  const report = await evaluateLabelledCases({
    question: { type: 'noul', instructions: 'Is it?' },
    provider: PROVIDER,
    cases: [
      { id: 'good', state: 'x', expected: true },
      { id: 'broken', state: 'y', expected: true },
    ],
    decide: async (id) =>
      ({ question: id === 'broken' ? { type: 'noul', probability: 4 } : { type: 'noul', probability: 0.8 } }) as never,
  })
  assert.equal(report.aggregate.answered, 1)
  assert.equal(report.aggregate.malformed, 1)
  assert.equal(report.cases.find((entry) => entry.id === 'broken')!.error, 'invalid_noul_probability')
})

test('the question fingerprint changes with the question and ignores key order', () => {
  const a = fingerprintQuestion({ type: 'choice', instructions: 'Which?', criteria: { x: 'X', y: 'Y' } })
  const b = fingerprintQuestion({ type: 'choice', instructions: 'Which?', criteria: { y: 'Y', x: 'X' } })
  const c = fingerprintQuestion({ type: 'choice', instructions: 'Which?', criteria: { x: 'X', y: 'Z' } })
  const d = fingerprintQuestion({ type: 'choice', instructions: 'Which else?', criteria: { x: 'X', y: 'Y' } })
  assert.equal(a, b, 'object criteria are canonicalized before hashing')
  assert.notEqual(a, c)
  assert.notEqual(a, d)
  assert.match(a, /^question:v1:[0-9a-f]{16}$/)
  // Any change to the text, including insignificant whitespace, is a change of
  // question: the fingerprint is conservative on purpose.
  assert.notEqual(
    fingerprintQuestion({ type: 'noul', instructions: 'Is it?' }),
    fingerprintQuestion({ type: 'noul', instructions: ' Is it?' }),
  )
  assert.equal(
    fingerprintQuestion({ type: 'noul', instructions: 'Is it?' }),
    fingerprintQuestion({ type: 'noul', instructions: 'Is it?' }),
  )
})

test('a candidate from another question is not applicable to this one', () => {
  const question: DecisionQuestion = { type: 'noul', instructions: 'Is it a regression?' }
  const candidate = {
    schemaVersion: 1 as const,
    active: false as const,
    provider: { presetId: 'kev', model: 'kev-4b' },
    question: { fingerprint: fingerprintQuestion(question), type: 'noul' as const, version: 'local-v1' },
    observations: { answered: 4 },
  }
  assert.equal(questionIsApplicableTo(candidate, question), true)
  assert.equal(
    questionIsApplicableTo(candidate, { type: 'noul', instructions: 'Is it a feature?' }),
    false,
  )
  assert.equal(
    questionIsApplicableTo({ ...candidate, question: { ...candidate.question, fingerprint: 'question:v1:0000000000000000' } }, question),
    false,
  )
})

test('an unusable answer and a missing case never become a matched observation', async () => {
  const report = await evaluateLabelledCases({
    question: { type: 'noul', instructions: 'Is it?' },
    provider: PROVIDER,
    cases: [{ id: 'a', state: 'x', expected: true }],
    decide: async () => ({ question: { type: 'noul', probability: 0.5 } }) as never,
  })
  // A 0.5 answer with no declared threshold: the case is answered but not
  // matched, and the report must not invent a decision boundary.
  const entry = report.cases[0]!
  assert.equal(entry.answered, true)
  assert.equal(entry.matched, false)
  assert.equal(report.aggregate.agreement, 0)
  // No case matched, so the matched-side range is unknown, not [0.5, 0.5].
  assert.equal(report.candidate.observations.probabilityWhenMatched, null)
  assert.equal(report.candidate.observations.probabilityWhenMismatched!.min, 0.5)
  assert.equal(report.candidate.observations.separation.separable, null)
  assert.equal(report.candidate.active, false)
  assert.equal(report.candidate.schemaVersion, 1)
})

test('the parsed input bounds the case count and the state size', () => {
  const cases = Array.from({ length: 60 }, (_, index) => ({ id: `c${index}`, state: 'x', expected: true }))
  assert.throws(
    () => parseQuestionCalibrationInput({ question: NOUL, cases }),
    (error: unknown) => error instanceof ProviderError && error.code === 'invalid_arguments',
  )
  assert.throws(
    () =>
      parseQuestionCalibrationInput({
        question: NOUL,
        cases: [{ id: 'a', state: 'x'.repeat(30_000), expected: true }],
      }),
    (error: unknown) => error instanceof ProviderError && error.code === 'invalid_arguments',
  )
  const parsed = parseQuestionCalibrationInput({
    question: NOUL,
    cases: [{ id: 'a', state: 'x', expected: true }],
    questionVersion: 'local-v1',
  })
  assert.equal(parsed.questionVersion, 'local-v1')
  assert.equal(parsed.cases[0]!.expected, true)
  assert.equal(ctx.projectId, 'p')
})

test('an array-rubric choice uses the criteria values as labels, like the adapter', async () => {
  // The shipped adapter addresses an array rubric by its VALUES, so the
  // evaluator must too. Indexing here would score a correct answer malformed.
  const question: DecisionQuestion = {
    type: 'choice',
    instructions: 'Which severity applies?',
    criteria: ['low', 'high'],
  }
  assert.deepEqual([...questionLabels(question)], ['low', 'high'], 'array criteria are addressed by value')
  // A `score` rubric stays addressed by level index, so its levels are the keys.
  assert.deepEqual(
    [...questionLabels({ type: 'score', instructions: 'Level?', criteria: ['low', 'high'] })],
    ['0', '1'],
    'a score rubric is addressed by level index, not by its labels',
  )
  const parsed = parseQuestionCalibrationInput({
    question,
    cases: [
      { id: 'a', state: 'x', expected: 'high' },
      { id: 'b', state: 'y', expected: 'low' },
    ],
  })
  assert.equal(parsed.cases[0]!.expected, 'high', 'the operator labels the criterion by value')
  const report = await evaluateLabelledCases({
    question,
    provider: PROVIDER,
    cases: parsed.cases,
    decide: async (id) =>
      ({
        answers: {
          question: {
            type: 'choice',
            choice: id === 'a' ? 'high' : 'low',
            probabilities: { low: id === 'a' ? 0.3 : 0.7, high: id === 'a' ? 0.7 : 0.3 },
          },
        },
      }) as never,
  })
  assert.equal(report.aggregate.answered, 2, 'a valid answer is never read as malformed')
  assert.equal(report.aggregate.matched, 2)
  assert.deepEqual(report.criteriaLabels, ['low', 'high'])
  assert.equal(report.metrics.choice!.accuracy, 1)
})

test('the report names the model actually evaluated, not the configured one', async () => {
  const question: DecisionQuestion = { type: 'noul', instructions: 'Is it?' }
  // A per-call override outranks the configured model and the provider echo.
  const overridden = await evaluateLabelledCases({
    question,
    provider: { presetId: 'custom', model: 'settings-model' },
    requestedModel: 'override-model',
    cases: [{ id: 'a', state: 'x', expected: true }],
    decide: async () =>
      ({ answers: { question: { type: 'noul', probability: 0.9 } }, model: 'echoed-model' }) as never,
  })
  assert.equal(overridden.provider.model, 'override-model', 'the override is what was requested')
  assert.equal(
    overridden.candidate.provider.model,
    'override-model',
    'the candidate must not read as calibrated for another model',
  )

  // With no override, the provider's own answer is the next best evidence.
  const echoed = await evaluateLabelledCases({
    question,
    provider: { presetId: 'custom', model: 'settings-model' },
    cases: [{ id: 'a', state: 'x', expected: true }],
    decide: async () =>
      ({ answers: { question: { type: 'noul', probability: 0.9 } }, model: 'echoed-model' }) as never,
  })
  assert.equal(echoed.provider.model, 'echoed-model', 'the model served, not the model configured')
  assert.equal(echoed.candidate.provider.model, 'echoed-model')

  // With neither, the configured model is the only honest answer.
  const plain = await evaluateLabelledCases({
    question,
    provider: { presetId: 'custom', model: 'settings-model' },
    cases: [{ id: 'a', state: 'x', expected: true }],
    decide: async () => ({ question: { type: 'noul', probability: 0.9 } }) as never,
  })
  assert.equal(plain.provider.model, 'settings-model')
  assert.equal(plain.candidate.provider.model, 'settings-model')

  // A bare answer map stays supported: no declared model, nothing invented.
  const undeclared = await evaluateLabelledCases({
    question,
    provider: { presetId: 'custom' },
    cases: [{ id: 'a', state: 'x', expected: true }],
    decide: async () => ({ question: { type: 'noul', probability: 0.9 } }) as never,
  })
  assert.equal(undeclared.provider.model, undefined, 'no model is invented when none was declared')
})
