import type { PluginTool } from 'openfox/plugin'

import { ProviderError, SystemOneHttpProvider } from '../providers/system-one.js'
import { parseSettings } from '../settings.js'
import type { DecisionRequest, JsonValue } from '../decision/types.js'
import {
  QUESTION_ID,
  evaluateLabelledCases,
  parseQuestionCalibrationInput,
  type CaseDecision,
  type LabelledCase,
} from './question-eval.js'

/**
 * Operator-facing question calibration.
 *
 * The tool is a thin wrapper: parsing, evaluation and metrics live in
 * `./question-eval.ts` so another use case (reference agreement) can reuse them
 * without going through the OpenFox tool boundary.
 */
export function createQuestionCalibrationTool(
  readSettings: (projectId?: string) => Record<string, unknown>,
  transport: typeof fetch = fetch,
): PluginTool {
  return {
    name: 'semantic_question_calibration',
    description:
      'Evaluate one arbitrary noul/choice/score question against operator-labelled cases and report agreement, error and calibration evidence. Advisory and inactive: never activates a threshold.',
    parameters: {
      type: 'object',
      required: ['question', 'cases'],
      additionalProperties: false,
      properties: {
        question: {
          type: 'object',
          required: ['type', 'instructions'],
          additionalProperties: false,
          properties: {
            type: { enum: ['noul', 'choice', 'score'] },
            instructions: { type: 'string', minLength: 1 },
            criteria: {
              anyOf: [
                { type: 'array', items: { type: 'string' }, minItems: 2 },
                { type: 'object', additionalProperties: { type: 'string' }, minProperties: 2 },
              ],
            },
          },
        },
        cases: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['id', 'state', 'expected'],
            additionalProperties: false,
            properties: {
              id: { type: 'string', minLength: 1 },
              state: { anyOf: [{ type: 'string' }, { type: 'object' }, { type: 'array' }] },
              expected: { anyOf: [{ type: 'boolean' }, { type: 'string' }, { type: 'number' }] },
            },
          },
        },
        questionVersion: { type: 'string', minLength: 1 },
        model: { type: 'string', minLength: 1 },
      },
    },
    async execute(args, context) {
      try {
        // Malformed arguments are rejected here, before any provider call, and
        // before a single labelled state is read into a request.
        const input = parseQuestionCalibrationInput(args)
        const rawSettings = readSettings(context.projectId)
        const settings = parseSettings(rawSettings)
        const runtimeVersion =
          typeof rawSettings.runtimeVersion === 'string' && rawSettings.runtimeVersion.trim()
            ? rawSettings.runtimeVersion.trim()
            : undefined
        const provider = new SystemOneHttpProvider(settings, transport)
        const providerIdentity = {
          presetId: settings.presetId ?? 'custom',
          ...(settings.model ? { model: settings.model } : {}),
          ...(runtimeVersion ? { runtimeVersion } : {}),
        }
        const casesById = new Map<string, LabelledCase>(input.cases.map((entry) => [entry.id, entry]))
        const decide = async (id: string): Promise<CaseDecision> => {
          const entry = casesById.get(id)
          /* c8 ignore next 3 -- the evaluator only passes ids it was given */
          if (!entry) throw new ProviderError('invalid_arguments', `Unknown case id "${id}"`)
          const request: DecisionRequest = {
            state: entry.state,
            ...(input.model ? { model: input.model } : {}),
            questions: { [QUESTION_ID]: input.question },
          }
          const response = await provider.decide(request, {
            signal: context.signal,
            // The operator supplied the states and asked for this run, so the
            // call is explicit. `block-remote-all` still refuses it above.
            origin: 'explicit',
          })
          // The response model is surfaced so the report can name what was
          // actually evaluated rather than what was merely configured.
          return { answers: response.answers, ...(response.model ? { model: response.model } : {}) }
        }
        const report = await evaluateLabelledCases({
          question: input.question,
          cases: input.cases,
          ...(input.questionVersion === undefined ? {} : { questionVersion: input.questionVersion }),
          provider: providerIdentity,
          ...(input.model === undefined ? {} : { requestedModel: input.model }),
          decide,
        })
        return { success: true, output: JSON.stringify(report) }
      } catch (error) {
        const code = error instanceof ProviderError ? error.code : 'invalid_arguments'
        // ProviderError messages are controlled and carry no endpoint, body or
        // credential; anything else may, so it is never echoed.
        const message =
          error instanceof ProviderError ? error.message : 'Invalid arguments or unavailable plugin settings'
        return { success: false, error: JSON.stringify({ code, message }) }
      }
    },
  }
}

/** Re-exported so callers can type a report without importing the module. */
export type { JsonValue }
