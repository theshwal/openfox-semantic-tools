import assert from 'node:assert/strict'
import test from 'node:test'
import { summarize,validateRecord,type RunRecord } from '../src/evaluation/records.ts'
const run:RunRecord={task:'a',variant:'baseline',mode:'openfox',wallMs:1,mainInputTokens:null,mainOutputTokens:null,mainCalls:null,verifierCalls:null,semanticCalls:0,semanticCost:null,fallbacks:0,taskSuccess:null,falsePasses:null,falseNegatives:null}
test('comparison separates variants and preserves unknown measurements',()=>{
  const summary=summarize([run,{...run,variant:'candidate',semanticCalls:1}])
  assert.ok(summary.includes('openfox/baseline'));assert.ok(summary.includes('openfox/candidate'));assert.ok(summary.includes('unknown'))
})
test('invalid measurements are rejected',()=>{
  assert.throws(()=>validateRecord({...run,wallMs:-1}));assert.throws(()=>validateRecord({...run,mainCalls:undefined}))
})
