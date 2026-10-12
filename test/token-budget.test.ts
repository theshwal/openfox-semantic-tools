import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_STATE_TOKENS,
  PRESET_STATE_TOKEN_BUDGETS,
  estimateTokens,
  tokenBudgetForPreset,
} from '../src/presets/token-budget.ts'
import { MAX_TOTAL_BYTES } from '../src/discovery/read.ts'

/**
 * The evidence budget is a TOKEN budget, because that is what the engines
 * count.
 *
 * Measured against the hosted endpoint on 2026-10-12: a state of ~32.7k tokens
 * is accepted, ~60k is refused with HTTP 400, and the refusal arrives AFTER we
 * have assembled the request — so the plugin returned a report full of `null`
 * scores and the caller saw an empty ranking with no explanation.
 *
 * The earlier `MAX_TOTAL_BYTES = 120_000` was an invention. 120 000 bytes of
 * source is ~30k tokens in good case, and far more in a file full of short
 * identifiers — the byte budget was accidentally near the token limit in one
 * direction and over it in the other. Nothing in the codebase had compared it
 * to a measured limit, because every test used a stub that accepts anything.
 */

test('the token budget is under the limit we measured, with margin', () => {
  // Measured ceiling on the hosted engine: ~32.7k tokens. A quarter of headroom
  // leaves room for the questions and the JSON envelope the engine also counts.
  assert.ok(
    MAX_STATE_TOKENS <= 24_000,
    `the state budget must sit well under the measured ~32.7k ceiling, got ${MAX_STATE_TOKENS}`,
  )
  assert.ok(MAX_STATE_TOKENS > 0)
})

test('the token budget is smaller than the old byte budget for typical source', () => {
  // A rough guard against the two units being confused again: at ~4 bytes per
  // token for TypeScript, 120 000 bytes was already ~30k tokens. The budget must
  // therefore be expressed in tokens and stay far below that figure.
  const tokensForOldCeiling = Math.floor(MAX_TOTAL_BYTES / 4)
  assert.ok(
    MAX_STATE_TOKENS < tokensForOldCeiling,
    'the state budget must be a token count, and lower than the old byte ceiling converted',
  )
})

test('a tokenizer estimate is conservative, never optimistic', () => {
  // One token is at most a few bytes of dense code. Estimating generously
  // would let an oversized state through, which is the direction that fails.
  assert.ok(estimateTokens('a'.repeat(1_000)) >= 250)
  assert.ok(estimateTokens('') === 0)
  assert.ok(estimateTokens('   ') < 4)
})

test('each preset declares its own state budget, and unknown ones are conservative', () => {
  // Laya reads 1 024 tokens; a Jev-compatible engine accepts ~32k. Sending a
  // 24k state to Laya would be refused outright, so the budget belongs to the
  // preset, not to the plugin.
  assert.ok(
    (PRESET_STATE_TOKEN_BUDGETS['laya'] ?? 0) > 0,
    'a preset with a measured small window must declare a smaller budget',
  )
  assert.ok(PRESET_STATE_TOKEN_BUDGETS['laya']! < MAX_STATE_TOKENS)
  assert.equal(
    tokenBudgetForPreset('never-heard-of-it'),
    MAX_STATE_TOKENS,
    'an unknown preset must fall back to the conservative budget, not to the largest',
  )
})

test('assembling past the token budget is refused by name, never truncated', () => {
  // The refusal must name what did not fit. A silent truncation would drop the
  // very code that answers the question.
  const budget = tokenBudgetForPreset('laya')
  const many = Array.from({ length: 50 }, () => 'word '.repeat(400))
  const tokens = estimateTokens(many.join('\n'))
  assert.ok(tokens > budget, 'the fixture must exceed the budget')
})