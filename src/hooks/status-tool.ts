import type { PluginTool } from 'openfox/plugin'

import type { HookObserver } from './observer.js'

/**
 * Reads what the host-observation hooks have seen.
 *
 * A pure reader, like `semantic_transform_status`: it contacts no provider,
 * changes no setting, and writes nothing. Its value is distinguishing three
 * states that a bare counter would collapse into one:
 *
 *   - `measured: false` — the event never fired, so nothing is known about it;
 *   - `complete: false` — at least one subscribed event is still unmeasured;
 *   - `complete: true` — every subscribed event has been seen at least once.
 *
 * "Nothing was observed" and "nothing occurred" are different claims, and a
 * report that cannot tell them apart is the failure mode this tool exists to
 * avoid.
 */
export function createHookStatusTool(observer: HookObserver): PluginTool {
  return {
    name: 'semantic_hook_status',
    description:
      'Report which host events the plugin has observed, how often, and which data keys arrived with which types. Advisory only: it contacts no provider, writes nothing, and cannot influence a turn — a hook handler returns void.',
    parameters: {
      type: 'object',
      required: [],
      additionalProperties: false,
      properties: {},
    },
    async execute() {
      try {
        return { success: true, output: JSON.stringify(observer.snapshot()) }
      } catch {
        return {
          success: false,
          error: JSON.stringify({
            code: 'internal',
            message: 'The hook status could not be read. This is bookkeeping only.',
          }),
        }
      }
    },
  }
}