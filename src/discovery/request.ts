import type { DecisionQuestion } from '../decision/types.js'
import { ProviderError } from '../errors.js'
import { isRecord } from '../decision/validation.js'
import { readBoundedCandidates, type BoundedRead } from './read.js'

/** Hard bounds, mirrored in the tool schema so the caller sees them. */
export const MAX_QUERY_LENGTH = 400
export const MAX_PREDICATE_LENGTH = 400

const ALLOWED = new Set(['query', 'predicate', 'candidates', 'model', 'root'])

function readText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProviderError('invalid_arguments', `${field} must be a nonempty string`)
  }
  if (value.length > max) {
    throw new ProviderError('invalid_arguments', `${field} exceeds ${max} characters`)
  }
  return value
}

/**
 * Builds the state sent to the provider: the caller's question, plus the exact
 * file excerpts that were read. Excerpts are labelled with their relative path
 * so the answer can refer to them, and the paths are the only location
 * information that leaves the machine.
 */
export function buildDiscoveryState(
  question: string,
  read: BoundedRead,
  questionId: string,
): Record<string, unknown> {
  return {
    question,
    files: read.files.map((file) => ({ path: file.path, content: file.content })),
    fileCount: read.files.length,
    totalBytes: read.bytes,
  }
}

export function discoveryQuestionId(questionId: string, index: number): string {
  return `${questionId}_${index}`
}

/**
 * One batched provider call, but one score question per candidate. A single
 * score over the whole list cannot rank files against each other.
 */
export function buildDiscoveryQuestions(
  question: string,
  questionId: string,
  files: readonly { path: string }[],
): Record<string, DecisionQuestion> {
  const out: Record<string, DecisionQuestion> = {}
  files.forEach((file, index) => {
    out[discoveryQuestionId(questionId, index)] = {
      type: 'score',
      instructions:
        `${question} Consider only the supplied file "${file.path}". ` +
        'Place this file on the following rubric according to how strongly its content bears on the question. ' +
        'Judge only the supplied content, and answer with the level whose probability best matches your reading.',
      criteria: [
        'The file content has no bearing on the question',
        'The file content is tangentially related to the question',
        'The file content is directly relevant to answering the question',
      ],
    }
  })
  return out
}

export interface ParsedDiscoveryInput {
  readonly question: string
  readonly questionId: string
  readonly root: string
  readonly candidates: readonly string[]
  readonly model?: string
}

/** Validates the arguments before any file is read or any request is sent. */
export function parseDiscoveryArgs(
  value: unknown,
  workdir: string,
  field: 'query' | 'predicate',
  questionId: string,
): ParsedDiscoveryInput {
  if (!isRecord(value)) {
    throw new ProviderError('invalid_arguments', 'Discovery arguments must be an object')
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED.has(key)) {
      throw new ProviderError('invalid_arguments', `Unknown discovery field "${key}"`)
    }
  }
  const question = readText(value[field], field, field === 'query' ? MAX_QUERY_LENGTH : MAX_PREDICATE_LENGTH)
  if (value.candidates !== undefined && !Array.isArray(value.candidates)) {
    throw new ProviderError('invalid_arguments', 'candidates must be an array of relative paths')
  }
  if (field === 'predicate' && value.candidates === undefined) {
    throw new ProviderError('invalid_arguments', 'semantic_scan requires explicit candidates')
  }
  const model = value.model === undefined ? undefined : readText(value.model, 'model', 200)
  // The root defaults to the session workdir and is resolved by read.ts, which
  // confines every candidate to it.
  const root = value.root === undefined ? workdir : readText(value.root, 'root', 4096)
  return {
    question,
    questionId,
    root,
    candidates: (value.candidates as unknown[] | undefined)?.map((c) => {
      if (typeof c !== 'string') {
        throw new ProviderError('invalid_arguments', 'candidates must contain only strings')
      }
      return c
    }) ?? [],
    ...(model ? { model } : {}),
  }
}
