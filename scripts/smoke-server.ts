// Offline smoke server implementing a minimal System One contract.
// Used to exercise `npm run conformance` without a hosted or paid provider.
import { createServer } from 'node:http'

const server = createServer((incoming, response) => {
  const chunks: Buffer[] = []
  incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
  incoming.on('end', () => {
    let body: Record<string, any> = {}
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {}
    // Offline auth simulation, used by the auth probe in the conformance
    // suite. Enabled only by an explicit env var so the default offline smoke
    // run stays credential-free.
    const requiredKey = process.env.SMOKE_REQUIRED_KEY
    if (requiredKey && incoming.headers.authorization !== `Bearer ${requiredKey}`) {
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'invalid api key' }))
      return
    }
    if (!body.questions || !body.state) {
      response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'invalid request' }))
      return
    }
    const questions = body.questions as Record<string, Record<string, any>>
    for (const question of Object.values(questions)) {
      if (!question || !['noul', 'choice', 'score'].includes(question.type) || typeof question.instructions !== 'string' || !question.instructions.trim()) {
        response.writeHead(400, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: 'invalid question' }))
        return
      }
    }
    if (body.model === 'unsupported-model-for-smoke') {
      response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'unknown model' }))
      return
    }
    const answers: Record<string, unknown> = {}
    for (const [id, question] of Object.entries(questions)) {
      const criteria: string[] = Array.isArray(question.criteria)
        ? question.criteria
        : Object.keys(question.criteria ?? {})
      if (question.type === 'noul') answers[id] = { type: 'noul', noul: 0.8 }
      else if (question.type === 'choice') {
        answers[id] = {
          type: 'choice',
          choice: criteria[0],
          probabilities: Object.fromEntries(criteria.map((label, index) => [label, index === 0 ? 0.6 : 0.4 / (criteria.length - 1)])),
        }
      } else {
        answers[id] = {
          type: 'score',
          score: 1,
          probabilities: Object.fromEntries(criteria.map((_label, index) => [String(index), index === criteria.length - 1 ? 0.7 : 0.3 / (criteria.length - 1)])),
        }
      }
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ model: body.model ?? 'smoke-model', answers }))
  })
})

server.listen(Number(process.env.SMOKE_PORT ?? 8787), '127.0.0.1', () => {
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  console.log(`smoke system-one listening on 127.0.0.1:${port}`)
})
