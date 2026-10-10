import assert from 'node:assert/strict'
import test from 'node:test'

import { adaptRequestForPreset } from '../src/presets/adapt.ts'
import { PRESETS, capabilityOf } from '../src/presets/index.ts'
import { SystemOneHttpProvider } from '../src/providers/system-one.ts'
import type { DecisionRequest } from '../src/decision/types.ts'

/**
 * The presets that actually record the observed array-criteria deviation.
 *
 * The test follows the declaration rather than hard-coding an id: a capability
 * is promoted from a real conformance run, so the set of declaring presets is
 * data. `kev` is deliberately NOT asserted here — its recorded run is
 * incomplete (a second deviation: it accepted a malformed wire payload), so
 * the project keeps it `unverified` and it must never rewrite a request.
 */
const DECLARING_PRESETS = PRESETS.filter((p) => p.capabilities.choiceArrayCriteria === false).map(
  (p) => p.id,
)

const request: DecisionRequest = {
  state: 'public synthetic state',
  questions: {
    noul: { type: 'noul', instructions: 'Is it fine?' },
    arrayChoice: { type: 'choice', instructions: 'Pick one', criteria: ['pass', 'fail'] },
    objectChoice: { type: 'choice', instructions: 'Pick one', criteria: { pass: 'Passes', fail: 'Fails' } },
    score: { type: 'score', instructions: 'Rate it', criteria: ['none', 'some', 'full'] },
  },
}

// --- The rewrite itself. ---

test('a preset that observed no array-criteria incompatibility sends the request verbatim', () => {
  // The label set and the criteria FORM both matter: an object-map question
  // must reach a runtime that serves object maps in that exact form.
  for (const presetId of ['custom', 'laya', 'not-a-preset', undefined]) {
    assert.deepEqual(adaptRequestForPreset(request, presetId), request, String(presetId))
  }
})

test('a declared array-criteria incompatibility rewrites only choice array criteria', () => {
  const adapted = adaptRequestForPreset(request, DECLARING_PRESETS[0])
  assert.ok(DECLARING_PRESETS.length > 0, 'no preset records the observed deviation')
  // The object-map question keeps its descriptions verbatim.
  assert.deepEqual(adapted.questions.objectChoice, request.questions.objectChoice)
  // noul carries no criteria and is untouched.
  assert.deepEqual(adapted.questions.noul, request.questions.noul)
  // Score criteria stay an ordered array: the rubric order carries meaning and
  // the common contract requires the ordered form there.
  const score = adapted.questions.score!
  assert.ok(score.type === 'score' && Array.isArray(score.criteria))
  // The array choice became the equivalent identity object map.
  assert.deepEqual(adapted.questions.arrayChoice, {
    type: 'choice',
    instructions: 'Pick one',
    criteria: { pass: 'pass', fail: 'fail' },
  })
})

test('the rewrite preserves the label set and the order, so the answer is unchanged', () => {
  const labels = (criteria: unknown): string[] =>
    Array.isArray(criteria) ? criteria : Object.keys(criteria as Record<string, string>)
  for (const presetId of DECLARING_PRESETS) {
    for (const id of Object.keys(request.questions)) {
      const question = request.questions[id]
      if (question.type !== 'choice') continue
      const adapted = adaptRequestForPreset(request, presetId).questions[id]
      if (adapted.type !== 'choice') continue
      assert.deepEqual(labels(adapted.criteria), labels(question.criteria), `${presetId}/${id}`)
    }
  }
})

test('the input request is never mutated', () => {
  const before = JSON.parse(JSON.stringify(request))
  adaptRequestForPreset(request, DECLARING_PRESETS[0])
  assert.deepEqual(JSON.parse(JSON.stringify(request)), before)
})

test('a request with no array choice criteria is returned unchanged', () => {
  // Object identity: the caller must not receive a different object for nothing.
  const onlyObjects: DecisionRequest = {
    state: 'x',
    questions: { c: { type: 'choice', instructions: 'Pick', criteria: { a: 'A', b: 'B' } } },
  }
  assert.equal(adaptRequestForPreset(onlyObjects, DECLARING_PRESETS[0]), onlyObjects)
})

test('an unverified capability never rewrites a request', () => {
  // Absence of evidence is never evidence of absence: only an explicit `false`
  // is a declaration, so only an explicit `false` may change the wire format.
  for (const presetId of ['custom', 'system-one', 'sys1', 'lichen', 'edgejev', 'not-a-preset']) {
    assert.equal(capabilityOf(presetId, 'choiceArrayCriteria'), 'unverified', presetId)
    assert.deepEqual(adaptRequestForPreset(request, presetId), request, presetId)
  }
})

// --- End to end: the rewrite is what reaches the wire. ---

test('the wire request is rewritten for a declared deviation, and unchanged otherwise', async () => {
  const seen: Array<Record<string, any>> = []
  const transport: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, any>
    seen.push(body)
    return Response.json({
      answers: {
        noul: { type: 'noul', noul: 0.9 },
        // Keys stay the labels, so the normalized answer is identical either way.
        arrayChoice: { type: 'choice', choice: 'pass', probabilities: { pass: 0.6, fail: 0.4 } },
        objectChoice: { type: 'choice', choice: 'pass', probabilities: { pass: 0.6, fail: 0.4 } },
        score: { type: 'score', score: 2, probabilities: { '0': 0, '1': 0, '2': 1 } },
      },
    })
  }
  const answer = async (backend: string) => {
    const provider = new SystemOneHttpProvider(
      { endpoint: 'http://127.0.0.1:1/v1/systemone', timeoutMs: 1000, presetId: backend },
      transport,
    )
    return provider.decide(request)
  }

  const custom = await answer('custom')
  assert.ok(Array.isArray(seen[0].questions.arrayChoice.criteria), 'custom must not rewrite the request')

  const declaring = await answer(DECLARING_PRESETS[0])
  assert.deepEqual(seen[1].questions.arrayChoice.criteria, { pass: 'pass', fail: 'fail' })
  // The answer is identical: the rewrite changed the request form, not the meaning.
  assert.deepEqual(declaring.answers.arrayChoice, custom.answers.arrayChoice)
})

test('a preset whose run is incomplete never rewrites a request', () => {
  // `kev` recorded an array-criteria deviation, but that same run also saw it
  // ACCEPT a malformed wire payload. An incomplete run is not a clean
  // observation, so the preset stays `unverified` and the request is verbatim.
  assert.equal(capabilityOf('kev', 'choiceArrayCriteria'), 'unverified')
  assert.deepEqual(adaptRequestForPreset(request, 'kev'), request)
})
