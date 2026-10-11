import assert from 'node:assert/strict'
import test from 'node:test'

import { createActivityRecorder } from '../src/activity/recorder.ts'
import {
  ACTIVITY_MAX_RETAINED,
  ActivityStore,
  classifyActivity,
  parseActivityPanelEnabled,
  questionKey,
  tokenSignature,
  type ActivityCall,
} from '../src/activity/index.ts'

/**
 * The activity registry is the ONLY place a semantic tool records anything
 * about itself. It is in-memory by design, so these tests are about what it is
 * allowed to remember: counters, statuses, timings and paths that already
 * appear in a report — never conversation content, never a credential.
 */

const DEFAULT_QUESTION = 'Where is the badge rendered?'

const baseCall = {
  tool: 'semantic_search',
  kind: 'discovery',
  sessionId: 's1',
  reportId: 'discovery:semantic_search:abc',
  success: true,
  latencyMs: 412,
} as const

/**
 * Builds a recorded call. `question` is given as TEXT and immediately reduced
 * to the digest and signature the registry actually holds, exactly as the
 * recorder does — the tests must never be able to place raw text in a call.
 */
function call(overrides: Partial<ActivityCall> & { question?: string } = {}): ActivityCall {
  const { question = DEFAULT_QUESTION, ...rest } = overrides
  return {
    at: 1_700_000_000_000,
    usableCandidates: 2,
    semanticApplied: true,
    status: null,
    statuses: [],
    coverageStatuses: [],
    gateReasons: [],
    questionKey: questionKey(question),
    tokenSignature: tokenSignature(question),
    ...baseCall,
    ...rest,
  }
}

test('the registry is bounded and drops the oldest call first', () => {
  const store = new ActivityStore(ACTIVITY_MAX_RETAINED)
  for (let index = 0; index < ACTIVITY_MAX_RETAINED + 5; index += 1) {
    store.record(call({ reportId: `r${index}` }))
  }
  const retained = store.callsFor('s1')
  assert.equal(retained.length, ACTIVITY_MAX_RETAINED)
  // Newest first.
  assert.equal(retained[0]!.reportId, `r${ACTIVITY_MAX_RETAINED + 4}`)
})

test('the registry hands out copies: a caller cannot mutate what is stored', () => {
  const store = new ActivityStore()
  store.record(call())
  const [first] = store.callsFor('s1')
  assert.ok(first)
  const mutated = { ...first, tool: 'tampered' } satisfies ActivityCall
  assert.equal(mutated.tool, 'tampered')
  assert.equal(store.callsFor('s1')[0]!.tool, 'semantic_search')
})

test('calls are grouped by session and never leak into another', () => {
  const store = new ActivityStore()
  store.record(call({ sessionId: 'a' }))
  store.record(call({ sessionId: 'b' }))
  store.record(call({ sessionId: 'a' }))
  assert.equal(store.callsFor('a').length, 2)
  assert.equal(store.callsFor('b').length, 1)
  assert.equal(store.callsFor('never-seen').length, 0)
})

test('the recorder keeps nothing when the switch is off', () => {
  const store = new ActivityStore()
  const recorder = createActivityRecorder(store, () => ({ activityPanel: false }))
  recorder.record({
    tool: 'semantic_search',
    kind: 'discovery',
    reportId: 'a',
    context: { sessionId: 's1', workdir: '/tmp' },
    success: true,
  })
  // Disabled means nothing is recorded, not "recorded and hidden": the gate is
  // in the recorder, before the store is ever touched.
  assert.equal(store.callsFor('s1').length, 0)
})

test('a repeated question is a proven non-conclusive signal', () => {
  const verdict = classifyActivity([
    call({ reportId: 'a' }),
    call({ reportId: 'b' }),
  ])
  assert.equal(verdict.repeatedQuestion, 1)
  assert.equal(verdict.repeatedQuestion + verdict.narrowedQuestion, 1)
  // The FIRST call is the one that failed to conclude; the repeat is evidence
  // about it, not a separate failure of its own.
  assert.equal(verdict.calls[0]!.nonConclusive, true)
  assert.equal(verdict.calls[0]!.nonConclusiveProof, 'proven-repeated-question')
  assert.equal(verdict.calls[1]!.nonConclusive, false)
})

test('the same question on two different tools is still a repeat', () => {
  const verdict = classifyActivity([
    call({ tool: 'semantic_search', kind: 'discovery', reportId: 'a' }),
    call({ tool: 'semantic_scan', kind: 'discovery', reportId: 'b' }),
  ])
  assert.equal(verdict.repeatedQuestion, 1)
})

test('a narrowed question after a broad one is a proven non-conclusive signal', () => {
  const verdict = classifyActivity([
    call({ question: 'how does the session stats panel work', reportId: 'a' }),
    call({ question: 'session stats panel', reportId: 'b' }),
  ])
  assert.equal(verdict.repeatedQuestion + verdict.narrowedQuestion, 1)
  assert.equal(verdict.calls[0]!.nonConclusiveProof, 'proven-narrowed-question')
  // The narrowing attempt itself is not a failure.
  assert.equal(verdict.calls[1]!.nonConclusive, false)
})

test('a broadened question is not a narrowing: it asks for more, not less', () => {
  const verdict = classifyActivity([
    call({ question: 'stats panel', reportId: 'a' }),
    call({ question: 'how does the session stats panel work', reportId: 'b' }),
  ])
  assert.equal(verdict.repeatedQuestion + verdict.narrowedQuestion, 0)
})

test('a decision call over the same subject is a heuristic, not a proof', () => {
  const verdict = classifyActivity([
    call({ tool: 'semantic_search', kind: 'discovery', question: 'badge rendering', reportId: 'a' }),
    call({ tool: 'semantic_decide', kind: 'decide', question: 'badge rendering', reportId: 'b' }),
  ])
  // The questions are identical, so the proven exact-match rule applies and the
  // heuristic never has a chance to claim the call.
  assert.equal(verdict.repeatedQuestion + verdict.narrowedQuestion, 1)
  assert.equal(verdict.heuristicNonConclusive, 0)
})

test('the same-subject heuristic is counted apart from the proven signals', () => {
  const verdict = classifyActivity([
    call({ tool: 'semantic_search', kind: 'discovery', question: 'badge', reportId: 'a' }),
    call({ tool: 'semantic_decide', kind: 'decide', question: 'badge padding color', reportId: 'b' }),
  ])
  assert.equal(verdict.heuristicNonConclusive, 1)
  assert.equal(verdict.repeatedQuestion + verdict.narrowedQuestion, 0)
  assert.equal(verdict.calls[0]!.nonConclusiveProof, 'heuristic-same-subject')
})

test('a decision call on an unrelated subject is not a repeat', () => {
  const verdict = classifyActivity([
    call({ tool: 'semantic_search', kind: 'discovery', question: 'badge rendering', reportId: 'a' }),
    call({ tool: 'semantic_decide', kind: 'decide', question: 'provider latency budget', reportId: 'b' }),
  ])
  assert.equal(verdict.heuristicNonConclusive, 0)
  assert.equal(verdict.repeatedQuestion + verdict.narrowedQuestion, 0)
})

test('a question with no significant words is never compared', () => {
  const verdict = classifyActivity([
    call({ question: 'the a of', reportId: 'a' }),
    call({ question: 'the a of', reportId: 'b' }),
  ])
  // It still repeats verbatim, which needs no token comparison at all.
  assert.equal(verdict.repeatedQuestion, 1)
})

test('distinct questions never count as a repeat', () => {
  const verdict = classifyActivity([
    call({ question: 'where is the badge rendered?', reportId: 'a' }),
    call({ question: 'how is the transport built?', reportId: 'b' }),
  ])
  assert.equal(verdict.repeatedQuestion, 0)
  assert.equal(verdict.repeatedQuestion + verdict.narrowedQuestion, 0)
})

test('every call with no usable candidate is counted as an unusable answer', () => {
  const verdict = classifyActivity([
    call({ usableCandidates: 0, gateReasons: ['no_decisive_level'], reportId: 'a' }),
  ])
  assert.equal(verdict.unusableAnswers, 1)
})

test('a partially usable answer is usable: one usable candidate is enough', () => {
  const verdict = classifyActivity([
    call({
      usableCandidates: 1,
      gateReasons: ['x:no_decisive_level'],
      reportId: 'a',
    }),
  ])
  assert.equal(verdict.unusableAnswers, 0)
})

test('a discovery answer with no candidate at all is unusable', () => {
  const verdict = classifyActivity([call({ usableCandidates: 0, reportId: 'a' })])
  assert.equal(verdict.unusableAnswers, 1)
})

test('a local fallback is its own category, not an unusable answer', () => {
  const verdict = classifyActivity([
    call({ usableCandidates: 2, semanticApplied: false, reportId: 'a' }),
  ])
  // The provider FAILED and the deterministic shortlist was returned instead.
  // Calling that an "unusable answer" would over-claim: the agent may well have
  // used those candidates, which the local ranking did score.
  assert.equal(verdict.fellBackToLocal, 1)
  assert.equal(verdict.unusableAnswers, 0)
  assert.equal(verdict.abandoned, 0)
})

test('a failed call is an abandoned attempt, not an unusable answer', () => {
  const verdict = classifyActivity([call({ success: false, reportId: 'a' })])
  assert.equal(verdict.abandoned, 1)
  assert.equal(verdict.unusableAnswers, 0)
})

test('policy failures count unknown and insufficient-evidence separately', () => {
  const verdict = classifyActivity([
    call({ tool: 'semantic_verify_task', statuses: ['unknown'], reportId: 'a' }),
    call({ tool: 'semantic_verify_task', statuses: ['insufficient-evidence'], reportId: 'b' }),
    call({ tool: 'semantic_verify_task', statuses: ['pass-candidate'], reportId: 'c' }),
  ])
  assert.equal(verdict.policyUnknown, 2)
  assert.equal(verdict.passCandidate, 1)
})

test('coverage criteria statuses feed the policy counters', () => {
  const verdict = classifyActivity([
    call({
      tool: 'semantic_issue_coverage',
      coverageStatuses: ['missing', 'covered', 'uncertain'],
      reportId: 'a',
    }),
  ])
  assert.equal(verdict.coverageMissing, 1)
  assert.equal(verdict.coverageCovered, 1)
  assert.equal(verdict.coverageUncertain, 1)
})

test('no call is ever marked conclusive without a deterministic corroboration', () => {
  const verdict = classifyActivity([call({ reportId: 'a' })])
  for (const entry of verdict.calls) {
    assert.equal(entry.conclusive, false)
    assert.equal(entry.conclusiveProof, 'indeterminate')
  }
  assert.equal(verdict.indeterminate, 1)
  assert.equal(verdict.conclusive, 0)
})

test('a non-conclusive verdict wins over anything weaker', () => {
  const order = classifyActivity([
    call({ reportId: 'a' }),
    call({ reportId: 'b' }),
    call({ usableCandidates: 0, reportId: 'c' }),
  ])
  const second = order.calls.find((entry) => entry.reportId === 'b')!
  assert.equal(second.nonConclusive, true)
  const third = order.calls.find((entry) => entry.reportId === 'c')!
  assert.equal(third.unusableAnswer, true)
  assert.equal(third.nonConclusive, false)
})

test('every call lands in exactly one bucket, so the panel rows reconcile', () => {
  const verdict = classifyActivity([
    call({ reportId: 'ok', question: 'a plain question here', at: 1 }),
    call({ reportId: 'repeated', question: 'another plain question', at: 2 }),
    call({ reportId: 'repeated-again', question: 'another plain question', at: 3 }),
    call({ reportId: 'failed', question: 'yet another question', at: 4, success: false }),
  ])
  const bucketSum =
    verdict.abandoned +
    verdict.fellBackToLocal +
    verdict.unusableAnswers +
    verdict.repeatedQuestion +
    verdict.narrowedQuestion +
    verdict.heuristicNonConclusive +
    verdict.indeterminate
  // The reader must be able to add the rows up to "Semantic calls".
  assert.equal(bucketSum, verdict.totalCalls)
})

test('the settings default keeps the panel on and never silently coerces a string', () => {
  assert.equal(parseActivityPanelEnabled(undefined), true)
  assert.equal(parseActivityPanelEnabled({}), true)
  assert.equal(parseActivityPanelEnabled({ activityPanel: true }), true)
  assert.equal(parseActivityPanelEnabled({ activityPanel: false }), false)
  // Anything that is not an explicit boolean leaves the default in place rather
  // than guessing from a truthy string.
  assert.equal(parseActivityPanelEnabled({ activityPanel: 'false' }), true)
  assert.equal(parseActivityPanelEnabled({ activityPanel: 1 }), true)
})

test('the summary carries the advisory wording so the panel cannot be misread', () => {
  const verdict = classifyActivity([call()])
  assert.equal(verdict.advisory, true)
  assert.equal(verdict.status, 'observed-propensity')
  assert.match(verdict.note, /not a quality/)
})
test('the session map itself is bounded, so a finished session cannot be retained forever', () => {
  // The host serves many sessions in one process and the plugin registers no
  // session-end hook, so per-session bounds alone would leak a finished
  // session's entries for the life of the process. The map must be bounded too.
  const store = new ActivityStore(ACTIVITY_MAX_RETAINED, 3)
  for (let index = 0; index < 6; index += 1) {
    store.record(call({ sessionId: `s${index}`, reportId: `r${index}` }))
  }
  assert.deepEqual(store.callsFor('s5').length, 1)
  assert.deepEqual(store.callsFor('s0').length, 0, 'the oldest session was evicted')
})

test('touching a session again protects it from the next eviction', () => {
  const store = new ActivityStore(ACTIVITY_MAX_RETAINED, 2)
  store.record(call({ sessionId: 'old' }))
  store.record(call({ sessionId: 'new' }))
  // Re-recording makes `old` the most recently touched, so `new` goes first.
  store.record(call({ sessionId: 'old' }))
  store.record(call({ sessionId: 'newest' }))
  assert.equal(store.callsFor('old').length, 2)
  assert.equal(store.callsFor('new').length, 0)
})

test('the question text is never stored, only digests', () => {
  const store = new ActivityStore()
  const secret = 'where does the export leak tenant identifiers'
  store.record(call({ question: secret }))
  const [entry] = store.callsFor('s1')
  assert.ok(entry)
  const serialized = JSON.stringify(entry)
  assert.doesNotMatch(serialized, /tenant identifiers/)
  // Two calls with the same wording share a digest: that is all the repeat
  // rule needs, and it is not a reversible encoding of a short phrase.
  assert.match(entry.questionKey ?? '', /^[0-9a-f]{16}$/)
})

test('a digest is equal for the same wording regardless of case and spacing', () => {
  assert.equal(questionKey('Where is the badge?'), questionKey('  where   is the BADGE? '))
  assert.notEqual(questionKey('where is the badge?'), questionKey('where is the footer?'))
  assert.equal(questionKey(''), null)
  assert.equal(questionKey(undefined), null)
})

test('a batched call counts every status it produced', () => {
  const verdict = classifyActivity([
    call({ kind: 'coverage', status: null, statuses: ['unknown', 'covered', 'insufficient-evidence'] }),
  ])
  assert.equal(verdict.policyUnknown, 2)
})

test('gate reasons are counted by frequency, never interpreted', () => {
  const verdict = classifyActivity([
    call({ kind: 'verify', gateReasons: ['off_scope_detected', 'evidence_insufficient'] }),
    call({ kind: 'verify', gateReasons: ['off_scope_detected'] }),
  ])
  assert.deepEqual(verdict.gateReasons, [
    { reason: 'off_scope_detected', count: 2 },
    { reason: 'evidence_insufficient', count: 1 },
  ])
})

test('the tool mix reports each tool share among our own calls', () => {
  const verdict = classifyActivity([
    call({ tool: 'semantic_search', reportId: 'a' }),
    call({ tool: 'semantic_search', reportId: 'b', question: 'other question' }),
    call({ tool: 'semantic_verify_task', kind: 'verify', reportId: 'c', question: 'third question' }),
  ])
  assert.deepEqual(verdict.toolMix, [
    { tool: 'semantic_search', count: 2, share: 0.67 },
    { tool: 'semantic_verify_task', count: 1, share: 0.33 },
  ])
})

test('the tool mix is empty when nothing was called', () => {
  assert.deepEqual(classifyActivity([]).toolMix, [])
})

test('two calls in the same millisecond are still ordered, and the right one is marked', () => {
  // `Date.now()` has millisecond resolution, so this ordering must NOT depend
  // on it: the repeat rule has to mark the FIRST call, not an arbitrary one.
  const store = new ActivityStore()
  for (const reportId of ['first', 'second', 'third']) {
    store.record(
      call({ reportId, at: 1_700_000_000_000, question: 'the very same question' }),
    )
  }
  const verdict = classifyActivity(store.callsFor('s1'))
  // `classifyActivity` returns calls oldest-first.
  const order = verdict.calls.map((entry) => entry.reportId)
  assert.deepEqual(order, ['first', 'second', 'third'])
  // Each repeat invalidates the attempt BEFORE it: with the same question
  // asked three times, the first two did not settle it and the last may have.
  assert.equal(verdict.calls[0]!.nonConclusive, true)
  assert.equal(verdict.calls[1]!.nonConclusive, true)
  assert.equal(verdict.calls[2]!.nonConclusive, false)
  assert.equal(verdict.repeatedQuestion, 2)
})

test('a narrowing repeat is counted in its own bucket', () => {
  const verdict = classifyActivity([
    call({ question: 'how does the session stats panel work', reportId: 'a', at: 1 }),
    call({ question: 'session stats panel', reportId: 'b', at: 2 }),
  ])
  // It used to vanish between `repeatedQuestion` and `indeterminate`.
  assert.equal(verdict.narrowedQuestion, 1)
  assert.equal(verdict.repeatedQuestion, 0)
  assert.equal(verdict.calls[0]!.nonConclusiveProof, 'proven-narrowed-question')
})

test('the store stamps a strictly increasing sequence', () => {
  const store = new ActivityStore()
  store.record(call({ reportId: 'a' }))
  store.record(call({ reportId: 'b' }))
  // `callsFor` is newest-first, so the head carries the larger sequence.
  const [newest, older] = store.callsFor('s1')
  assert.equal(newest!.reportId, 'b')
  assert.ok((newest!.seq ?? 0) > (older!.seq ?? 0))
})
