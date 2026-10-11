import type {
  PluginMessageTransform,
  PluginRegistry,
  PluginSettingsSchema,
  PluginSkillSource,
  PluginTool,
  PluginToolContext,
  PluginUiAction,
  PluginUiComponent,
  PluginUiPanel,
} from 'openfox/plugin'

export type RpcHandler = (
  params: Record<string, unknown>,
  context: PluginToolContext,
) => unknown | Promise<unknown>

/**
 * Minimal fake registry: the OpenFox registry is a plain object, so a stub is
 * enough to assert every contribution without a running host.
 *
 * It implements exactly the methods the plugin is allowed to call. A
 * contribution this fake does not implement would throw, which is what keeps
 * "the plugin registers no hook and no transition handler" a mechanically
 * enforced property rather than a promise in a document.
 */
/**
 * Settings values a fake registry hands back.
 *
 * Typed to the values `context.settings()` actually promises, so a test cannot
 * smuggle in a shape the real registry would never return.
 */
export type FakeSettings = Record<string, string | number | boolean>

export function fakeRegistry(
  settingsValues: FakeSettings = {},
): {
  registry: PluginRegistry
  tools: Map<string, PluginTool>
  skillSources: PluginSkillSource[]
  messageTransforms: PluginMessageTransform[]
  settings: PluginSettingsSchema[]
  settingsCalls: Array<string | undefined>
  components: PluginUiComponent[]
  actions: PluginUiAction[]
  panels: PluginUiPanel[]
  rpcs: Map<string, RpcHandler>
  /**
   * The values every `context.settings()` call returns.
   *
   * Returned by REFERENCE so a test can set a value between calls, which is
   * how the settings-dependent tests drive the plugin.
   */
  settingsValues: FakeSettings
} {
  const tools = new Map<string, PluginTool>()
  const skillSources: PluginSkillSource[] = []
  const messageTransforms: PluginMessageTransform[] = []
  const settings: PluginSettingsSchema[] = []
  const settingsCalls: Array<string | undefined> = []
  const components: PluginUiComponent[] = []
  const actions: PluginUiAction[] = []
  const panels: PluginUiPanel[] = []
  const rpcs = new Map<string, RpcHandler>()
  const registry = {
    context: {
      settings(scope?: 'global' | 'project') {
        settingsCalls.push(scope)
        return settingsValues
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
    registerMessageTransform(transform: PluginMessageTransform) {
      messageTransforms.push(transform)
    },
    registerUiComponent(component: PluginUiComponent) {
      components.push(component)
    },
    registerUiAction(action: PluginUiAction) {
      actions.push(action)
    },
    registerUiPanel(panel: PluginUiPanel) {
      panels.push(panel)
    },
    registerRpc(method: string, handler: RpcHandler) {
      rpcs.set(method, handler)
    },
  } as unknown as PluginRegistry
  return {
    registry,
    tools,
    skillSources,
    messageTransforms,
    settings,
    settingsCalls,
    components,
    actions,
    panels,
    rpcs,
    settingsValues,
  }
}

/** A tool context for a session, matching the host's tool contract. */
export function toolContext(sessionId = 'session-1', projectId?: string): PluginToolContext {
  return { sessionId, workdir: '/tmp/work', ...(projectId ? { projectId } : {}) }
}
