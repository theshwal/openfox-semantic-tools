export type JsonPrimitive = null | boolean | number | string

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface NoulQuestion {
  type: 'noul'
  instructions: string
}

export interface ChoiceQuestion {
  type: 'choice'
  instructions: string
  criteria: string[] | Record<string, string>
}

export interface ScoreQuestion {
  type: 'score'
  instructions: string
  criteria: string[] | Record<string, string>
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion

export interface DecisionRequest {
  state: string | JsonValue
  model?: string
  questions: Record<string, DecisionQuestion>
}

export interface NoulAnswer {
  type: 'noul'
  probability: number
}

export interface ChoiceAnswer {
  type: 'choice'
  choice?: string
  probabilities?: Record<string, number>
  confidence?: number
}

export interface ScoreAnswer {
  type: 'score'
  score?: number
  probabilities?: Record<string, number>
  confidence?: number
}

export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer

export interface DecisionResponse {
  provider: string
  model?: string
  answers: Record<string, DecisionAnswer>
  latencyMs?: number
}

export interface DecisionOptions {
  signal?: AbortSignal
  /**
   * Whether the call was explicitly invoked by the agent (`explicit`) or issued
   * automatically on repository/session-derived content (`automatic`).
   * Egress policy may forbid the latter on remote endpoints. Defaults to
   * `explicit` so a deliberately invoked tool call is never silently blocked.
   */
  origin?: CallOrigin
}

// Single source of truth: the egress policy owns the vocabulary.
import type { CallOrigin } from '../egress.js'
export type { CallOrigin }

export interface DecisionProvider {
  readonly id: string

  decide(
    request: DecisionRequest,
    options?: DecisionOptions,
  ): Promise<DecisionResponse>
}
