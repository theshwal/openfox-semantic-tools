/**
 * Message segmentation for the context-reduction transform.
 *
 * The transform must only ever DROP a message that is unambiguously
 * reconstructible history. Everything else is kept, so the transform can never
 * silently remove evidence from a turn:
 *
 * - `system` carries the contract, not history. Never a candidate.
 * - `tool` / `tool_result` / `tool_call` are evidence an earlier step produced.
 *   Dropping them would make a later model answer about work it can no longer
 *   see, so they are never candidates either.
 * - structured content (arrays, object parts) is not safely summarizable, so a
 *   message carrying it is never a candidate.
 * - **the live turn** — everything from the last tool result onwards, or the
 *   trailing exchange when there is no tool result — is the work in progress.
 *   It is never a candidate, because deleting the request the model is
 *   answering leaves it responding to a question it can no longer read.
 *
 * Only a plain string `content` on a `user` or `assistant` message qualifies,
 * AND only when it sits strictly before the live window.
 */

export interface Segment {
  /** Index in the original message array, so history order can be restored. */
  index: number
  role: 'user' | 'assistant'
  text: string
}

export const MAX_REDUCED_SEGMENTS = 40

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Roles that mark a tool round-trip, and so the start of the live window. */
function isToolRole(role: unknown): boolean {
  return role === 'tool' || role === 'tool_result' || role === 'tool_call'
}

/**
 * Index of the first message of the live window: nothing at or after it may be
 * dropped.
 *
 * The anchor is the LAST tool result when there is one, because everything
 * after it is what the model is currently doing with that output. Without a
 * tool result, the trailing `user` turn is the anchor: from the last user
 * message onwards the exchange is the current one, and the assistant messages
 * after it are the answer being composed.
 *
 * Returns `messages.length` when the whole conversation is live, which makes
 * every segment eligible-by-role ineligible in practice.
 */
export function liveWindowStart(messages: Array<Record<string, unknown>>): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (isRecord(message) && isToolRole(message.role)) return index
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (isRecord(message) && message.role === 'user') return index
  }
  return messages.length
}

/**
 * Selects the droppable segments of a conversation.
 *
 * The bound is a safety limit, not an optimization: past `MAX_REDUCED_SEGMENTS`
 * candidates, the remaining ones are simply not offered for reduction. They are
 * kept as-is, so the bound can only make the transform do less, never cause a
 * drop the caller did not measure.
 */
export function segmentMessages(messages: Array<Record<string, unknown>>): Segment[] {
  const liveFrom = liveWindowStart(messages)
  const segments: Segment[] = []
  for (const [index, message] of messages.entries()) {
    if (segments.length >= MAX_REDUCED_SEGMENTS) break
    // The live turn is never droppable, however confident a provider is.
    if (index >= liveFrom) break
    if (!isRecord(message)) continue
    if (message.role !== 'user' && message.role !== 'assistant') continue
    // Structured content is never a safe reduction candidate.
    if (typeof message.content !== 'string') continue
    const text = message.content
    if (!text.trim()) continue
    segments.push({ index, role: message.role, text })
  }
  return segments
}