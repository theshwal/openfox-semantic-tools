import assert from 'node:assert/strict'
import test from 'node:test'

import { createProviderSelfTestTool } from '../src/calibration/self-test.ts'
import { createCalibrationCandidateTool } from '../src/calibration/candidate-tool.ts'

const ctx = { sessionId: 's', workdir: '/tmp', projectId: 'p' }

function syntheticTransport() {
  const seen: any[] = []
  const transport: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    seen.push(body)
    const answers = Object.fromEntries(
      Object.entries(body.questions as Record<string, any>).map(([id, question]) => {
        if (question.type === 'score') {
          return [id, { type: 'score', score: 2, probabilities: { 0: 0, 1: 0, 2: 1 } }]
        }
        if (question.type === 'choice') {
          return [id, { type: 'choice', choice: 'ok', probabilities: { ok: 1, bad: 0 } }]
        }
        const probability =
          id === 'offScope' || id === 'needsDeeperVerification' ? 0.05 : 0.95
        return [id, { type: 'noul', noul: probability }]
      }),
    )
    return Response.json({ model: 'fixture-model', answers })
  }
  return { transport, seen }
}

test('provider self-test uses only embedded synthetic state and never changes settings', async () => {
  const { transport, seen } = syntheticTransport()
  const raw = {
    backend: 'custom',
    endpoint: 'http://localhost/v1/systemone',
    model: 'fixture-model',
    calibrationProfileJson: JSON.stringify({
      schemaVersion: 1,
      id: 'fixture-profile',
      provider: { presetId: 'custom', model: 'fixture-model' },
      policyVersion: 'verify-0.3.0',
      testedAt: '2026-10-01T00:00:00.000Z',
      status: 'provisional',
      provenance: 'test',
      active: false,
    }),
  }
  const tool = createProviderSelfTestTool(() => raw, transport)
  const result = await tool.execute({}, ctx)
  assert.equal(result.success, true)
  const report = JSON.parse(result.output!)
  assert.equal(report.advisory, true)
  assert.equal(report.syntheticOnly, true)
  assert.equal(report.protocol.reachable, true)
  assert.equal(report.protocol.choice.attempted, false, 'custom preset has unverified choice capability')
  assert.equal(report.activeProfile.freshness, 'matched')
  assert.equal(report.activeProfile.active, false)
  assert.equal(report.semanticSmoke.total, 3)
  assert.equal(seen.length, 3)
  for (const request of seen) {
    const serialized = JSON.stringify(request)
    assert.ok(serialized.includes('health') || serialized.includes('retry') || serialized.includes('parser'))
    assert.doesNotMatch(serialized, /src\//)
    assert.doesNotMatch(serialized, /apiKey|secret|token/i)
  }
})

test('candidate tool returns an inactive JSON profile and never activates it', async () => {
  const tool = createCalibrationCandidateTool()
  const gates = {
    criterionTestable: 0.8,
    satisfied: 0.7,
    evidenceSufficiency: 1.2,
    offScope: 0.3,
    needsDeeperVerification: 0.6,
  }
  const result = await tool.execute(
    {
      id: 'local-candidate',
      provider: { presetId: 'kev', model: 'kev-4b' },
      cases: [
        { id: 'a', expectedStatus: 'unknown', gates },
        { id: 'b', expectedStatus: 'needs-verification', gates: { ...gates, satisfied: 0.4 } },
      ],
    },
    ctx,
  )
  assert.equal(result.success, true)
  const output = JSON.parse(result.output!)
  assert.equal(output.advisory, true)
  assert.equal(output.active, false)
  assert.equal(output.profile.active, false)
  assert.equal(output.profile.status, 'user-calibrated')
  assert.equal(output.profile.gateOverrides, undefined)
  assert.match(output.nextStep, /explicit/i)
})
