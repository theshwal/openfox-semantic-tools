import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { SystemOneHttpProvider } from '../src/providers/system-one.ts'
import { summarize, validateRecord, type RunRecord } from '../src/evaluation/records.ts'
import type { DecisionRequest } from '../src/decision/types.ts'
const input = process.argv[2]
const out = resolve(process.argv[3] ?? 'benchmark/results')
let records: RunRecord[] = []
if (input) {
  const parsed: unknown = JSON.parse(await readFile(input,'utf8'))
  if (!Array.isArray(parsed)) throw new Error('Expected an array of run records')
  parsed.forEach(validateRecord); records=parsed
} else {
  const fixtures: Array<{task:string;request:DecisionRequest;answer:unknown}> = [
    {task:'clear-noul',request:{state:'A test passes.',questions:{q:{type:'noul',instructions:'Does a test pass?'}}},answer:{type:'noul',noul:0.99}},
    {task:'choice',request:{state:'HTTP handler',questions:{q:{type:'choice',instructions:'Pick region',criteria:['handler','database']}}},answer:{type:'choice',choice:'handler',probabilities:{handler:0.9,database:0.1}}},
    {task:'score',request:{state:'Partial evidence',questions:{q:{type:'score',instructions:'Rate evidence',criteria:['absent','complete']}}},answer:{type:'score',score:0.4,probabilities:{0:0.6,1:0.4}}},
    {task:'ambiguous',request:{state:'No implementation supplied',questions:{q:{type:'noul',instructions:'Is the requirement fulfilled?'}}},answer:{type:'noul',noul:0.5}},
  ]
  for(const f of fixtures){
    const start=performance.now()
    const provider=new SystemOneHttpProvider({endpoint:'http://localhost/v1/systemone',timeoutMs:5000},async()=>Response.json({answers:{q:f.answer}}))
    await provider.decide(f.request)
    records.push({task:f.task,variant:'mock-candidate',mode:'fixture',wallMs:performance.now()-start,mainInputTokens:null,mainOutputTokens:null,mainCalls:null,verifierCalls:null,semanticCalls:1,semanticCost:null,fallbacks:0,taskSuccess:null,falsePasses:null,falseNegatives:null})
  }
}
await mkdir(out,{recursive:true})
await writeFile(resolve(out,'runs.json'),JSON.stringify(records,null,2)+'\n')
await writeFile(resolve(out,'summary.md'),summarize(records))
console.log(`Recorded ${records.length} runs in ${out}; no quality or saving claim inferred.`)
