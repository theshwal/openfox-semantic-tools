import { createHash } from 'node:crypto'

import type { PluginTool } from 'openfox/plugin'

import { ProviderError, SystemOneHttpProvider } from '../providers/system-one.js'
import { parseSettings } from '../settings.js'
import { readBoundedCandidates, MAX_CANDIDATE_FILES } from './read.js'
import { localRecall, type LocalRecallResult } from './recall.js'
import { buildDiscoveryQuestions, buildDiscoveryState, parseDiscoveryArgs } from './request.js'
import {
  buildLocalFallbackReport,
  buildReport,
  rankCandidates,
  type DiscoveryReport,
} from './rank.js'

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
      try {
        const parsed = parseDiscoveryArgs(args, context.workdir, field, questionId)
        let candidates = parsed.candidates

        if (name === 'semantic_search' && candidates.length === 0) {
          recall = await localRecall(parsed.root, parsed.question)
          candidates = recall.candidates.map((candidate) => candidate.path)
          if (candidates.length === 0) {
            throw new ProviderError(
              'insufficient_evidence',
              'Local recall found no repository files matching the query. Use normal code tools or refine the query.',
            )
          }
        }

        const read = await readBoundedCandidates(parsed.root, candidates)
        const state = buildDiscoveryState(parsed.question, read, questionId)
        const request = {
          state: state as unknown as Record<string, never>,
          ...(parsed.model ? { model: parsed.model } : {}),
          questions: buildDiscoveryQuestions(parsed.question, questionId, read.files),
        }
        const id = reportId(name, parsed.question, read.files.map((file) => file.path))

        try {
          const provider = new SystemOneHttpProvider(parseSettings(readSettings(context.projectId)), transport)
          const response = await provider.decide(request, {
            signal: context.signal,
            origin: 'automatic',
          })
          const ranked = rankCandidates(read.files, response.answers, questionId)
          const report: DiscoveryReport = buildReport(
            name,
            id,
            questionId,
            parsed.question,
            read,
            response,
            ranked,
            recall,
          )
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
            )
            return { success: true, output: JSON.stringify(report) }
          }
          throw error
        }
      } catch (error) {
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
