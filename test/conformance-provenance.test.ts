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

test('a local stub reports observations without asserting any identity', async () => {
  const { spawn: spawnChild } = await import('node:child_process')
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
