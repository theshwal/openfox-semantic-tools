import type { HttpSettings } from './providers/system-one.js'
import { ProviderError } from './providers/system-one.js'
import { resolveEndpointClass, resolveEgressPolicy } from './egress.js'
import { DEFAULT_BACKEND_ID, applyPreset, isPresetId } from './presets/index.js'
export function parseSettings(values: Record<string, unknown>): HttpSettings {
  // A preset only fills in missing defaults. Everything the operator typed,
  // including an empty string meaning "no override", is preserved.
  const backend = values.backend === undefined ? DEFAULT_BACKEND_ID : String(values.backend)
  if (!isPresetId(backend)) throw new ProviderError('configuration',`Unsupported backend "${backend}"`)
  const presetDefaults = applyPreset({ ...values, backend })
  if (typeof presetDefaults.endpoint !== 'string' || !presetDefaults.endpoint.trim()) throw new ProviderError('configuration','Configure a full System One endpoint before calling this tool')
  for (const key of ['model','apiKey']) if (values[key] !== undefined && typeof values[key] !== 'string') throw new ProviderError('configuration',`Invalid ${key} setting`)
  const timeoutMs = values.timeoutMs ?? 5000
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs)) throw new ProviderError('configuration','Invalid timeout setting')
  const endpoint = presetDefaults.endpoint.trim()
  // Fail fast on an unusable endpoint or policy instead of failing inside the request.
  const endpointClass = resolveEndpointClass(endpoint, values.endpointClass)
  const egressPolicy = resolveEgressPolicy(values.egressPolicy)
  // The cache is an optimization, so it is off unless explicitly enabled.
  const cacheEnabled = values.cacheEnabled === true
  const cacheTtlMs = values.cacheTtlMs === undefined ? 300_000 : Number(values.cacheTtlMs)
  if (!Number.isInteger(cacheTtlMs) || cacheTtlMs < 0 || cacheTtlMs > 86_400_000) throw new ProviderError('configuration','Invalid cache TTL setting')
  const cacheMaxEntries = values.cacheMaxEntries === undefined ? 128 : Number(values.cacheMaxEntries)
  if (!Number.isInteger(cacheMaxEntries) || cacheMaxEntries < 1 || cacheMaxEntries > 10_000) throw new ProviderError('configuration','Invalid cache size setting')
  return { endpoint, timeoutMs, endpointClass, egressPolicy, presetId: backend, ...(presetDefaults.model ? {model: presetDefaults.model} : {}), ...(presetDefaults.apiKey ? {apiKey:presetDefaults.apiKey} : {}), cache: { enabled: cacheEnabled, ttlMs: cacheTtlMs, maxEntries: cacheMaxEntries } }
}
