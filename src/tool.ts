import type { PluginTool } from 'openfox/plugin'
import { validateRequest } from './decision/validation.js'
import { parseSettings } from './settings.js'
import { ProviderError, SystemOneHttpProvider, type HttpSettings } from './providers/system-one.js'
import { DecisionCache, NAMESPACE_DECIDE, cacheKey } from './cache/index.js'
import { createHash } from 'node:crypto'
import { NULL_ACTIVITY_RECORDER, type ActivityRecorder } from './activity/recorder.js'

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
/**
 * A stable digest of every question instruction in a batched decision call.
 *
 * `semantic_decide` has no single question field, so the repeat detection
 * needs one comparable value. Concatenating the instructions in key order and
 * hashing them yields a digest that is equal exactly when the same batch was
 * asked again, and reveals nothing about the wording.
 */
function digestDecisionQuestions(questions: unknown): string {
  if (questions === null || typeof questions !== 'object' || Array.isArray(questions)) return ''
  const entries = Object.entries(questions as Record<string, unknown>)
    .map(([id, question]) => {
      const instructions =
        question !== null && typeof question === 'object'
          ? (question as { instructions?: unknown }).instructions
          : undefined
      return `${id}:${typeof instructions === 'string' ? instructions : ''}`
    })
    .sort()
  return entries.join('|')
}

export function createDecisionTool(readSettings: (projectId?: string) => Record<string, unknown>, transport: typeof fetch = fetch, activity: ActivityRecorder = NULL_ACTIVITY_RECORDER): PluginTool {
  // One cache per tool instance, so entries survive across calls. It stays empty
  // unless the operator enables it, and it is rebuilt from the current settings
  // on the first use.
  let cache: DecisionCache | null = null
  let cacheFingerprint = ''
  // Activity ids are a local counter, never the cache key: the key is a digest
  // over the endpoint and the transmitted state, and neither may be recorded.
  let activitySeq = 0
  const nextActivityId = (): string => `decide:${(activitySeq += 1)}`
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
      // A generic primitive call carries no single question field, so the
      // repeat detection compares one digest built from every instruction in
      // the batch. Computed before the try so the failure path can record it
      // too, and empty rather than throwing when the batch is malformed.
      const decisionQuestion = digestDecisionQuestions(args.questions)
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
          activity.record({
            tool: 'semantic_decide',
            kind: 'decide',
            reportId: nextActivityId(),
            context,
            question: decisionQuestion,
            success: true,
            latencyMs: 0,
          })
          return { success: true, output: JSON.stringify({ ...(cached as object), cache: 'hit' }) }
        }
        // Only a successful response is stored: a provider error, timeout or
        // malformed payload throws above and never reaches `set`.
        const response = await provider.decide(args, { signal: context.signal })
        cache.set(key, response)
        activity.record({
          tool: 'semantic_decide',
          kind: 'decide',
          reportId: nextActivityId(),
          context,
          question: decisionQuestion,
          success: true,
          latencyMs: response.latencyMs ?? 0,
        })
        return { success: true, output: JSON.stringify({ ...response, cache: 'miss' }) }
      } catch (error) {
        activity.record({
          tool: 'semantic_decide',
          kind: 'decide',
          reportId: 'decide:failed',
          context,
          question: decisionQuestion,
          success: false,
        })
        const code = error instanceof ProviderError ? error.code : 'invalid_arguments'
        // Only our controlled errors are safe to expose; settings access can throw secret-bearing errors.
        const message = error instanceof ProviderError ? error.message : 'Invalid arguments or unavailable plugin settings'
        return {success:false,error:JSON.stringify({code,message})}
      }
    },
  }
}
