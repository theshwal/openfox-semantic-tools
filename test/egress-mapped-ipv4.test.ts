import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyEndpoint } from '../src/egress.ts'

// Regression: IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) embed a literal IPv4
// address. Classifying them as `remote` would wrongly enable remote-egress
// policy on an endpoint that is in fact local or private.
test('IPv4-mapped loopback addresses classify as local', () => {
  assert.equal(classifyEndpoint('http://[::ffff:127.0.0.1]/v1/systemone'), 'local')
  assert.equal(classifyEndpoint('http://[::ffff:127.0.0.53]/v1/systemone'), 'local')
})

test('IPv4-mapped private addresses classify as private', () => {
  assert.equal(classifyEndpoint('http://[::ffff:10.1.2.3]/v1/systemone'), 'private')
  assert.equal(classifyEndpoint('http://[::ffff:192.168.0.10]/v1/systemone'), 'private')
  assert.equal(classifyEndpoint('http://[::ffff:172.16.9.9]/v1/systemone'), 'private')
  assert.equal(classifyEndpoint('http://[::ffff:169.254.1.1]/v1/systemone'), 'private')
})

test('IPv4-mapped public addresses stay remote', () => {
  assert.equal(classifyEndpoint('http://[::ffff:8.8.8.8]/v1/systemone'), 'remote')
  assert.equal(classifyEndpoint('http://[::ffff:203.0.113.5]/v1/systemone'), 'remote')
})

test('non-mapped IPv6 loopback and unique-local still classify correctly', () => {
  assert.equal(classifyEndpoint('http://[::1]/v1/systemone'), 'local')
  assert.equal(classifyEndpoint('http://[fd00::1]/v1/systemone'), 'private')
  assert.equal(classifyEndpoint('http://[2001:db8::1]/v1/systemone'), 'remote')
})
