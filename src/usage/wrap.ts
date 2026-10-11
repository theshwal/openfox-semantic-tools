import type {
  PluginSkillSource,
  PluginTool,
  PluginToolContext,
  PluginToolResult,
} from 'openfox/plugin'

import type { UsageLedger } from '../usage/ledger.js'

/**
 * Wraps a tool so a real invocation is counted.
 *
 * "Offered" is seeded once at registration from the plugin's own catalogue, so
 * the report distinguishes three real states rather than two: a capability the
 * agent was never shown, one it was shown and ignored, and one it used. Without
 * that seed a fresh report would be an empty object, and "never offered" would
 * be indistinguishable from "not implemented".
 *
 * The wrap is deliberately transparent: it forwards arguments and result
 * unchanged and never swallows an error, so a bookkeeping failure cannot change
 * what a tool returns.
 */
export function withUsage<T extends PluginTool>(
  tool: T,
  ledger: UsageLedger | undefined,
): PluginTool {
  if (ledger === undefined) return tool
  const name = tool.name
  return {
    ...tool,
    async execute(
      args: Record<string, unknown>,
      context: PluginToolContext,
    ): Promise<PluginToolResult> {
      try {
        ledger.noteUsed(name)
      } catch {
        // Bookkeeping must never affect the tool's own behaviour.
      }
      return tool.execute(args, context)
    },
  }
}

/** Applies the wrapper to a whole registration pass. */
export function withUsageAll(
  tools: readonly PluginTool[],
  ledger: UsageLedger | undefined,
): PluginTool[] {
  return tools.map((tool) => withUsage(tool, ledger))
}

/**
 * Seeds the catalogue so every shipped capability and skill appears in the
 * report from the first run.
 *
 * Idempotent per name, so a hot reload cannot inflate the count.
 */
export function seedCatalogue(
  ledger: UsageLedger,
  toolNames: readonly string[],
  skillNames: readonly string[],
): void {
  try {
    ledger.seed([...toolNames, ...skillNames])
  } catch {
    // A catalogue we cannot write is a catalogue we keep in memory.
  }
}

/**
 * Wraps a skill source so loading it counts as an OFFER.
 *
 * This is the only honest source of "offered" available to the plugin. A tool
 * becomes reachable through the agent's `allowedTools`, which the plugin never
 * observes; counting an offer per turn or per registration would be inventing a
 * number. A skill load IS observable, and it IS an offer: the guidance was
 * placed in front of the agent.
 *
 * So tools are reported as "available, never used" and skills as "offered vs
 * used", and the report's note states which basis each row uses.
 */
export function withUsageSkillSource(
  source: PluginSkillSource,
  ledger: UsageLedger,
): PluginSkillSource {
  return {
    ...source,
    async load() {
      const skills = await source.load()
      try {
        ledger.noteOffered(skills.map((skill) => skill.id))
      } catch {
        // Bookkeeping must never break skill loading.
      }
      return skills
    },
  }
}