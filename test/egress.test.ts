import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertEgressAllowed,
  classifyEndpoint,
  resolveEgressPolicy,
  resolveEndpointClass,
} from '../src/egress.ts'

test('classifies loopback endpoints as local', () => {
  for (const host of ['localhost', '127.0.0.1', '127.0.0.53', 'http://[::1]/v1/systemone', '0.0.0.0']) {
    const url = host.includes('://') ? host : `http://${host}:8080/v1/systemone`
    assert.equal(classifyEndpoint(url), 'local', url)
  }
})

test('classifies private-network endpoints as private', () => {
  for (const host of [
    '10.0.0.5',
    '172.16.4.4',
    '172.31.255.254',
    '192.168.1.10',
    '169.254.1.1',
    'http://[fd00::1]/v1/systemone',
    'jevin.local',
    'jev.internal',
  ]) {
    const url = host.includes('://') ? host : `http://${host}/v1/systemone`
    assert.equal(classifyEndpoint(url), 'private', url)
  }
})

test('classifies public HTTPS endpoints as remote', () => {
  assert.equal(classifyEndpoint('https://api.example.com/v1/systemone'), 'remote')
  assert.equal(classifyEndpoint('https://8.8.8.8/v1/systemone'), 'remote')
  assert.equal(classifyEndpoint('https://172.32.0.1/v1/systemone'), 'remote')
  assert.equal(classifyEndpoint('https://172.15.0.1/v1/systemone'), 'remote')
})

test('rejects non-HTTP and malformed endpoints', () => {
  for (const bad of ['ftp://host/x', 'not a url', 'file:///etc/passwd']) {
    assert.throws(() => classifyEndpoint(bad), { code: 'configuration' })
  }
})

test('explicit override wins over detection and is validated', () => {
  assert.equal(resolveEndpointClass('https://api.example.com/v1', 'local'), 'local')
  assert.equal(resolveEndpointClass('http://127.0.0.1:1/v1', 'remote'), 'remote')
  assert.equal(resolveEndpointClass('https://api.example.com/v1', undefined), 'remote')
  assert.equal(resolveEndpointClass('https://api.example.com/v1', 'auto'), 'remote')
  assert.throws(() => resolveEndpointClass('https://api.example.com/v1', 'elsewhere'), {
    code: 'configuration',
  })
})

test('egress policy defaults to allow and rejects unknown values', () => {
  assert.equal(resolveEgressPolicy(undefined), 'allow')
  assert.equal(resolveEgressPolicy(''), 'allow')
  assert.equal(resolveEgressPolicy('block-remote-automatic'), 'block-remote-automatic')
  assert.throws(() => resolveEgressPolicy('sometimes'), { code: 'configuration' })
})

test('blocks automatic remote calls but preserves authorized explicit calls', () => {
  assert.doesNotThrow(() => assertEgressAllowed('remote', 'allow', 'automatic'))
  assert.doesNotThrow(() =>
    assertEgressAllowed('remote', 'block-remote-automatic', 'explicit'),
  )
  assert.throws(() => assertEgressAllowed('remote', 'block-remote-automatic', 'automatic'), {
    code: 'egress_blocked',
  })
})

test('block-remote-all forbids explicit remote calls too', () => {
  assert.throws(() => assertEgressAllowed('remote', 'block-remote-all', 'explicit'), {
    code: 'egress_blocked',
  })
  assert.throws(() => assertEgressAllowed('remote', 'block-remote-all', 'automatic'), {
    code: 'egress_blocked',
  })
})

test('local and private endpoints are never blocked by remote policy', () => {
  for (const endpointClass of ['local', 'private'] as const) {
    for (const policy of ['allow', 'block-remote-automatic', 'block-remote-all'] as const) {
      assert.doesNotThrow(
        () => assertEgressAllowed(endpointClass, policy, 'automatic'),
        `${endpointClass}/${policy}`,
      )
    }
  }
})
