import assert from 'node:assert/strict'
import test from 'node:test'

import { register, SETTINGS } from '../src/index.ts'

test('registers the initial settings schema', () => {
  let captured: unknown

  register({
    registerSettings(schema) {
      captured = schema
    },
  })

  assert.equal(captured, SETTINGS)

  const keys = SETTINGS.fields.map((field) => field.key)
  assert.deepEqual(keys, [
    'backend',
    'endpoint',
    'model',
    'apiKey',
    'timeoutMs',
  ])
})

test('marks the API key as secret', () => {
  const apiKey = SETTINGS.fields.find((field) => field.key === 'apiKey')
  assert.equal(apiKey?.secret, true)
})
