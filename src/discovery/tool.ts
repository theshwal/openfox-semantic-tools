import { createHash } from 'node:crypto'

import type { PluginTool } from 'openfox/plugin'

import { ProviderError, SystemOneHttpProvider } from '../providers/system-one.js'
import { parseSettings } from '../settings.js'
import { readBoundedCandidates } from './read.js'
import { buildDiscoveryQuestions, buildDiscoveryState, parseDiscoveryArgs } from './request.js'
import { buildReport, rankCandidates, type DiscoveryReport } from './rank.js'
import { MAX_CANDIDATE_FILES } from './read.js'

export type DiscoveryToolName = 'semantic_search' | 'semantic_scan'

const FIELD = {
  semantic_search: { field: 'query', id: 'relevance' },
  semantic_scan: { field: 'predicate', id: 'matchStrength' },
} as const

const PURPOSE = {
  semantic_search:
    'Rank a caller-supplied list of code files by how likely each is to answer a query, so fewer exploratory reads are needed.',
  semantic_scan:
    'Score a caller-supplied list of code files against a behavioural predicate, to surface candidates that deserve a closer look.',
} as const

/**
 * Builds one advisory discovery tool.
 *
 * The caller narrows the candidates first: this tool never scans a repository
 * on its own, because sending a whole repository to a remote provider blindly
 * is exactly what the issue forbids. It reads only the listed files, inside the
 * session root, under hard byte bounds, and refuses rather than truncating.
 *
 * It always declares an `automatic` call origin, because the state is
 * repository-derived and the egress policy must be able to block it on a remote
 * endpoint before anything is sent.
 */
export function createDiscoveryTool(
  name: DiscoveryToolName,
  readSettings: (projectId?: string) => Record<string, unknown>,
  transport: typeof fetch = fetch,
): PluginTool {
  const { field, id: questionId } = FIELD[name]
  return {
    name,
    description: `${PURPOSE[name]} Advisory only: it returns ranked CANDIDATES to confirm with normal code tools, never a verdict, and it never marks anything complete.`,
    parameters: {
      type: 'object',
      required: [field, 'candidates'],
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
      try {
        const parsed = parseDiscoveryArgs(args, context.workdir, field, questionId)
        const read = await readBoundedCandidates(parsed.root, parsed.candidates)
        const state = buildDiscoveryState(parsed.question, read, questionId)
        const request = {
          state: state as unknown as Record<string, never>,
          ...(parsed.model ? { model: parsed.model } : {}),
          questions: buildDiscoveryQuestions(parsed.question, questionId),
        }
        const provider = new SystemOneHttpProvider(parseSettings(readSettings(context.projectId)), transport)
        // Repository-derived content: always automatic, never explicit.
        const response = await provider.decide(request, {
          signal: context.signal,
          origin: 'automatic',
        })
        const ranked = rankCandidates(read.files, response.answers, questionId)
        const report: DiscoveryReport = buildReport(
          name,
          `discovery:${name}:${createHash('sha256')
            .update(parsed.question)
            .update(read.files.map((file) => `${file.path}:${file.content.length}`).join(','))
            .digest('hex')
            .slice(0, 16)}`,
          questionId,
          parsed.question,
          read,
          response,
          ranked,
        )
        return { success: true, output: JSON.stringify(report) }
      } catch (error) {
        if (error instanceof ProviderError) {
          return { success: false, error: JSON.stringify({ code: error.code, message: error.message }) }
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
