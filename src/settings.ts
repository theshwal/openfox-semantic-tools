import type { HttpSettings } from './providers/system-one.js'
import { ProviderError } from './providers/system-one.js'
export function parseSettings(values: Record<string, unknown>): HttpSettings {
  if (values.backend !== undefined && !['jev','custom'].includes(String(values.backend))) throw new ProviderError('configuration','Unsupported backend')
  if (typeof values.endpoint !== 'string' || !values.endpoint.trim()) throw new ProviderError('configuration','Configure a full System One endpoint before calling this tool')
  for (const key of ['model','apiKey']) if (values[key] !== undefined && typeof values[key] !== 'string') throw new ProviderError('configuration',`Invalid ${key} setting`)
  const timeoutMs = values.timeoutMs ?? 5000
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs)) throw new ProviderError('configuration','Invalid timeout setting')
  return { endpoint: values.endpoint.trim(), timeoutMs, ...(values.model ? {model: String(values.model)} : {}), ...(values.apiKey ? {apiKey:String(values.apiKey)} : {}) }
}
