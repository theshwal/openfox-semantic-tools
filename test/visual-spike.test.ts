import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseManifest,
  percentile,
  strictJsonObject,
  summarize,
  type NormalizedVisualResult,
} from '../scripts/visual-spike-lib.ts'

test('visual manifest accepts typed choice and noul ground truth', () => {
  const manifest = parseManifest({
    schemaVersion: 1,
    source: { repository: 'x/y', ref: 'main', directory: 'screens', groundTruth: 'manual' },
    cases: [
      {
        id: 'c1',
        image: 'a.png',
        kind: 'choice',
        questionId: 'page',
        instructions: 'page?',
        choices: ['a', 'b'],
        expected: 'a',
        groundTruthNote: 'seen',
      },
      {
        id: 'c2',
        image: 'b.png',
        kind: 'noul',
        questionId: 'visible',
        instructions: 'visible?',
        expected: false,
        groundTruthNote: 'seen',
      },
    ],
  })
  assert.equal(manifest.cases.length, 2)
})

test('visual manifest rejects out-of-rubric expected labels', () => {
  assert.throws(() =>
    parseManifest({
      schemaVersion: 1,
      source: { repository: 'x/y', ref: 'main', directory: 'screens', groundTruth: 'manual' },
      cases: [{
        id: 'c1',
        image: 'a.png',
        kind: 'choice',
        questionId: 'page',
        instructions: 'page?',
        choices: ['a', 'b'],
        expected: 'c',
        groundTruthNote: 'seen',
      }],
    }),
  )
})

test('strict baseline parser rejects prose and markdown fences', () => {
  assert.deepEqual(strictJsonObject('{"answer":"agents"}'), { answer: 'agents' })
  assert.throws(() => strictJsonObject('The answer is agents'))
  assert.throws(() => strictJsonObject('```json\n{"answer":"agents"}\n```'))
})

test('summary preserves unmeasured safety metrics as null', () => {
  const results: NormalizedVisualResult[] = [
    {
      caseId: 'a', expected: 'homepage', answer: 'homepage', correct: true,
      malformed: false, latencyMs: 100, providerConfidence: 0.9, rawProbability: null,
      model: 'm', backend: 'openai', error: null,
    },
    {
      caseId: 'b', expected: false, answer: null, correct: null,
      malformed: true, latencyMs: 300, providerConfidence: null, rawProbability: null,
      model: 'm', backend: 'openai', error: 'bad json',
    },
  ]
  const summary = summarize(results)
  assert.equal(summary.accuracy, 1)
  assert.equal(summary.malformedRate, 0.5)
  assert.equal(summary.medianLatencyMs, 100)
  assert.equal(summary.p95LatencyMs, 300)
  assert.equal(summary.falsePositiveSuccessRate, null)
  assert.equal(summary.unknownFallbackRate, null)
})

test('percentile uses nearest-rank semantics', () => {
  assert.equal(percentile([30, 10, 20], 0.5), 20)
  assert.equal(percentile([30, 10, 20], 0.95), 30)
  assert.equal(percentile([], 0.5), null)
})
