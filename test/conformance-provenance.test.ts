import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'

/** Runs the real conformance script and returns the parsed redacted report. */
async function runConformance(
  env: Record<string, string>,
): Promise<{ report: Record<string, any>; exitCode: number }> {
  const out = await mkdtemp(join(tmpdir(), 'semantic-conformance-test-'))
  try {
    const exitCode = await new Promise<number>((resolve) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'scripts/conformance.ts', out],
        { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, stdio: ['ignore', 'ignore', 'ignore'] },
      )
      child.on('exit', (code) => resolve(code ?? 1))
    })
    const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'))
    return { report, exitCode }
  } finally {
    await rm(out, { recursive: true, force: true })
  }
}

// An address that nothing listens on: the connection attempt fails fast.
const UNREACHABLE = 'http://127.0.0.1:1/v1/systemone'

test('an unreachable endpoint never asserts a live or identified provider', async () => {
  const { report, exitCode } = await runConformance({
    SEMANTIC_ENDPOINT: UNREACHABLE,
    SEMANTIC_PROVIDER_ID: 'definitely-not-a-real-provider',
  })
  assert.equal(report.endpointReachable, false)
  assert.equal(report.remoteEndpointObserved, false)
  assert.equal(report.localEndpointObserved, false)
  assert.equal(report.protocolConformanceObserved, false)
  // A typed label is a label, not a verification.
  assert.equal(report.providerLabelExplicitlyConfigured, true)
  assert.equal(report.compatible, false)
  assert.notEqual(exitCode, 0)
})

test('the report contains no provider identity or provider-verification field', async () => {
  const { report } = await runConformance({ SEMANTIC_ENDPOINT: UNREACHABLE })
  for (const forbidden of [
    'liveProviderVerified',
    'providerIdentityVerified',
    'provenance',
    'provider',
    'verified',
  ]) {
    assert.equal(forbidden in report, false, `report must not publish "${forbidden}"`)
  }
  assert.equal(report.schemaVersion, 2)
  assert.equal(report.providerLabel, 'unknown')
})

test('a loopback stub behind a remote-looking hostname asserts no identity', async () => {
  // nip.io-style: a public-looking hostname that resolves to 127.0.0.1. The
  // syntactic classification says `remote`, but nothing about who answered may
  // be claimed, and no identity/verification field may reappear.
  const { spawn: spawnChild } = await import('node:child_process')
  const child = spawnChild(process.execPath, ['--import', 'tsx', 'scripts/smoke-server.ts'], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, SMOKE_PORT: '8918' },
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('smoke server timeout')), 10_000)
    child.stdout!.on('data', (chunk: Buffer) => {
      if (String(chunk).includes('listening')) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  try {
    // Public-looking hostname resolving to loopback. If the alias cannot be
    // resolved (offline CI), the run is reported unreachable, which is still a
    // valid check that no identity is asserted either way.
    const { report } = await runConformance({
      SEMANTIC_ENDPOINT: 'http://127.0.0.1.localtest.me:8918/v1/systemone',
      // No label configured at all.
      SEMANTIC_PROVIDER_ID: 'unknown',
      SEMANTIC_MODEL: 'smoke-model',
      SEMANTIC_UNSUPPORTED_MODEL: 'unsupported-model-for-smoke',
    })
    // Whatever the resolution outcome, no identity may be claimed and no
    // verification field may exist.
    assert.equal(report.providerLabelExplicitlyConfigured, false)
    assert.equal(report.providerLabel, 'unknown')
    for (const forbidden of ['liveProviderVerified', 'providerIdentityVerified', 'provenance']) {
      assert.equal(forbidden in report, false, forbidden)
    }
    if (report.endpointReachable) {
      // The stub did answer: classification is remote, yet nothing is certified.
      assert.equal(report.endpointClassification, 'remote')
      assert.equal(report.remoteEndpointObserved, true)
      assert.equal(report.protocolConformanceObserved, true)
    } else {
      assert.equal(report.remoteEndpointObserved, false)
      assert.equal(report.protocolConformanceObserved, false)
    }
  } finally {
    child.kill('SIGTERM')
  }
})

test('a transport failure does not mark negative capabilities as verified', async () => {
  const { report } = await runConformance({
    SEMANTIC_ENDPOINT: UNREACHABLE,
    SEMANTIC_PROVIDER_ID: 'unreachable-probe',
    SEMANTIC_UNSUPPORTED_MODEL: 'some-unsupported-model',
  })
  assert.equal(report.capabilities.rejectsUnsupportedModel, 'unverified')
  assert.equal(report.capabilities.runtimeRejectsMalformedWirePayload, 'unverified')
  // Client-side validation is local: it holds even when nothing answered.
  assert.equal(report.capabilities.clientRejectsMalformedQuestion, true)
  assert.ok(report.unverified.includes('rejectsUnsupportedModel'))
  assert.ok(report.transportFailures > 0, 'transport failures must be counted, not hidden')
})

test('a uniform 400 response is not read as protocol rejection capability', async () => {
  // The runtime answers, but refuses every request with the same blanket error.
  const server: Server = createServer((_incoming, response) => {
    response.writeHead(400, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: 'nope' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  try {
    const { report } = await runConformance({
      SEMANTIC_ENDPOINT: `http://127.0.0.1:${port}/v1/systemone`,
      SEMANTIC_PROVIDER_ID: 'blanket-400-runtime',
      SEMANTIC_UNSUPPORTED_MODEL: 'some-unsupported-model',
    })
    assert.equal(report.blanketRejection, true)
    assert.equal(report.endpointReachable, false, 'no positive case was answered')
    assert.equal(report.protocolConformanceObserved, false)
    assert.equal(report.compatible, false)
    // The blanket error is not protocol evidence for a targeted rejection.
    assert.equal(report.capabilities.rejectsUnsupportedModel, 'unverified')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('a local stub reports observations without asserting any identity', async () => {  const { spawn: spawnChild } = await import('node:child_process')
  const child = spawnChild(process.execPath, ['--import', 'tsx', 'scripts/smoke-server.ts'], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, SMOKE_PORT: '8913' },
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('smoke server timeout')), 10_000)
    child.stdout!.on('data', (chunk: Buffer) => {
      if (String(chunk).includes('listening')) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  try {
    const { report, exitCode } = await runConformance({
      SEMANTIC_ENDPOINT: 'http://127.0.0.1:8913/v1/systemone',
      SEMANTIC_PROVIDER_ID: 'offline-smoke-stub',
      SEMANTIC_MODEL: 'smoke-model',
      SEMANTIC_UNSUPPORTED_MODEL: 'unsupported-model-for-smoke',
    })
    assert.equal(report.endpointReachable, true)
    assert.equal(report.localEndpointObserved, true)
    assert.equal(report.remoteEndpointObserved, false)
    assert.equal(report.protocolConformanceObserved, true)
    assert.equal(report.compatible, true)
    assert.equal(report.strictCompatible, true)
    // The finding: a stub is observed, never certified.
    for (const forbidden of ['liveProviderVerified', 'providerIdentityVerified', 'provenance']) {
      assert.equal(forbidden in report, false, forbidden)
    }
    assert.equal(exitCode, 0)
  } finally {
    child.kill('SIGTERM')
  }
})

// --- #7: campaign metadata, model omission on the wire, and the auth probe. ---

/** Starts the offline stub, optionally requiring a bearer key. */
async function startStub(port: number, env: Record<string, string> = {}): Promise<() => void> {
  const { spawn: spawnChild } = await import('node:child_process')
  const child = spawnChild(process.execPath, ['--import', 'tsx', 'scripts/smoke-server.ts'], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, SMOKE_PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('smoke server timeout')), 10_000)
    child.stdout!.on('data', (chunk: Buffer) => {
      if (String(chunk).includes('listening')) { clearTimeout(timer); resolve() }
    })
  })
  return () => child.kill('SIGTERM')
}

test('campaign metadata records dates, declared values and no secrets', async () => {
  const stopStub = await startStub(8921)
  try {
    const { report } = await runConformance({
      SEMANTIC_ENDPOINT: 'http://127.0.0.1:8921/v1/systemone',
      SEMANTIC_PROVIDER_ID: 'offline-smoke-stub',
      SEMANTIC_MODEL: 'smoke-model',
      SEMANTIC_RUNTIME_VERSION: 'stub-0.0.1',
      SEMANTIC_UNSUPPORTED_MODEL: 'unsupported-model-for-smoke',
      SEMANTIC_API_KEY: 'sk-super-secret-value',
    })
    assert.ok(report.campaign, 'campaign metadata must be present')
    assert.ok(Date.parse(report.campaign.startedAt) > 0, 'startedAt must be a valid date')
    assert.ok(Date.parse(report.campaign.finishedAt) > 0, 'finishedAt must be a valid date')
    assert.ok(
      Date.parse(report.campaign.startedAt) <= Date.parse(report.campaign.finishedAt),
      'startedAt must not be after finishedAt',
    )
    assert.equal(report.campaign.runtimeVersion, 'stub-0.0.1')
    assert.equal(report.campaign.model, 'smoke-model')
    assert.equal(report.campaign.command, 'npm run conformance -- <report-directory>')
    // Declarative vs observed must be explicit, not guessed by the reader.
    assert.equal(report.campaign.provenance.runtimeVersion, 'operator-declared')
    assert.equal(report.campaign.provenance.model, 'operator-declared')
    assert.equal(report.campaign.provenance.startedAt, 'observed')
    // No secret, endpoint or key anywhere in the serialized report.
    const serialized = JSON.stringify(report)
    assert.ok(!serialized.includes('sk-super-secret-value'), 'api key must never be persisted')
    assert.ok(!serialized.includes('Bearer'), 'authorization header must never be persisted')
    assert.ok(!serialized.includes('127.0.0.1:8921'), 'endpoint host must not be persisted')
    assert.equal(report.endpoint, 'redacted')
  } finally { stopStub() }
})

test('undeclared runtime version is null rather than invented', async () => {
  const { report } = await runConformance({
    SEMANTIC_ENDPOINT: UNREACHABLE,
    SEMANTIC_PROVIDER_ID: 'unreachable-probe',
  })
  assert.equal(report.campaign.runtimeVersion, null)
  assert.equal(report.campaign.model, null, 'no configured model must be reported as null, not guessed')
})

test('model-omitted really sends no model on the wire, with SEMANTIC_MODEL configured', async () => {
  // The regression from #7: the case used to be measured with a configured
  // default silently filling the model back in, so it re-tested the default
  // instead of omission. The evidence here is a REAL stub that records the
  // exact bodies it receives, so the assertion rests on what crossed the wire
  // rather than on the suite describing itself.
  const captured: Array<{ model?: string }> = []
  const server: Server = createServer((incoming, response) => {
    const chunks: Buffer[] = []
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
    incoming.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const parsed = JSON.parse(raw) as { model?: string }
      captured.push(parsed)
      const body = JSON.parse(raw) as { questions: Record<string, unknown> }
      const answers: Record<string, unknown> = {}
      for (const id of Object.keys(body.questions)) answers[id] = { type: 'noul', noul: 0.8 }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ model: parsed.model ?? 'stub-default-model', answers }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  try {
    // A model IS configured: exactly the condition that used to defeat the case.
    const { report } = await runConformance({
      SEMANTIC_ENDPOINT: `http://127.0.0.1:${port}/v1/systemone`,
      SEMANTIC_PROVIDER_ID: 'model-omission-probe',
      SEMANTIC_MODEL: 'smoke-model',
    })
    assert.equal(captured.length > 0, true, 'the stub must have received requests')
    // Everything except the explicit model case must arrive with no model.
    assert.equal(
      captured.some((entry) => entry.model !== undefined),
      true,
      'the model-supplied case must reach the wire with its model',
    )
    assert.equal(
      captured.filter((entry) => entry.model === 'smoke-model').length,
      1,
      'exactly one request may carry the configured model: the explicit model-supplied case',
    )
    // And the report must state the mechanism rather than a self-assessment.
    assert.equal(report.modelOmittedOnWire.suiteProviderHasDefaultModel, false)
    assert.ok(report.modelOmittedOnWire.detail.length > 0)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('the auth probe is opt-in and reports unverified when absent', async () => {
  const { report } = await runConformance({
    SEMANTIC_ENDPOINT: UNREACHABLE,
    SEMANTIC_PROVIDER_ID: 'unreachable-probe',
  })
  assert.equal(report.authProbe.attempted, false)
  assert.equal(report.authProbe.reason, 'not-requested')
  assert.equal(report.authProbe.requiresAuth, 'unverified')
  // Auth must not leak into compatibility: it is an observation, not a rule.
  assert.ok(!('requiresAuth' in report.capabilities), 'auth must never be a capability')
  assert.ok(!report.failedBaseCapabilities.includes('requiresAuth'))
})

test('the auth probe observes a credential-enforcing endpoint', async () => {
  const stopStub = await startStub(8923, { SMOKE_REQUIRED_KEY: 'sk-required-value' })
  try {
    const { report } = await runConformance({
      SEMANTIC_ENDPOINT: 'http://127.0.0.1:8923/v1/systemone',
      SEMANTIC_PROVIDER_ID: 'auth-enforcing-stub',
      SEMANTIC_MODEL: 'smoke-model',
      SEMANTIC_UNSUPPORTED_MODEL: 'unsupported-model-for-smoke',
      SEMANTIC_API_KEY: 'sk-required-value',
      SEMANTIC_AUTH_PROBE: 'omit',
    })
    assert.equal(report.authProbe.attempted, true)
    // Without the header the endpoint answers 401, which isolates credentials.
    assert.equal(report.authProbe.requiresAuth, true)
    assert.equal(report.authProbe.httpStatus, 401)
    assert.equal(report.authProbe.normalizedWithoutAuth, false)
    assert.ok(!JSON.stringify(report).includes('sk-required-value'), 'the key must never be persisted')
    // This stub is selective: it enforces the key *and* answers a genuine 400
    // to the unsupported model, so the authenticated negative case remains
    // legitimate targeted protocol evidence.
    assert.equal(report.capabilities.rejectsUnsupportedModel, true)
  } finally { stopStub() }
})

test('an endpoint answering only 401 is never read as protocol rejection evidence', async () => {
  // A rejected credential on the authenticated path says nothing about whether
  // the runtime understands the payload. This must stay unverified, and the
  // run must not claim conformance.
  const server: Server = createServer((_incoming, response) => {
    response.writeHead(401, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: 'invalid api key sk-secret-value' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  try {
    const { report, exitCode } = await runConformance({
      SEMANTIC_ENDPOINT: `http://127.0.0.1:${port}/v1/systemone`,
      SEMANTIC_PROVIDER_ID: 'always-401-runtime',
      SEMANTIC_UNSUPPORTED_MODEL: 'some-unsupported-model',
      SEMANTIC_API_KEY: 'sk-secret-value',
    })
    // The numeric status is preserved for diagnosis...
    assert.equal(report.results.find((r: any) => r.id === 'unsupported-model')?.httpStatus, 401)
    // ...but it cannot prove a targeted rejection.
    assert.equal(report.capabilities.rejectsUnsupportedModel, 'unverified')
    assert.equal(report.endpointReachable, false)
    assert.equal(report.compatible, false)
    assert.notEqual(exitCode, 0)
    // The body, key and endpoint are never persisted.
    assert.ok(!JSON.stringify(report).includes('sk-secret-value'))
    assert.ok(!JSON.stringify(report).includes('invalid api key'))
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('the auth probe observes an endpoint that ignores credentials', async () => {
  // A local unauthenticated endpoint is allowed to answer normally: this must
  // be a legitimate observation, never a compatibility failure.
  const stopStub = await startStub(8924)
  try {
    const { report, exitCode } = await runConformance({
      SEMANTIC_ENDPOINT: 'http://127.0.0.1:8924/v1/systemone',
      SEMANTIC_PROVIDER_ID: 'unauthenticated-local-stub',
      SEMANTIC_MODEL: 'smoke-model',
      SEMANTIC_UNSUPPORTED_MODEL: 'unsupported-model-for-smoke',
      SEMANTIC_API_KEY: 'sk-configured-but-unused',
      SEMANTIC_AUTH_PROBE: 'omit',
    })
    assert.equal(report.authProbe.attempted, true)
    assert.equal(report.authProbe.requiresAuth, false)
    assert.equal(report.authProbe.normalizedWithoutAuth, true)
    assert.equal(report.compatible, true, 'an unauthenticated local endpoint must stay compatible')
    assert.equal(exitCode, 0)
  } finally { stopStub() }
})

test('the auth probe stays unverified when it cannot isolate credentials', async () => {
  // No key configured: probing would measure nothing, so it is not attempted.
  const stopStub = await startStub(8925)
  try {
    const { report } = await runConformance({
      SEMANTIC_ENDPOINT: 'http://127.0.0.1:8925/v1/systemone',
      SEMANTIC_PROVIDER_ID: 'no-key-stub',
      SEMANTIC_MODEL: 'smoke-model',
      SEMANTIC_AUTH_PROBE: 'omit',
    })
    assert.equal(report.authProbe.attempted, false)
    assert.equal(report.authProbe.reason, 'no-api-key-configured')
    assert.equal(report.authProbe.requiresAuth, 'unverified')
  } finally { stopStub() }
})

test('a 429 or 500 never counts as auth evidence', async () => {
  for (const [port, status] of [[8926, 429], [8927, 500]] as const) {
    const server = createServer((_incoming, response) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'nope' }))
    })
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
    try {
      const { report } = await runConformance({
        SEMANTIC_ENDPOINT: `http://127.0.0.1:${port}/v1/systemone`,
        SEMANTIC_PROVIDER_ID: 'inconclusive-auth-stub',
        SEMANTIC_MODEL: 'smoke-model',
        SEMANTIC_API_KEY: 'sk-configured-but-unused',
        SEMANTIC_AUTH_PROBE: 'omit',
      })
      assert.equal(report.authProbe.attempted, true, `status ${status}`)
      // Rate limiting and server failure say nothing about credentials.
      assert.equal(report.authProbe.requiresAuth, 'unverified', `status ${status}`)
      // Nor about whether an unauthenticated request would normalize: nothing
      // was answered, so nothing may be claimed.
      assert.equal(report.authProbe.normalizedWithoutAuth, 'unverified', `status ${status}`)
      assert.ok(!JSON.stringify(report).includes('sk-configured-but-unused'))
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
})
