import type { PluginTool } from 'openfox/plugin'

import {
  LABEL_SCHEMA,
  STATE_SCHEMA,
  createCalibrationTool,
} from './calibration-tool.js'
import { evaluateReferenceAgreement, parseReferenceAgreementInput } from './reference-agreement.js'

/**
 * Operator-facing reference agreement.
 *
 * A thin spec over the shared calibration machinery in
 * `./calibration-tool.ts`, exactly as `semantic_question_calibration` is. The
 * reference judgments are already frozen INPUT when this tool is entered,
 * because OpenFox exposes no plugin API for invoking the active main LLM: the
 * tool makes no LLM call of its own and holds no second credential, and only
 * runs the configured System One provider over the frozen states.
 */
export function createReferenceAgreementTool(
  readSettings: (projectId?: string) => Record<string, unknown>,
  transport: typeof fetch = fetch,
): PluginTool {
  return createCalibrationTool<ReturnType<typeof parseReferenceAgreementInput>, unknown>(
    {
      name: 'semantic_reference_agreement',
      description:
        'Compare the configured semantic provider against a caller-supplied reference judgment on a frozen question and case set, and report agreement/concordance, disagreements and low-confidence agreements. Advisory and inactive: never activates a threshold and never ranks providers.',
      required: ['cases', 'reference'],
      properties: {
        cases: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['id', 'state', 'referenceAnswer'],
            additionalProperties: false,
            properties: {
              id: { type: 'string', minLength: 1 },
              state: STATE_SCHEMA,
              referenceAnswer: LABEL_SCHEMA,
              disposition: { enum: ['clear', 'ambiguous'] },
            },
          },
        },
        reference: {
          type: 'object',
          required: ['source', 'promptVersion'],
          additionalProperties: false,
          properties: {
            source: { enum: ['llm', 'human'] },
            // `null` is accepted so a previous run's `reference` block can be
            // fed straight back in, which is how the same frozen reference is
            // re-measured against a newer provider.
            model: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
            promptVersion: { type: 'string', minLength: 1 },
            recordedAt: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
          },
        },
        reviewed: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'expected'],
            additionalProperties: false,
            properties: {
              id: { type: 'string', minLength: 1 },
              expected: LABEL_SCHEMA,
            },
          },
        },
      },
      parse: (args) => {
        const parsed = parseReferenceAgreementInput(args)
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
        evaluateReferenceAgreement({
          question: input.question,
          cases: parsed.cases,
          reference: parsed.reference,
          provider,
          ...(parsed.reviewed.length ? { reviewed: parsed.reviewed } : {}),
          ...(input.questionVersion === undefined ? {} : { questionVersion: input.questionVersion }),
          ...(input.model === undefined ? {} : { requestedModel: input.model }),
          decide,
        }),
    },
    readSettings,
    transport,
  )
}
