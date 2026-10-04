import type { PluginTool, PluginToolContext } from 'openfox/plugin'

import type { DecisionQuestion, JsonValue } from '../decision/types.js'
import { ProviderError, SystemOneHttpProvider } from '../providers/system-one.js'
import { parseSettings } from '../settings.js'
import { QUESTION_ID, type CaseDecision } from './question-eval.js'
import type { ProviderIdentity } from './profile.js'

/**
 * Shared machinery for the calibration tools.
 *
 * `semantic_question_calibration` and `semantic_reference_agreement` differ
 * only in their input shape and their evaluator. Everything else — the question
 * schema, the settings read, the provider construction, the per-case `decide`
 * closure, the explicit-call egress origin, the response-model provenance and,
 * above all, the rule that only a controlled `ProviderError` message is ever
 * echoed (AGENTS.md invariant 8: no endpoint, body or credential in an error) —
 * is identical and must not drift between them. A secret-hygiene or egress fix
 * applied to one wrapper and not the other would fail silently, so the shared
 * half lives here once and both tools are thin specs over it.
 */

/** The question sub-schema both tools expose verbatim. */
export const QUESTION_SCHEMA = {
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
} as const

/** A `noul`/`choice`/`score` label, in the primitive's own domain. */
export const LABEL_SCHEMA = {
  anyOf: [{ type: 'boolean' }, { type: 'string' }, { type: 'number' }],
} as const

/** A frozen case state, with the same contract a provider request accepts. */
export const STATE_SCHEMA = {
  anyOf: [{ type: 'string' }, { type: 'object' }, { type: 'array' }],
} as const

/** Runs ONE case against the provider. */
export type DecideCase = (id: string) => Promise<CaseDecision>

export interface CalibratedInput {
  readonly question: DecisionQuestion
  /** Frozen states, keyed by case id. */
  readonly states: ReadonlyMap<string, JsonValue>
  /** The per-run model override, when the caller supplied one. */
  readonly model?: string
  /** The prompt/question version, when the caller supplied one. */
  readonly questionVersion?: string
}

export interface CalibrationToolSpec<P, E> {
  readonly name: string
  readonly description: string
  /** Tool-specific required top-level fields; `question` is added by the builder. */
  readonly required: readonly string[]
  /** Tool-specific top-level properties, without `question`/`cases`. */
  readonly properties: Readonly<Record<string, unknown>>
  /**
   * Validates the raw arguments BEFORE any settings read and before a single
   * state is read into a request, so malformed input never sends anything.
   * Returns the shared input plus whatever the evaluator still needs.
   */
  readonly parse: (args: unknown) => { input: CalibratedInput; extra: P }
  /** Runs the parsed input and returns the report to serialize. */
  readonly evaluate: (
    input: CalibratedInput,
    decide: DecideCase,
    provider: ProviderIdentity,
    extra: P,
  ) => Promise<E>
}

/**
 * Maps a thrown error to the failed tool result.
 *
 * `ProviderError` messages are controlled and carry no endpoint, body or
 * credential; anything else may, so it is never echoed. Shared so both tools
 * cannot drift on the secret-hygiene rule.
 */
function failedResult(error: unknown): { success: false; error: string } {
  const code = error instanceof ProviderError ? error.code : 'invalid_arguments'
  const message =
    error instanceof ProviderError ? error.message : 'Invalid arguments or unavailable plugin settings'
  return { success: false, error: JSON.stringify({ code, message }) }
}

/**
 * Builds a calibration tool from its spec.
 *
 * Both calibration tools are this function with a different parse and evaluate.
 * They differ nowhere else, by construction rather than by discipline.
 */
export function createCalibrationTool<P, E>(
  spec: CalibrationToolSpec<P, E>,
  readSettings: (projectId?: string) => Record<string, unknown>,
  transport: typeof fetch = fetch,
): PluginTool {
  return {
    name: spec.name,
    description: spec.description,
    parameters: {
      type: 'object',
      required: ['question', ...spec.required],
      additionalProperties: false,
      properties: {
        question: QUESTION_SCHEMA,
        ...spec.properties,
        questionVersion: { type: 'string', minLength: 1 },
        model: { type: 'string', minLength: 1 },
      },
    } as unknown as PluginTool['parameters'],
    async execute(args, context) {
      try {
        // Parsed first, before any settings read and before a single frozen
        // state is read into a request.
        const { input, extra } = spec.parse(args)
        const rawSettings = readSettings((context as PluginToolContext).projectId)
        const settings = parseSettings(rawSettings)
        const runtimeVersion =
          typeof rawSettings.runtimeVersion === 'string' && rawSettings.runtimeVersion.trim()
            ? rawSettings.runtimeVersion.trim()
            : undefined
        const provider = new SystemOneHttpProvider(settings, transport)
        const providerIdentity: ProviderIdentity = {
          presetId: settings.presetId ?? 'custom',
          ...(settings.model ? { model: settings.model } : {}),
          ...(runtimeVersion ? { runtimeVersion } : {}),
        }
        const decide: DecideCase = async (id: string) => {
          const state = input.states.get(id)
          /* c8 ignore next 3 -- the evaluators only pass ids they were given */
          if (state === undefined) throw new ProviderError('invalid_arguments', `Unknown case id "${id}"`)
          const response = await provider.decide(
            {
              state,
              ...(input.model ? { model: input.model } : {}),
              questions: { [QUESTION_ID]: input.question },
            },
            {
              signal: (context as PluginToolContext).signal,
              // The operator supplied the states and asked for this run, so the
              // call is explicit. `block-remote-all` still refuses it above.
              origin: 'explicit',
            },
          )
          // The response model is surfaced so the report can name what was
          // actually evaluated rather than what was merely configured.
          return { answers: response.answers, ...(response.model ? { model: response.model } : {}) }
        }
        const report = await spec.evaluate(input, decide, providerIdentity, extra)
        return { success: true, output: JSON.stringify(report) }
      } catch (error) {
        return failedResult(error)
      }
    },
  }
}
