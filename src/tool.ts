import type { PluginTool } from 'openfox/plugin'
import { validateRequest } from './decision/validation.js'
import { parseSettings } from './settings.js'
import { ProviderError, SystemOneHttpProvider } from './providers/system-one.js'
export function createDecisionTool(readSettings: (projectId?: string) => Record<string, unknown>, transport: typeof fetch = fetch): PluginTool {
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
        const provider = new SystemOneHttpProvider(parseSettings(readSettings(context.projectId)), transport)
        return { success:true, output:JSON.stringify(await provider.decide(args,{signal:context.signal})) }
      } catch (error) {
        const code = error instanceof ProviderError ? error.code : 'invalid_arguments'
        // Only our controlled errors are safe to expose; settings access can throw secret-bearing errors.
        const message = error instanceof ProviderError ? error.message : 'Invalid arguments or unavailable plugin settings'
        return {success:false,error:JSON.stringify({code,message})}
      }
    },
  }
}
