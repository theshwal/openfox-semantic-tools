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

  /**
   * Declarative UI mounted in a host-rendered zone.
   *
   * Verified against the released Plugin API v2 baseline (2.0.161): the
   * `ui` capability and `registerUiComponent` are both present, and
   * `stats.modal` is one of the zones the client actually renders. Only the
   * fields this plugin uses are declared, so the mirror stays small.
   */
  export type DeclarativeNode =
    | { type: 'text'; text: LocalizedString; muted?: boolean; className?: string }
    | { type: 'keyValue'; items: Array<{ key: LocalizedString; value: string }> }
    | { type: 'table'; columns: LocalizedString[]; rows: string[][] }
    | { type: 'card'; title?: LocalizedString; tone?: string; children: DeclarativeNode[] }
    | { type: 'stack'; direction?: 'row' | 'column'; gap?: string; children: DeclarativeNode[] }
    | { type: 'callout'; tone?: string; title?: LocalizedString; text: LocalizedString }
    | { type: 'details'; title: LocalizedString; defaultOpen?: boolean; children: DeclarativeNode[] }
    | { type: 'divider' }

  export interface PluginUiContentSource {
    kind: 'rpc'
    method: string
    refreshMs?: number
  }

  export interface PluginVisibilityCondition {
    hasSession?: boolean
    hasProject?: boolean
    hasMessage?: boolean
  }

  export interface PluginSettingsTab {
    id: string
    label: LocalizedString
  }

  export type PluginActivation =
    | { kind: 'rpc'; method: string; params?: Record<string, unknown> }
    | { kind: 'openPanel'; panelId: string }
    | { kind: 'closePanel' }
    | { kind: 'openSettings'; tab?: string }
    | { kind: 'openUrl'; url: string }

  export interface PluginUiAction {
    id: string
    slot: string
    label: LocalizedString
    icon?: string
    variant?: 'default' | 'primary' | 'danger' | 'ghost'
    tooltip?: LocalizedString
    visibleWhen?: PluginVisibilityCondition
    onActivate: PluginActivation
  }

  export interface PluginUiPanel {
    id: string
    title: LocalizedString
    size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | 'full'
    kind: 'declarative' | 'iframe'
    content?: DeclarativeNode[]
    footer?: DeclarativeNode[]
    url?: string
  }

  export interface PluginUiComponent {
    id: string
    zone: string
    position?: 'before' | 'inside' | 'after'
    order?: number
    visibleWhen?: PluginVisibilityCondition
    component: DeclarativeNode
    contentSource?: PluginUiContentSource
  }

  /**
   * Events the host emits to plugins, as declared by the 2.0.161 API.
   *
   * Read from `/tmp/of-harness-probe/node_modules/openfox/dist/plugin/index.d.ts`
   * (see `PluginHookEvent` there). Listed in full so a drift test can compare
   * the two, and because `registerHook` accepts only these literals.
   */
  export type PluginHookEvent =
    | 'session.created'
    | 'turn.completed'
    | 'workflow.step.completed'
    | 'workflow.execution.changed'
    | 'task.completed'
    | 'message.created'
    | 'tool.completed'
    | 'llm.completed'
    | 'criterion.updated'
    | 'provider.changed'
    | 'devserver.started'
    | 'devserver.stopped'
    | 'devserver.state.changed'
    | 'context.compacted'
    | 'retry.triggered'

  export interface PluginHookPayload {
    readonly event: PluginHookEvent
    readonly sessionId: string
    readonly projectId?: string
    readonly timestamp: string
    /**
     * Event-specific data.
     *
     * Deliberately `Record<string, unknown>` upstream, and deliberately NOT
     * narrowed here. What each event actually carries was measured on a real
     * host rather than assumed: see `scripts/hook-observation-pass.ts`
     * (`npm run hooks:observe`) and the written result in
     * `docs/HOOK-PAYLOADS.md`. Anything that reads `data` must narrow it, and
     * must never persist a value it has not classified.
     */
    readonly data: Record<string, unknown>
  }

  /**
   * A hook handler.
   *
   * RETURNS void. That is the whole point of N1-3: a handler observes, it
   * cannot decide. There is no return channel through which a plugin could
   * accept, refuse or alter a tool call, a turn or a workflow step, so no
   * feature in this repository may rest on a veto. The host currently offers
   * no such capability for plugins; `registerHook` is the only hook surface it
   * declares.
   */
  export type PluginHookHandler = (payload: PluginHookPayload) => void | Promise<void>

  export interface PluginRegistry {
    readonly context: {
      settings(scope?: 'global' | 'project', projectId?: string): Record<string, string | number | boolean>
    }
    registerTool(tool: PluginTool): void
    registerSettings(schema: PluginSettingsSchema): void
    registerSkillSource(source: PluginSkillSource): void
    registerMessageTransform(transform: PluginMessageTransform): void
    /** Observability only; requires the `hooks` capability. See PluginHookHandler. */
    registerHook(event: PluginHookEvent, handler: PluginHookHandler): void
    /** Declarative UI, released in the Plugin API v2 `ui` capability. */
    registerUiComponent(component: PluginUiComponent): void
    /** A header/menu action. Opens one of this plugin's own panels. */
    registerUiAction(action: PluginUiAction): void
    /** A panel this plugin owns, declarative or iframe. */
    registerUiPanel(panel: PluginUiPanel): void
    /**
     * An extra tab in the Plugins settings modal. Declared for completeness of
     * the settings surface; the activity panel does not register one, because
     * `registerSettings` already renders its own schema-driven tab.
     */
    registerSettingsTab(tab: PluginSettingsTab): void
    /** RPC endpoint; requires the `rpc` capability when capabilities are declared. */
    registerRpc(
      method: string,
      handler: (
        params: Record<string, unknown>,
        context: PluginToolContext,
      ) => unknown | Promise<unknown>,
    ): void
  }
}
