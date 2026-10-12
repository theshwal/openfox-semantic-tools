import { createHash } from 'node:crypto'

import type { PluginTool } from 'openfox/plugin'

import { ProviderError, SystemOneHttpProvider } from '../providers/system-one.js'
import { parseSettings } from '../settings.js'
import { resolveConfidenceThreshold } from '../relevance/threshold.js'
import {
  describeSkipped,
  readBoundedCandidates,
  MAX_CANDIDATE_FILES,
} from './read.js'
import { localRecall, type LocalRecallResult } from './recall.js'
import { buildDiscoveryQuestions, buildDiscoveryState, parseDiscoveryArgs } from './request.js'
import { buildFragments } from './fragments.js'
import {
  buildLocalFallbackReport,
  buildReport,
  rankCandidates,
  type DiscoveryReport,
} from './rank.js'
import { NULL_ACTIVITY_RECORDER, type ActivityRecorder } from '../activity/recorder.js'

export type DiscoveryToolName = 'semantic_search' | 'semantic_scan'

const FIELD = {
  semantic_search: { field: 'query', id: 'relevance' },
  semantic_scan: { field: 'predicate', id: 'matchStrength' },
} as const

const PURPOSE = {
  semantic_search:
    'Find code from a natural-language query using bounded local recall followed by semantic reranking; explicit candidate lists remain supported.',
  semantic_scan:
    'Score an explicit caller-supplied list of code files against a behavioural predicate, to surface candidates that deserve a closer look.',
} as const

function reportId(
  name: DiscoveryToolName,
  question: string,
  paths: readonly string[],
): string {
  return `discovery:${name}:${createHash('sha256')
    .update(question)
    .update(paths.join(','))
    .digest('hex')
    .slice(0, 16)}`
}

/**
 * Builds one advisory discovery tool.
 *
 * semantic_search may obtain candidates from a bounded local deterministic
 * recall stage when none are supplied. semantic_scan always requires explicit
 * candidates. Only the bounded candidate contents are eligible for transmission
 * to the configured semantic endpoint.
 */
export function createDiscoveryTool(
  name: DiscoveryToolName,
  readSettings: (projectId?: string) => Record<string, unknown>,
  transport: typeof fetch = fetch,
  activity: ActivityRecorder = NULL_ACTIVITY_RECORDER,
): PluginTool {
  const { field, id: questionId } = FIELD[name]
  const required = name === 'semantic_search' ? [field] : [field, 'candidates']
  return {
    name,
    description: `${PURPOSE[name]} Advisory only: it returns ranked CANDIDATES to confirm with normal code tools, never a verdict, and it never marks anything complete.`,
    parameters: {
      type: 'object',
      required,
      additionalProperties: false,
      properties: {
        [field]: { type: 'string', minLength: 1 },
        candidates: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_CANDIDATE_FILES,
          items: { type: 'string', minLength: 1 },
        },
        root: { type: 'string', minLength: 1 },
        model: { type: 'string', minLength: 1 },
      },
    },
    async execute(args, context) {
      let recall: LocalRecallResult | undefined
      // A fallback still SPENT the time it took the provider to fail, so the
      // elapsed time is measured here rather than reported as zero.
      const startedAt = Date.now()
      try {
        const parsed = parseDiscoveryArgs(args, context.workdir, field, questionId)
        // Read on every call, never captured: the operator's dial must take
        // effect on the next tool call, without a reload.
        const settings = readSettings(context.projectId)
        const threshold = resolveConfidenceThreshold(settings)
        let candidates = parsed.candidates

        if (name === 'semantic_search' && candidates.length === 0) {
          recall = await localRecall(parsed.root, parsed.question)
          candidates = recall.candidates.map((candidate) => candidate.path)
          if (candidates.length === 0) {
            // B1-18: an empty candidate set is exactly when the caller must
            // learn WHAT was not readable. Without this, a repository whose
            // files are all oversized or binary reads as "the code does not
            // exist", which is a different and much stronger claim.
            throw new ProviderError(
              'insufficient_evidence',
              'Local recall found no repository files matching the query.' +
                describeSkipped(recall.skipped) +
                ' Use normal code tools or refine the query.',
            )
          }
        }

        const read = await readBoundedCandidates(parsed.root, candidates, {
          presetId: typeof settings.backend === 'string' ? settings.backend : undefined,
        })
        // FRAGMENTS, not files. A decision model is asked to judge a
        // declaration, not to read a module; whole files cost ~4 000 tokens
        // per question, which is what made this tool expensive at scale.
        const fragments = await buildFragments(parsed.root, read.files.map((f) => f.path))
        if (fragments.length === 0) {
          throw new ProviderError(
            'insufficient_evidence',
            'No fragment could be built from the candidates. Confirm the paths are readable source files.',
          )
        }
        const state = buildDiscoveryState(parsed.question, fragments)
        const request = {
          state: state as unknown as Record<string, never>,
          ...(parsed.model ? { model: parsed.model } : {}),
          questions: buildDiscoveryQuestions(parsed.question, questionId, fragments),
        }
        const id = reportId(
          name,
          parsed.question,
          fragments.map((fragment) => `${fragment.path}:${fragment.startLine}`),
        )

        try {
          const provider = new SystemOneHttpProvider(parseSettings(settings), transport)
          const response = await provider.decide(request, {
            signal: context.signal,
            origin: 'automatic',
          })
          const ranked = rankCandidates(
            fragments.map((fragment) => ({
              path: fragment.path,
              startLine: fragment.startLine,
              endLine: fragment.endLine,
              evidenceKind: fragment.kind,
            })),
            response.answers,
            questionId,
          )
          const report: DiscoveryReport = buildReport(
            name,
            id,
            questionId,
            parsed.question,
            read,
            response,
            ranked,
            recall,
            threshold,
          )
          activity.record({
            tool: name,
            kind: 'discovery',
            reportId: id,
            context,
            question: parsed.question,
            success: true,
            latencyMs: report.latencyMs,
            usableCandidates: report.candidates.filter((candidate) => candidate.usable).length,
            semanticApplied: report.semanticApplied,
          })
          return { success: true, output: JSON.stringify(report) }
        } catch (error) {
          // Only an auto-recall semantic_search can safely degrade to the local
          // shortlist: it has a real deterministic ranking to return. Explicit
          // candidate calls preserve the historical fail-closed behavior.
          if (recall && error instanceof ProviderError) {
            const report = buildLocalFallbackReport(
              id,
              questionId,
              parsed.question,
              read,
              recall,
              `semantic_fallback:${error.code}`,
              threshold,
            )
            activity.record({
              tool: name,
              kind: 'discovery',
              reportId: id,
              context,
              question: parsed.question,
              success: true,
              latencyMs: Date.now() - startedAt,
              usableCandidates: report.candidates.filter((candidate) => candidate.usable).length,
              semanticApplied: false,
            })
            return { success: true, output: JSON.stringify(report) }
          }
          throw error
        }
      } catch (error) {
        // Recorded once here: every failure path reaches this handler, so
        // recording in the inner catch too would count the same call twice.
        activity.record({
          tool: name,
          kind: 'discovery',
          reportId: `discovery:${name}:failed`,
          context,
          question: typeof args[field] === 'string' ? args[field] : '',
          success: false,
        })
        if (error instanceof ProviderError) {
          return {
            success: false,
            error: JSON.stringify({ code: error.code, message: error.message }),
          }
        }
        return {
          success: false,
          error: JSON.stringify({
            code: 'internal',
            message: 'Semantic discovery failed to run. Use deterministic code tools instead.',
          }),
        }
      }
    },
  }
}
