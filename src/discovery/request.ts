import type { DecisionQuestion } from '../decision/types.js'
import { ProviderError } from '../errors.js'
import { isRecord } from '../decision/validation.js'
import type { Fragment } from './fragments.js'

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
 * Builds the state sent to the provider: the caller's question, plus the
 * FRAGMENTS that were read.
 *
 * Fragments, not files: a decision model is asked to judge a declaration, not
 * to read a module. Handing it whole files cost ~4 000 tokens per question,
 * which is what turned a few searches into millions of tokens. Each fragment
 * carries its path and line range, so the answer can be acted on by reading
 * the real code afterwards, and `kind` so a preview is never mistaken for a
 * complete view of the file.
 */
export function buildDiscoveryState(
  question: string,
  fragments: readonly Fragment[],
): Record<string, unknown> {
  return {
    question,
    fragments: fragments.map((fragment) => ({
      path: fragment.path,
      lines: `${fragment.startLine}-${fragment.endLine}`,
      kind: fragment.kind,
      text: fragment.text,
    })),
    fragmentCount: fragments.length,
    totalBytes: fragments.reduce((sum, fragment) => sum + fragment.bytes, 0),
    note:
      'fragments are declaration signatures with bodies elided, or a declared preview of an unparseable file; read the file for the full source',
  }
}

export function discoveryQuestionId(questionId: string, index: number): string {
  return `${questionId}_${index}`
}

/**
 * One batched provider call, one score question per FRAGMENT.
 *
 * A single score over the whole list cannot rank candidates against each
 * other. The instruction names the file AND the line range, so the answer says
 * which declaration is relevant rather than merely which file is — which is the
 * difference between a lead the agent can use and one it has to re-explore.
 */
export function buildDiscoveryQuestions(
  question: string,
  questionId: string,
  fragments: readonly Fragment[],
): Record<string, DecisionQuestion> {
  const out: Record<string, DecisionQuestion> = {}
  fragments.forEach((fragment, index) => {
    out[discoveryQuestionId(questionId, index)] = {
      type: 'score',
      instructions:
        `${question} Consider only the supplied fragment of "${fragment.path}" ` +
        `(lines ${fragment.startLine}-${fragment.endLine}, body elided). ` +
        'Place this declaration on the following rubric according to how strongly its ' +
        'signature bears on the question. Judge only the supplied signature, and answer ' +
        'with the level whose probability best matches your reading.',
      criteria: [
        'This declaration has no bearing on the question',
        'This declaration is tangentially related to the question',
        'This declaration is directly relevant to answering the question',
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
