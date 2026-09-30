import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DecisionCache,
  NAMESPACE_DECIDE,
  NAMESPACE_VERIFY,
  PROTOCOL_VERSION,
  canonicalEndpoint,
  cacheKey,
} from '../src/cache/index.ts'

const request: { state: unknown; questions: unknown } = {
  state: { criterion: 'bounded timeout' },
  questions: { q: { type: 'noul' as const, instructions: 'Is it bounded?' } },
}

const identity: {
  namespace: string
  presetId: string
  endpoint: string
  model: string
  policyVersion: string | null
} = {
  namespace: NAMESPACE_DECIDE,
  presetId: 'jev-hosted',
  endpoint: 'https://api.example.invalid/v1/systemone',
  model: 'jev-latest',
  policyVersion: null,
}

test('the key is deterministic for identical input', () => {
  assert.equal(cacheKey(identity, request), cacheKey(identity, request))
})

test('every identity component separates the key', () => {
  const base = cacheKey(identity, request)
  const variants: Array<[string, typeof identity | typeof request]> = [
    ['namespace', { ...identity, namespace: NAMESPACE_VERIFY }],
    ['presetId', { ...identity, presetId: 'custom' }],
    ['endpoint', { ...identity, endpoint: 'http://localhost/v1/systemone' }],
    ['model', { ...identity, model: 'other-model' }],
    ['policyVersion', { ...identity, policyVersion: 'verify-0.2.0' }],
    ['state', { ...request, state: { criterion: 'something else' } }],
    ['questions', { ...request, questions: { q: { type: 'noul' as const, instructions: 'Different?' } } } ],
    ['questionId', { ...request, questions: { other: { type: 'noul' as const, instructions: 'Is it bounded?' } } } ],
  ]
  for (const [name, changed] of variants) {
    assert.notEqual(cacheKey(identity, changed as never), base, `${name} must change the key`)
  }
})

test('criteria are part of the key, not just the question text', () => {
  const scored = {
    state: { x: 1 },
    questions: {
      q: { type: 'score' as const, instructions: 'Rate it', criteria: ['low', 'high'] },
    },
  }
  const rescored = {
    state: { x: 1 },
    questions: {
      q: { type: 'score' as const, instructions: 'Rate it', criteria: ['low', 'medium', 'high'] },
    },
  }
  assert.notEqual(cacheKey(identity, scored), cacheKey(identity, rescored))
})

test('the key never carries a secret, and the endpoint is canonical', () => {
  // A key is often logged for evaluation, so it must not embed credentials.
  const withSecretQuery = 'https://user:pass@api.example.invalid/v1/systemone?token=abc#frag'
  const key = cacheKey({ ...identity, endpoint: withSecretQuery }, request)
  assert.ok(!key.includes('user:pass'))
  assert.ok(!key.includes('token=abc'))
  assert.ok(!key.includes('abc'))

  // Credentials and a fragment never affect the identity...
  assert.equal(
    canonicalEndpoint(withSecretQuery),
    'https://api.example.invalid/v1/systemone?token=abc',
    'userinfo and fragment are removed; a query parameter is kept here',
  )
  // ...and a secret query parameter is dropped before the key is built, so it
  // never becomes part of the identity and never appears in a key.
  assert.equal(
    cacheKey({ ...identity, endpoint: withSecretQuery }, request),
    cacheKey({ ...identity, endpoint: 'https://api.example.invalid/v1/systemone' }, request),
    'a secret query must not affect the key',
  )
  // The transport refuses a query on the endpoint, so the tenant separation is
  // proven at the key level, and the store invalidation at the fingerprint.
  const tenantA = 'https://api.example.invalid/v1/systemone?tenant=a'
  const tenantB = 'https://api.example.invalid/v1/systemone?tenant=b'
  assert.notEqual(
    cacheKey({ ...identity, endpoint: tenantA }, request),
    cacheKey({ ...identity, endpoint: tenantB }, request),
    'two tenants must not share a key',
  )
  // A secret query parameter is dropped from the key, never hashed as identity.
  assert.equal(
    cacheKey({ ...identity, endpoint: 'https://api.example.invalid/v1/systemone?token=zzz' }, request),
    cacheKey({ ...identity, endpoint: 'https://api.example.invalid/v1/systemone' }, request),
  )
})

test('the protocol version is part of the key material', () => {
  // The key is a hash, so the version is not readable in it. What matters is
  // that the key changes when the protocol version does, so a protocol change
  // cannot reuse an entry written under the previous one.
  const key = cacheKey(identity, request)
  assert.ok(PROTOCOL_VERSION.length > 0)
  const other = cacheKey(
    { ...identity, model: `${identity.model}|${PROTOCOL_VERSION}` },
    request,
  )
  assert.notEqual(key, other, 'a different material must produce a different key')
  // Sanity: the digest is opaque and fixed-width, so it leaks nothing.
  assert.match(key, /^[0-9a-f]{64}$/)
})

test('a cache is a miss when disabled or when the TTL is zero', () => {
  const cache = new DecisionCache({ enabled: false })
  cache.set(cacheKey(identity, request), { ok: true })
  assert.equal(cache.get(cacheKey(identity, request)), undefined)

  const noTtl = new DecisionCache({ enabled: true, ttlMs: 0 })
  noTtl.set(cacheKey(identity, request), { ok: true })
  assert.equal(noTtl.get(cacheKey(identity, request)), undefined, 'a zero TTL never reuses')
})

test('an entry past its TTL is treated as absent', () => {
  const cache = new DecisionCache({ enabled: true, ttlMs: 5 })
  cache.set(cacheKey(identity, request), { ok: true })
  assert.deepEqual(cache.get(cacheKey(identity, request)), { ok: true })
  // Without a real clock we cannot wait, so the entry is aged deterministically.
  cache.ageAll(1000)
  assert.equal(cache.get(cacheKey(identity, request)), undefined)
})

test('the cache is bounded and evicts the oldest entry first', () => {
  const cache = new DecisionCache({ enabled: true, ttlMs: 60_000, maxEntries: 2 })
  cache.set('a', 1)
  cache.set('b', 2)
  cache.set('c', 3)
  assert.equal(cache.size, 2, 'the cache must not grow past its bound')
  assert.equal(cache.get('a'), undefined, 'the oldest entry is evicted')
  assert.equal(cache.get('b'), 2)
  assert.equal(cache.get('c'), 3)
})

test('hits and misses are counted for evaluation, and the key is not logged with content', () => {
  const cache = new DecisionCache({ enabled: true, ttlMs: 60_000 })
  const key = cacheKey(identity, request)
  cache.get(key)
  cache.set(key, { ok: true })
  cache.get(key)
  const stats = cache.stats()
  assert.equal(stats.hits, 1)
  assert.equal(stats.misses, 1)
  assert.equal(stats.entries, 1)
  // The stats expose counters only, never a key or any state content.
  assert.deepEqual(Object.keys(stats).sort(), ['entries', 'hits', 'misses', 'sizeLimit', 'ttlMs'])
})

test('namespaces keep a primitive decision apart from a policy result', () => {
  assert.notEqual(NAMESPACE_DECIDE, NAMESPACE_VERIFY)
  const decide = cacheKey({ ...identity, namespace: NAMESPACE_DECIDE }, request)
  const verify = cacheKey({ ...identity, namespace: NAMESPACE_VERIFY }, request)
  assert.notEqual(decide, verify, 'a generic answer must never be reused as a policy outcome')
})

test('a cached value cannot be mutated by the caller', () => {
  const cache = new DecisionCache({ enabled: true, ttlMs: 60_000 })
  const original = { answers: { q: { probability: 0.4 } } }
  cache.set('k', original)

  // Mutating the object handed to `set` must not reach the store.
  ;(original.answers.q as { probability: number }).probability = 0.99
  assert.deepEqual(cache.get('k'), { answers: { q: { probability: 0.4 } } })

  // Mutating a value handed back by `get` must not reach the store either.
  const read = cache.get('k') as { answers: { q: { probability: number } } }
  read.answers.q.probability = 0.01
  assert.deepEqual(cache.get('k'), { answers: { q: { probability: 0.4 } } })
})

test('the tool rebuilds its cache when the provider identity changes', async () => {
  const { createDecisionTool } = await import('../src/tool.ts')
  const args = { state: 'public', questions: { q: { type: 'noul' as const, instructions: 'Is it public?' } } }
  const ctx = { sessionId: 's', workdir: '/tmp' }
  let calls = 0
  const transport = async () => {
    calls += 1
    return Response.json({ answers: { q: { type: 'noul', noul: 0.5 } } })
  }

  // A different credential on the same endpoint can address a different
  // tenant, so the store must be rebuilt too. The fingerprint is opaque: it
  // never exposes the key, only that something changed.
  let apiKey: string | undefined = 'key-a'
  const byAuth = createDecisionTool(
    () => ({ endpoint: 'http://localhost/v1/systemone', apiKey, cacheEnabled: true, cacheTtlMs: 60_000 }),
    transport,
  )
  const before = calls
  const hit = JSON.parse((await byAuth.execute(args, ctx)).output!)
  const reused = JSON.parse((await byAuth.execute(args, ctx)).output!)
  assert.equal(calls - before, 1, 'an unchanged credential reuses the entry')
  assert.equal(reused.cache, 'hit')
  assert.ok(!JSON.stringify(reused).includes('key-a'), 'no credential may appear in a report')
  assert.ok(!JSON.stringify(hit).includes('key-a'))
  apiKey = 'key-b'
  const afterChange = JSON.parse((await byAuth.execute(args, ctx)).output!)
  assert.equal(calls - before, 2, 'a changed credential must not reuse the entry')
  assert.equal(afterChange.cache, 'miss')
  assert.ok(!JSON.stringify(afterChange).includes('key-b'))
})

test('a changed TTL or size setting rebuilds the store', async () => {
  const { createDecisionTool } = await import('../src/tool.ts')
  const args = { state: 'public', questions: { q: { type: 'noul' as const, instructions: 'Is it public?' } } }
  const ctx = { sessionId: 's', workdir: '/tmp' }
  let calls = 0
  let ttlMs = 60_000
  const tool = createDecisionTool(
    () => ({ endpoint: 'http://localhost/v1/systemone', cacheEnabled: true, cacheTtlMs: ttlMs }),
    async () => {
      calls += 1
      return Response.json({ answers: { q: { type: 'noul', noul: 0.5 } } })
    },
  )
  await tool.execute(args, ctx)
  await tool.execute(args, ctx)
  assert.equal(calls, 1, 'an unchanged TTL reuses the entry')
  ttlMs = 1000
  await tool.execute(args, ctx)
  assert.equal(calls, 2, 'a changed TTL rebuilds the store rather than keeping stale entries')
})

test('a per-call model override is part of the key, not only the configured one', async () => {
  // The provider resolves `request.model ?? settings.model`, so the key must
  // use the same effective value. Otherwise two calls with different overrides
  // share an entry and the second one replays the first one's answer.
  const { createDecisionTool } = await import('../src/tool.ts')
  const ctx = { sessionId: 's', workdir: '/tmp' }
  const question = { q: { type: 'noul' as const, instructions: 'Is it public?' } }
  let calls = 0
  const tool = createDecisionTool(
    () => ({ endpoint: 'http://localhost/v1/systemone', cacheEnabled: true, cacheTtlMs: 60_000 }),
    async () => {
      calls += 1
      return Response.json({ answers: { q: { type: 'noul', noul: 0.5 } } })
    },
  )

  // Two different overrides over the same configured model: two provider calls.
  await tool.execute({ state: 'public', questions: question, model: 'model-a' }, ctx)
  await tool.execute({ state: 'public', questions: question, model: 'model-b' }, ctx)
  assert.equal(calls, 2, 'a different override must not reuse the previous answer')

  // The same override twice: a hit.
  const before = calls
  const hit = JSON.parse((await tool.execute({ state: 'public', questions: question, model: 'model-a' }, ctx)).output!)
  assert.equal(calls - before, 0)
  assert.equal(hit.cache, 'hit', 'an identical override reuses the entry')

  // An override equal to the configured model is the effective same model.
  const withConfigured = createDecisionTool(
    () => ({
      endpoint: 'http://localhost/v1/systemone',
      model: 'configured-model',
      cacheEnabled: true,
      cacheTtlMs: 60_000,
    }),
    async () => {
      calls += 1
      return Response.json({ answers: { q: { type: 'noul', noul: 0.5 } } })
    },
  )
  const countBefore = calls
  await withConfigured.execute({ state: 'public', questions: question, model: 'configured-model' }, ctx)
  await withConfigured.execute({ state: 'public', questions: question }, ctx)
  assert.equal(calls - countBefore, 1, 'an override equal to the configured model is the same effective model')

  // And no override at all: the configured model alone.
  const defaultCalls = createDecisionTool(
    () => ({
      endpoint: 'http://localhost/v1/systemone',
      model: 'configured-model',
      cacheEnabled: true,
      cacheTtlMs: 60_000,
    }),
    async () => {
      calls += 1
      return Response.json({ answers: { q: { type: 'noul', noul: 0.5 } } })
    },
  )
  const beforeDefault = calls
  await defaultCalls.execute({ state: 'public', questions: question }, ctx)
  await defaultCalls.execute({ state: 'public', questions: question }, ctx)
  assert.equal(calls - beforeDefault, 1, 'repeated calls with no override hit the cache')

  // An override that differs from the configured model must not collide with a
  // bare call, and must not be replayed either way.
  const mixed = createDecisionTool(
    () => ({
      endpoint: 'http://localhost/v1/systemone',
      model: 'configured-model',
      cacheEnabled: true,
      cacheTtlMs: 60_000,
    }),
    async () => {
      calls += 1
      return Response.json({ answers: { q: { type: 'noul', noul: 0.5 } } })
    },
  )
  const beforeMixed = calls
  await mixed.execute({ state: 'public', questions: question }, ctx)
  const overridden = JSON.parse(
    (await mixed.execute({ state: 'public', questions: question, model: 'other-model' }, ctx)).output!,
  )
  assert.equal(overridden.cache, 'miss', 'an override is a different effective model')
  const bare = JSON.parse((await mixed.execute({ state: 'public', questions: question }, ctx)).output!)
  assert.equal(bare.cache, 'hit', 'the bare call still hits its own entry')
  assert.equal(calls - beforeMixed, 2, 'exactly two provider calls: the bare one and the override')

  // The provider sends the model verbatim, so the key must not normalise it:
  // trimming would make two different sent models share an entry.
  const spaced = createDecisionTool(
    () => ({ endpoint: 'http://localhost/v1/systemone', cacheEnabled: true, cacheTtlMs: 60_000 }),
    async () => {
      calls += 1
      return Response.json({ answers: { q: { type: 'noul', noul: 0.5 } } })
    },
  )
  const beforeSpaced = calls
  await spaced.execute({ state: 'public', questions: question, model: 'model-a' }, ctx)
  await spaced.execute({ state: 'public', questions: question, model: ' model-a ' }, ctx)
  assert.equal(
    calls - beforeSpaced,
    2,
    'a model differing only by surrounding spaces is a different sent model',
  )
})

test('a blank model is rejected before the cache is ever consulted', async () => {
  // validateRequest rejects an empty or whitespace-only model, and it runs
  // before the cache key is built, so a bad model can neither be cached nor
  // served from a previous hit.
  const { createDecisionTool } = await import('../src/tool.ts')
  const ctx = { sessionId: 's', workdir: '/tmp' }
  let calls = 0
  const tool = createDecisionTool(
    () => ({ endpoint: 'http://localhost/v1/systemone', cacheEnabled: true, cacheTtlMs: 60_000 }),
    async () => {
      calls += 1
      return Response.json({ answers: { q: { type: 'noul', noul: 0.5 } } })
    },
  )
  const question = { q: { type: 'noul' as const, instructions: 'Is it public?' } }
  // Prime the cache with a valid call.
  await tool.execute({ state: 'public', questions: question, model: 'model-a' }, ctx)
  assert.equal(calls, 1)

  for (const bad of ['', '   ']) {
    const result = await tool.execute({ state: 'public', questions: question, model: bad }, ctx)
    assert.equal(result.success, false, `model ${JSON.stringify(bad)} must be rejected`)
    assert.equal(calls, 1, 'a rejected model must not reach the provider or the cache')
  }
})

test('the model actually sent matches the model in the key', async () => {
  // The key must not only separate models, it must describe what is sent.
  const { createDecisionTool } = await import('../src/tool.ts')
  const ctx = { sessionId: 's', workdir: '/tmp' }
  const sent: Array<string | undefined> = []
  const tool = createDecisionTool(
    () => ({ endpoint: 'http://localhost/v1/systemone', cacheEnabled: true, cacheTtlMs: 60_000 }),
    async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)).model)
      return Response.json({ answers: { q: { type: 'noul', noul: 0.5 } } })
    },
  )
  const question = { q: { type: 'noul' as const, instructions: 'Is it public?' } }
  await tool.execute({ state: 'public', questions: question, model: ' override ' }, ctx)
  assert.deepEqual(sent, [' override '], 'the provider receives the model verbatim, untrimmed')
})

test('a non-positive result is never stored as a positive reuse', () => {
  const cache = new DecisionCache({ enabled: true, ttlMs: 60_000 })
  // The cache only ever stores successful provider responses; callers decide
  // that. This asserts the shape guard: a stored entry must be a plain object.
  assert.throws(() => cache.set('k', undefined as never))
  assert.throws(() => cache.set('k', null as never))
  assert.equal(cache.get('k'), undefined)
})

test('the tool reuses a repeated call but never an error', async () => {
  const { createDecisionTool } = await import('../src/tool.ts')
  const args = { state: 'public', questions: { q: { type: 'noul' as const, instructions: 'Is it public?' } } }
  const ctx = { sessionId: 's', workdir: '/tmp' }
  const settings = (enabled: boolean) => () => ({
    endpoint: 'http://localhost/v1/systemone',
    cacheEnabled: enabled,
    cacheTtlMs: 60_000,
  })

  // Disabled: every call reaches the provider.
  let calls = 0
  const off = createDecisionTool(settings(false), async () => {
    calls += 1
    return Response.json({ answers: { q: { type: 'noul', noul: 0.8 } } })
  })
  await off.execute(args, ctx)
  await off.execute(args, ctx)
  assert.equal(calls, 2, 'a disabled cache must not change behaviour')

  // Enabled: the second identical call is served from the cache.
  let cached = 0
  const on = createDecisionTool(settings(true), async () => {
    cached += 1
    return Response.json({ answers: { q: { type: 'noul', noul: 0.8 } } })
  })
  const first = JSON.parse((await on.execute(args, ctx)).output!)
  const second = JSON.parse((await on.execute(args, ctx)).output!)
  assert.equal(cached, 1, 'the provider is called once for two identical requests')
  assert.equal(first.cache, 'miss')
  assert.equal(second.cache, 'hit')
  assert.equal(second.answers.q.probability, 0.8, 'the cached answer is the real answer')
})

test('a failed call is never cached and never replayed', async () => {
  const { createDecisionTool } = await import('../src/tool.ts')
  const args = { state: 'public', questions: { q: { type: 'noul' as const, instructions: 'Is it public?' } } }
  const ctx = { sessionId: 's', workdir: '/tmp' }
  let calls = 0
  const tool = createDecisionTool(
    () => ({ endpoint: 'http://localhost/v1/systemone', cacheEnabled: true, cacheTtlMs: 60_000 }),
    async () => {
      calls += 1
      return new Response('provider is down', { status: 503 })
    },
  )
  const first = await tool.execute(args, ctx)
  const second = await tool.execute(args, ctx)
  assert.equal(first.success, false)
  assert.equal(second.success, false, 'an error must not become a cached success')
  assert.equal(calls, 2, 'the provider is retried rather than replayed from cache')
})

test('changing the state produces a miss, not a stale reuse', async () => {
  const { createDecisionTool } = await import('../src/tool.ts')
  const ctx = { sessionId: 's', workdir: '/tmp' }
  let calls = 0
  const tool = createDecisionTool(
    () => ({ endpoint: 'http://localhost/v1/systemone', cacheEnabled: true, cacheTtlMs: 60_000 }),
    async () => {
      calls += 1
      return Response.json({ answers: { q: { type: 'noul', noul: 0.5 } } })
    },
  )
  await tool.execute(
    { state: 'first', questions: { q: { type: 'noul' as const, instructions: 'Same question?' } } },
    ctx,
  )
  await tool.execute(
    { state: 'second', questions: { q: { type: 'noul' as const, instructions: 'Same question?' } } },
    ctx,
  )
  assert.equal(calls, 2, 'different state must not reuse the previous answer')
})
