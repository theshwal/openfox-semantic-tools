import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'

import {
  imageDataUrl,
  loadManifest,
  strictJsonObject,
  summarize,
  type NormalizedVisualResult,
  type VisualCase,
} from './visual-spike-lib.ts'

type Backend = 'systemone' | 'openai'

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function authHeaders(apiKey: string | undefined): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  }
}

function answerFromSystemOne(testCase: VisualCase, body: any): {
  answer: string | boolean | null
  confidence: number | null
  probability: number | null
} {
  const answer = body?.answers?.[testCase.questionId]
  if (!answer || typeof answer !== 'object') throw new Error('Missing typed answer')

  if (testCase.kind === 'choice') {
    if (answer.type !== 'choice' || typeof answer.choice !== 'string') {
      throw new Error('Malformed choice answer')
    }
    return {
      answer: answer.choice,
      confidence: typeof answer.confidence === 'number' ? answer.confidence : null,
      probability:
        answer.probabilities && typeof answer.probabilities[answer.choice] === 'number'
          ? answer.probabilities[answer.choice]
          : null,
    }
  }

  const probability =
    typeof answer.noul === 'number'
      ? answer.noul
      : typeof answer.probability === 'number'
        ? answer.probability
        : null
  if (answer.type !== 'noul' || probability === null || probability < 0 || probability > 1) {
    throw new Error('Malformed noul answer')
  }
  return {
    answer: probability >= 0.5,
    confidence: typeof answer.confidence === 'number' ? answer.confidence : null,
    probability,
  }
}

async function runSystemOne(
  testCase: VisualCase,
  image: string,
  endpoint: string,
  model: string,
  apiKey?: string,
): Promise<{ answer: string | boolean | null; confidence: number | null; probability: number | null }> {
  const question =
    testCase.kind === 'choice'
      ? {
          type: 'choice',
          instructions: testCase.instructions,
          criteria: Object.fromEntries(testCase.choices.map((choice) => [choice, choice])),
        }
      : { type: 'noul', instructions: testCase.instructions }

  const imageField = process.env.VISUAL_SYSTEMONE_IMAGE_FIELD === 'image' ? 'image' : 'images'
  const payload = {
    model,
    state: 'Judge only the supplied OpenFox screenshot.',
    questions: { [testCase.questionId]: question },
    ...(imageField === 'image' ? { image } : { images: [image] }),
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return answerFromSystemOne(testCase, await response.json())
}

function openAiPrompt(testCase: VisualCase): string {
  if (testCase.kind === 'choice') {
    return [
      testCase.instructions,
      `Allowed answers: ${testCase.choices.join(', ')}.`,
      'Return exactly one JSON object: {"answer":"<allowed answer>"}. No markdown, no explanation.',
    ].join(' ')
  }
  return [
    testCase.instructions,
    'Return exactly one JSON object: {"answer":true} or {"answer":false}. No markdown, no explanation.',
  ].join(' ')
}

async function runOpenAi(
  testCase: VisualCase,
  image: string,
  endpoint: string,
  model: string,
  apiKey?: string,
): Promise<{ answer: string | boolean | null; confidence: number | null; probability: number | null }> {
  const payload = {
    model,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: openAiPrompt(testCase) },
          { type: 'image_url', image_url: { url: image } },
        ],
      },
    ],
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body: any = await response.json()
  const content = body?.choices?.[0]?.message?.content
  if (typeof content !== 'string') throw new Error('Missing chat completion content')
  const parsed = strictJsonObject(content)
  if (testCase.kind === 'choice') {
    if (typeof parsed.answer !== 'string' || !testCase.choices.includes(parsed.answer)) {
      throw new Error('Choice baseline returned an out-of-rubric answer')
    }
  } else if (typeof parsed.answer !== 'boolean') {
    throw new Error('Noul baseline did not return a boolean')
  }
  return {
    answer: parsed.answer as string | boolean,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
    probability: null,
  }
}

async function main(): Promise<void> {
  const backend = (process.env.VISUAL_BACKEND ?? '').trim() as Backend
  if (backend !== 'systemone' && backend !== 'openai') {
    throw new Error('VISUAL_BACKEND must be systemone or openai')
  }

  const manifestPath = process.env.VISUAL_MANIFEST ?? 'benchmark/visual/cases.json'
  const fixtureRoot = required('VISUAL_FIXTURE_ROOT')
  const endpoint = required('VISUAL_ENDPOINT')
  const model = required('VISUAL_MODEL')
  const apiKey = process.env.VISUAL_API_KEY?.trim() || undefined
  const manifest = await loadManifest(resolve(manifestPath))
  const results: NormalizedVisualResult[] = []

  for (const testCase of manifest.cases) {
    const image = await imageDataUrl(fixtureRoot, testCase.image)
    const started = performance.now()
    try {
      const observed =
        backend === 'systemone'
          ? await runSystemOne(testCase, image, endpoint, model, apiKey)
          : await runOpenAi(testCase, image, endpoint, model, apiKey)
      const latencyMs = Math.round(performance.now() - started)
      results.push({
        caseId: testCase.id,
        expected: testCase.expected,
        answer: observed.answer,
        correct: observed.answer === testCase.expected,
        malformed: false,
        latencyMs,
        providerConfidence: observed.confidence,
        rawProbability: observed.probability,
        model,
        backend,
        error: null,
      })
    } catch (error) {
      results.push({
        caseId: testCase.id,
        expected: testCase.expected,
        answer: null,
        correct: null,
        malformed: true,
        latencyMs: Math.round(performance.now() - started),
        providerConfidence: null,
        rawProbability: null,
        model,
        backend,
        error: error instanceof Error ? error.message : 'unknown error',
      })
    }
  }

  const report = {
    schemaVersion: 1,
    measured: true,
    fixtureSource: manifest.source,
    backend,
    endpointClass: endpoint.startsWith('http://127.0.0.1') || endpoint.startsWith('http://localhost')
      ? 'local'
      : 'operator-supplied',
    model,
    results,
    summary: summarize(results),
    limitations: [
      'This smoke set validates visual input and bounded page/form decisions; it is not yet the 25-50 action-state dataset required for the production GO gate.',
      'falsePositiveSuccessRate remains null until success/non-success action-state cases exist.',
      'unknownFallbackRate remains null until the evaluated backend exposes or the benchmark defines an explicit abstention/fallback policy.',
      backend === 'openai'
        ? 'OpenAI-compatible chat is a conventional VLM baseline, not System One equivalence.'
        : 'System One results are backend-specific evidence and do not imply another provider/model shares the calibration.',
    ],
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'visual spike failed'}\n`)
  process.exitCode = 1
})
