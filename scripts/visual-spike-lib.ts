import { readFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'

export type VisualCase =
  | {
      id: string
      image: string
      kind: 'choice'
      questionId: string
      instructions: string
      choices: string[]
      expected: string
      groundTruthNote: string
    }
  | {
      id: string
      image: string
      kind: 'noul'
      questionId: string
      instructions: string
      expected: boolean
      groundTruthNote: string
    }

export interface VisualManifest {
  schemaVersion: 1
  source: {
    repository: string
    ref: string
    directory: string
    groundTruth: string
  }
  cases: VisualCase[]
}

export interface NormalizedVisualResult {
  caseId: string
  expected: string | boolean
  answer: string | boolean | null
  correct: boolean | null
  malformed: boolean
  latencyMs: number
  providerConfidence: number | null
  rawProbability: number | null
  model: string
  backend: 'systemone' | 'openai'
  error: string | null
}

export interface VisualSummary {
  total: number
  answered: number
  correct: number
  accuracy: number | null
  malformed: number
  malformedRate: number
  medianLatencyMs: number | null
  p95LatencyMs: number | null
  falsePositiveSuccessRate: number | null
  unknownFallbackRate: number | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function parseManifest(value: unknown): VisualManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.source) || !Array.isArray(value.cases)) {
    throw new Error('Invalid visual fixture manifest')
  }
  if (value.cases.length === 0) throw new Error('Visual fixture manifest has no cases')

  for (const [index, raw] of value.cases.entries()) {
    if (!isRecord(raw)) throw new Error(`cases[${index}] must be an object`)
    for (const field of ['id', 'image', 'kind', 'questionId', 'instructions', 'groundTruthNote']) {
      if (typeof raw[field] !== 'string' || !(raw[field] as string).trim()) {
        throw new Error(`cases[${index}].${field} must be a nonempty string`)
      }
    }
    if (raw.kind === 'choice') {
      if (!Array.isArray(raw.choices) || raw.choices.length < 2 || !raw.choices.every((x) => typeof x === 'string')) {
        throw new Error(`cases[${index}].choices must contain at least two strings`)
      }
      if (typeof raw.expected !== 'string' || !raw.choices.includes(raw.expected)) {
        throw new Error(`cases[${index}].expected must be one of choices`)
      }
    } else if (raw.kind === 'noul') {
      if (typeof raw.expected !== 'boolean') {
        throw new Error(`cases[${index}].expected must be boolean for noul`)
      }
    } else {
      throw new Error(`cases[${index}].kind is unsupported`)
    }
  }

  return value as unknown as VisualManifest
}

export async function loadManifest(path: string): Promise<VisualManifest> {
  return parseManifest(JSON.parse(await readFile(path, 'utf8')))
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

export async function imageDataUrl(root: string, image: string): Promise<string> {
  if (image.includes('\0') || image.startsWith('/') || image.includes('..')) {
    throw new Error(`Unsafe fixture image path: ${image}`)
  }
  const mime = MIME[extname(image).toLowerCase()]
  if (!mime) throw new Error(`Unsupported fixture image type: ${image}`)
  const bytes = await readFile(resolve(root, image))
  if (bytes.length === 0) throw new Error(`Fixture image is empty: ${image}`)
  return `data:${mime};base64,${bytes.toString('base64')}`
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[index]
}

export function summarize(results: readonly NormalizedVisualResult[]): VisualSummary {
  const answered = results.filter((result) => result.answer !== null && !result.malformed)
  const correct = answered.filter((result) => result.correct === true)
  const malformed = results.filter((result) => result.malformed).length
  const latencies = results.filter((result) => result.latencyMs >= 0).map((result) => result.latencyMs)

  const successNegatives = results.filter(
    (result) => result.expected !== 'success' && result.answer !== null,
  )
  const falseSuccess = successNegatives.filter((result) => result.answer === 'success').length
  const hasSuccessTaxonomy = results.some(
    (result) => result.expected === 'success' || result.answer === 'success',
  )

  // "Unknown" is intentionally not invented for backends that expose no such
  // state. A future benchmark with explicit unknown/fallback outcomes can fill
  // this field; until then null means unmeasured.
  return {
    total: results.length,
    answered: answered.length,
    correct: correct.length,
    accuracy: answered.length ? correct.length / answered.length : null,
    malformed,
    malformedRate: results.length ? malformed / results.length : 0,
    medianLatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    falsePositiveSuccessRate:
      hasSuccessTaxonomy && successNegatives.length ? falseSuccess / successNegatives.length : null,
    unknownFallbackRate: null,
  }
}

export function strictJsonObject(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text)
  if (!isRecord(parsed)) throw new Error('Response JSON must be an object')
  return parsed
}
