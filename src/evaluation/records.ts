import { isRecord } from '../decision/validation.js'
export interface RunRecord {
  task: string; variant: string; mode: 'fixture' | 'live' | 'openfox'
  wallMs: number; mainInputTokens: number | null; mainOutputTokens: number | null
  mainCalls: number | null; verifierCalls: number | null; semanticCalls: number
  semanticCost: number | null; fallbacks: number; taskSuccess: boolean | null
  falsePasses: number | null; falseNegatives: number | null
}
export function validateRecord(v: unknown): asserts v is RunRecord {
  if (!isRecord(v) || typeof v.task !== 'string' || !v.task || typeof v.variant !== 'string' || !v.variant || !['fixture','live','openfox'].includes(String(v.mode))) throw new Error('Invalid run identity')
  for (const key of ['wallMs','semanticCalls','fallbacks']) if (typeof v[key] !== 'number' || !Number.isFinite(v[key]) || (v[key] as number) < 0) throw new Error(`Invalid ${key}`)
  for (const key of ['mainInputTokens','mainOutputTokens','mainCalls','verifierCalls','semanticCost','falsePasses','falseNegatives']) if (v[key] !== null && (typeof v[key] !== 'number' || !Number.isFinite(v[key]) || (v[key] as number) < 0)) throw new Error(`Invalid ${key}`)
  if (v.taskSuccess !== null && typeof v.taskSuccess !== 'boolean') throw new Error('Invalid task success')
}
export function summarize(records: RunRecord[]): string {
  records.forEach(validateRecord)
  const groups = new Map<string, RunRecord[]>()
  for (const r of records) { const key = `${r.mode}/${r.variant}`; const rows = groups.get(key) ?? []; rows.push(r); groups.set(key, rows) }
  const sum = (rows:RunRecord[],key:keyof RunRecord) => rows.some(r=>r[key]===null) ? 'unknown' : String(rows.reduce((n,r)=>n+Number(r[key]),0))
  const lines = ['# Evaluation summary','','Fixture results test plumbing only; unknown metrics are not zero. Compare the same tasks and environment before claiming a gain.','','| Mode / variant | Runs | Wall ms | Main input | Main calls | Verifier calls | Semantic calls | Fallbacks | Success | False passes |','| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
  for(const [key,rows] of groups) lines.push(`| ${key.replaceAll('|','\\|').replaceAll('\n',' ')} | ${rows.length} | ${sum(rows,'wallMs')} | ${sum(rows,'mainInputTokens')} | ${sum(rows,'mainCalls')} | ${sum(rows,'verifierCalls')} | ${sum(rows,'semanticCalls')} | ${sum(rows,'fallbacks')} | ${rows.some(r=>r.taskSuccess===null)?'unknown':rows.filter(r=>r.taskSuccess).length} | ${sum(rows,'falsePasses')} |`)
  return lines.join('\n')+'\n'
}
