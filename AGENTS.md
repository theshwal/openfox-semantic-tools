# AGENTS.md

## Mission

Build `openfox-semantic-tools` as a small, benchmark-driven OpenFox Plugin API v2 extension for typed semantic decisions.

The plugin must remain useful with both hosted Jev and compatible local/open-source System One endpoints. Do not couple OpenFox tools directly to one vendor.

## Read first

Before changing plugin integration code, inspect the current upstream OpenFox contract:

- https://github.com/co-l/openfox/blob/develop/docs/PLUGINS.md
- https://github.com/co-l/openfox/blob/develop/src/plugin/index.ts
- https://github.com/co-l/openfox/tree/develop/examples/hello-plugin

The OpenFox plugin API is evolving. Do not assume a capability seen on `develop` exists in a released version.

Compatibility baseline for V0: OpenFox 2.0.157 for tools/settings.

## Architectural invariants

1. OpenFox-facing use cases depend on a `DecisionProvider` abstraction.
2. The first transport should be a generic System One-compatible HTTP adapter, not a Jev-only client.
3. Preserve typed decision primitives: `noul`, `choice`, `score`.
4. Keep thresholds/fallback policy in the use-case layer, not the transport.
5. Batch multiple questions against the same state when the protocol supports it.
6. Deterministic checks remain deterministic; never replace tests/typechecks/linters with semantic inference.
7. A provider error, timeout, malformed response or low-confidence result must never silently become a positive/pass result.
8. Never log API keys or full secret-bearing settings.
9. Do not transmit repository/session content to a remote provider except through an explicitly invoked or enabled feature. Endpoints are classified `local`/`private`/`remote` and the `egressPolicy` setting blocks automatic remote calls before any request is sent. A call that does not declare an origin is treated as explicit.
10. No OpenFox core changes for V0. If a later use case needs an upstream API change, isolate it in a separate issue/PR and keep the request generic.

## Scope discipline

### V0

Implement only:

- settings;
- System One request/response contract;
- one HTTP provider adapter;
- `semantic_decide`;
- tests;
- minimal benchmark/evaluation plumbing.

Do not add automatic verification gates, codebase-wide scanning or context mutation before the primitive is tested.

### Next experiments

The issue-level coverage and hybrid discovery work are delivered.

Current development priority:

1. **#35 — visual semantic decision spike**: backend viability is now **GO**.
   The same versioned smoke harness has measured both the conventional Qwen VLM
   baseline and an image-capable typed OpenJev System One baseline. Do **not**
   register a production visual tool yet. Production remains **DEFER** until:
   - the action-state dataset defined in
     `benchmark/visual/ACTION-STATE-DATASET.md` exists;
   - false-positive success / fallback / latency are measured on that frozen
     corpus;
   - an explicit production GO or DEFER decision is recorded.
2. **#9 — measurement umbrella**: collect durable evidence for delivered
   capabilities (#33, #34 and #35) without turning the repository into a
   permanent provider leaderboard.
3. **#6 — pre-LLM context relevance/reduction**: remains blocked until the
   message-transform capability exists in a released OpenFox version.

Delivered in the current cycle:

- **#33** — `semantic_issue_coverage`, conservative aggregation over the
  existing verification policy/calibration path;
- **#34** — bounded repository-local recall plus true per-file semantic
  reranking in `semantic_search`.

Model/skill routing remains out of scope unless measured evidence changes that.

## Skills and agent adoption

Semantic tools are not self-explanatory merely because they are registered.

Use OpenFox plugin skills to teach **when and how** proven semantic tools should be used:

- prefer a small number of usage-oriented skills over one skill per tool;
- keep skill descriptions concise so permanent prompt overhead stays low;
- put detailed operational guidance in the skill prompt loaded through `load_skill`;
- teach when **not** to use semantic tools;
- keep provider names/endpoints/models out of skills;
- never let a skill imply that it grants tool access — plugin tools still require the agent's `allowedTools`.

Usage skills from #14 are shipped:

- `semantic-code-discovery` for semantic search/scan;
- `semantic-verification` for post-build evidence checks and issue coverage.

Do not expose guidance for a higher-level tool before that tool exists and has enough evidence to justify normal agent usage.

## OpenFox message transforms

Current OpenFox `develop` exposes `registerMessageTransform`, which can mutate messages/system prompt before LLM dispatch and is a promising hook for context reduction.

It is not part of the 2.0.157 compatibility baseline. Before implementing any transform:

1. verify it exists in a released OpenFox package;
2. update the minimum supported OpenFox version;
3. make the transform opt-in;
4. make failures fail open to the original messages;
5. measure token savings and task-quality regressions.

## Provider contract guidance

A provider request is conceptually:

```ts
{
  state: string | object | array,
  model?: string,
  questions: {
    [id: string]:
      | { type: 'noul'; instructions: string }
      | { type: 'choice'; instructions: string; criteria: ... }
      | { type: 'score'; instructions: string; criteria: ... }
  }
}
```

Do not reduce the common provider contract to a single boolean question.

Do not invent provider-specific semantics. When Jev-compatible runtimes differ, preserve the common subset and expose capability differences explicitly.

## Error/fallback rules

- Network failure: return a structured failed tool result.
- Timeout/abort: stop promptly and preserve the abort signal.
- HTTP non-2xx: include status and a bounded/sanitized error body.
- Invalid JSON/schema: reject the response.
- Unsupported question type/capability: reject explicitly; never drop a question.
- Use-case uncertainty: caller decides whether to invoke the normal OpenFox verifier/model.

## Testing

Every implementation PR should include the smallest tests that prove its contract.

At minimum test:

- plugin registration;
- settings parsing/defaults;
- all supported question types;
- multi-question batching;
- successful provider response;
- timeout/abort;
- non-2xx;
- malformed/partial response;
- secret values not logged;
- provider-agnostic endpoint configuration.

Use fixtures/mocked HTTP in unit tests. Tests must not require a paid Jev key.

Integration tests against hosted/local providers may exist separately and must be opt-in.

## Evaluation requirement

Do not claim that a feature saves tokens, cost or time without measurements.

For any optimization experiment record:

- main-model input/output tokens;
- semantic-provider input/cost where available;
- total wall time;
- number of main-model/verifier calls;
- fallback rate;
- task success / acceptance-criteria success;
- false-pass / false-negative rate when applicable.

See `docs/EVALUATION.md`.

## Code conventions

- TypeScript, ESM, Node 24+.
- Keep modules small and single-purpose.
- Prefer explicit JSON-safe types at external boundaries.
- Keep raw provider payloads out of the public tool contract unless needed for debugging.
- Tool names use the `semantic_` prefix.
- Avoid new runtime dependencies unless they materially simplify correctness.
- Add dependencies only after checking whether Node/OpenFox already provides the needed capability.
- Keep README and architecture docs updated when the public contract changes.

## Definition of done for V0

V0 is done when a clean OpenFox install can:

1. install/enable the plugin;
2. configure a System One endpoint and optional secret API key;
3. allow an agent to call `semantic_decide`;
4. execute `noul`, `choice` and `score` requests, including batched questions;
5. receive a stable, provider-neutral result;
6. fail safely on provider errors;
7. run the complete local test suite without external credentials.

Do not promote higher-level automation before this passes.
