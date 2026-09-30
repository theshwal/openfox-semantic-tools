/**
 * Narrow compile-time mirror of the released OpenFox Plugin API surface used
 * by the bootstrap. Keep this file intentionally small.
 *
 * Before adding/changing a contribution, compare it with:
 * https://github.com/co-l/openfox/blob/develop/src/plugin/index.ts
 */
declare module 'openfox/plugin' {
  export type LocalizedString = {
    en: string
    fr: string
  }

  export interface PluginSettingOption {
    value: string
    label: LocalizedString
  }

  export interface PluginSettingsField {
    key: string
    type: 'text' | 'password' | 'number' | 'boolean' | 'select' | 'textarea' | 'path'
    label: LocalizedString
    description?: LocalizedString
    default?: string | number | boolean
    secret?: boolean
    options?: PluginSettingOption[]
  }

  export interface PluginSettingsSchema {
    fields: PluginSettingsField[]
  }

  export interface PluginToolContext { sessionId: string; workdir: string; projectId?: string; signal?: AbortSignal }
  export interface PluginToolResult { success: boolean; output?: string; error?: string }
  export interface PluginTool { name: string; description: string; parameters: Record<string, unknown>; execute(args: Record<string, unknown>, context: PluginToolContext): Promise<PluginToolResult> }
  export interface PluginRegistry {
    readonly context: { settings(scope?: 'global' | 'project', projectId?: string): Record<string, string | number | boolean> }
    registerTool(tool: PluginTool): void
    registerSettings(schema: PluginSettingsSchema): void
  }
}
