import type { PluginTool } from 'openfox/plugin'
import { validateRequest } from './decision/validation.js'
import { parseSettings } from './settings.js'
import { ProviderError, SystemOneHttpProvider, type HttpSettings } from './providers/system-one.js'
import { DecisionCache, NAMESPACE_DECIDE, cacheKey } from './cache/index.js'
import { createHash } from 'node:crypto'

/**
 * Opaque fingerprint of everything that can change a provider answer.
 *
 * It deliberately uses the **raw** endpoint, not the canonicalized one: two
 * endpoints that differ only by a non-secret query parameter (a tenant, an API
 * version) are different providers and must not share entries. It also covers
 * the credential, because a different key can address a different tenant on the
 * same host.
 *
 * The result is a digest: it reveals nothing, is never logged, and never
 * leaves the process.
 */
function providerFingerprint(settings: HttpSettings): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        endpoint: settings.endpoint,
        model: settings.model ?? null,
        presetId: settings.presetId ?? null,
        // Hashed alongside the rest; the fingerprint itself is opaque.
        apiKey: settings.apiKey ?? null,
        endpointClass: settings.endpointClass ?? null,
        egressPolicy: settings.egressPolicy ?? null,
        cache: settings.cache ?? null,
      }),
    )
    .digest('hex')
}
export function createDecisionTool(readSettings: (projectId?: string) => Record<string, unknown>, transport: typeof fetch = fetch): PluginTool {
  // One cache per tool instance, so entries survive across calls. It stays empty
  // unless the operator enables it, and it is rebuilt from the current settings
  // on the first use.
  let cache: DecisionCache | null = null
  let cacheFingerprint = ''
  return {
    name: 'semantic_decide',
    description: 'Explicitly send bounded state to the configured System One endpoint for typed semantic probabilities. Does not replace tests or mark tasks complete.',
    parameters: {
      type: 'object', required: ['state','questions'], additionalProperties: false,
      properties: {
        state: { anyOf: [{type:'string'},{type:'object'},{type:'array'}] },
        model: {type:'string', minLength:1},
        questions: { type:'object', minProperties:1, additionalProperties: {
          type:'object', required:['type','instructions'],
          properties: {type:{enum:['noul','choice','score']},instructions:{type:'string',minLength:1},criteria:{anyOf:[{type:'array',items:{type:'string'},minItems:2},{type:'object',additionalProperties:{type:'string'},minProperties:2}]}},
        } },
      },
    },
    async execute(args, context) {
      try {
        validateRequest(args)
        const settings = parseSettings(readSettings(context.projectId))
        const provider = new SystemOneHttpProvider(settings, transport)
        // The provider resolves `request.model ?? this.settings.model` and sends
        // that value verbatim. The key must use the identical expression.
        // `validateRequest` has already rejected an absent, non-string, empty or
        // whitespace-only model, so a present `args.model` is a usable string.
        // It is deliberately NOT trimmed: the provider does not trim either, so
        // trimming here would make "model-a" and " model-a " share a key while
        // the provider is asked two different models.
        const effectiveModel = args.model ?? settings.model ?? ''
        // The store is rebuilt whenever anything that can change an answer
        // changes. The fingerprint is an opaque in-memory digest: it covers the
        // raw endpoint, so a non-secret query parameter (tenant, API version)
        // still separates two endpoints, and it covers the credential, because
        // a different key can address a different tenant. The fingerprint is
        // never logged and never leaves the process, and no secret is stored
        // with it.
        const fingerprint = providerFingerprint(settings)
        if (cache === null || fingerprint !== cacheFingerprint) {
          cache = new DecisionCache(settings.cache)
          cacheFingerprint = fingerprint
        }
        const key = cacheKey(
          {
            namespace: NAMESPACE_DECIDE,
            presetId: settings.presetId ?? 'custom',
            endpoint: settings.endpoint,
            model: effectiveModel,
            // A generic primitive answer carries no policy, so no policy version
            // belongs in its key.
            policyVersion: null,
          },
          { state: args.state, questions: args.questions },
        )
        const cached = cache.get(key)
        if (cached !== undefined) {
          return { success: true, output: JSON.stringify({ ...(cached as object), cache: 'hit' }) }
        }
        // Only a successful response is stored: a provider error, timeout or
        // malformed payload throws above and never reaches `set`.
        const response = await provider.decide(args, { signal: context.signal })
        cache.set(key, response)
        return { success: true, output: JSON.stringify({ ...response, cache: 'miss' }) }
      } catch (error) {
        const code = error instanceof ProviderError ? error.code : 'invalid_arguments'
        // Only our controlled errors are safe to expose; settings access can throw secret-bearing errors.
        const message = error instanceof ProviderError ? error.message : 'Invalid arguments or unavailable plugin settings'
        return {success:false,error:JSON.stringify({code,message})}
      }
    },
  }
}
