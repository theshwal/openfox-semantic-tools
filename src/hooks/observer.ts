import type {
  PluginHookEvent,
  PluginHookPayload,
  PluginRegistry,
} from 'openfox/plugin'

/**
 * Observation of what the host does, without ever influencing it.
 *
 * WHY THIS EXISTS
 * `PluginHookHandler` returns `void` upstream. A handler therefore physically
 * cannot accept, refuse or alter a tool call, a turn or a workflow step: there
 * is no return channel. This module only ever writes to its own store.
 *
 * WHICH EVENTS
 * `PluginHookEvent` declares 15 values, but the 2.0.161 host emits only the
 * ones in `EVENT_HOOK_MAP` (`dist/chunk-4XRJ4J6E.js`) plus `turn.completed`
 * and `workflow.step.completed`. `llm.completed`, `provider.changed` and the
 * three `devserver.*` values are accepted by `registerHook` and then never
 * fire, so subscribing to them would look successful and observe nothing. The
 * measured list is reproduced in `docs/HOOK-PAYLOADS.md`; this constant is the
 * single place it is encoded, and a test fails if it drifts from the measured
 * set.
 */
export const OBSERVED_EVENTS: readonly PluginHookEvent[] = [
  'session.created',
  'turn.completed',
  'workflow.step.completed',
  'workflow.execution.changed',
  'task.completed',
  'message.created',
  'tool.completed',
  'criterion.updated',
  'context.compacted',
  'retry.triggered',
]

/** What is retained per event. Counts and shapes, never values. */
export interface ObservedEvent {
  readonly event: PluginHookEvent
  readonly count: number
  /** Distinct session ids seen. Stored as a count; ids themselves are not kept. */
  readonly sessions: number
  /**
   * Who produced whatever this event describes.
   *
   * Always `'host'`. It is spelled out rather than left implicit because the
   * host measures its own compaction (`CompactionEventRecord` carries
   * `reductionPercent` and friends), and an observation without an owner reads
   * like a claim this plugin made it. See docs/HOOK-PAYLOADS.md.
   */
  readonly attributedTo: 'host'
  /**
   * `data` keys seen, each with the TYPE NAMES observed for it.
   *
   * A type name cannot carry repository or conversation text, so this is a
   * schema census: enough to classify which keys hold free text, never enough
   * to reconstruct what was said. Values are never read into it.
   */
  readonly dataKeyTypes: Record<string, string[]>
  /** False until at least one payload arrives for this event. */
  readonly measured: boolean
}

export interface HookSnapshot {
  readonly advisory: true
  /**
   * True when every subscribed event has fired at least once.
   *
   * Until then the snapshot describes an observer that has not seen traffic,
   * which is a very different statement from one that has seen none occur.
   */
  readonly complete: boolean
  readonly events: readonly ObservedEvent[]
  readonly note: string
}

const NOTE =
  'Counts, session counts and data-key TYPES only. No payload value, session id, question, path or file content is retained or transmitted: a type name cannot carry text.'

interface Internal {
  count: number
  readonly sessions: Set<string>
  readonly dataKeyTypes: Record<string, Set<string>>
}

export interface HookObserver {
  attach(registry: PluginRegistry): void
  snapshot(): HookSnapshot
}

/**
 * Classifies a value by TYPE only.
 *
 * For an array the ELEMENT types are reported, because "array of what" is the
 * question that matters for risk and the answer cannot carry content. A
 * primitive is reported by `typeof`; no branch returns the value itself.
 */
function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    const inner = new Set<string>()
    for (const item of value) inner.add(typeName(item))
    return `array<${[...inner].sort().join('|') || 'empty'}>`
  }
  return typeof value
}

export function createHookObserver(): HookObserver {
  const state = new Map<PluginHookEvent, Internal>()
  for (const event of OBSERVED_EVENTS) {
    state.set(event, { count: 0, sessions: new Set(), dataKeyTypes: {} })
  }

  return {
    attach(registry: PluginRegistry): void {
      for (const event of OBSERVED_EVENTS) {
        registry.registerHook(event, (payload: PluginHookPayload) => {
          absorb(state, event, payload)
        })
      }
    },

    snapshot(): HookSnapshot {
      const events = OBSERVED_EVENTS.map((event) => {
        const entry = state.get(event)!
        const dataKeyTypes: Record<string, string[]> = {}
        for (const [key, kinds] of Object.entries(entry.dataKeyTypes)) {
          dataKeyTypes[key] = [...kinds].sort()
        }
        return {
          event,
          count: entry.count,
          sessions: entry.sessions.size,
          attributedTo: 'host' as const,
          dataKeyTypes,
          measured: entry.count > 0,
        }
      })
      return {
        advisory: true,
        complete: events.every((entry) => entry.measured),
        events,
        note: NOTE,
      }
    },
  }
}

/**
 * Folds one payload into the counters.
 *
 * Deliberately total: every access is guarded, because `data` is untyped
 * upstream and a malformed payload must not throw into the host's turn. A
 * throw here would be the one way this plugin could interfere with a session,
 * which is precisely what it must never do.
 */
function absorb(
  state: Map<PluginHookEvent, Internal>,
  event: PluginHookEvent,
  payload: PluginHookPayload,
): void {
  const entry = state.get(event)
  if (entry === undefined) return
  entry.count += 1

  try {
    if (typeof payload?.sessionId === 'string') entry.sessions.add(payload.sessionId)
  } catch {
    /* an absent or malformed session id simply is not counted */
  }

  const data = payload?.data
  if (data === null || typeof data !== 'object') return
  for (const key of Object.keys(data)) {
    const kinds = entry.dataKeyTypes[key] ?? (entry.dataKeyTypes[key] = new Set<string>())
    try {
      kinds.add(typeName((data as Record<string, unknown>)[key]))
    } catch {
      kinds.add('unreadable')
    }
  }
}