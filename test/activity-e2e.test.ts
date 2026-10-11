import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createDecisionTool } from '../src/tool.ts'
import { createDiscoveryTool } from '../src/discovery/tool.ts'
import { createVerifyTool } from '../src/verify/tool.ts'
import { ActivityStore, classifyActivity } from '../src/activity/index.ts'
import { createActivityRecorder } from '../src/activity/recorder.ts'
import { toolContext } from './helpers/registry.ts'

/**
 * The registry is only useful if the real tool executions feed it. These tests
 * drive an actual tool against a stubbed transport and assert what the tool
 * itself contributed — no hand-built records.
 */

const SETTINGS = {
  backend: 'custom',
  endpoint: 'http://localhost/v1/systemone',
  model: 'fixture-model',
  timeoutMs: 2000,
}

/**
 * Answers whatever the tool actually asked, keyed by the question ids it built.
 * A fixed answer map would miss the real ids and every candidate would come back
 * unusable for the wrong reason.
 */
function answeringTransport(
  respond: (questionId: string, index: number) => unknown = () => ({
    type: 'score',
    score: 1,
    probabilities: { '0': 0, '1': 1, '2': 0 },
    confidence: 0.9,
  }),
): typeof fetch {
  return async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      questions: Record<string, unknown>
    }
    const answers: Record<string, unknown> = {}
    Object.keys(body.questions).forEach((id, index) => {
      answers[id] = respond(id, index)
    })
    return Response.json({ answers, provider: 'stub' })
  }
}

const failingTransport: typeof fetch = async () =>
  new Response('nope', { status: 500, headers: { 'content-type': 'application/json' } })

/** Answers each question with an answer matching the type the tool declared. */
function typedTransport(): typeof fetch {
  return async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      questions: Record<string, { type: string }>
    }
    const answers: Record<string, unknown> = {}
    for (const [id, question] of Object.entries(body.questions)) {
      if (question.type === 'noul') {
        answers[id] = { type: 'noul', noul: 0.8, confidence: 0.9 }
      } else if (question.type === 'choice') {
        answers[id] = { type: 'choice', choice: 'yes', confidence: 0.9 }
      } else {
        answers[id] = {
          type: 'score',
          score: 1,
          probabilities: { '0': 0, '1': 1, '2': 0 },
          confidence: 0.9,
        }
      }
    }
    return Response.json({ answers, provider: 'stub' })
  }
}

async function fixtureDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'activity-e2e-'))
  await writeFile(join(dir, 'target.ts'), 'export const scoped = true\n')
  return dir
}

test('a discovery call records its usable candidates and the paths it listed', async () => {
  const dir = await fixtureDir()
  try {
    const store = new ActivityStore()
    const recorder = createActivityRecorder(store, () => SETTINGS)
    const tool = createDiscoveryTool(
      'semantic_scan',
      () => SETTINGS,
      answeringTransport(),
      recorder,
    )
    const result = await tool.execute(
      { predicate: 'is it scoped?', candidates: ['target.ts'], root: dir },
      toolContext('s1'),
    )
    assert.equal(result.success, true)
    const [call] = store.callsFor('s1')
    assert.ok(call, 'the tool must record its own call')
    assert.equal(call.tool, 'semantic_scan')
    assert.equal(call.kind, 'discovery')
    assert.equal(call.success, true)
    assert.equal(call.usableCandidates, 1)
    assert.equal(call.semanticApplied, true)
    // The report id the tool already produced, not a synthetic one.
    assert.match(call.reportId, /^discovery:semantic_scan:/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a discovery answer the provider could not rank is recorded as unusable', async () => {
  const dir = await fixtureDir()
  try {
    const store = new ActivityStore()
    const recorder = createActivityRecorder(store, () => SETTINGS)
    const tool = createDiscoveryTool(
      'semantic_scan',
      () => SETTINGS,
      // A flat distribution carries no decisive level, so no candidate is usable.
      answeringTransport(() => ({
        type: 'score',
        score: 1,
        probabilities: { '0': 0.34, '1': 0.33, '2': 0.33 },
        confidence: 0.4,
      })),
      recorder,
    )
    const result = await tool.execute(
      { predicate: 'is it scoped?', candidates: ['target.ts'], root: dir },
      toolContext('s1'),
    )
    assert.equal(result.success, true)
    const verdict = classifyActivity(store.callsFor('s1'))
    assert.equal(verdict.unusableAnswers, 1)
    // The report's own reason survives, which is what makes the count legible.
    const [call] = store.callsFor('s1')
    assert.equal(call.usableCandidates, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failed discovery call is recorded as abandoned, not as an unusable answer', async () => {
  const dir = await fixtureDir()
  try {
    const store = new ActivityStore()
    const recorder = createActivityRecorder(store, () => SETTINGS)
    const tool = createDiscoveryTool(
      'semantic_scan',
      () => SETTINGS,
      failingTransport,
      recorder,
    )
    const result = await tool.execute(
      { predicate: 'is it scoped?', candidates: ['target.ts'], root: dir },
      toolContext('s1'),
    )
    assert.equal(result.success, false)
    const verdict = classifyActivity(store.callsFor('s1'))
    assert.equal(verdict.abandoned, 1)
    assert.equal(verdict.unusableAnswers, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('asking the same question twice marks the first call as proven non-conclusive', async () => {
  const dir = await fixtureDir()
  try {
    const store = new ActivityStore()
    const recorder = createActivityRecorder(store, () => SETTINGS)
    const tool = createDiscoveryTool(
      'semantic_scan',
      () => SETTINGS,
      answeringTransport(),
      recorder,
    )
    const args = { predicate: 'is it scoped?', candidates: ['target.ts'], root: dir }
    await tool.execute(args, toolContext('s1'))
    await tool.execute(args, toolContext('s1'))
    const verdict = classifyActivity(store.callsFor('s1'))
    assert.equal(verdict.repeatedQuestion, 1)
    assert.equal(verdict.repeatedQuestion + verdict.narrowedQuestion, 1)
    assert.equal(verdict.calls[0]!.nonConclusiveProof, 'proven-repeated-question')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('two distinct questions are never reported as a repeat', async () => {
  const dir = await fixtureDir()
  try {
    const store = new ActivityStore()
    const recorder = createActivityRecorder(store, () => SETTINGS)
    const tool = createDiscoveryTool(
      'semantic_scan',
      () => SETTINGS,
      answeringTransport(),
      recorder,
    )
    await tool.execute(
      { predicate: 'is it scoped?', candidates: ['target.ts'], root: dir },
      toolContext('s1'),
    )
    await tool.execute(
      { predicate: 'does it export a default?', candidates: ['target.ts'], root: dir },
      toolContext('s1'),
    )
    const verdict = classifyActivity(store.callsFor('s1'))
    assert.equal(verdict.repeatedQuestion, 0)
    assert.equal(verdict.repeatedQuestion + verdict.narrowedQuestion, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a verify call records the very status its report returned', async () => {
  const store = new ActivityStore()
  const recorder = createActivityRecorder(store, () => SETTINGS)
  // The verify core asks a MIX of question types (noul gates plus score
  // questions), so the stub answers each by its declared type rather than
  // answering everything as a score.
  const tool = createVerifyTool(
    () => SETTINGS,
    { transport: typedTransport() },
    recorder,
  )
  const result = await tool.execute(
    {
      criterionId: 'ac-1',
      criterion: 'The export scopes every record to the tenant.',
      evidence: { summary: 'x', diffExcerpts: ['y'], deterministicTestResults: ['ok'] },
    },
    toolContext('s1'),
  )
  assert.equal(result.success, true)
  const report = JSON.parse(result.output ?? '{}') as {
    status: string
    reportId: string
    reasons: string[]
  }
  const [call] = store.callsFor('s1')
  assert.equal(call?.tool, 'semantic_verify_task')
  assert.equal(call?.kind, 'verify')
  // The recorded status is the report's own, never a re-interpretation: the
  // panel counts outcomes, it does not re-judge them.
  assert.equal(call?.status, report.status)
  assert.equal(call?.reportId, report.reportId)
  assert.equal(classifyActivity(store.callsFor('s1')).totalCalls, 1)
})

test('a non-positive verification status feeds the policy counter', async () => {
  const store = new ActivityStore()
  const recorder = createActivityRecorder(store, () => SETTINGS)
  const tool = createVerifyTool(() => SETTINGS, { transport: typedTransport() }, recorder)
  // Evidence that makes the criterion look off-scope, which is the status an
  // uncalibrated run produces most often.
  await tool.execute(
    {
      criterionId: 'ac-1',
      criterion: 'The release pipeline publishes nightly.',
      evidence: {
        summary: 'a refactor of the button colour',
        diffExcerpts: ['const color = "blue"'],
        deterministicTestResults: ['ok'],
      },
    },
    toolContext('s1'),
  )
  const [call] = store.callsFor('s1')
  assert.ok(call?.status, 'a status must be recorded')
  assert.equal(call?.status, 'off-scope')
  // `off-scope` is a DEFINITE non-positive outcome, not an absence of evidence,
  // so it is counted apart rather than being read as unknown.
  const verdict = classifyActivity(store.callsFor('s1'))
  assert.equal(verdict.policyNeedsWork, 1)
  assert.equal(verdict.policyUnknown, 0)
  assert.equal(verdict.passCandidate, 0)
  // The call itself carried no unusable answer and no repeat, so the call-level
  // bucket is still "no evidence either way" — the policy counters and the
  // call-level bucket measure different things and must not be conflated.
  assert.equal(verdict.unusableAnswers, 0)
  assert.equal(verdict.repeatedQuestion + verdict.narrowedQuestion, 0)
})

test('a decision call is counted without ever recording the state it sent', async () => {
  const store = new ActivityStore()
  const recorder = createActivityRecorder(store, () => SETTINGS)
  const tool = createDecisionTool(() => SETTINGS, answeringTransport(() => ({ type: 'noul', noul: 0.5 })), recorder)
  const result = await tool.execute(
    { state: 'A CONFIDENTIAL STRING', questions: { q: { type: 'noul', instructions: 'a?' } } },
    toolContext('s1'),
  )
  assert.equal(result.success, true)
  const [call] = store.callsFor('s1')
  assert.equal(call?.tool, 'semantic_decide')
  // Neither the transmitted state nor the question text may survive anywhere:
  // `semantic_decide` now contributes a DIGEST of its batch's instructions, so
  // the repeat rule is reachable for it without the wording being kept.
  const serialized = JSON.stringify(call)
  assert.doesNotMatch(serialized, /CONFIDENTIAL/)
  assert.doesNotMatch(serialized, /sky blue/i)
  assert.doesNotMatch(serialized, /noul|instructions/i)
  assert.equal(typeof call?.questionKey, 'string')
})

test('with the switch off, a real tool call leaves the registry empty', async () => {
  const dir = await fixtureDir()
  try {
    const store = new ActivityStore()
    const recorder = createActivityRecorder(store, () => ({ ...SETTINGS, activityPanel: false }))
    const tool = createDiscoveryTool(
      'semantic_scan',
      () => SETTINGS,
      answeringTransport(),
      recorder,
    )
    const result = await tool.execute(
      { predicate: 'is it scoped?', candidates: ['target.ts'], root: dir },
      toolContext('s1'),
    )
    assert.equal(result.success, true, 'the tool still works with the panel off')
    assert.equal(store.callsFor('s1').length, 0, 'nothing is kept, not kept and hidden')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the registry never grows without bound across many calls', async () => {
  const dir = await fixtureDir()
  try {
    const store = new ActivityStore()
    const recorder = createActivityRecorder(store, () => SETTINGS)
    const tool = createDiscoveryTool(
      'semantic_scan',
      () => SETTINGS,
      answeringTransport(),
      recorder,
    )
    for (let index = 0; index < 60; index += 1) {
      await tool.execute(
        { predicate: `question number ${index}`, candidates: ['target.ts'], root: dir },
        toolContext('s1'),
      )
    }
    assert.ok(store.callsFor('s1').length <= 50)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
test('a coverage assessment counts every criterion status', async () => {
  const { createIssueCoverageTool } = await import('../src/verify/coverage.ts')
  const store = new ActivityStore()
  const recorder = createActivityRecorder(store, () => SETTINGS)
  const tool = createIssueCoverageTool(() => SETTINGS, { transport: typedTransport() }, recorder)
  const result = await tool.execute(
    {
      criteria: [
        { id: 'ac-1', text: 'The release pipeline publishes nightly.' },
        { id: 'ac-2', text: 'The export scopes every record to the tenant.' },
      ],
      evidence: {
        summary: 'a refactor of the button colour',
        diffExcerpts: ['const color = "blue"'],
        deterministicTestResults: ['ok'],
      },
    },
    toolContext('s1'),
  )
  assert.equal(result.success, true)
  const report = JSON.parse(result.output ?? '{}') as {
    criteria: Array<{ coverage: string; verificationStatus: string }>
  }
  const [call] = store.callsFor('s1')
  assert.ok(call)
  // Without `statuses`, a coverage call would feed the coverage buckets while
  // its non-positive verification statuses went uncounted.
  assert.deepEqual(
    [...call.statuses].sort(),
    report.criteria.map((c) => c.verificationStatus).sort(),
  )
  const verdict = classifyActivity(store.callsFor('s1'))
  assert.equal(verdict.totalCalls, 1)
  // Gate reasons the policy emitted reach the panel, counted not interpreted.
  assert.ok(verdict.gateReasons.length > 0)
})

test('a decision call reaches the repeat rule through its instruction digest', async () => {
  const store = new ActivityStore()
  const recorder = createActivityRecorder(store, () => SETTINGS)
  const tool = createDecisionTool(() => SETTINGS, answeringTransport(() => ({ type: 'noul', noul: 0.5 })), recorder)
  const args = {
    state: 'the export endpoint scopes every record to the tenant',
    questions: { scoped: { type: 'noul', instructions: 'Does the export scope every record to the tenant?' } },
  }
  await tool.execute(args, toolContext('s1'))
  await tool.execute(args, toolContext('s1'))
  const verdict = classifyActivity(store.callsFor('s1'))
  // The wording is only ever a digest, and that is enough to see the repeat.
  assert.equal(verdict.repeatedQuestion, 1)
  assert.equal(verdict.repeatedQuestion + verdict.narrowedQuestion, 1)
  assert.doesNotMatch(JSON.stringify(store.callsFor('s1')), /scopes every record/)
})

test('a decision call over what a discovery call covered is reachable end to end', async () => {
  const dir = await fixtureDir()
  try {
    const store = new ActivityStore()
    const recorder = createActivityRecorder(store, () => SETTINGS)
    const discovery = createDiscoveryTool(
      'semantic_scan',
      () => SETTINGS,
      answeringTransport(),
      recorder,
    )
    await discovery.execute(
      { predicate: 'tenant scoped export', candidates: ['target.ts'], root: dir },
      toolContext('s1'),
    )
    const decide = createDecisionTool(
      () => SETTINGS,
      answeringTransport(() => ({ type: 'noul', noul: 0.5 })),
      recorder,
    )
    await decide.execute(
      {
        state: 'target.ts',
        questions: { q: { type: 'noul', instructions: 'tenant scoped export' } },
      },
      toolContext('s1'),
    )
    const verdict = classifyActivity(store.callsFor('s1'))
    // Reachable in production, not only in hand-built unit calls.
    assert.equal(verdict.heuristicNonConclusive, 1)
    assert.equal(verdict.calls[0]!.nonConclusiveProof, 'heuristic-same-subject')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
