/**
 * Optional, bounded decision cache.
 *
 * This is an **optimization**, not a source of truth. Its only job is to avoid
 * re-asking an identical question against an unchanged provider, so it is
 * built so that a mistake is inert rather than dangerous:
 *
 * - the key is canonical and covers every input that can change an answer:
 *   namespace, preset identity, secret-free endpoint, model, protocol version,
 *   state, questions with their criteria, and the policy version when a
 *   higher-level result is cached. Keying on the question text alone is
 *   explicitly not enough;
 * - no secret ever reaches a key: credentials, query and fragment are stripped
 *   before the endpoint is hashed, so a key is safe to log;
 * - a caller stores only a **successful** response, so a provider error,
 *   timeout or malformed payload can never be replayed as a result;
 * - entries expire on a configurable TTL and the store is bounded, with a
 *   deterministic oldest-first eviction;
 * - `enabled: false` disables it completely, and a zero TTL disables reuse, so
 *   the cache can be turned off without touching call sites.
 *
 * The cache never influences policy: it cannot calibrate anything, cannot make
 * a positive verdict reachable, and it is scoped per namespace so a generic
 * `semantic_decide` answer is never reused as a higher-level policy outcome.
 */

import { createHash } from 'node:crypto'

/** Bumped whenever the wire contract or the answer shape changes. */
export const PROTOCOL_VERSION = 'systemone/1'

/** Separate namespaces, so a primitive answer is never a policy outcome. */
export const NAMESPACE_DECIDE = 'semantic_decide'
export const NAMESPACE_VERIFY = 'semantic_verify_task'
export const NAMESPACE_SEARCH = 'semantic_search'
export const NAMESPACE_SCAN = 'semantic_scan'

/**
 * Normalizes an endpoint into a **secret-free** identity.
 *
 * Credentials are stripped because userinfo is a secret. A non-secret query
 * parameter is deliberately **kept**: `?tenant=a` and `?tenant=b` are different
 * providers, and dropping it would let two tenants share cache entries — a
 * cross-tenant reuse that is exactly the dangerous case this cache must avoid.
 * The fragment is dropped because it is never sent to the server.
 */
export function canonicalEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    url.username = ''
    url.password = ''
    url.hash = ''
    return url.toString()
  } catch {
    // A non-URL endpoint is still usable, but strip obvious credentials rather
    // than trusting it verbatim, and keep everything else intact.
    return endpoint.split('#')[0].replace(/\/\/[^@/]*@/, '//')
  }
}

/** Query parameters whose name suggests a credential are dropped from the key. */
const SECRET_QUERY_KEYS = new Set([
  'api_key',
  'apikey',
  'key',
  'token',
  'access_token',
  'auth',
  'password',
  'secret',
  'signature',
  'sig',
])

/**
 * Removes credential-looking query parameters while preserving every other one,
 * so two genuinely different endpoints keep different keys.
 */
function stripSecretQuery(endpoint: string): string {
  if (!endpoint.includes('?')) return endpoint
  const [base, query] = endpoint.split('?', 2)
  if (query === undefined) return endpoint
  const kept = query
    .split('&')
    .filter((pair) => {
      const name = pair.split('=', 1)[0].toLowerCase()
      return name.length > 0 && !SECRET_QUERY_KEYS.has(name)
    })
    .sort()
  return kept.length > 0 ? `${base}?${kept.join('&')}` : base
}

/** Stable serialization: object keys are emitted in sorted order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
}

export interface CacheIdentity {
  /** Which tool produced the result. Never shared across tools. */
  readonly namespace: string
  readonly presetId: string
  readonly endpoint: string
  readonly model: string
  /** Set only when a higher-level policy result is cached. */
  readonly policyVersion: string | null
}

export interface CacheableRequest {
  readonly state: unknown
  readonly questions: unknown
}

/**
 * The canonical cache key. Two calls share a key only when every input that can
 * change the answer is identical.
 */
export function cacheKey(identity: CacheIdentity, request: CacheableRequest): string {
  const material = canonical({
    protocol: PROTOCOL_VERSION,
    namespace: identity.namespace,
    presetId: identity.presetId,
    endpoint: stripSecretQuery(canonicalEndpoint(identity.endpoint)),
    model: identity.model,
    policyVersion: identity.policyVersion,
    state: request.state,
    questions: request.questions,
  })
  return createHash('sha256').update(material).digest('hex')
}

export interface CacheOptions {
  /** Defaults to off: caching must be a deliberate choice. */
  readonly enabled?: boolean
  /** Entry lifetime. Zero disables reuse entirely. */
  readonly ttlMs?: number
  /** Hard bound on stored entries. */
  readonly maxEntries?: number
  /** Injectable clock, so expiry is testable without waiting. */
  readonly now?: () => number
}

interface Entry {
  readonly value: unknown
  readonly storedAt: number
}

export interface CacheStats {
  hits: number
  misses: number
  entries: number
  ttlMs: number
  sizeLimit: number
}

/**
 * Deep copy of a JSON-shaped value.
 *
 * The cache is exposed to callers that also hand the value to `JSON.stringify`,
 * and a caller could mutate a returned object after the fact. Cloning at both
 * boundaries keeps a stored entry from being altered by the caller, and keeps a
 * caller's mutation from leaking into the next read.
 */
function cloneValue<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  return JSON.parse(JSON.stringify(value)) as T
}

export class DecisionCache {
  private readonly store = new Map<string, Entry>()
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly now: () => number
  readonly enabled: boolean
  private hits = 0
  private misses = 0

  constructor(options: CacheOptions = {}) {
    this.enabled = options.enabled ?? false
    this.ttlMs = options.ttlMs ?? 300_000
    this.maxEntries = Math.max(1, options.maxEntries ?? 128)
    this.now = options.now ?? (() => Date.now())
  }

  get(key: string): unknown {
    if (!this.enabled || this.ttlMs <= 0) {
      this.misses += 1
      return undefined
    }
    const entry = this.store.get(key)
    if (!entry) {
      this.misses += 1
      return undefined
    }
    if (this.now() - entry.storedAt > this.ttlMs) {
      this.store.delete(key)
      this.misses += 1
      return undefined
    }
    this.hits += 1
    // Clone on read: a caller mutating the result must not corrupt the store.
    return cloneValue(entry.value)
  }

  /**
   * Stores a **successful** result. Callers must not reach this for an error,
   * a timeout or a malformed response; a null or undefined value is refused so
   * a failed call cannot be replayed as a result.
   */
  set(key: string, value: unknown): void {
    if (!this.enabled || this.ttlMs <= 0) return
    if (value === null || value === undefined) {
      throw new Error('Only a successful result may be cached')
    }
    if (this.store.has(key)) this.store.delete(key)
    // Clone on write: the caller's object stays theirs.
    this.store.set(key, { value: cloneValue(value), storedAt: this.now() })
    while (this.store.size > this.maxEntries) {
      // Map preserves insertion order, so the first key is the oldest.
      const oldest = this.store.keys().next()
      if (oldest.done) break
      this.store.delete(oldest.value)
    }
  }

  clear(): void {
    this.store.clear()
  }

  /** Test helper: age every entry without waiting for the real clock. */
  ageAll(byMs: number): void {
    for (const [key, entry] of this.store) {
      this.store.set(key, { value: entry.value, storedAt: entry.storedAt - byMs })
    }
  }

  get size(): number {
    return this.store.size
  }

  /** Counters only: no key, no state content, no credential. */
  stats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      entries: this.store.size,
      ttlMs: this.ttlMs,
      sizeLimit: this.maxEntries,
    }
  }
}
