import type { DecisionQuestion, DecisionRequest } from '../decision/types.js'
import { EVIDENCE_SUFFICIENCY_RUBRIC, type GateId } from './policy.js'
import type { VerifyState } from './state.js'

/**
 * The four questions the use case always asks about the same state, in a single
 * batched provider call. Ids match the policy gate ids so a caller never has to
 * map one vocabulary onto another.
 *
 * Every question is phrased so that a HIGH answer is the desirable one, or so
 * that the risk is stated positively and read with `at-most`. The policy
 * declares the polarity; the wording is kept consistent with it here.
 */
export const VERIFY_QUESTION_IDS = {
  satisfied: 'satisfied',
  evidenceSufficiency: 'evidenceSufficiency',
  offScope: 'offScope',
  needsDeeperVerification: 'needsDeeperVerification',
} as const satisfies Record<GateId, GateId>

export function buildVerifyQuestions(criterion: string): Record<string, DecisionQuestion> {
  return {
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
        'Is the implementation staying on scope for this criterion, rather than changing unrelated behaviour? Answer high only when unrelated behaviour is genuinely touched.',
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
