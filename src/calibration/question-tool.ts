import type { PluginTool } from 'openfox/plugin'

import type { JsonValue } from '../decision/types.js'
import {
  LABEL_SCHEMA,
  STATE_SCHEMA,
  createCalibrationTool,
  type CalibratedInput,
} from './calibration-tool.js'
import { evaluateLabelledCases, parseQuestionCalibrationInput } from './question-eval.js'

/**
 * Operator-facing question calibration.
 *
 * A thin spec over the shared calibration machinery in
 * `./calibration-tool.ts`. Parsing, evaluation and metrics live in
 * `./question-eval.ts` so another use case (reference agreement) can reuse them
 * without going through the OpenFox tool boundary; the provider call, the
 * egress origin and the error mapping live in the shared builder so they cannot
 * drift from the other calibration tool.
 */
export function createQuestionCalibrationTool(
  readSettings: (projectId?: string) => Record<string, unknown>,
  transport: typeof fetch = fetch,
): PluginTool {
  return createCalibrationTool<ReturnType<typeof parseQuestionCalibrationInput>, unknown>(
    {
      name: 'semantic_question_calibration',
      description:
        'Evaluate one arbitrary noul/choice/score question against operator-labelled cases and report agreement, error and calibration evidence. Advisory and inactive: never activates a threshold.',
      required: ['cases'],
      properties: {
        cases: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['id', 'state', 'expected'],
            additionalProperties: false,
            properties: {
              id: { type: 'string', minLength: 1 },
              state: STATE_SCHEMA,
              expected: LABEL_SCHEMA,
            },
          },
        },
      },
      // The parser is the single gate: it rejects an unknown field, a bad label
      // and an oversized state before any settings read or provider request.
      parse: (args) => {
        const parsed = parseQuestionCalibrationInput(args)
        return {
          input: {
            question: parsed.question,
            states: new Map(parsed.cases.map((entry) => [entry.id, entry.state])),
            ...(parsed.model === undefined ? {} : { model: parsed.model }),
            ...(parsed.questionVersion === undefined ? {} : { questionVersion: parsed.questionVersion }),
          },
          extra: parsed,
        }
      },
      evaluate: (input, decide, provider, parsed) =>
        evaluateLabelledCases({
          question: input.question,
          cases: parsed.cases,
          ...(input.questionVersion === undefined ? {} : { questionVersion: input.questionVersion }),
          provider,
          ...(input.model === undefined ? {} : { requestedModel: input.model }),
          decide,
        }),
    },
    readSettings,
    transport,
  )
}

/** Re-exported so callers can type a report without importing the module. */
export type { JsonValue, CalibratedInput }
