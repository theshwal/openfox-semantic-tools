import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LOW_CONFIDENCE_MIN_DECLARED,
  LOW_CONFIDENCE_NOUL_MARGIN,
  evaluateReferenceAgreement,
  parseReferenceAgreementInput,
  promotionCases,
  type ReferenceCase,
} from '../src/calibration/reference-agreement.ts'
import { parseQuestionCalibrationInput } from '../src/calibration/question-eval.ts'
import type { DecisionAnswer } from '../src/decision/types.ts'

const PROVIDER = { presetId: 'custom', model: 'fixture-model' }
const QUESTION = { type: 'noul', instructions: 'Does the note contain a precise diagnosis?' } as const
const LLM_REFERENCE = {
  source: 'llm' as const,
  model: 'main-model-x',
  promptVersion: 'notes-prompt-v3',
  recordedAt: '2026-10-01',
}
const HUMAN_REFERENCE = {
  source: 'human' as const,
  model: null,
  promptVersion: 'notes-prompt-v3',
  recordedAt: '2026-10-01',
}

const CASES: ReferenceCase[] = [
  { id: 'clear', state: 'a precise diagnosis of pulmonary embolism', referenceAnswer: true },
  { id: 'vague', state: 'the patient is unwell', referenceAnswer: false },
]

/** Provider answers keyed by case id, in the primitive's own domain. */
function decider(answers: Record<string, DecisionAnswer>, seen?: string[]) {
  return async (id: string) => {
    seen?.push(id)
    return { answers: { question: answers[id]! } }
  }
}

test('the same frozen input produces the same question fingerprint and runs each frozen case', async () => {
  const seen: string[] = []
  const decide = decider(
    { clear: { type: 'noul', probability: 0.9 }, vague: { type: 'noul', probability: 0.1 } },
    seen,
  )
  const options = { question: QUESTION, cases: CASES, reference: LLM_REFERENCE, provider: PROVIDER, decide }
  const first = await evaluateReferenceAgreement(options)
  const second = await evaluateReferenceAgreement(options)
  assert.equal(first.question.fingerprint, second.question.fingerprint)
  assert.deepEqual(
    { ...first.aggregate, latencyMs: null },
    { ...second.aggregate, latencyMs: null },
  )
  assert.deepEqual(seen, ['clear', 'vague', 'clear', 'vague'])
  assert.equal(first.aggregate.total, 2)
})

test('a case cannot carry a semantic answer, so the reference judgment is never contaminated', async () => {
  for (const leaked of [
    { id: 'a', state: 's', referenceAnswer: true, answer: { type: 'noul', probability: 0.9 } },
    { id: 'a', state: 's', referenceAnswer: true, observed: true },
  ]) {
    assert.throws(
      () => parseReferenceAgreementInput({ question: QUESTION, reference: LLM_REFERENCE, cases: [leaked] }),
      /Unknown cases\[0\] field/,
    )
  }
  // The reported reference answer is exactly the supplied one: the evaluator
  // compares against the caller's frozen judgments, unchanged.
  const report = await evaluateReferenceAgreement({
    question: QUESTION,
    cases: [
      { id: 'clear', state: 'a precise diagnosis', referenceAnswer: true },
      { id: 'vague', state: 'the patient is unwell', referenceAnswer: false },
    ],
    reference: LLM_REFERENCE,
    provider: PROVIDER,
    decide: decider({ clear: { type: 'noul', probability: 0.9 }, vague: { type: 'noul', probability: 0.9 } }),
  })
  assert.deepEqual(
    report.review.map((entry) => [entry.id, entry.referenceAnswer]),
    [['vague', false]],
  )
})

test('an LLM reference reports agreement, a human reference reports accuracy, and the report says which', async () => {
  const decide = decider({ clear: { type: 'noul', probability: 0.9 }, vague: { type: 'noul', probability: 0.1 } })
  const llm = await evaluateReferenceAgreement({
    question: QUESTION,
    cases: CASES,
    reference: LLM_REFERENCE,
    provider: PROVIDER,
    decide,
  })
  assert.equal(llm.metric.name, 'agreement')
  assert.equal(llm.metric.kind, 'concordance')
  assert.ok(!/accuracy/.test(JSON.stringify(llm)))
  const human = await evaluateReferenceAgreement({
    question: QUESTION,
    cases: CASES,
    reference: HUMAN_REFERENCE,
    provider: PROVIDER,
    decide,
  })
  assert.equal(human.metric.name, 'accuracy')
  assert.equal(human.metric.kind, 'accuracy')
  // Distinguishable from the report alone.
  assert.notEqual(JSON.stringify(llm.metric), JSON.stringify(human.metric))
})

test('disagreements are first-class review items carrying both answers', async () => {
  const report = await evaluateReferenceAgreement({
    question: QUESTION,
    cases: [
      { id: 'a', state: 'sa', referenceAnswer: true },
      { id: 'b', state: 'sb', referenceAnswer: false },
      { id: 'c', state: 'sc', referenceAnswer: true },
      { id: 'd', state: 'sd', referenceAnswer: false },
    ],
    reference: LLM_REFERENCE,
    provider: PROVIDER,
    decide: decider({
      a: { type: 'noul', probability: 0.95 },
      b: { type: 'noul', probability: 0.8 },
      c: { type: 'noul', probability: 0.75 },
      d: { type: 'noul', probability: 0.05 },
    }),
  })
  assert.deepEqual(report.review.map((entry) => entry.id), ['b'])
  assert.equal(report.review[0].referenceAnswer, false)
  assert.equal(report.review[0].observed, true)
  assert.equal(report.review[0].probability, 0.8)
  assert.equal(report.review[0].reason, 'mismatch')
  assert.equal(report.aggregate.agreed, 3)
  assert.equal(report.aggregate.agreement, 0.75)
})

test('raw probabilities, distributions and confidence stay visible for every primitive', async () => {
  const noul = await evaluateReferenceAgreement({
    question: QUESTION,
    cases: [{ id: 'a', state: 'sa', referenceAnswer: true }],
    reference: LLM_REFERENCE,
    provider: PROVIDER,
    decide: async () => ({ answers: { question: { type: 'noul', probability: 0.82, confidence: 0.9 } } }),
  })
  assert.equal(noul.lowConfidenceAgreements.length, 0)
  assert.equal(noul.aggregate.agreement, 1)
  assert.equal(noul.cases[0].probability, 0.82)
  assert.equal(noul.cases[0].confidence, 0.9)

  const choice = await evaluateReferenceAgreement({
    question: { type: 'choice', instructions: 'Which side?', criteria: ['left', 'right'] },
    cases: [{ id: 'a', state: 'sa', referenceAnswer: 'left' }],
    reference: LLM_REFERENCE,
    provider: PROVIDER,
    decide: async () => ({
      answers: {
        question: { type: 'choice', choice: 'left', probabilities: { left: 0.7, right: 0.3 }, confidence: 0.7 },
      },
    }),
  })
  assert.deepEqual(choice.review, [])
  assert.equal(choice.aggregate.agreement, 1)
  assert.deepEqual(choice.cases[0].distribution, { left: 0.7, right: 0.3 })
  assert.equal(choice.cases[0].confidence, 0.7)
  assert.deepEqual(choice.perClassAgreement, { left: 1, right: null })
  assert.deepEqual(choice.perClassAgreementUnavailable, ['right'])

  const score = await evaluateReferenceAgreement({
    question: { type: 'score', instructions: 'How bad?', criteria: ['low', 'mid', 'high'] },
    cases: [{ id: 'a', state: 'sa', referenceAnswer: 2 }],
    reference: LLM_REFERENCE,
    provider: PROVIDER,
    // A `score` rubric is addressed by LEVEL INDEX, exactly as the shipped
    // adapter addresses it, so the distribution keys are "0","1","2".
    decide: async () => ({
      answers: {
        question: {
          type: 'score',
          score: 2,
          probabilities: { '0': 0, '1': 0, '2': 1 },
          confidence: 0.8,
        },
      },
    }),
  })
  assert.equal(score.aggregate.agreement, 1)
  assert.equal(score.cases[0].score, 2)
  assert.deepEqual(score.cases[0].distribution, { '0': 0, '1': 0, '2': 1 })
  assert.equal(score.cases[0].confidence, 0.8)
  assert.deepEqual(score.rubricRange, { min: 0, max: 2 })
})

test('a low-confidence agreement stays visible and still counts as an agreement', async () => {
  // Above the 0.5 decision boundary, so it agrees, but within the reported
  // margin of that boundary, so the provider itself is undecided.
  const probability = 0.5 + LOW_CONFIDENCE_NOUL_MARGIN / 2
  const report = await evaluateReferenceAgreement({
    question: QUESTION,
    cases: [
      { id: 'sure', state: 'a precise diagnosis', referenceAnswer: true },
      { id: 'wobbly', state: 'a somewhat precise note', referenceAnswer: true },
    ],
    reference: LLM_REFERENCE,
    provider: PROVIDER,
    decide: decider({
      sure: { type: 'noul', probability: 0.99 },
      wobbly: { type: 'noul', probability },
    }),
  })
  assert.equal(report.aggregate.agreed, 2)
  assert.equal(report.aggregate.agreement, 1)
  assert.deepEqual(report.review, [])
  assert.deepEqual(report.lowConfidenceAgreements.map((entry) => [entry.id, entry.reason]), [
    ['wobbly', 'near_decision_boundary'],
  ])
  assert.equal(report.lowConfidenceAgreements[0]!.probability, probability)
  // A declared confidence under the stated floor is low confidence too.
  const declared = await evaluateReferenceAgreement({
    question: QUESTION,
    cases: [{ id: 'a', state: 'sa', referenceAnswer: true }],
    reference: LLM_REFERENCE,
    provider: PROVIDER,
    decide: async () => ({
      answers: { question: { type: 'noul', probability: 0.99, confidence: LOW_CONFIDENCE_MIN_DECLARED - 0.01 } },
    }),
  })
  assert.deepEqual(declared.lowConfidenceAgreements.map((entry) => entry.reason), ['low_declared_confidence'])
  // A flat choice distribution is ambiguous between criteria.
  const flat = await evaluateReferenceAgreement({
    question: { type: 'choice', instructions: 'Which side?', criteria: ['left', 'right'] },
    cases: [{ id: 'a', state: 'sa', referenceAnswer: 'left' }],
    reference: LLM_REFERENCE,
    provider: PROVIDER,
    decide: async () => ({
      answers: {
        question: { type: 'choice', choice: 'left', probabilities: { left: 0.55, right: 0.45 } },
      },
    }),
  })
  assert.equal(flat.aggregate.agreement, 1)
  assert.deepEqual(flat.lowConfidenceAgreements.map((entry) => entry.reason), ['flat_distribution'])
})

test('an LLM reference without a model identifier is rejected before any run', () => {
  for (const reference of [
    { source: 'llm', promptVersion: 'v1' },
    { source: 'llm', promptVersion: 'v1', model: '  ' },
    { source: 'robot', promptVersion: 'v1', model: 'm' },
    { source: 'human', promptVersion: 'v1', model: 'm' },
    { source: 'llm', promptVersion: 'v1', model: 'm', origin: 'openfox' },
  ]) {
    assert.throws(
      () => parseReferenceAgreementInput({ question: QUESTION, reference, cases: CASES }),
      /reference/,
      JSON.stringify(reference),
    )
  }
  const parsed = parseReferenceAgreementInput({
    question: QUESTION,
    reference: { source: 'llm', model: 'main-model-x', promptVersion: 'notes-prompt-v3' },
    cases: CASES,
  })
  assert.deepEqual(parsed.reference, {
    source: 'llm',
    model: 'main-model-x',
    promptVersion: 'notes-prompt-v3',
    recordedAt: null,
  })
})

test('reference provenance is echoed verbatim and an unreported date is null', async () => {
  const report = await evaluateReferenceAgreement({
    question: QUESTION,
    cases: CASES,
    reference: LLM_REFERENCE,
    provider: PROVIDER,
    decide: decider({ clear: { type: 'noul', probability: 0.9 }, vague: { type: 'noul', probability: 0.1 } }),
  })
  assert.deepEqual(report.reference, LLM_REFERENCE)
  assert.equal(report.reference.model, 'main-model-x')
  assert.equal(report.reference.promptVersion, 'notes-prompt-v3')
  assert.equal(report.provider.presetId, 'custom')
  assert.equal(report.question.version, null)
})

test('reviewed disagreements are reusable as labelled cases by the question calibration flow', async () => {
  const report = await evaluateReferenceAgreement({
    question: { type: 'choice', instructions: 'Which side?', criteria: ['left', 'right'] },
    cases: [
      { id: 'a', state: 'sa', referenceAnswer: 'left' },
      { id: 'b', state: 'sb', referenceAnswer: 'left' },
    ],
    reference: LLM_REFERENCE,
    provider: PROVIDER,
    decide: decider({
      a: { type: 'choice', choice: 'left', probabilities: { left: 0.9, right: 0.1 } },
      b: { type: 'choice', choice: 'right', probabilities: { left: 0.1, right: 0.9 } },
    }),
    reviewed: [{ id: 'b', expected: 'right' }],
  })
  assert.equal(report.promotion.reviewed, 1)
  const labelled = report.promotion.labelledCases!
  assert.deepEqual(labelled, [{ id: 'b', state: 'sb', expected: 'right' }])
  // Round trip into the shipped arbitrary-question flow, unchanged.
  const reparsed = parseQuestionCalibrationInput({
    question: { type: 'choice', instructions: 'Which side?', criteria: ['left', 'right'] },
    cases: labelled,
  })
  assert.deepEqual(reparsed.cases, labelled)
  // No reviewed label means nothing is promoted: promoting the provider's own
  // answer would make the next run agree with itself.
  assert.equal(promotionCases(CASES, []), null)
})

test('a case row names the reference answer referenceAnswer, never the operator-label expected', async () => {
  // `expected` means "operator ground truth" on `semantic_question_calibration`.
  // Reusing that name here would let an operator read this report backwards, so
  // the case row publishes the reference answer under its own name.
  const report = await evaluateReferenceAgreement({
    question: QUESTION,
    cases: [{ id: 'a', state: 'sa', referenceAnswer: true }],
    reference: LLM_REFERENCE,
    provider: PROVIDER,
    decide: decider({ a: { type: 'noul', probability: 0.9 } }),
  })
  const row = report.cases[0] as unknown as Record<string, unknown>
  assert.equal(row.referenceAnswer, true)
  assert.equal('expected' in row, false, 'the operator-label name must not reappear on this surface')
})

test('promoted labelled cases carry the reviewed cases own frozen state back into the report', async () => {
  // The report is otherwise state-free, so this is a deliberate boundary: the
  // promoted cases are the operator's own input, echoed verbatim so they can be
  // fed back into `semantic_question_calibration` without retyping the state.
  const state = 'SECRET patient note 12345'
  const report = await evaluateReferenceAgreement({
    question: QUESTION,
    cases: [{ id: 'a', state, referenceAnswer: true }],
    reference: LLM_REFERENCE,
    provider: PROVIDER,
    decide: decider({ a: { type: 'noul', probability: 0.1 } }),
    reviewed: [{ id: 'a', expected: false }],
  })
  assert.deepEqual(report.promotion.labelledCases, [{ id: 'a', state, expected: false }])
  assert.ok(JSON.stringify(report).includes(state))
  // Nothing reviewed: no echo at all, so the unreviewed path stays state-free.
  const unreviewed = await evaluateReferenceAgreement({
    question: QUESTION,
    cases: [{ id: 'a', state, referenceAnswer: true }],
    reference: LLM_REFERENCE,
    provider: PROVIDER,
    decide: decider({ a: { type: 'noul', probability: 0.9 } }),
  })
  assert.equal(unreviewed.promotion.labelledCases, null)
  assert.ok(!JSON.stringify(unreviewed).includes(state))
})

test('an invalid reviewed label is reported against reviewed, not against a frozen case', () => {
  // The reviewed id may point at a frozen case several positions away, so the
  // error must name the field the operator actually typed.
  const choice = { type: 'choice' as const, instructions: 'Which side?', criteria: ['l', 'r'] }
  assert.throws(
    () =>
      parseReferenceAgreementInput({
        question: choice,
        reference: LLM_REFERENCE,
        cases: [
          { id: 'a', state: 'sa', referenceAnswer: 'l' },
          { id: 'b', state: 'sb', referenceAnswer: 'r' },
        ],
        reviewed: [{ id: 'b', expected: 'nope' }],
      }),
    /reviewed\[0\]\.expected must be one of the question criteria \(l, r\)/,
  )
  // A frozen case keeps its own wording.
  assert.throws(
    () =>
      parseReferenceAgreementInput({
        question: choice,
        reference: LLM_REFERENCE,
        cases: [{ id: 'a', state: 'sa', referenceAnswer: 'nope' }],
      }),
    /cases\[0\]\.referenceAnswer must be one of the question criteria/,
  )
})

test('the report carries a run date, and a pinned one is honoured', async () => {
  const options = {
    question: QUESTION,
    cases: CASES,
    reference: LLM_REFERENCE,
    provider: PROVIDER,
    decide: decider({ clear: { type: 'noul', probability: 0.9 }, vague: { type: 'noul', probability: 0.1 } }),
  }
  const pinned = await evaluateReferenceAgreement({ ...options, evaluatedAt: '1999-01-01T00:00:00.000Z' })
  assert.equal(pinned.runAt, '1999-01-01T00:00:00.000Z')
  const unpinned = await evaluateReferenceAgreement(options)
  assert.equal(typeof unpinned.runAt, 'string')
  assert.ok(!Number.isNaN(Date.parse(unpinned.runAt)), 'the default run date must be a real date')
})

test('an ambiguous reference is locatable from the report, not only counted', async () => {
  // Provider-side uncertainty gets `lowConfidenceAgreements`; the reference side
  // must be just as visible, or a reader sees agreement 0.75 with no idea that
  // part of it rests on judgments the operator themselves called ambiguous.
  const report = await evaluateReferenceAgreement({
    question: QUESTION,
    cases: [
      { id: 'a', state: 'sa', referenceAnswer: true, disposition: 'clear' },
      { id: 'b', state: 'sb', referenceAnswer: false, disposition: 'ambiguous' },
      { id: 'c', state: 'sc', referenceAnswer: true, disposition: 'ambiguous' },
    ],
    reference: LLM_REFERENCE,
    provider: PROVIDER,
    decide: decider({
      a: { type: 'noul', probability: 0.9 },
      b: { type: 'noul', probability: 0.1 },
      c: { type: 'noul', probability: 0.1 },
    }),
  })
  assert.equal(report.aggregate.ambiguous, 2)
  // Locatable as a first-class list...
  assert.deepEqual(report.referenceAmbiguous, ['b', 'c'])
  // ...and on each case row, with a null where none was declared.
  assert.deepEqual(
    report.cases.map((entry) => entry.disposition),
    ['clear', 'ambiguous', 'ambiguous'],
  )
  // An ambiguous reference is not forced into the review list: it is not a
  // provider failure, only an untrusted reference.
  assert.deepEqual(report.review.map((entry) => entry.id), ['c'])
  assert.equal(report.review[0]!.disposition, 'ambiguous')
  // No disposition anywhere: both the list and the field are empty/null, not 0.
  const undisposed = await evaluateReferenceAgreement({
    question: QUESTION,
    cases: CASES,
    reference: LLM_REFERENCE,
    provider: PROVIDER,
    decide: decider({ clear: { type: 'noul', probability: 0.9 }, vague: { type: 'noul', probability: 0.1 } }),
  })
  assert.deepEqual(undisposed.referenceAmbiguous, [])
  assert.deepEqual(undisposed.cases.map((entry) => entry.disposition), [null, null])
})

test("the report's own reference block is valid input for the next run", async () => {
  // `runAt` exists so two reports can be compared, which means re-supplying the
  // SAME frozen reference against a newer provider. The report publishes
  // `model: null` for a human reference and `recordedAt: null` when no date was
  // recorded, so an explicit null must parse exactly like an omitted field.
  const decide = decider({ clear: { type: 'noul', probability: 0.9 }, vague: { type: 'noul', probability: 0.1 } })
  for (const reference of [
    { source: 'human' as const, model: null, promptVersion: 'notes-prompt-v3', recordedAt: null },
    { source: 'llm' as const, model: 'main-model-x', promptVersion: 'notes-prompt-v3', recordedAt: null },
    { source: 'llm' as const, model: 'main-model-x', promptVersion: 'notes-prompt-v3', recordedAt: '2026-10-01' },
  ]) {
    const report = await evaluateReferenceAgreement({
      question: QUESTION,
      cases: CASES,
      reference,
      provider: PROVIDER,
      decide,
    })
    // Fed straight back, unchanged.
    const reparsed = parseReferenceAgreementInput({ question: QUESTION, reference: report.reference, cases: CASES })
    assert.deepEqual(reparsed.reference, reference, JSON.stringify(reference))
  }
  // An LLM reference with a null model is still refused: the rule is about the
  // null FORM being accepted where omission is allowed, not about relaxing the
  // provenance requirement.
  assert.throws(
    () => parseReferenceAgreementInput({ question: QUESTION, reference: { source: 'llm', model: null, promptVersion: 'v1' }, cases: CASES }),
    /reference\.model must be a nonempty string/,
  )
})

test('a duplicate reviewed id is refused instead of producing duplicate promoted cases', async () => {
  // A reviewer revisiting a case would otherwise emit two promoted cases with
  // the same id, and `parseQuestionCalibrationInput` rejects duplicates: the
  // round trip the docs promise would break exactly there.
  assert.throws(
    () =>
      parseReferenceAgreementInput({
        question: QUESTION,
        reference: LLM_REFERENCE,
        cases: [
          { id: 'a', state: 'sa', referenceAnswer: true },
          { id: 'b', state: 'sb', referenceAnswer: true },
        ],
        reviewed: [
          { id: 'b', expected: false },
          { id: 'b', expected: true },
        ],
      }),
    /Duplicate reviewed id "b"/,
  )
  // A distinct set of reviewed ids promotes cleanly and reparses.
  const report = await evaluateReferenceAgreement({
    question: QUESTION,
    cases: [
      { id: 'a', state: 'sa', referenceAnswer: true },
      { id: 'b', state: 'sb', referenceAnswer: true },
    ],
    reference: LLM_REFERENCE,
    provider: PROVIDER,
    decide: decider({
      a: { type: 'noul', probability: 0.1 },
      b: { type: 'noul', probability: 0.1 },
    }),
    reviewed: [
      { id: 'a', expected: false },
      { id: 'b', expected: false },
    ],
  })
  const labelled = report.promotion.labelledCases!
  assert.equal(new Set(labelled.map((entry) => entry.id)).size, labelled.length)
  assert.deepEqual(
    parseQuestionCalibrationInput({ question: QUESTION, cases: labelled }).cases,
    labelled,
  )
})

test('the report carries the required fields, a null ambiguous count and no threshold', async () => {
  const report = await evaluateReferenceAgreement({
    question: QUESTION,
    cases: [
      { id: 'a', state: 'sa', referenceAnswer: true, disposition: 'clear' },
      { id: 'b', state: 'sb', referenceAnswer: false, disposition: 'ambiguous' },
    ],
    reference: LLM_REFERENCE,
    provider: PROVIDER,
    decide: decider({ a: { type: 'noul', probability: 0.9 }, b: { type: 'noul', probability: 0.1 } }),
  })
  assert.equal(report.advisory, true)
  assert.equal(report.active, false)
  assert.equal(report.aggregate.total, 2)
  assert.equal(report.aggregate.agreement, 1)
  assert.equal(report.aggregate.ambiguous, 1)
  assert.ok(report.aggregate.latencyMs.total >= 0)
  assert.equal(typeof report.aggregate.latencyMs.mean, 'number')
  assert.equal(report.perClassAgreement, null)
  // No threshold recommendation and no provider ranking anywhere in the output.
  const serialized = JSON.stringify(report)
  assert.ok(!/threshold|rank|recommend/i.test(serialized))

  // No disposition supplied at all: unknown, not zero.
  const undisposed = await evaluateReferenceAgreement({
    question: QUESTION,
    cases: CASES,
    reference: LLM_REFERENCE,
    provider: PROVIDER,
    decide: decider({ clear: { type: 'noul', probability: 0.9 }, vague: { type: 'noul', probability: 0.1 } }),
  })
  assert.equal(undisposed.aggregate.ambiguous, null)
})

test('a provider error and a malformed answer stay visible instead of counting as agreement', async () => {
  const report = await evaluateReferenceAgreement({
    question: QUESTION,
    cases: [
      { id: 'ok', state: 'sa', referenceAnswer: true },
      { id: 'boom', state: 'sb', referenceAnswer: false },
      { id: 'garbage', state: 'sc', referenceAnswer: true },
    ],
    reference: LLM_REFERENCE,
    provider: PROVIDER,
    decide: async (id) => {
      if (id === 'boom') throw new Error('connection reset')
      if (id === 'garbage') return { answers: { question: { type: 'noul', probability: 9 } } }
      return { answers: { question: { type: 'noul', probability: 0.9 } } }
    },
  })
  assert.equal(report.aggregate.total, 3)
  assert.equal(report.aggregate.answered, 1)
  assert.equal(report.aggregate.agreed, 1)
  assert.equal(report.aggregate.agreement, 1)
  assert.equal(report.aggregate.errors, 1)
  assert.equal(report.aggregate.malformed, 1)
  assert.deepEqual(
    report.review.map((entry) => [entry.id, entry.reason]),
    [
      ['boom', 'provider_error'],
      ['garbage', 'malformed_answer'],
    ],
  )
  for (const entry of report.review) {
    assert.equal(entry.observed, null)
    assert.ok(entry.error)
  }
})

test('a fatal provider failure stops the run instead of producing a report', async () => {
  const { ProviderError } = await import('../src/errors.ts')
  await assert.rejects(
    evaluateReferenceAgreement({
      question: QUESTION,
      cases: CASES,
      reference: LLM_REFERENCE,
      provider: PROVIDER,
      decide: async () => {
        throw new ProviderError('aborted', 'cancelled')
      },
    }),
    /cancelled/,
  )
})

test('malformed input is rejected before any provider call', () => {
  for (const args of [
    { cases: CASES, reference: LLM_REFERENCE },
    { question: QUESTION, cases: CASES },
    { question: QUESTION, reference: LLM_REFERENCE, cases: [] },
    { question: QUESTION, reference: LLM_REFERENCE, cases: [{ id: 'a', state: 's' }] },
    {
      question: QUESTION,
      reference: LLM_REFERENCE,
      cases: [{ id: 'a', state: 's', referenceAnswer: true, disposition: 'unsure' }],
    },
    {
      question: QUESTION,
      reference: LLM_REFERENCE,
      cases: [{ id: 'a', state: 's', referenceAnswer: 'yes' }],
    },
    {
      question: QUESTION,
      reference: LLM_REFERENCE,
      cases: [{ id: 'a', state: 's', referenceAnswer: true }],
      reviewed: [{ id: 'b', expected: true }],
    },
    {
      question: QUESTION,
      reference: LLM_REFERENCE,
      cases: [{ id: 'a', state: 's', referenceAnswer: true }],
      reviewed: [{ id: 'a', expected: 'yes' }],
    },
  ]) {
    assert.throws(() => parseReferenceAgreementInput(args), /./, JSON.stringify(args))
  }
})
