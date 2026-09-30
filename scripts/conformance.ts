import { mkdir,writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { SystemOneHttpProvider,ProviderError } from '../src/providers/system-one.ts'
import type { DecisionRequest } from '../src/decision/types.ts'
// Credentials are read only from the process environment and never persisted.
const endpoint=process.env.SEMANTIC_ENDPOINT
if(!endpoint)throw new Error('Set SEMANTIC_ENDPOINT to the verified full POST endpoint')
const provider=new SystemOneHttpProvider({endpoint,apiKey:process.env.SEMANTIC_API_KEY,model:process.env.SEMANTIC_MODEL,timeoutMs:10000})
const questions:DecisionRequest['questions']={
  noul:{type:'noul',instructions:'Does the state report a passing test?'},
  choice:{type:'choice',instructions:'Choose the reported test outcome',criteria:{pass:'Test passes',fail:'Test fails'}},
  score:{type:'score',instructions:'Rate the completeness of test evidence',criteria:['No evidence','Reported test result']},
}
const cases:Array<{id:string;request:DecisionRequest}>=[
  {id:'string-mixed',request:{state:'A public synthetic test passes.',questions}},
  {id:'object-mixed',request:{state:{test:'passes',fixture:'public synthetic'},questions}},
  {id:'array-mixed',request:{state:['public synthetic','test passes'],questions}},
  {id:'choice-array',request:{state:'Test passes',questions:{q:{type:'choice',instructions:'Select outcome',criteria:['pass','fail']}}}},
]
const results=[]
for(const entry of cases){
  try{const response=await provider.decide(entry.request);results.push({id:entry.id,success:true,response})}
  catch(error){results.push({id:entry.id,success:false,code:error instanceof ProviderError?error.code:'failure'})}
}
const out=resolve(process.argv[2]??'benchmark/results/conformance')
await mkdir(out,{recursive:true})
await writeFile(resolve(out,'report.json'),JSON.stringify({endpoint:'redacted',provider:'system-one',scope:'initial positive protocol cases; not full conformance or quality evaluation',results},null,2)+'\n')
console.log(`Recorded ${results.length} protocol cases; ${results.filter(r=>r.success).length} passed. Endpoint and credentials omitted.`)
if(results.some(r=>!r.success))process.exitCode=1
