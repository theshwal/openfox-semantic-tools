import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { SystemOneHttpProvider } from '../src/providers/system-one.ts'
import { validateRequest } from '../src/decision/validation.ts'
import type { DecisionRequest } from '../src/decision/types.ts'
const request: DecisionRequest = { state: { code: 'public fixture' }, questions: {
  yes: { type: 'noul', instructions: 'Is this public?' },
  pick: { type: 'choice', instructions: 'Pick', criteria: ['a','b'] },
  rate: { type: 'score', instructions: 'Rate', criteria: ['low','high'] },
} }
const payload = { model: 'fixture', answers: { yes: { type: 'noul', noul: 0.8 }, pick: { type: 'choice', choice: 'a', probabilities: { a: 0.9, b: 0.1 } }, rate: { type: 'score', score: 0.7, probabilities: { 0: 0.3, 1: 0.7 } } } }
const settings = { endpoint: 'http://localhost:1234/v1/systemone', timeoutMs: 1000 }
test('normalizes batched typed answers and preserves request configuration', async () => {
  const p = new SystemOneHttpProvider({ ...settings, model: 'default', apiKey: 'secret' }, async (url, init) => {
    assert.equal(url, settings.endpoint); assert.equal(init?.redirect, 'error')
    assert.equal((init?.headers as Record<string,string>).Authorization, 'Bearer secret')
    assert.equal(JSON.parse(String(init?.body)).model, 'override')
    return Response.json(payload)
  })
  const r = await p.decide({ ...request, model: 'override' })
  assert.equal(r.answers.yes.type, 'noul'); assert.equal((r.answers.yes as any).probability, 0.8)
  assert.equal((r.answers.pick as any).choice, 'a'); assert.equal((r.answers.rate as any).score, 0.7)
  assert.equal(r.model, 'fixture'); assert.ok(r.latencyMs! >= 0)
})
for (const state of ['text', {}, []]) test(`supports ${JSON.stringify(state)} state`, async () => {
  await new SystemOneHttpProvider(settings, async () => Response.json(payload)).decide({ ...request, state })
})
for (const [name, body] of Object.entries({ missing: {}, partial: {answers: {yes: payload.answers.yes}}, invalidProbability: {answers: {...payload.answers, yes: {type: 'noul', noul: 2}}}, invalidDistribution: {answers: {...payload.answers, pick: {...payload.answers.pick, probabilities: {a: 0.2,b: 0.2}}}}, invalidChoice: {answers: {...payload.answers,pick: {...payload.answers.pick,choice:'c'}}} })) test(`rejects ${name}`, async () => {
  await assert.rejects(new SystemOneHttpProvider(settings, async () => Response.json(body)).decide(request), {code: 'invalid_response'})
})
test('rejects malformed JSON and sanitizes HTTP/network failures', async () => {
  await assert.rejects(new SystemOneHttpProvider(settings, async () => new Response('bad')).decide(request), {code: 'invalid_response'})
  await assert.rejects(new SystemOneHttpProvider(settings, async () => new Response('secret source', {status: 401})).decide(request), {message:'System One HTTP 401'})
  await assert.rejects(new SystemOneHttpProvider(settings, async () => {throw new Error('secret')}).decide(request), {message:'Semantic provider request failed'})
})
test('invalid input never reaches transport', async () => {
  let called = false
  const p = new SystemOneHttpProvider(settings, async () => {called = true; return Response.json(payload)})
  await assert.rejects(p.decide({...request,questions:{bad:{type:'other'}}} as any)); assert.equal(called,false)
  for (const state of [undefined, NaN, ()=>{}, new Date()]) assert.throws(()=>validateRequest({...request,state}))
})
test('actual HTTP timeout and cancellation stop a stalled response', async () => {
  const server = createServer(() => {})
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve))
  const port = (server.address() as any).port
  try {
    const p = new SystemOneHttpProvider({endpoint:`http://127.0.0.1:${port}/v1/systemone`,timeoutMs:30})
    await assert.rejects(p.decide(request),{code:'timeout'})
    const controller = new AbortController(); controller.abort()
    await assert.rejects(p.decide(request,{signal:controller.signal}),{code:'aborted'})
    const later = new AbortController(); setTimeout(()=>later.abort(),10)
    await assert.rejects(p.decide(request,{signal:later.signal}),{code:'aborted'})
  } finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())) }
})
test('rejects oversized response bodies and unsafe endpoint credentials',async()=>{
  await assert.rejects(new SystemOneHttpProvider(settings,async()=>new Response('x'.repeat(2_000_001))).decide(request),{code:'invalid_response'})
  for(const endpoint of ['file:///tmp/x','https://user:secret@example.com','https://example.com?token=secret'])assert.throws(()=>new SystemOneHttpProvider({...settings,endpoint}))
})
test('preserves object choice criteria and rejects unsupported score objects',async()=>{
  const choiceRequest:DecisionRequest={state:[],questions:{q:{type:'choice',instructions:'Pick',criteria:{a:'first',b:'second'}}}}
  await new SystemOneHttpProvider(settings,async()=>Response.json({answers:{q:payload.answers.pick}})).decide(choiceRequest)
  assert.throws(()=>validateRequest({state:'x',questions:{q:{type:'score',instructions:'Rate',criteria:{a:'first',b:'second'}}}}))
})
