import assert from 'node:assert/strict'
import test from 'node:test'

import { register, SETTINGS } from '../src/index.ts'
import {
  buildActivitySection,
  ACTIVITY_ACTION_ID,
  ACTIVITY_ACTION_SLOT,
  ACTIVITY_PANEL_ID,
  ACTIVITY_RPC_METHOD,
  createActivityAction,
  createActivityPanel,
  createActivityRpc,
} from '../src/activity/panel.ts'
import {
  ActivityStore,
  classifyActivity,
  questionKey,
  tokenSignature,
  type ActivityCall,
} from '../src/activity/index.ts'
import { createActivityRecorder, NULL_ACTIVITY_RECORDER } from '../src/activity/recorder.ts'
import { fakeRegistry, toolContext } from './helpers/registry.ts'

/**
 * The Stats section is the only user-facing part of the activity feature, so
 * these tests pin what it is allowed to say. The hazard is not that it crashes:
 * it is that it renders an absence of evidence as a negative judgement, or that
 * it keeps data an operator switched off.
 */

const DEFAULT_QUESTION = 'where is the badge rendered'

/**
 * Builds a recorded call from TEXT, reducing the question to the digests the
 * registry holds exactly as the recorder does.
 */
function stored(overrides: Partial<ActivityCall> & { question?: string } = {}): ActivityCall {
  const { question = DEFAULT_QUESTION, ...rest } = overrides
  return {
    reportId: 'discovery:semantic_search:a',
    tool: 'semantic_search',
    kind: 'discovery',
    sessionId: 's1',
    at: 1_700_000_000_000,
    success: true,
    latencyMs: 412,
    usableCandidates: 1,
    semanticApplied: true,
    status: null,
    statuses: [],
    coverageStatuses: [],
    gateReasons: [],
    questionKey: questionKey(question),
    tokenSignature: tokenSignature(question),
    ...rest,
  }
}

/**
 * Flattens the declarative tree into the text and values it would render.
 *
 * It must know every node type the section actually emits, otherwise a row
 * silently vanishes from the string and a test asserts against nothing.
 */
function render(node: unknown): string {
  if (Array.isArray(node)) return node.map(render).filter(Boolean).join('\n')
  if (node === null || typeof node !== 'object') return ''
  const typed = node as Record<string, unknown>
  switch (typed.type) {
    case 'text':
      return (typed.text as { en: string }).en
    case 'keyValue':
      return (typed.items as Array<{ key: { en: string }; value: string }>)
        .map((item) => `${item.key.en}: ${item.value}`)
        .join('\n')
    case 'table':
      return (typed.rows as string[][]).map((row) => row.join(': ')).join('\n')
    case 'card':
    case 'stack':
    case 'details': {
      const body = render(typed.children)
      const title = typed.title as { en: string } | undefined
      return title ? `${title.en}\n${body}`.trim() : body
    }
    default:
      return ''
  }
}

test('the header action opens this plugin own panel', () => {
  const action = createActivityAction()
  assert.equal(action.id, ACTIVITY_ACTION_ID)
  // The one slot the client provably renders for a session, and the mechanism
  // the sibling observability plugin uses.
  assert.equal(action.slot, ACTIVITY_ACTION_SLOT)
  assert.equal(action.visibleWhen?.hasSession, true)
  assert.deepEqual(action.onActivate, { kind: 'openPanel', panelId: ACTIVITY_PANEL_ID })
})

test('the panel is declarative, with a placeholder shown before the RPC resolves', () => {
  const panel = createActivityPanel()
  assert.equal(panel.id, ACTIVITY_PANEL_ID)
  assert.equal(panel.kind, 'declarative')
  assert.ok(panel.content?.length, 'a static placeholder must be declared')
  assert.match(render(panel.content![0]), /Loading/)
})

test('an empty session explains itself instead of showing an empty panel', async () => {
  const store = new ActivityStore()
  const rpc = createActivityRpc(store, () => ({}))
  const result = (await rpc({}, toolContext('s1'))) as { content: unknown[] }
  const rendered = render(result.content)
  // Silence would read as a broken panel, so the empty case says what it means.
  assert.match(rendered, /No semantic tool was called/)
})

test('the panel is scoped to the session on screen', async () => {
  const store = new ActivityStore()
  store.record(stored({ sessionId: 'other', reportId: 'a' }))
  const rpc = createActivityRpc(store, () => ({}))
  const shown = (await rpc({}, toolContext('s1'))) as { content: unknown[] }
  // Only the session being displayed counts, never another session's calls.
  assert.match(render(shown.content), /No semantic tool was called/)
})

test('the section reports counts, timings and the unusable-answer rate', async () => {
  const store = new ActivityStore()
  store.record(stored())
  const rpc = createActivityRpc(store, () => ({}))
  const rendered = render(((await rpc({}, toolContext('s1'))) as { content: unknown[] }).content)
  assert.match(rendered, /1 call, nothing failed/)
  assert.match(rendered, /Provider time: 412 ms/)
})

test('a call with no evidence is labelled indeterminate, never useless', async () => {
  const store = new ActivityStore()
  store.record(stored())
  const rpc = createActivityRpc(store, () => ({}))
  const rendered = render(((await rpc({}, toolContext('s1'))) as { content: unknown[] }).content)
  assert.match(rendered, /No verdict either way: 1/)
  // The LABEL must not judge; the collapsed doctrine legitimately says the word
  // when explaining that a non-answer is never counted as useless.
  const labels = rendered.split('\n').filter((line) => line.includes(':'))
  assert.doesNotMatch(labels.join('\n'), /useless|pointless|ineffective/i)
})

test('a repeated question is reported as a proven non-conclusive signal', async () => {
  const store = new ActivityStore()
  store.record(stored({ reportId: 'a', at: 1 }))
  store.record(stored({ reportId: 'b', at: 2 }))
  const rpc = createActivityRpc(store, () => ({}))
  const rendered = render(((await rpc({}, toolContext('s1'))) as { content: unknown[] }).content)
  assert.match(rendered, /Asked again identically/)
})

test('the same-subject heuristic is shown as unproven, apart from the proven count', async () => {
  const store = new ActivityStore()
  store.record(stored({ reportId: 'a', question: 'badge', at: 1 }))
  store.record(
    stored({
      reportId: 'b',
      tool: 'semantic_decide',
      kind: 'decide',
      question: 'badge padding color',
      at: 2,
    }),
  )
  const rpc = createActivityRpc(store, () => ({}))
  const rendered = render(((await rpc({}, toolContext('s1'))) as { content: unknown[] }).content)
  assert.match(rendered, /Looks like the same subject/)
  assert.doesNotMatch(rendered, /re-asked/)
})

test('the share is never displayed when the host count is unknown', async () => {
  const store = new ActivityStore()
  store.record(stored())
  const rpc = createActivityRpc(store, () => ({}))
  const rendered = render(((await rpc({}, toolContext('s1'))) as { content: unknown[] }).content)
  // 2.0.161 exposes no per-session tool-call count to a plugin, so an invented
  // share would be a fabrication.
  assert.doesNotMatch(rendered, /Share of tool calls/)
})

test('the section carries the advisory wording', async () => {
  const store = new ActivityStore()
  store.record(stored())
  const rpc = createActivityRpc(store, () => ({}))
  const rendered = render(((await rpc({}, toolContext('s1'))) as { content: unknown[] }).content)
  assert.match(rendered, /does not claim the semantic path is better/)
})

test('a session with no recorded call never sees another session data', async () => {
  const store = new ActivityStore()
  store.record(stored({ sessionId: 'other' }))
  const rpc = createActivityRpc(store, () => ({}))
  const rendered = render(((await rpc({}, toolContext('s1'))) as { content: unknown[] }).content)
  assert.doesNotMatch(rendered, /Semantic calls/)
})

test('the switch hides the section when the panel is off', async () => {
  const store = new ActivityStore()
  store.record(stored())
  const rpc = createActivityRpc(store, () => ({ activityPanel: false }))
  const result = (await rpc({}, toolContext('s1'))) as { content: unknown[] }
  // Off means nothing is recorded, so there is nothing to show either.
  assert.deepEqual(result.content, [])
})

test('a settings read that throws leaves the default in place rather than failing', async () => {
  const store = new ActivityStore()
  store.record(stored())
  const rpc = createActivityRpc(store, () => {
    throw new Error('secret-bearing settings failure')
  })
  const rendered = render(((await rpc({}, toolContext('s1'))) as { content: unknown[] }).content)
  assert.match(rendered, /1 call, nothing failed/)
})

test('the recorder stores nothing when the switch is off', async () => {
  const store = new ActivityStore()
  const recorder = createActivityRecorder(store, () => ({ activityPanel: false }))
  recorder.record({
    tool: 'semantic_search',
    kind: 'discovery',
    reportId: 'a',
    context: toolContext('s1'),
    question: 'q',
    success: true,
  })
  assert.equal(store.callsFor('s1').length, 0)
})

test('the recorder stores nothing when reading settings throws', async () => {
  const store = new ActivityStore()
  const recorder = createActivityRecorder(store, () => {
    throw new Error('secret-bearing settings failure')
  })
  recorder.record({
    tool: 'semantic_search',
    kind: 'discovery',
    reportId: 'a',
    context: toolContext('s1'),
    question: 'q',
    success: true,
  })
  assert.equal(store.callsFor('s1').length, 0)
})

test('a recorded call carries no conversation content, endpoint or credential', async () => {
  const store = new ActivityStore()
  const recorder = createActivityRecorder(store, () => ({
    endpoint: 'https://secret-host.example/v1/systemone',
    apiKey: 'sk-super-secret',
  }))
  recorder.record({
    tool: 'semantic_decide',
    kind: 'decide',
    reportId: 'decide:1',
    context: toolContext('s1'),
    success: true,
    latencyMs: 10,
  })
  const [call] = store.callsFor('s1')
  assert.ok(call)
  const serialized = JSON.stringify(call)
  assert.doesNotMatch(serialized, /secret-host|sk-super-secret/)
  // The recorded keys are exactly the bounded, non-sensitive ones.
  assert.deepEqual(Object.keys(call).sort(), [
    'at',
    'coverageStatuses',
    'gateReasons',
    'kind',
    'latencyMs',
    'questionKey',
    'reportId',
    'semanticApplied',
    'seq',
    'sessionId',
    'status',
    'statuses',
    'success',
    'tokenSignature',
    'tool',
    'usableCandidates',
  ])
})

test('the null recorder is a real no-op', () => {
  const store = new ActivityStore()
  NULL_ACTIVITY_RECORDER.record({
    tool: 'semantic_decide',
    kind: 'decide',
    reportId: 'a',
    context: toolContext('s1'),
    success: true,
  })
  assert.equal(store.callsFor('s1').length, 0)
})

test('the plugin registers the action, the panel, the RPC and the switch', () => {
  const { registry, components, actions, panels, rpcs } = fakeRegistry()
  register(registry)
  assert.equal(components.length, 0, 'no component is mounted into a host zone')
  assert.equal(actions.length, 1)
  assert.equal(actions[0]!.id, ACTIVITY_ACTION_ID)
  assert.equal(panels.length, 1)
  assert.equal(panels[0]!.id, ACTIVITY_PANEL_ID)
  assert.ok(rpcs.has(ACTIVITY_RPC_METHOD))
  const field = SETTINGS.fields.find((entry) => entry.key === 'activityPanel')
  assert.ok(field, 'the activityPanel setting must exist')
  assert.equal(field.type, 'boolean')
  assert.equal(field.default, true)
})

test('the plugin registers no transition handler, and its hooks cannot decide', () => {
  const { registry, hooks } = fakeRegistry()
  register(registry)
  const raw = registry as unknown as Record<string, unknown>
  // A workflow transition is a real gate, so it must stay absent.
  assert.equal(raw.registerTransitionHandler, undefined)

  // Hooks are read-only. `PluginHookHandler` returns void upstream, so a
  // handler has no channel through which it could accept, refuse or alter a
  // turn. That is the guarantee this plugin relies on, and it is structural.
  //
  // An earlier version of this test asserted only that a handler had an own
  // `length` property, which every JavaScript function does — it proved
  // nothing. The real assertion lives in test/hook-observer.test.ts, where a
  // handler is actually invoked and its return value checked.
  assert.ok(hooks.size > 0, 'the observer should subscribe to the emitted events')
  for (const [event, handler] of hooks) {
    assert.equal(typeof handler, 'function', `${event} must be a function`)
  }
})

test('no classified call can ever be reported as conclusive', () => {
  const verdict = classifyActivity([stored()])
  assert.equal(verdict.conclusive, 0)
  for (const entry of verdict.calls) {
    assert.equal(entry.conclusive, false)
    assert.equal(entry.conclusiveProof, 'indeterminate')
  }
})
test('each tool in the mix gets its own row', async () => {
  const store = new ActivityStore()
  store.record(stored({ reportId: 'a', at: 1 }))
  store.record(stored({ reportId: 'b', at: 2, question: 'a different question' }))
  const rpc = createActivityRpc(store, () => ({}))
  const rendered = render(((await rpc({}, toolContext('s1'))) as { content: unknown[] }).content)
  assert.match(rendered, /semantic_search: 2 · 100%/)
})

test('the panel speaks one language, and French is really French', async () => {
  const store = new ActivityStore()
  store.record(stored({ usableCandidates: 0, reportId: 'a' }))
  const verdict = classifyActivity(store.callsFor('s1'))
  // `render` reads the `en` field, so it cannot prove the FRENCH branch. The
  // rows are compared directly, because that is where the locale is applied.
  const rowsOf = (fr: boolean): string[][] => {
    const card = (buildActivitySection(verdict, fr) as { children?: unknown[] }).children?.[0] as
      | { children?: unknown[] }
      | undefined
    const table = card?.children?.[0] as { rows?: string[][] } | undefined
    return table?.rows ?? []
  }
  const en = rowsOf(false).map((row) => row.join(' ')).join('\n')
  const fr = rowsOf(true).map((row) => row.join(' ')).join('\n')
  // Neither rendering may leak the other language.
  assert.doesNotMatch(en, /Échecs|Temps fournisseur|requête|Vérifications/)
  assert.doesNotMatch(fr, /Failed|Provider time|calls|unusable/)
  assert.match(fr, /Temps fournisseur/)
  assert.match(fr, /Sans verdict/)
  // The narrative is WRITTEN per locale, not translated word by word: an
  // English sentence must not survive in the French rendering.
  const narrativeFr = rowsOf(true)[0]?.[1] ?? ''
  assert.match(narrativeFr, /réponse|appels|échoué|inconclusive/)
  assert.doesNotMatch(narrativeFr, /unusable|failed|verdict|calls/)
})

test('no rendered value embeds a newline the host would collapse', async () => {
  // The host interpolates a `keyValue` value as plain text, so a "\\n" inside
  // one renders as a single space. Multi-line content must be a real node.
  const store = new ActivityStore()
  store.record(stored({ reportId: 'a', at: 1 }))
  store.record(
    stored({ reportId: 'b', at: 2, tool: 'semantic_verify_task', kind: 'verify', question: 'another question' }),
  )
  const rpc = createActivityRpc(store, () => ({}))
  const section = { children: ((await rpc({}, toolContext('s1'))) as { content: unknown[] }).content }
  const values: string[] = []
  const walk = (node: unknown): void => {
    const typed = node as { type?: string; items?: Array<{ value: string }>; children?: unknown[] }
      if (typed.type === 'keyValue') for (const item of typed.items ?? []) values.push(item.value)
    if (typed.type === 'table') {
      for (const row of (typed as { rows?: string[][] }).rows ?? []) values.push(...row)
    }
    for (const child of typed.children ?? []) walk(child)
  }
  walk(section)
  assert.ok(values.length > 0)
  for (const value of values) {
    assert.doesNotMatch(value, /\n/, `a rendered value would collapse to one line: ${value}`)
  }
})

test('the semantic-vs-deterministic share is never rendered, having no denominator', async () => {
  const store = new ActivityStore()
  store.record(stored())
  const rpc = createActivityRpc(store, () => ({}))
  const rendered = render(((await rpc({}, toolContext('s1'))) as { content: unknown[] }).content)
  // The host's per-session tool-call count is unreachable without a hook or a
  // call back into the server, so no ratio against it may appear.
  assert.doesNotMatch(rendered, /Share of tool calls/)
})

test('the opening line judges the session instead of listing a total', async () => {
  const store = new ActivityStore()
  // Five of six calls never reached the provider: the panel must say so in the
  // first line, not leave it in the fourth row for the reader to sum up.
  for (let index = 0; index < 5; index += 1) {
    store.record(stored({ reportId: `bad${index}`, at: index, success: false }))
  }
  store.record(stored({ reportId: 'ok', at: 9, question: 'a different question' }))
  const rpc = createActivityRpc(store, () => ({}))
  const rendered = render(((await rpc({}, toolContext('s1'))) as { content: unknown[] }).content)
  const first = rendered.split('\n').find((line) => line.startsWith('What happened:'))
  assert.ok(first, `the panel must open with a sentence, got: ${rendered.slice(0, 160)}`)
  assert.match(first, /5 of 6 calls failed before any answer/)
})

test('a session where nothing failed does not read like one where everything did', async () => {
  const store = new ActivityStore()
  store.record(stored({ reportId: 'a', at: 1 }))
  const rpc = createActivityRpc(store, () => ({}))
  const rendered = render(((await rpc({}, toolContext('s1'))) as { content: unknown[] }).content)
  const first = rendered.split('\n').find((line) => line.startsWith('What happened:'))
  assert.match(first ?? '', /nothing failed/)
  assert.doesNotMatch(first ?? '', /failed before any answer/)
})

test('check outcomes are kept apart from the call rows', async () => {
  // A verification call can report `unknown` AND `off-scope` at once, so those
  // numbers are outcomes, not calls. Beside the call rows the column looked
  // additive: 4 failed + 1 off-scope + 2 no-verdict read as 7 against 6.
  const store = new ActivityStore()
  store.record(
    stored({
      reportId: 'a',
      at: 1,
      status: 'off-scope',
      statuses: ['off-scope', 'unknown'],
    }),
  )
  const rpc = createActivityRpc(store, () => ({}))
  const content = ((await rpc({}, toolContext('s1'))) as { content: unknown[] }).content
  const collect = (node: unknown): Array<{ rows: string[][] }> => {
    if (Array.isArray(node)) return node.flatMap(collect)
    if (!node || typeof node !== 'object') return []
    const typed = node as Record<string, unknown>
    if (typed.type === 'table') return [typed as { rows: string[][] }]
    return collect((typed.children ?? []) as unknown[])
  }
  const tables = collect(content)
  assert.ok(tables.length >= 2, 'check outcomes must live in their own table')
  const rendered = render(content)
  assert.match(rendered, /Check outcomes — not calls/)
  // The off-scope outcome is NOT presented as a call bucket.
  const callRows = (tables[0] as { rows: string[][] }).rows
  assert.doesNotMatch(callRows.map((row) => row[0]).join('|'), /Off-scope/)
})

test('gate reasons are rendered with their count', async () => {
  const store = new ActivityStore()
  store.record(
    stored({ kind: 'verify', gateReasons: ['off_scope_detected'], reportId: 'a' }),
  )
  store.record(
    stored({
      kind: 'verify',
      gateReasons: ['off_scope_detected'],
      reportId: 'b',
      at: 2,
      question: 'another criterion entirely',
    }),
  )
  const rpc = createActivityRpc(store, () => ({}))
  const rendered = render(((await rpc({}, toolContext('s1'))) as { content: unknown[] }).content)
  assert.match(rendered, /Reason: off_scope_detected: 2/)
})
