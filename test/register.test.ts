import assert from 'node:assert/strict'
import test from 'node:test'

import { register, SETTINGS } from '../src/index.ts'

test('registers the initial settings schema', () => {
  let captured: unknown

  register({
    context: { settings: () => ({}) },
    registerTool(tool) { assert.equal(tool.name, 'semantic_decide') },
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

test('uses global configured credentials even in project sessions', async () => {
  let captured: import('openfox/plugin').PluginTool | undefined
  const scopes: string[] = []
  register({
    context: { settings(scope) { scopes.push(scope!); return {} } },
    registerSettings() {}, registerTool(tool) {captured=tool},
  })
  const result=await captured!.execute({state:'x',questions:{q:{type:'noul',instructions:'Check'}}},{sessionId:'s',workdir:'/tmp',projectId:'p'})
  assert.equal(result.success,false);assert.deepEqual(scopes,['global'])
})
