import type { PluginTool } from 'openfox/plugin'

import type { UsageLedger } from './ledger.js'

/**
 * Reads the usage ledger.
 *
 * It writes a file and returns the report inline. It takes NO transport: the
 * absence is the guarantee. An unused `fetch` parameter existed only so a test
 * could spy on it, which proves less than the absence does — there is no code
 * path here that could reach the network.
 */
export function createUsageReportTool(ledger: UsageLedger): PluginTool {
  return {
    name: 'semantic_usage_report',
    description:
      'Report how often each semantic capability and skill was offered to the agent versus actually invoked. Advisory only: it contacts no provider, changes no setting, and judges no code.',
    parameters: {
      type: 'object',
      required: [],
      additionalProperties: false,
      properties: {},
    },
    async execute() {
      try {
        const reportPath = await ledger.writeReport()
        return {
          success: true,
          output: JSON.stringify({
            ...ledger.report(),
            reportPath,
          }),
        }
      } catch {
        return {
          success: false,
          error: JSON.stringify({
            code: 'internal',
            message:
              'The usage report could not be written. This is bookkeeping only: it never affects any other result.',
          }),
        }
      }
    },
  }
}