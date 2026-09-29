# openfox-semantic-tools

Experimental OpenFox plugin for **fast, typed semantic decisions** and, where it is measurably useful, **lower token usage and lower latency**.

The project is intentionally provider-agnostic. The first transport target is the Jev / System One-style `POST /v1/systemone` API, so the same OpenFox tools can be backed by hosted Jev or by a compatible local/open-source runtime.

> Status: bootstrap / research. The repository defines the contract and evaluation rules before adding automation.

## Why this exists

A coding agent often asks small, bounded questions with a large generative model:

- Does this change satisfy a specific acceptance criterion?
- Which of these code regions is most likely relevant?
- Is this old tool output still useful for the current goal?
- Does this function exhibit a given semantic behavior?
- Is another expensive verifier pass actually needed?

Those are not necessarily generation problems. A fast decision model may be able to answer them more cheaply and quickly, while returning probabilities that application code can consume directly.

The goal is **not** to replace OpenFox's main model. The goal is to give OpenFox a small set of explicit semantic primitives and use them only when benchmarks show an end-to-end benefit.

## Design principles

1. **OpenFox plugin, not an OpenFox fork.** Prefer the public plugin API and keep any upstream request small and generic.
2. **Protocol before vendor.** OpenFox-facing code depends on a decision-provider contract, not directly on Jev.
3. **Typed decisions, not chat.** Preserve the System One primitives (`noul`, `choice`, `score`) instead of turning every decision into generated prose.
4. **Use-case policy stays above the provider.** Thresholds, fallback rules and "pass/fail" semantics belong to each OpenFox use case.
5. **Deterministic checks stay deterministic.** Tests, type checks, linters, file existence and exact parsing are not replaced by semantic inference.
6. **Measure first.** A semantic step is kept only if it improves the relevant end-to-end metric without degrading task quality.
7. **Privacy is explicit.** Remote providers may receive source code, diffs or session state. Local endpoints must remain a first-class option.

## Initial architecture

```text
OpenFox
  |
  +-- semantic_decide          (V0 primitive)
  +-- semantic_verify_task     (experiment)
  +-- semantic_scan            (experiment)
  +-- semantic_search          (experiment)
  +-- context relevance        (experiment)
          |
          v
   use-case policy
          |
          v
   DecisionProvider
          |
          v
   System One HTTP adapter
      |              |
      +-- hosted Jev |
      +-- local / compatible endpoints
```

The provider layer should accept one state plus one or more typed questions in a single request. It must not hard-code task-specific thresholds.

## V0 scope

The first useful milestone is deliberately small:

- OpenFox Plugin API v2 package.
- Plugin settings for backend, endpoint, model, API key and timeout.
- A generic `semantic_decide` tool.
- One HTTP adapter for a System One-compatible endpoint.
- Support for `noul`, `choice` and `score`.
- Normalized errors, timeout/abort handling and tests.
- A tiny evaluation harness comparing the semantic path with the normal OpenFox path.

No automatic workflow gating in V0.

## Candidate use cases

| Use case | Purpose | Priority | Main risk |
| --- | --- | --- | --- |
| `semantic_verify_task` | Check issue/acceptance criteria against implementation evidence before another verifier pass | High | False pass |
| `semantic_scan` | Rank functions/files by whether they exhibit a requested behavior | High | Candidate misses |
| `semantic_search` | Find likely relevant code with less exploratory reading | Medium | Extra scan cost |
| Context relevance | Keep/drop/rank old context before an LLM call | High potential | Removing useful context |
| Model/skill routing | Pick a model or skill | Low for this project | Adds complexity without clear value |

### Important OpenFox API note

The stable Plugin API v2 already supports tools, settings, hooks and workflow transitions.

OpenFox `develop` also currently exposes `registerMessageTransform`, which can mutate the pre-LLM message stream and is a natural future integration point for context reduction. That API is **not present in the v2.0.157 release** used as the initial compatibility baseline, so V0 must not depend on it. Re-check upstream before implementing the context-reduction experiment.

## System One contract

The integration should model the public typed-decision shape rather than a Jev-specific SDK:

- `noul`: yes/no proposition represented by a probability.
- `choice`: choose among caller-provided options, with probabilities.
- `score`: place state on an ordered rubric.

Multiple questions about the same state should be batchable in one call.

Compatible/local runtimes are evolving quickly. Current projects worth evaluating include:

- [LiteVar/system-one](https://github.com/LiteVar/system-one) — local runtime exposing a Jev-compatible API.
- [alvarobartt/sys1](https://github.com/alvarobartt/sys1) — Rust System One-compatible API for open decision models.
- [yijunyu/jev-rs](https://github.com/yijunyu/jev-rs) — Jev-compatible engine / harness for local models.
- [dzhng/jevgrep](https://github.com/dzhng/jevgrep) — useful reference for semantic code retrieval, not a provider abstraction.

These are references/candidates, not dependencies or endorsements. Compatibility and quality must be tested.

## Evaluation: what counts as success

Every experimental feature should be compared with an OpenFox baseline on the same tasks.

Record at least:

- total input/output tokens consumed by the main generative model;
- semantic-provider input and cost;
- end-to-end wall-clock time;
- number of main-model calls / verifier calls avoided;
- semantic fallback rate;
- task success / acceptance-criteria success;
- false-pass and false-negative rate for verification use cases;
- provider failures/timeouts;
- cache hit rate if caching is later introduced.

A feature that saves semantic-provider latency but makes the overall OpenFox task slower is a failure. A feature that saves tokens but increases false passes is also a failure.

## Safety and failure behavior

- Provider failure must not silently become a positive decision.
- Experimental optimization paths should fail open to the normal OpenFox behavior where possible.
- High-impact decisions should keep an explicit LLM/human fallback until measured otherwise.
- API credentials must use OpenFox secret settings and must never be logged.
- Remote code/state transmission must be obvious in documentation and configuration.

## OpenFox compatibility

Initial target:

- OpenFox Plugin API: v2
- Node.js: 24+
- Language: TypeScript / ESM
- Minimum compatibility baseline: OpenFox 2.0.157 for tools/settings
- No OpenFox core patch required for V0

Authoritative upstream references:

- [OpenFox plugin contract](https://github.com/co-l/openfox/blob/develop/docs/PLUGINS.md)
- [OpenFox plugin API source](https://github.com/co-l/openfox/blob/develop/src/plugin/index.ts)
- [Reference plugin](https://github.com/co-l/openfox/tree/develop/examples/hello-plugin)

## Development order

1. Freeze the provider/request/response contract.
2. Implement the generic System One HTTP adapter.
3. Expose `semantic_decide` as an OpenFox tool.
4. Add fixture-based provider tests and a minimal benchmark harness.
5. Run real comparisons before promoting any higher-level use case.
6. Add `semantic_verify_task` first if results justify it.
7. Explore semantic scan/search.
8. Explore pre-LLM context reduction only against an OpenFox release that officially exposes message transforms.

See [AGENTS.md](./AGENTS.md), [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) and [docs/EVALUATION.md](./docs/EVALUATION.md) before implementing.
