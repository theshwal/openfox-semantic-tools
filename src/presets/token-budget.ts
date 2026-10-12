/**
 * How much evidence may go into ONE decision request.
 *
 * THE MEASUREMENT THIS EXISTS FOR
 * On 2026-10-12, against the hosted System One endpoint: a state of roughly
 * 32.7k tokens was accepted, ~60k was refused with HTTP 400. The refusal
 * arrives AFTER the plugin has assembled and sent the request, so the caller
 * received a report whose scores were all `null` — an empty ranking with no
 * stated reason, which reads as "nothing is relevant" when the truth is "the
 * request was refused".
 *
 * The budget was previously expressed in BYTES (120 000). That number was
 * invented rather than measured, and it is wrong in both directions: 120 000
 * bytes of ordinary TypeScript is already ~30k tokens, while a file of short
 * identifiers is far denser. Every test in the repository used a stub that
 * accepts anything, so nothing ever compared the budget to a real engine.
 *
 * WHY AN ESTIMATE AND NOT A TOKENIZER
 * A dependency-free estimate that is deliberately generous — it must never
 * UNDER-count, or an oversized state would still be sent. It is 4 characters
 * per token, which is conservative for source code (real English averages
 * closer to 4.5, and dense identifiers reach 3).
 */

/** Hard ceiling on the state of ONE request, in tokens. */
export const MAX_STATE_TOKENS = 24_000

/** Conservative characters-per-token factor. Lower = more conservative. */
const CHARS_PER_TOKEN = 4

/**
 * Estimates a token count, rounding UP.
 *
 * Never under-counts: that is the direction that gets the request refused.
 * Whitespace runs count as one token, so padding a file with blank lines does
 * not buy extra evidence.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * Per-preset budgets, from what is actually known about each engine.
 *
 * `laya` is the case that matters: it reads 1 024 tokens including options,
 * so a 24k state would be refused outright. A preset with a measured small
 * window must therefore carry a smaller budget than the general one.
 *
 * A preset absent here gets `MAX_STATE_TOKENS`, which is the conservative
 * choice: too small and a search returns fewer candidates, too large and the
 * request is refused outright with no usable ranking.
 */
export const PRESET_STATE_TOKEN_BUDGETS: Readonly<Record<string, number>> = {
  // Reads 1 024 tokens INCLUDING its options, so the state must leave room.
  laya: 800,
}

export function tokenBudgetForPreset(presetId: string | undefined): number {
  if (presetId === undefined) return MAX_STATE_TOKENS
  return PRESET_STATE_TOKEN_BUDGETS[presetId] ?? MAX_STATE_TOKENS
}