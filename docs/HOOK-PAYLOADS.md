# Hook payload census — what the host actually emits

Measured on a real **OpenFox 2.0.161** host (`scripts/setup-harness.sh`), not
inferred from the type declarations. This file exists because
`PluginHookPayload.data` is declared `Record<string, unknown>` upstream: the
shape of each event cannot be known from the types, and guessing it is how a
plugin ends up persisting repository or conversation text.

## The declared type list is not the emitted list

`PluginHookEvent` declares **15** values. The host's `EVENT_HOOK_MAP` maps only
**9** internal events onto 7 of them, plus two conditional ones. Measured from
`dist/chunk-4XRJ4J6E.js`:

```js
var EVENT_HOOK_MAP = {
  "session.initialized":  "session.created",
  "task.completed":       "task.completed",
  "message.done":         "message.created",
  "tool.result":          "tool.completed",
  "criterion.updated":    "criterion.updated",
  "workflow.execution_changed": "workflow.execution.changed",
  // OpenFox-internal events (Plugin API v2). Mapped 1:1 from the
  // TurnEvent names so plugins can correlate hook payloads with the
  // session's EventStore stream.
  "context.compacted":    "context.compacted",
  "pattern.retry":        "retry.triggered"
}
```

Plus one conditional emission:

```js
hooks.emit(payload["reason"] === "step_done" ? "workflow.step.completed" : "turn.completed", base)
```

### Reachable in 2.0.161

| Plugin event | Internal source |
| --- | --- |
| `session.created` | `session.initialized` |
| `task.completed` | `task.completed` |
| `message.created` | `message.done` |
| `tool.completed` | `tool.result` |
| `criterion.updated` | `criterion.updated` |
| `workflow.execution.changed` | `workflow.execution_changed` |
| `context.compacted` | `context.compacted` |
| `retry.triggered` | `pattern.retry` |
| `turn.completed` | any non-`step_done` turn reason |
| `workflow.step.completed` | turn reason `step_done` |

### Declared but **never emitted** in 2.0.161

`llm.completed`, `provider.changed`, `devserver.started`, `devserver.stopped`,
`devserver.state.changed`.

They are valid values of the type and are accepted by `registerHook`, so a
subscription succeeds silently and then never fires. **A plugin must not treat
a successful registration as proof the event exists.** Five of the fifteen
declared values are inert on this release.

## Consequence for this plugin

`turn.completed` is reachable, so the tool-usage observation planned in N2 does
not depend on `tool.completed` alone. But the payload contents are still
unmeasured: the observation pass
(`scripts/hook-observation-pass.ts`) installs the probe, and the isolated host
starts and loads it without firing a single event, because the harness runs no
model turn. **The census of `data` keys stays empty until a real session with a
configured provider drives the host.**

So the honest state is:

- **which events exist** — measured, above;
- **what each `data` contains** — not yet measured, and must not be assumed.

## `context.compacted` carries the conversation summary

This is the one payload whose contents could be read from the shipped bundle
without running a session, so it was read directly. From
`dist/chunk-JNGNOZRQ.js`:

```js
append({
  type: "context.compacted",
  data: {
    closedWindowId, newWindowId,
    beforeTokens: tokenCountAtClose,
    afterTokens: 0,
    summary,
    ...subAgentTags()      // subAgentId, subAgentType when applicable
  },
})
```

**`summary` is a verbatim condensation of what the user said.** It is the most
sensitive field in the entire hook surface, and it arrives on every compaction
the host performs — including when this plugin has been told to do nothing.

The observer therefore keeps the KEY and its TYPE (`summary: string`) and never
the content. That is the property the census was built for: a reader can see
that a risky key exists and classify it, and a report can be produced from a
live session without writing a single word of conversation to disk.
`test/hook-observer.test.ts` "the compaction summary — the most sensitive
payload the host sends — is never retained" asserts it against the real payload
shape, including a planted secret.

## Why the probe never fires

The harness proves installation, manifest validation, `register()`, and the
host's own contribution counts. It does not run an agent turn, because a turn
needs a live model provider. Every hook above is emitted from inside a turn or
a task, so an offline harness sees none of them. This is the same boundary the
harness documents for tool execution.

Reproduce the observation with:

```bash
npm run setup-harness        # once
npm run hooks:observe        # writes the census, then cleans up after itself
```

The census comes back empty offline. That is the expected result, not a
failure, and it is why the emitted-vs-declared list above is the part of this
document that rests on a measurement.