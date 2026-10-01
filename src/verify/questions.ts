import type { DecisionQuestion, DecisionRequest } from '../decision/types.js'
import { EVIDENCE_SUFFICIENCY_RUBRIC, type GateId } from './policy.js'
import type { VerifyState } from './state.js'

/**
 * The questions the use case always asks about the same state, in a single
 * batched provider call. Ids match the policy gate ids so a caller never has to
 * map one vocabulary onto another.
 *
 * Every question is phrased so that a HIGH answer is the desirable one, or so
 * that the risk is stated positively and read with `at-most`. The policy
 * declares the polarity; the wording is kept consistent with it here.
 */
export const VERIFY_QUESTION_IDS = {
  criterionTestable: 'criterionTestable',
  satisfied: 'satisfied',
  evidenceSufficiency: 'evidenceSufficiency',
  offScope: 'offScope',
  needsDeeperVerification: 'needsDeeperVerification',
} as const satisfies Record<GateId, GateId>

export function buildVerifyQuestions(criterion: string): Record<string, DecisionQuestion> {
  return {
    /**
     * Asked first, and about the criterion text alone. Every other question
     * assumes the criterion can be decided at all; when it cannot, their
     * answers are readings of noise. Phrased as a positive so the gate keeps
     * `high-is-good` / `at-least`: a HIGH answer means "decidable".
     */
    [VERIFY_QUESTION_IDS.criterionTestable]: {
      type: 'noul',
      instructions:
        'Considered on its own, without any implementation evidence, is the acceptance criterion ' +
        `"${criterion}" ` +
        'a checkable statement — could some concrete state of the code make it clearly true or clearly false? ' +
        'Answer high only when the criterion names observable behaviour or a measurable property. ' +
        'Answer low for a criterion that states an intention, a quality without a measure, or a vague improvement.',
    },
    [VERIFY_QUESTION_IDS.satisfied]: {
      type: 'noul',
      instructions:
        `Given only the supplied implementation evidence, is the acceptance criterion "${criterion}" actually satisfied?` +
        ' Judge the evidence, not the intent of the summary. Answer high only when the code and test output directly demonstrate the criterion.',
    },
    [VERIFY_QUESTION_IDS.evidenceSufficiency]: {
      type: 'score',
      instructions:
        'How sufficient is the supplied evidence to decide this criterion without reading the whole change?',
      criteria: [...EVIDENCE_SUFFICIENCY_RUBRIC],
    },
    [VERIFY_QUESTION_IDS.offScope]: {
      type: 'noul',
      instructions:
        'Does the implementation touch behaviour unrelated to this criterion? Answer high only when unrelated behaviour is genuinely changed.',
    },
    [VERIFY_QUESTION_IDS.needsDeeperVerification]: {
      type: 'noul',
      instructions:
        'Is there a concrete risk that this criterion is only superficially addressed and a deeper verifier pass would find a defect? Answer high when a deeper pass is warranted.',
    },
  }
}

export function buildVerifyRequest(state: VerifyState, criterion: string, model?: string): DecisionRequest {
  return {
    state: state as unknown as DecisionRequest['state'],
    ...(model ? { model } : {}),
    questions: buildVerifyQuestions(criterion),
  }
}
