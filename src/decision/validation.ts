import type { DecisionRequest, JsonValue } from './types.js'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}
function isJson(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || seen.has(value!)) return false
  seen.add(value!)
  const valid = (Array.isArray(value) || isRecord(value)) && Object.values(value!).every(v => isJson(v, seen))
  seen.delete(value!)
  return valid
}
export function validateRequest(value: unknown): asserts value is DecisionRequest {
  if (!isRecord(value) || !('state' in value) || !isJson(value.state)) throw new Error('Invalid JSON state')
  if (typeof value.state !== 'string' && !isRecord(value.state) && !Array.isArray(value.state)) throw new Error('State must be a string, object or array')
  if (value.model !== undefined && (typeof value.model !== 'string' || !value.model.trim())) throw new Error('Invalid model')
  if (!isRecord(value.questions) || !Object.keys(value.questions).length) throw new Error('Questions must be a nonempty object')
  for (const [id, q] of Object.entries(value.questions)) {
    if (!id.trim() || !isRecord(q) || !['noul', 'choice', 'score'].includes(String(q.type)) || typeof q.instructions !== 'string' || !q.instructions.trim()) throw new Error('Invalid question')
    if (q.type !== 'noul') {
      if (!Array.isArray(q.criteria) && !isRecord(q.criteria)) throw new Error('Criteria are required')
      if (q.type === 'score' && !Array.isArray(q.criteria)) throw new Error('Score criteria must be an ordered array for the common System One contract')
      const entries = Object.entries(q.criteria)
      if (entries.length < 2 || entries.some(([k, v]) => !k.trim() || typeof v !== 'string' || !v.trim())) throw new Error('At least two nonempty criteria are required')
      if (Array.isArray(q.criteria) && new Set(q.criteria).size !== q.criteria.length) throw new Error('Duplicate criteria')
    }
  }
}
