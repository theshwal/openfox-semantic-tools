import type { PluginToolContext } from 'openfox/plugin'

import {
  parseActivityPanelEnabled,
  questionKey,
  tokenSignature,
  type ActivityCall,
  type ActivityKind,
  type ActivityStore,
} from '../activity/index.js'

/**
 * Connects the semantic tools to the in-memory activity registry.
 *
 * Recording is done by the tool that produced the report, so nothing about the
 * agent has to be observed. The caller's question is NEVER stored: it is
 * reduced to a short digest and a word signature at the boundary, so the
 * registry can detect a repeat without holding the text that could carry
 * repository or conversation content.
 */
export interface ActivityRecorder {
  record(input: ActivityInput): void
}

export interface ActivityInput {
  readonly tool: string
  readonly kind: ActivityKind
  readonly reportId: string
  readonly context: PluginToolContext
  readonly question?: string | undefined
  readonly success: boolean
  readonly latencyMs?: number
  readonly usableCandidates?: number
  readonly semanticApplied?: boolean | null
  readonly status?: string | null
  readonly coverageStatuses?: readonly string[]
  /**
   * Verification statuses a single call produced. `semantic_issue_coverage`
   * yields one per criterion, so the policy counters see exactly what
   * `semantic_verify_task` would have reported for each of them.
   */
  readonly statuses?: readonly string[]
  readonly gateReasons?: readonly string[]
}

/**
 * Builds the recorder the tools call on every execution.
 *
 * It reads the switch through the same settings accessor the tools already use,
 * so a project-scoped value is honoured the same way it is everywhere else.
 * A disabled recorder is a real no-op: nothing reaches the store.
 */
export function createActivityRecorder(
  store: ActivityStore,
  readSettings: (projectId?: string) => Record<string, unknown>,
  now: () => number = () => Date.now(),
): ActivityRecorder {
  return {
    record(input: ActivityInput): void {
      let values: Record<string, unknown>
      try {
        values = readSettings(input.context.projectId)
      } catch {
        // Settings access can throw for secret-bearing reasons. An activity
        // record is never worth an error, and it must never surface one.
        return
      }
      if (!parseActivityPanelEnabled(values)) return
      const call: ActivityCall = {
        reportId: input.reportId,
        tool: input.tool,
        kind: input.kind,
        sessionId: input.context.sessionId,
        at: now(),
        success: input.success,
        latencyMs: input.latencyMs ?? 0,
        // The text stops here: only digests of it are retained.
        questionKey: questionKey(input.question),
        tokenSignature: tokenSignature(input.question),
        usableCandidates: input.usableCandidates ?? 0,
        semanticApplied: input.semanticApplied ?? null,
        status: input.status ?? null,
        // A call with several statuses contributes all of them; the single
        // `status` field stays for the one-status tools.
        statuses: input.statuses ?? (input.status ? [input.status] : []),
        coverageStatuses: input.coverageStatuses ?? [],
        gateReasons: input.gateReasons ?? [],
      }
      store.record(call)
    },
  }
}

/** A recorder that records nothing, used when the panel is off. */
export const NULL_ACTIVITY_RECORDER: ActivityRecorder = {
  record(): void {},
}
