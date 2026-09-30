# openfox-semantic-tools

Experimental OpenFox plugin for **fast, typed semantic decisions** and, where it is measurably useful, **lower token usage and lower latency**.

The project is intentionally provider-agnostic. The first transport target is the Jev / System One-style `POST /v1/systemone` API, so the same OpenFox tools can be backed by hosted Jev or by a compatible local/open-source runtime.

> Status: V0 implementation — HTTP transport, `semantic_decide`, tests and fixture evaluation. Real provider quality and OpenFox runtime installation are still to be measured.

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

See [AGENTS.md](./AGENTS.md), [docs/ROADMAP.md](./docs/ROADMAP.md), [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md), [docs/PROVIDERS.md](./docs/PROVIDERS.md) and [docs/EVALUATION.md](./docs/EVALUATION.md) before implementing.

## Run the implemented V0

```bash
npm ci --ignore-scripts
npm run check
npm run evaluate
npm pack
```

The package entry is `dist/index.js`; `prepack` builds it. Install the built package through OpenFox's plugin installation flow, then enable it. Configure the **full POST endpoint**, optional model/API key, and timeout in global plugin settings. `backend` currently identifies the intended backend; it does not supply an inferred endpoint. No endpoint is selected automatically.

Allow `semantic_decide` in the agent's tool list. Tool registration does not grant access. V0 does not install skills for tools that do not exist yet.

Example tool arguments:

```json
{
  "state": {"evidence": "Public synthetic excerpt"},
  "questions": {
    "satisfied": {"type": "noul", "instructions": "Does the supplied evidence satisfy the criterion?"},
    "region": {"type": "choice", "instructions": "Choose the relevant region", "criteria": ["handler", "database"]},
    "coverage": {"type": "score", "instructions": "Rate evidence completeness", "criteria": ["absent", "partial", "complete"]}
  }
}
```

Output contains `provider`, optional `model`, `answers` and `latencyMs`. Noul responses normalize the wire field `noul` to `probability`. Choice/score retain their distributions. Score criteria must be ordered arrays in the currently verified common protocol. Failures return `success: false` with a JSON error containing `code` and a controlled message.

**Data sent:** exactly the supplied state, questions and optional model. No repository scanning, context mutation or automatic workflow gating is enabled. The configured endpoint receives the content when the tool is invoked. Keys use OpenFox secret settings; HTTP errors report status without reflecting response bodies. Redirects are refused.

The default evaluation uses deterministic synthetic responses to test plumbing. It makes no quality or saving claim. To compare actual measurements, supply an array of `RunRecord` values (see `src/evaluation/records.ts`):

```bash
npm run evaluate -- /path/to/measured-runs.json /path/to/report-directory
```

Unmeasured metrics are `null`, not zero. Baseline and candidate remain separate in the summary. Results stay uncommitted by default. See [implementation order and delivery boundaries](docs/IMPLEMENTATION.md).

For opt-in live protocol checks, configure `SEMANTIC_ENDPOINT`, `SEMANTIC_API_KEY` and optionally `SEMANTIC_MODEL` securely in your environment, then run `npm run conformance`. The report omits the endpoint and credentials. Live checks are excluded from CI.

```bash
npm run conformance            # against SEMANTIC_ENDPOINT
npm run conformance:smoke      # against a local offline stub, no credentials
```

`npm run conformance:smoke` is the only conformance evidence reproducible in
CI: it starts a local System One stub and runs the same case matrix, so it
proves the transport, the suite and the report shape. It proves **nothing** about
decision quality or about a real runtime. `SEMANTIC_UNSUPPORTED_MODEL` enables
the negative model case.

The report contains no provider identity and no provider verification: nothing a
protocol probe can do establishes which system answered, and a public-looking
hostname may resolve to loopback. It reports observations only —
`remoteEndpointObserved`, `localEndpointObserved`, `protocolConformanceObserved`
and the purely descriptive `providerLabelExplicitlyConfigured` — plus the
`compatible` / `strictCompatible` verdicts and the authoritative `deviations`
list. A `compatible: true` result against the stub says nothing about hosted Jev
or any other provider; no real runtime has been exercised by this repository
yet. See [providers and egress](docs/PROVIDERS.md).

## Controlling what leaves the machine

Every semantic call sends its state to the configured endpoint. Two settings
make that boundary explicit:

- **Endpoint class** — auto-detected as `local`, `private` or `remote`, with a
  manual override for unusual networks.
- **Egress policy** — `allow` (default), `block-remote-automatic` (refuses
  automatic remote calls for repository/session-derived content while keeping
  deliberate `semantic_decide` calls) or `block-remote-all` (refuses every remote
  call).

Local and private endpoints are never blocked. A blocked call returns a
structured `egress_blocked` failure **before** any request is sent and is never
silently rerouted. Automatic calls opt into the policy explicitly via
`DecisionOptions.origin`; a call that does not declare an origin is treated as
explicit, because the tool is only ever invoked deliberately today.

Redaction of state is deliberately not implemented: it would change the meaning
of the question. Control the boundary by choosing a local or private endpoint,
or by restricting the policy. See [providers and egress](docs/PROVIDERS.md).
