import type { DecisionQuestion, DecisionRequest } from '../decision/types.js'
import { capabilityOf } from './index.js'

/**
 * Applies the ONE protocol deviation a preset has actually declared.
 *
 * A conformance run observed that some System One-compatible runtimes refuse
 * `choice` questions whose `criteria` are a plain array while serving the
 * object-map form. Rather than teaching the transport about vendors, the
 * deviation is data: a preset that explicitly declares
 * `choiceArrayCriteria: false` gets its array criteria rewritten into the
 * equivalent identity object map, `{ label: 'label' }`.
 *
 * The rewrite is strictly minimal and semantically neutral:
 *
 * - only `choice` questions with a `string[]` criteria are touched. `score`
 *   criteria stay an ordered array, because the common contract requires the
 *   ordered form there and the rubric order carries meaning;
 * - the labels are preserved, in order, so the answer still validates against
 *   exactly the same label set and the reported choice is unchanged;
 * - `noul` questions carry no criteria and are returned untouched;
 * - a `choice` question that already uses object criteria is returned
 *   untouched, since it is already in the form the runtime serves.
 *
 * Anything not explicitly observed stays untouched. A preset that declares
 * `true`, `unverified`, or no declaration at all — including `custom` — sends
 * the caller's criteria verbatim, so absence of evidence never rewrites a
 * request.
 *
 * The input request is never mutated: a new request object is returned so a
 * caller can still hash or display what it originally asked.
 */
export function adaptRequestForPreset(request: DecisionRequest, presetId: unknown): DecisionRequest {
  if (capabilityOf(presetId, 'choiceArrayCriteria') !== false) return request

  let adapted = false
  const questions: Record<string, DecisionQuestion> = {}
  for (const [id, question] of Object.entries(request.questions)) {
    const rewritten = identityCriteria(question)
    if (rewritten !== question) adapted = true
    questions[id] = rewritten
  }
  return adapted
    ? { ...request, questions }
    : request
}

function identityCriteria(question: DecisionQuestion): DecisionQuestion {
  if (question.type !== 'choice' || !Array.isArray(question.criteria)) return question
  const criteria: Record<string, string> = {}
  for (const label of question.criteria) criteria[label] = label
  return { ...question, criteria }
}
