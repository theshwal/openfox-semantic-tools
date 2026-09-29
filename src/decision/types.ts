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
}

export interface DecisionProvider {
  readonly id: string

  decide(
    request: DecisionRequest,
    options?: DecisionOptions,
  ): Promise<DecisionResponse>
}
