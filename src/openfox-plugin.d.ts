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

  export type PluginSettingScope = 'global' | 'project'

  export type PluginSettingValue = string | number | boolean

  /**
   * "Open the provider page" button rendered next to a field or a `list`
   * sub-field input. The URL is a template resolved against the values of the
   * row (or the whole form for a top-level field).
   */
  export interface PluginSettingsLinkButton {
    label: LocalizedString
    /** URL template, also used as the fallback when `hrefByValue` has no match. */
    href?: string
    /** Field whose value selects the template in `hrefByValue`. */
    hrefByField?: string
    /** Templates keyed by the value of `hrefByField`. */
    hrefByValue?: Record<string, string>
  }

  export interface PluginSettingsField {
    key: string
    type: 'text' | 'password' | 'number' | 'boolean' | 'select' | 'textarea' | 'path' | 'button' | 'status' | 'list'
    label: LocalizedString
    buttonLabel?: LocalizedString
    buttonVariant?: 'default' | 'primary' | 'secondary' | 'danger' | 'ghost'
    rpcMethod?: string
    description?: LocalizedString
    default?: PluginSettingValue
    options?: PluginSettingOption[]
    required?: boolean
    secret?: boolean
    placeholder?: string
    scope?: PluginSettingScope
    parentKey?: string
    width?: 'full' | 'half'
    section?: LocalizedString
    hideWhenInstalled?: boolean
    /** Display-only field: rendered disabled, always shows `default`, never read from or written to storage. */
    readOnly?: boolean
    /** Whether to render a directory browser button to pick files or folders from the filesystem. */
    browseDirectory?: boolean
    /** Custom label for the browse directory button. */
    browseButtonLabel?: LocalizedString
    /** Danger levels for which this setting field is applicable. */
    dangerLevels?: string[]
    /**
     * Sub-fields of a `list` field, rendered inline on a single row per item.
     * Values are stored as a JSON array string, so a list value always travels
     * through the settings values as a `string`.
     */
    itemFields?: PluginSettingsField[]
    addLabel?: LocalizedString
    removeLabel?: LocalizedString
    minItems?: number
    maxItems?: number
    linkButton?: PluginSettingsLinkButton
    /**
     * Backing store of the value: read from and written to the plugin's own
     * storage instead of the settings store. Storage-backed fields are global.
     */
    storageKey?: string
  }

  export interface PluginSettingsSchema {
    fields: PluginSettingsField[]
  }

  export interface PluginToolContext { sessionId: string; workdir: string; projectId?: string; signal?: AbortSignal }
  export interface PluginToolResult { success: boolean; output?: string; error?: string }
  export interface PluginTool { name: string; description: string; parameters: Record<string, unknown>; execute(args: Record<string, unknown>, context: PluginToolContext): Promise<PluginToolResult> }
  // Present in the released Plugin API v2 baseline (2.0.157) as well as current
  // releases; verified against the upstream plugin index before use.
  export interface PluginSkill { id: string; name: string; description: string; prompt: string; group?: string }
  export interface PluginSkillSource { id: string; label: LocalizedString; load(): Promise<PluginSkill[]> | PluginSkill[] }

  /**
   * Pre-LLM message transform. Released in OpenFox 2.0.161 with the
   * `transforms` capability: runs before every LLM dispatch, fails open to the
   * unmodified messages on error or timeout (5 s upstream).
   *
   * `LLMMessage` is intentionally loose: the upstream type lives in the host's
   * internal server tree and is not published from `openfox/plugin`. Only the
   * fields this plugin reads are asserted, in `src/transform/messages.ts`.
   */
  export interface PluginMessageTransformContext {
    sessionId: string
    projectId?: string
    workdir: string
    model: string
    systemPrompt: string
    mode?: string
    signal?: AbortSignal
  }

  export interface PluginMessageTransformResult {
    messages: Array<Record<string, unknown>>
    systemPrompt?: string
    metadata?: Record<string, unknown>
  }

  export interface PluginMessageTransform {
    id: string
    priority?: number
    transform(
      messages: Array<Record<string, unknown>>,
      context: PluginMessageTransformContext,
    ): Promise<PluginMessageTransformResult | Array<Record<string, unknown>>> | PluginMessageTransformResult | Array<Record<string, unknown>>
  }

  export interface PluginRegistry {
    readonly context: { settings(scope?: 'global' | 'project', projectId?: string): Record<string, string | number | boolean> }
    registerTool(tool: PluginTool): void
    registerSettings(schema: PluginSettingsSchema): void
    registerSkillSource(source: PluginSkillSource): void
    registerMessageTransform(transform: PluginMessageTransform): void
  }
}
