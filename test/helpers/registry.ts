import type { PluginRegistry, PluginSettingsSchema, PluginSkillSource, PluginTool } from 'openfox/plugin'

/**
 * Minimal fake registry: the OpenFox registry is a plain object, so a stub is
 * enough to assert every contribution without a running host.
 */
export function fakeRegistry(): {
  registry: PluginRegistry
  tools: Map<string, PluginTool>
  skillSources: PluginSkillSource[]
  settings: PluginSettingsSchema[]
  settingsCalls: Array<string | undefined>
} {
  const tools = new Map<string, PluginTool>()
  const skillSources: PluginSkillSource[] = []
  const settings: PluginSettingsSchema[] = []
  const settingsCalls: Array<string | undefined> = []
  const registry = {
    context: {
      settings(scope?: 'global' | 'project') {
        settingsCalls.push(scope)
        return {}
      },
    },
    registerTool(tool: PluginTool) {
      tools.set(tool.name, tool)
    },
    registerSettings(schema: PluginSettingsSchema) {
      settings.push(schema)
    },
    registerSkillSource(source: PluginSkillSource) {
      skillSources.push(source)
    },
  } as unknown as PluginRegistry
  return { registry, tools, skillSources, settings, settingsCalls }
}
