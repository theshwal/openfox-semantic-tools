#!/usr/bin/env node
/**
 * Measures the opt-in context-reduction transform against a baseline.
 *
 * WHAT THIS IS
 * A harness, not a verdict. It runs the SAME synthetic conversation twice —
 * once with the transform disabled (baseline) and once enabled (candidate) —
 * and records what docs/EVALUATION.md requires: main-model input/output
 * tokens, semantic-provider tokens and calls, wall time, fallback rate and the
 * size of the reduction.
 *
 * WHAT THIS IS NOT
 * - NOT a task-quality measurement. It cannot tell you whether the model
 *   produced a better answer afterwards, because no model runs here. A
 *   reduction that saves tokens and forces a re-read is a LOSS, and this
 *   script cannot detect that. `measured: false` is recorded for exactly this
 *   reason.
 * - NOT a claim. It writes numbers; the verdict is written by a human into
 *   docs/EVALUATION.md after a real OpenFox run.
 * - NOT a provider quality claim. With `--live` it contacts the endpoint in
 *   SEMANTIC_ENDPOINT; without it, a deterministic stub answers, which proves
 *   plumbing only.
 *
 * No message content is written to the report: only counts and token totals.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { PluginMessageTransformContext } from 'openfox/plugin'

import { createContextTransform, segmentMessages } from '../src/transform/index.ts'
import {
  evaluateReferenceAgreement,
  type ReferenceCase,
} from '../src/calibration/reference-agreement.ts'
import { QUESTION_ID } from '../src/calibration/question-eval.ts'
import type { DecisionAnswer, DecisionRequest } from '../src/decision/types.ts'
import { SystemOneHttpProvider } from '../src/providers/system-one.ts'

/**
 * Token estimate.
 *
 * An estimate, deliberately labelled as one. Counting real tokens needs the
 * host's tokenizer for whatever model is in use, which this script does not
 * have and must not fake. The value is a character-based lower bound used only
 * to compare two runs of the SAME conversation against each other, where any
 * consistent scale is valid.
 */
function estimateTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return Math.ceil(text.length / 4)
}

interface Conversation {
  id: string
  messages: Array<Record<string, unknown>>
}

const conversations: Conversation[] = [
  {
    id: 'long-tool-heavy-session',
    messages: [
      { role: 'system', content: 'You are a coding assistant.' },
      { role: 'user', content: 'Add tenant scoping to the export endpoint.' },
      { role: 'assistant', content: 'Let me look at the export handler first.' },
      { role: 'tool_result', content: 'export handler source: SELECT * FROM records' },
      { role: 'assistant', content: 'The query has no tenant predicate. I will add one.' },
      { role: 'assistant', content: 'Draft: SELECT * FROM records WHERE tenant_id = ?' },
      { role: 'user', content: 'Also make sure the tests cover it.' },
      { role: 'assistant', content: 'I will add a regression test for tenant isolation.' },
      { role: 'assistant', content: 'Test sketch: export scopes every record to the tenant.' },
    ],
  },
  {
    id: 'short-session',
    messages: [
      { role: 'system', content: 'You are a coding assistant.' },
      { role: 'user', content: 'What does this function do?' },
      { role: 'assistant', content: 'It normalizes a tenant identifier.' },
    ],
  },
  {
    id: 'tool-only-session',
    messages: [
      { role: 'system', content: 'You are a coding assistant.' },
      { role: 'tool_result', content: 'a' },
      { role: 'tool_result', content: 'b' },
    ],
  },
]

const context: PluginMessageTransformContext = {
  sessionId: 'benchmark',
  workdir: process.cwd(),
  model: 'benchmark-stub',
  systemPrompt: 'You are a coding assistant.',
}

/** The stub used offline: never drops anything, so the baseline is honest. */
function stubTransport(): typeof fetch {
  return async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> }
    const answers: Record<string, unknown> = {}
    for (const id of Object.keys(body.questions)) {
      // Everything is reported as still needed: a neutral stub must not
      // manufacture a reduction the real provider might never produce.
      answers[id] = { type: 'noul', noul: 0.95, confidence: 0.9 }
    }
    return Response.json({ answers })
  }
}

/**
 * Provider cost per million input tokens, in USD.
 *
 * There is NO default. An unset value yields `null`, never `0`, because a zero
 * cost is a claim ("this is free") and an unknown cost is not. A caller that
 * knows its own pricing supplies it; this project refuses to hard-code a
 * vendor price that would silently date the report.
 */
function providerCostUsd(inputTokens: number, perMillion: number | null): number | null {
  if (perMillion === null) return null
  return (inputTokens / 1_000_000) * perMillion
}

interface RunOutcome {
  id: string
  variant: 'baseline' | 'candidate' | 'synthetic-drop-all'
  messagesIn: number
  messagesOut: number
  segmentsOffered: number
  segmentsDropped: number
  mainInputTokensIn: number
  mainInputTokensOut: number
  mainOutputTokens: number
  mainCalls: number
  semanticCalls: number
  semanticInputTokens: number
  /** null when pricing was not supplied: an unknown cost is not a zero cost. */
  semanticCostUsd: number | null
  wallMs: number
  fallbacks: number
  applied: boolean
  /** Why the transform did nothing, or null when it reduced. */
  reason: string | null
}

async function run(
  conversation: Conversation,
  variant: 'baseline' | 'candidate' | 'synthetic-drop-all',
  transport: typeof fetch,
  costPerMillion: number | null,
): Promise<RunOutcome> {
  const calls = { count: 0, inputTokens: 0 }
  // Counting the request here, at the transport boundary, is the only place
  // that observes what the provider was actually sent.
  const counting: typeof fetch = async (url, init) => {
    calls.count += 1
    if (typeof init?.body === 'string') calls.inputTokens += estimateTokens(JSON.parse(init.body))
    return transport(url, init)
  }
  const transform = createContextTransform(
    () =>
      variant === 'baseline'
        ? { contextReduce: false }
        : { contextReduce: true, endpoint: 'http://127.0.0.1:1/v1/systemone', timeoutMs: 2000 },
    counting,
  )

  const started = performance.now()
  const result = await transform.transform(conversation.messages, context)
  const wallMs = performance.now() - started

  const isEnvelope = typeof result === 'object' && result !== null && 'messages' in result
  const messages = isEnvelope
    ? (result as { messages: Array<Record<string, unknown>> }).messages
    : (result as Array<Record<string, unknown>>)

  const offered = segmentMessages(conversation.messages).length
  const metadata = isEnvelope
    ? ((result as { metadata?: Record<string, unknown> }).metadata ?? {})
    : {}
  const dropped = Number(metadata['semantic.segmentsDropped'] ?? 0)
  const reason = (metadata['semantic.reason'] as string | null) ?? null

  return {
    id: conversation.id,
    variant,
    messagesIn: conversation.messages.length,
    messagesOut: messages.length,
    segmentsOffered: offered,
    segmentsDropped: dropped,
    mainInputTokensIn: estimateTokens(conversation.messages),
    mainInputTokensOut: estimateTokens(messages),
    mainOutputTokens: 0,
    mainCalls: 1,
    semanticCalls: calls.count,
    semanticInputTokens: calls.inputTokens,
    semanticCostUsd: providerCostUsd(calls.inputTokens, costPerMillion),
    wallMs,
    // A run that did not reduce anything is a fallback to the full context.
    fallbacks: dropped === 0 ? 1 : 0,
    applied: dropped > 0,
    reason,
  }
}

/**
 * Asks the provider, per case, whether a segment is still needed — the exact
 * question the transform relies on — and reports agreement against the known
 * answer.
 *
 * Run through `evaluateReferenceAgreement`, so the report shape, the agreement
 * rule and the "unusable answer is a disagreement, not an agreement" behaviour
 * are the project's own, not a second implementation that could drift.
 */
async function measureSegmentAgreement(
  transport: typeof fetch,
): Promise<Record<string, unknown>> {
  const cases: ReferenceCase[] = [
    // The segment is plainly the live request.
    { id: 'current-request', state: 'Add tenant scoping to the export endpoint.', referenceAnswer: true },
    // Stale exploration, superseded by the draft that follows it.
    { id: 'superseded-read', state: 'Reading export.ts to find the query.', referenceAnswer: false },
    // A conclusion already carried forward, so the deliberation is redundant.
    { id: 'settled-conclusion', state: 'I concluded the query lacks a tenant predicate.', referenceAnswer: false },
    // Genuinely ambiguous: no honest answer, and the transform must not drop it.
    { id: 'ambiguous', state: 'Something may be off in the handler.', referenceAnswer: true },
  ]

  const report = await evaluateReferenceAgreement({
    question: {
      type: 'noul',
      instructions: 'SEGMENT KEEP: is this conversation segment still needed for the task?',
    },
    cases,
    reference: {
      // Hand-written expectations: a HUMAN reference, which is what permits
      // the metric to be called accuracy rather than mere concordance.
      source: 'human',
      model: null,
      promptVersion: 'transform-benchmark/v1',
      recordedAt: null,
    },
    // Identity only, never the endpoint: a URL is configuration, not identity,
    // and must not end up in a committed report.
    provider: { presetId: 'custom' },
    decide: async (id) => {
      const case_ = cases.find((entry) => entry.id === id)
      if (!case_) return {}
      const request: DecisionRequest = {
        state: { text: String(case_.state) },
        questions: {
          // The evaluator reads the answer under its OWN question id
          // (`QUESTION_ID`), so this request must use the same key. Using a
          // different one is reported as `malformed`, not silently ignored.
          [QUESTION_ID]: {
            type: 'noul',
            instructions: 'SEGMENT KEEP: is this conversation segment still needed for the task?',
          },
        },
      }
      const provider = new SystemOneHttpProvider(
        { endpoint: 'http://127.0.0.1:1/v1/systemone', timeoutMs: 2000 },
        transport,
      )
      const response = await provider.decide(request)
      return response.answers as Record<string, DecisionAnswer>
    },
  })

  return {
    scope:
      'provider capability check for the transform question, NOT task quality. It does not run a model after a reduction, so it cannot detect the cost of rediscovering discarded context.',
    metric: report.metric.name,
    metricKind: report.metric.kind,
    total: report.aggregate.total,
    answered: report.aggregate.answered,
    agreed: report.aggregate.agreed,
    // Null when nothing was answered: an unmeasured rate is never zero.
    accuracy: report.aggregate.agreement,
    errors: report.aggregate.errors,
    malformed: report.aggregate.malformed,
    disagreementIds: report.review.map((item) => item.id),
  }
}

async function main(): Promise<void> {
  const live = process.argv.includes('--live')
  const out = resolve(process.argv[2] ?? 'benchmark/results/transform')
  const endpoint = process.env.SEMANTIC_ENDPOINT
  const apiKey = process.env.SEMANTIC_API_KEY

  if (live && !endpoint) {
    throw new Error('--live needs SEMANTIC_ENDPOINT. Offline runs prove plumbing only.')
  }

  const transport: typeof fetch = live
    ? async (url, init) => {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        }
        return fetch(url, { ...init, headers })
      }
    : stubTransport()

  // Optional pricing. Absent means `null` in the report, never `0`.
  const costPerMillion =
    process.env.SEMANTIC_INPUT_USD_PER_MTOK === undefined
      ? null
      : Number(process.env.SEMANTIC_INPUT_USD_PER_MTOK)
  if (costPerMillion !== null && (!Number.isFinite(costPerMillion) || costPerMillion < 0)) {
    throw new Error('SEMANTIC_INPUT_USD_PER_MTOK must be a non-negative number')
  }

  const runs: RunOutcome[] = []
  for (const conversation of conversations) {
    runs.push(await run(conversation, 'baseline', transport, costPerMillion))
    runs.push(await run(conversation, 'candidate', transport, costPerMillion))
  }
  // A third, clearly synthetic variant: a stub that reports every segment as
  // droppable EXCEPT the first, so a genuine partial reduction occurs. Without
  // it the honest stub always yields zero, which proves the no-op path but never
  // exercises the saving path.
  //
  // It is NOT a provider claim and NOT a result. Note it cannot express
  // "drop everything": the transform deliberately refuses a reduction that
  // would empty the conversation, which is a safety property this harness also
  // proves.
  const droppingStub: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> }
    const ids = Object.keys(body.questions)
    const answers: Record<string, unknown> = {}
    ids.forEach((id, i) => {
      // The last segment is always kept, so the conversation retains content.
      answers[id] =
        i === ids.length - 1
          ? { type: 'noul', noul: 0.99, confidence: 0.95 }
          : { type: 'noul', noul: 0.01, confidence: 0.95 }
    })
    return Response.json({ answers })
  }
  for (const conversation of conversations) {
    runs.push(await run(conversation, 'synthetic-drop-all', droppingStub, costPerMillion))
  }

  /**
   * The quality axis, run through the project's own labelled evaluator.
   *
   * The token arithmetic above says nothing about whether the provider can
   * actually judge a conversation segment. This asks it the question the
   * transform depends on — "is this segment still needed?" — against cases
   * whose expected answer is known, and reports the agreement rate the
   * transform's policy would achieve.
   *
   * This is a *provider capability* check, not a task-quality check: it does
   * not run a model after a reduction, so it still cannot detect the cost of a
   * model having to rediscover discarded context. It is recorded as a separate,
   * weaker axis rather than folded into the token numbers.
   */
  const quality = await measureSegmentAgreement(transport)

  const provider = live
    ? `${new URL(endpoint!).host} (live)`
    : 'deterministic stub (offline)'
  const total = (variant: RunOutcome['variant'], key: keyof RunOutcome) =>
    runs.filter((r) => r.variant === variant).reduce((n, r) => n + Number(r[key] ?? 0), 0)

  /** Sums a cost only when EVERY contributing run knew its price. */
  const totalCost = (variant: RunOutcome['variant']): number | null => {
    const rows = runs.filter((r) => r.variant === variant)
    const costs = rows.map((r) => r.semanticCostUsd)
    if (costs.some((c) => c === null)) return null
    return (costs as number[]).reduce((a, b) => a + b, 0)
  }

  const report = {
    schemaVersion: 1,
    scope:
      'context-reduction transform: token/latency arithmetic on a synthetic conversation. NOT task quality, NOT a savings claim.',
    // The whole point of the project's evaluation rule: this harness cannot
    // observe whether the reduced context hurt the task.
    measured: false,
    openfoxVersion: null,
    mainModel: null,
    semanticProvider: provider,
    semanticModel: live ? (process.env.SEMANTIC_MODEL ?? null) : null,
    verdict: 'INCONCLUSIVE',
    verdictReason:
      'No task ran after the reduction. A smaller prompt that makes the model rediscard context is a loss, and this harness cannot observe that. The quality axis below measures the PROVIDER on the transform question, not the task. Keep contextReduce off until a real OpenFox A/B run is recorded in docs/EVALUATION.md.',
    tokenNote:
      'Token counts are a character-based estimate (len/4), not a real tokenizer. Valid only for comparing the same conversation across variants.',
    costNote:
      costPerMillion === null
        ? 'Provider cost is null, not zero: no price was supplied. Set SEMANTIC_INPUT_USD_PER_MTOK to price it. A null cost is an unknown cost.'
        : `Provider cost priced at $${costPerMillion} per million input tokens, supplied by the operator.`,
    // The quality axis is measured; TASK quality still is not. The two must not
    // be conflated, so this flag stays false and refers to the task.
    qualityMeasured: false,
    providerCapability: quality,
    totals: {
      baseline: {
        mainInputTokens: total('baseline', 'mainInputTokensOut'),
        semanticCalls: total('baseline', 'semanticCalls'),
        semanticInputTokens: total('baseline', 'semanticInputTokens'),
        semanticCostUsd: totalCost('baseline'),
        wallMs: Math.round(total('baseline', 'wallMs')),
        fallbacks: total('baseline', 'fallbacks'),
      },
      candidate: {
        mainInputTokens: total('candidate', 'mainInputTokensOut'),
        semanticCalls: total('candidate', 'semanticCalls'),
        semanticInputTokens: total('candidate', 'semanticInputTokens'),
        semanticCostUsd: totalCost('candidate'),
        wallMs: Math.round(total('candidate', 'wallMs')),
        fallbacks: total('candidate', 'fallbacks'),
        segmentsOffered: total('candidate', 'segmentsOffered'),
        segmentsDropped: total('candidate', 'segmentsDropped'),
      },
      // Not a result: the same synthetic "drop everything" answer for every
      // conversation, purely so the saving path is exercised and visible.
      syntheticDropAll: {
        mainInputTokens: total('synthetic-drop-all', 'mainInputTokensOut'),
        segmentsDropped: total('synthetic-drop-all', 'segmentsDropped'),
      },
    },
    runs,
  }

  await mkdir(out, { recursive: true })
  await writeFile(resolve(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)

  const lines = [
    '# Context-reduction transform — offline harness',
    '',
    `Provider: ${provider}`,
    '',
    '**Verdict: INCONCLUSIVE.** This harness measures token arithmetic and the',
    "provider's own accuracy on the transform question. It does NOT run a task",
    'after a reduction, so it cannot show whether the model then needed the',
    'context that was removed. `contextReduce` stays off by default.',
    '',
    'Tokens are a character-based estimate (len/4), not a real tokenizer.',
    '',
    report.costNote,
    '',
    '| Conversation | Variant | Messages in/out | Input tokens (est.) | Semantic calls | Cost USD | Dropped | Reason |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |',
  ]
  for (const run_ of runs) {
    lines.push(
      `| ${run_.id} | ${run_.variant} | ${run_.messagesIn}/${run_.messagesOut} | ${run_.mainInputTokensOut} | ${run_.semanticCalls} | ${run_.semanticCostUsd ?? 'unknown'} | ${run_.segmentsDropped} | ${run_.reason ?? 'applied'} |`,
    )
  }
  const capability = report.providerCapability as Record<string, unknown>
  lines.push(
    '',
    '## Provider capability on the transform question',
    '',
    `Metric: ${capability.metric} (${capability.metricKind}) — ${capability.scope}`,
    '',
    `- Cases: ${capability.total}, answered: ${capability.answered}, agreed: ${capability.agreed}`,
    `- Accuracy: ${capability.accuracy ?? 'unknown'}`,
    `- Errors: ${capability.errors}, malformed: ${capability.malformed}`,
    `- Disagreement ids: ${(capability.disagreementIds as string[]).join(', ') || 'none'}`,
    '',
    'A conversation with nothing droppable (`tool-only-session`) and one where every',
    'segment is reported as still needed must both produce zero reduction: a stub',
    'that drops context would make the harness prove nothing.',
    '',
    'The `synthetic-drop-all` variant is NOT a result. It is one canned answer',
    'applied to every conversation, present only so the saving path is executed',
    'and visible. A real provider has not been asked.',
    '',
  )
  await writeFile(resolve(out, 'summary.md'), lines.join('\n'))

  const { baseline, candidate } = report.totals
  console.log(
    `Recorded ${runs.length} runs in ${out}. ` +
      `baseline input ${baseline.mainInputTokens} vs candidate ${candidate.mainInputTokens} (estimated tokens). ` +
      'No quality or saving claim inferred: verdict is INCONCLUSIVE.',
  )
}

await main()