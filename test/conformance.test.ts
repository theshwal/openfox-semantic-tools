import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, type Server } from 'node:http'
import { classifyEndpoint } from '../src/egress.ts'
import { SystemOneHttpProvider } from '../src/providers/system-one.ts'
import type { DecisionRequest } from '../src/decision/types.ts'

const request: DecisionRequest = {
  state: 'A public synthetic test passes.',
  questions: {
    noul: { type: 'noul', instructions: 'Does the state report a passing test?' },
    choice: { type: 'choice', instructions: 'Choose the outcome', criteria: { pass: 'Test passes', fail: 'Test fails' } },
    score: { type: 'score', instructions: 'Rate the evidence', criteria: ['No evidence', 'Reported result'] },
  },
}

/** A minimal System One-shaped server used to keep conformance evidence offline. */
function startServer(handler: (body: string) => { status: number; payload?: unknown }): Promise<{ server: Server; url: string }> {
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = []
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
    incoming.on('end', () => {
      const { status, payload } = handler(Buffer.concat(chunks).toString('utf8'))
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(payload === undefined ? '' : JSON.stringify(payload))
    })
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/systemone` }),
    ),
  )
}

async function stop(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

const wellFormed = (ids: string[]) => ({
  answers: Object.fromEntries(
    ids.map((id) => [
      id,
      id === 'noul'
        ? { type: 'noul', noul: 0.82 }
        : id === 'choice'
          ? { type: 'choice', choice: 'pass', probabilities: { pass: 0.7, fail: 0.3 } }
          : { type: 'score', score: 1, probabilities: { '0': 0.25, '1': 0.75 } },
    ]),
  ),
})

test('offline server satisfies the mixed question batch and normalizes answers', async () => {
  const { server, url } = await startServer((body) => ({ status: 200, payload: wellFormed(Object.keys(JSON.parse(body).questions)) }))
  try {
    const response = await new SystemOneHttpProvider({ endpoint: url, timeoutMs: 2000 }).decide(request)
    assert.equal(response.provider, 'system-one')
    assert.equal((response.answers.noul as { probability: number }).probability, 0.82)
    assert.equal((response.answers.choice as { choice?: string }).choice, 'pass')
    assert.equal((response.answers.score as { score?: number }).score, 1)
  } finally { await stop(server) }
})

test('a runtime rejecting a question id is detected, not silently dropped', async () => {
  const { server, url } = await startServer((body) => {
    const ids = Object.keys(JSON.parse(body).questions)
    return { status: 200, payload: wellFormed(ids.slice(0, -1)) }
  })
  try {
    await assert.rejects(new SystemOneHttpProvider({ endpoint: url, timeoutMs: 2000 }).decide(request), { code: 'invalid_response' })
  } finally { await stop(server) }
})

test('auth failure shape is observable as an http error without echoing the body', async () => {
  const { server, url } = await startServer(() => ({ status: 401, payload: { error: 'invalid api key sk-secret-value' } }))
  try {
    const error = await new SystemOneHttpProvider({ endpoint: url, timeoutMs: 2000, apiKey: 'sk-secret-value' })
      .decide(request)
      .then(() => null, (e: unknown) => e)
    assert.equal((error as { code?: string }).code, 'http')
    assert.ok(!String((error as Error).message).includes('sk-secret-value'))
  } finally { await stop(server) }
})

test('a 200 response that is not valid JSON is rejected', async () => {
  const server = createServer((_incoming, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end('not json at all')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/systemone`
  try {
    await assert.rejects(new SystemOneHttpProvider({ endpoint: url, timeoutMs: 2000 }).decide(request), { code: 'invalid_response' })
  } finally { await stop(server) }
})

test('unsupported model ids are surfaced by the runtime rather than guessed', async () => {
  const seen: Array<string | undefined> = []
  const { server, url } = await startServer((body) => {
    const parsed = JSON.parse(body) as { model?: string; questions: object }
    seen.push(parsed.model)
    if (parsed.model === 'definitely-not-a-model') return { status: 400, payload: { error: 'unknown model' } }
    return { status: 200, payload: wellFormed(Object.keys(parsed.questions)) }
  })
  try {
    const provider = new SystemOneHttpProvider({ endpoint: url, timeoutMs: 2000 })
    await assert.rejects(provider.decide({ ...request, model: 'definitely-not-a-model' }), { code: 'http' })
    const ok = await provider.decide(request)
    assert.equal(ok.provider, 'system-one')
    assert.deepEqual(seen, ['definitely-not-a-model', undefined])
    assert.equal(seen[1], undefined, 'model must be omitted rather than invented')
  } finally { await stop(server) }
})

test('a localhost conformance target is classified as local', () => {
  assert.equal(classifyEndpoint('http://127.0.0.1:8080/v1/systemone'), 'local')
})
