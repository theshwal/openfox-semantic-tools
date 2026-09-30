import assert from 'node:assert/strict'
import test from 'node:test'
import type { CallOrigin } from '../src/decision/types.ts'
import type { CallOrigin as EgressCallOrigin } from '../src/egress.ts'
import { assertEgressAllowed } from '../src/egress.ts'

// F2: `CallOrigin` must have a single definition. These annotations fail to
// compile if the re-exported type and the egress type ever drift apart.
const fromTypes: CallOrigin = 'automatic'
const fromEgress: EgressCallOrigin = 'explicit'
const identical: CallOrigin = fromEgress
const same: EgressCallOrigin = fromTypes

test('CallOrigin is re-exported from the decision types without divergence', () => {
  assert.equal(fromTypes, 'automatic')
  assert.equal(fromEgress, 'explicit')
  assert.equal(identical, 'explicit')
  assert.equal(same, 'automatic')
})

test('the re-exported origin is the one the policy actually enforces', () => {
  // Compile-time proof above, behaviour proof here: the value flowing through
  // the shared type is the value the egress guard branches on.
  assert.throws(() => assertEgressAllowed('remote', 'block-remote-automatic', fromTypes), {
    code: 'egress_blocked',
  })
  assert.doesNotThrow(() => assertEgressAllowed('remote', 'block-remote-automatic', fromEgress))
})
