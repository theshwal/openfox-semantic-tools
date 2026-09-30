import type { DecisionAnswer, DecisionProvider, DecisionRequest, DecisionResponse, DecisionOptions } from '../decision/types.js'
import { isRecord, validateRequest } from '../decision/validation.js'
import { assertEgressAllowed, resolveEndpointClass, resolveEgressPolicy, type CallOrigin, type EndpointClass, type EgressPolicy } from '../egress.js'
import { ProviderError } from '../errors.js'

export { ProviderError }
export interface CacheSettings {
  enabled: boolean
  ttlMs: number
  maxEntries: number
}
export interface HttpSettings { endpoint: string; model?: string; apiKey?: string; timeoutMs: number; endpointClass?: EndpointClass; egressPolicy?: EgressPolicy; /** Preset identity, used to keep cache keys separated per backend. */ presetId?: string; cache?: CacheSettings }
const probability = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1

export function normalizeResponse(payload: unknown, request: DecisionRequest): Record<string, DecisionAnswer> {
  if (!isRecord(payload) || !isRecord(payload.answers)) throw new ProviderError('invalid_response', 'Missing answers')
  if (Object.keys(payload.answers).length !== Object.keys(request.questions).length) throw new ProviderError('invalid_response', 'Question count mismatch')
  return Object.fromEntries(Object.entries(request.questions).map(([id, q]) => {
    const a = (payload.answers as Record<string, unknown>)[id]
    if (!isRecord(a) || a.type !== q.type) throw new ProviderError('invalid_response', 'Missing or mismatched answer')
    if (a.confidence !== undefined && !probability(a.confidence)) throw new ProviderError('invalid_response', 'Invalid confidence')
    if (q.type === 'noul') {
      if (!probability(a.noul)) throw new ProviderError('invalid_response', 'Invalid noul probability')
      return [id, { type: 'noul', probability: a.noul }]
    }
    const labels = q.type === 'score' ? Object.keys(q.criteria) : Array.isArray(q.criteria) ? q.criteria : Object.keys(q.criteria)
    if (!isRecord(a.probabilities) || Object.keys(a.probabilities).length !== labels.length || labels.some(k => !Object.hasOwn(a.probabilities as object, k) || !probability((a.probabilities as Record<string, unknown>)[k]))) throw new ProviderError('invalid_response', 'Invalid probability distribution')
    const sum = Object.values(a.probabilities).reduce<number>((s, v) => s + (v as number), 0)
    if (Math.abs(sum - 1) > 0.002) throw new ProviderError('invalid_response', 'Distribution does not sum to one')
    const common = { probabilities: a.probabilities as Record<string, number>, ...(a.confidence === undefined ? {} : { confidence: a.confidence as number }) }
    if (q.type === 'choice') {
      if (typeof a.choice !== 'string' || !labels.includes(a.choice)) throw new ProviderError('invalid_response', 'Invalid choice')
      return [id, { type: 'choice', choice: a.choice, ...common }]
    }
    if (typeof a.score !== 'number' || !Number.isFinite(a.score) || a.score < 0 || a.score > labels.length - 1) throw new ProviderError('invalid_response', 'Invalid score')
    return [id, { type: 'score', score: a.score, ...common }]
  })) as Record<string, DecisionAnswer>
}

export class SystemOneHttpProvider implements DecisionProvider {
  readonly id = 'system-one'
  constructor(private readonly settings: HttpSettings, private readonly transport: typeof fetch = fetch) {
    const url = new URL(settings.endpoint)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ProviderError('configuration', 'Endpoint must be an HTTP(S) URL without credentials, query or fragment')
    if (!Number.isInteger(settings.timeoutMs) || settings.timeoutMs < 1 || settings.timeoutMs > 120000) throw new ProviderError('configuration', 'Timeout must be between 1 and 120000 ms')
  }
  async decide(request: DecisionRequest, options: DecisionOptions = {}): Promise<DecisionResponse> {
    validateRequest(request)
    // Enforce egress before any network work so a blocked call sends nothing.
    assertEgressAllowed(
      this.settings.endpointClass ?? resolveEndpointClass(this.settings.endpoint, undefined),
      resolveEgressPolicy(this.settings.egressPolicy),
      (options.origin ?? 'explicit') as CallOrigin,
    )
    const started = performance.now()
    const timeout = AbortSignal.timeout(this.settings.timeoutMs)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    const model = request.model ?? this.settings.model
    try {
      signal.throwIfAborted()
      const response = await this.transport(this.settings.endpoint, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', ...(this.settings.apiKey ? { Authorization: `Bearer ${this.settings.apiKey}` } : {}) },
        body: JSON.stringify({ ...request, ...(model ? { model } : {}) }),
      })
      // Do not echo arbitrary upstream bodies: they can contain submitted source or credentials.
      if (!response.ok) { await response.body?.cancel(); throw new ProviderError('http', `System One HTTP ${response.status}`) }
      const reader = response.body?.getReader()
      const chunks: Uint8Array[] = []
      let bytes = 0
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            bytes += value.byteLength
            if (bytes > 2_000_000) { await reader.cancel(); throw new ProviderError('invalid_response', 'Response exceeds size limit') }
            chunks.push(value)
          }
        } finally { reader.releaseLock() }
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      let payload: unknown
      try { payload = JSON.parse(raw) } catch { throw new ProviderError('invalid_response', 'Provider returned invalid JSON') }
      const answers = normalizeResponse(payload, request)
      if (isRecord(payload) && payload.model !== undefined && typeof payload.model !== 'string') throw new ProviderError('invalid_response', 'Invalid response model')
      return { provider: this.id, ...(isRecord(payload) && typeof payload.model === 'string' ? { model: payload.model } : model ? { model } : {}), answers, latencyMs: performance.now() - started }
    } catch (error) {
      if (options.signal?.aborted) throw new ProviderError('aborted', 'Semantic request cancelled')
      if (timeout.aborted) throw new ProviderError('timeout', 'Semantic provider timed out')
      if (error instanceof ProviderError) throw error
      throw new ProviderError('network', 'Semantic provider request failed')
    }
  }
}
