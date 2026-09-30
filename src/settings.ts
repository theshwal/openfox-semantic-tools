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
  return { endpoint, timeoutMs, endpointClass, egressPolicy, ...(presetDefaults.model ? {model: presetDefaults.model} : {}), ...(presetDefaults.apiKey ? {apiKey:presetDefaults.apiKey} : {}) }
}
