import assert from 'node:assert/strict'
import test from 'node:test'
import { createDecisionTool } from '../src/tool.ts'
import { parseSettings } from '../src/settings.ts'
const args = {state:'public',questions:{q:{type:'noul',instructions:'Is this public?'}}}
const ctx = {sessionId:'fixture',workdir:'/tmp',projectId:'project'}
test('tool reads live scoped settings and returns stable JSON',async()=>{
  let selected: string | undefined
  const tool=createDecisionTool(id=>{selected=id;return{endpoint:'http://localhost/v1/systemone'}},async()=>Response.json({answers:{q:{type:'noul',noul:0.9}}}))
  const result=await tool.execute(args,ctx)
  assert.equal(selected,'project');assert.equal(result.success,true);assert.equal(JSON.parse(result.output!).answers.q.probability,0.9)
})
test('tool validates before dispatch and fails on provider errors',async()=>{
  let calls=0
  const tool=createDecisionTool(()=>({endpoint:'http://localhost/v1/systemone'}),async()=>{calls++;return new Response('secret',{status:503})})
  assert.equal((await tool.execute({},ctx)).success,false);assert.equal(calls,0)
  const r=await tool.execute(args,ctx);assert.equal(r.success,false);assert.equal(JSON.parse(r.error!).code,'http');assert.ok(!r.error!.includes('secret'))
})
test('tool propagates cancellation',async()=>{
  const c=new AbortController();c.abort()
  const r=await createDecisionTool(()=>({endpoint:'http://localhost/v1/systemone'})).execute(args,{...ctx,signal:c.signal})
  assert.equal(JSON.parse(r.error!).code,'aborted')
})
test('settings defaults and invalid configuration',()=>{
  assert.equal(parseSettings({endpoint:'http://localhost/v1/systemone'}).timeoutMs,5000)
  for(const values of [{},{endpoint:'x',timeoutMs:'5'},{endpoint:'x',backend:'unknown'},{endpoint:'x',apiKey:5}])assert.throws(()=>parseSettings(values))
})
