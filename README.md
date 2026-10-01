# openfox-semantic-tools

Experimental OpenFox plugin for **fast, typed semantic decisions** and, where it is measurably useful, **lower token usage and lower latency**.

The project is intentionally provider-agnostic. The first transport target is the Jev / System One-style `POST /v1/systemone` API, so the same OpenFox tools can be backed by hosted Jev or by a compatible local/open-source runtime.

> Status: six tools, two usage skills, presets, optional cache, egress,
> calibration and advisory workflow, validated on OpenFox 2.0.157 and 2.0.160.
> Dated provider observations are scoped in #9; no durable quality
> certification or end-to-end savings claim is made. See
> [Evaluation](#evaluation-what-counts-as-success).

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
  +-- semantic_decide            noul / choice / score, batched
  +-- semantic_verify_task       advisory, one criterion per call
  +-- semantic_search            advisory, caller-narrowed candidates
  +-- semantic_scan              advisory, caller-narrowed candidates
  +-- semantic_provider_self_test
  +-- semantic_calibration_candidate
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

## What this plugin actually registers

Six tools and two usage skills, all through the public Plugin API v2. Nothing
below is planned; see [docs/ROADMAP.md](./docs/ROADMAP.md) for what is not.

| Tool | Shape | Advisory? |
| --- | --- | --- |
| `semantic_decide` | One state plus batched `noul`/`choice`/`score` questions. | No — it returns typed answers, not verdicts. |
| `semantic_verify_task` | One acceptance criterion plus bounded evidence. | Yes — never a pass. |
| `semantic_search` | Ranks a caller-supplied file list by relevance to a query. | Yes — candidates only. |
| `semantic_scan` | Scores a caller-supplied file list against a behavioural predicate. | Yes — candidates only. |
| `semantic_provider_self_test` | Embedded synthetic smoke test against the configured endpoint. | Yes — never changes settings. |
| `semantic_calibration_candidate` | Turns an operator-labelled case set into an inactive candidate profile. | Yes — never activates anything. |

| Skill | Covers |
| --- | --- |
| `semantic-verification` | When to use `semantic_verify_task`, and when to fall back. |
| `semantic-code-discovery` | When `semantic_search`/`semantic_scan` reduce exploration. |

Supporting features: global settings, provider presets with capability
declarations, an optional decision cache (off by default), explicit endpoint
classification and egress policy, a versioned calibration layer, and an opt-in
advisory workflow file.

**What is not here:** no automatic verification gate, no hook, no workflow
transition, no context mutation, and no message transform. The plugin registers
zero hooks and zero transitions, which the real host confirms.

### The one hard blocker

OpenFox `develop` exposes `registerMessageTransform`, the natural hook for
pre-LLM context reduction. That API was **absent from the two released versions
checked here** (`v2.0.157` and `v2.0.160`, both read directly from
`src/plugin/index.ts`), so context reduction is **blocked on the released-API
issue** and is not implemented. Re-check upstream before starting it, and
re-check further releases rather than assuming the whole line behaves alike.

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

### What is actually measured today

**No durable quality certification, and no end-to-end saving has been
measured.** The shipped evidence is:

- offline protocol conformance against a local stub (`npm run conformance:smoke`);
- labelled fixtures replayed through a scripted transport (`npm run verify:experiment`);
- replays of two committed number-only live snapshots (`npm run verify:replay`);
- real-host plugin loading, settings, skills and tool registration on two
  OpenFox releases (`npm run harness`, `npm run harness:agent-e2e`).

Those live snapshots are dated observations scoped in #9, not a benchmark and
not a certification. No false-pass rate exists. No token, cost or wall-time
saving exists. Those fields stay `null` and are never written as zero. A
measurement that was not made is unknown, not good.

## Safety and failure behavior

- Provider failure must not silently become a positive decision.
- Experimental optimization paths should fail open to the normal OpenFox behavior where possible.
- High-impact decisions should keep an explicit LLM/human fallback until measured otherwise.
- API credentials must use OpenFox secret settings and must never be logged.
- Remote code/state transmission must be obvious in documentation and configuration.

## OpenFox compatibility

- OpenFox Plugin API: v2
- Node.js: 24+
- Language: TypeScript / ESM
- **Minimum validated release: OpenFox 2.0.157** (`>=2.0.157` in
  `peerDependencies`)
- No OpenFox core patch, public or private

Both ends of the range were validated by installing the package into a **real
isolated host** in a throwaway tree — including through the host's own
`POST /api/plugins/install` local-path route, not a hand-made copy.

| Check | `2.0.157` (minimum) | `2.0.160` |
| --- | --- | --- |
| `npm run harness` (install, load, skills, tools, settings) | 20/20 | 20/20 |
| `npm run harness:agent-e2e` (real agent turns, permissions, workflow) | 67/67 | 67/67 |

Both hosts reported the same six tools, one skill source and thirteen settings
fields, and confirmed zero hooks and zero transitions. The versions above are
read back from each installed tree, never hardcoded.

Authoritative upstream references:

- [OpenFox plugin contract](https://github.com/co-l/openfox/blob/develop/docs/PLUGINS.md)
- [OpenFox plugin API source](https://github.com/co-l/openfox/blob/v2.0.160/src/plugin/index.ts)
- [Reference plugin](https://github.com/co-l/openfox/tree/develop/examples/hello-plugin)
- [Installation recipes](docs/INSTALLATION.md)

## Run it locally

```bash
npm ci --ignore-scripts
npm run check
npm run evaluate
npm run verify:experiment
npm pack --dry-run     # inspect the packed contents; see INSTALLATION.md
```

See [docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md) for the contributor loop.

The two harnesses are separate because they need a throwaway OpenFox install
first (`scripts/setup-harness.sh`, which never touches your own OpenFox). Use
one `HARNESS_PKG_DIR` per version:

```bash
HARNESS_PKG_DIR=/tmp/of-harness-2.0.157 OPENFOX_VERSION=2.0.157 scripts/setup-harness.sh
HARNESS_PKG_DIR=/tmp/of-harness-2.0.157 npm run harness    # loading, settings, skills
HARNESS_PKG_DIR=/tmp/of-harness-2.0.157 npm run harness:agent-e2e  # real agent turns, permissions, workflow runtime
```

Install the built package through OpenFox's plugin installation flow, then enable
it. The exact recipes — and why a GitHub URL is not a pinned install — are in
[docs/INSTALLATION.md](./docs/INSTALLATION.md).

Allow the semantic tools you want in the agent's tool list. Tool registration does not grant access. Each usage skill ships with the tools it describes: `semantic-verification` with `semantic_verify_task`, `semantic-code-discovery` with `semantic_search` and `semantic_scan`.

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
list. A `compatible: true` result against the stub says nothing about any hosted
provider.

One opt-in live campaign has reached the official hosted endpoint and recorded a
single real deviation (`choice` with array criteria), which is why the hosted
preset declares `choiceArrayCriteria: false`. That declaration describes **one
observed run**, not a permanent property of the runtime.

Two further live runs — 7-case `verify-0.2.1` campaigns against Kev and Laya —
are committed as number-only snapshots. They are **verification** campaigns over
the policy, not the conformance matrix, so no conformance deviation list exists
for those runtimes. These seven-case verification snapshots are not a
conformance matrix or a quality certification; dated comparison observations are
scoped in #9, with no durable quality/savings claim.
See [providers and egress](docs/PROVIDERS.md).

## Decision cache (optional, off by default)

An identical previous answer can be reused instead of calling the provider
again, which helps during retries and verifier loops. Three settings control it:

| Setting | Default | Meaning |
| --- | --- | --- |
| `cacheEnabled` | `false` | Turns the cache on. Off means behaviour is unchanged. |
| `cacheTtlMs` | `300000` | How long an entry may be reused. `0` disables reuse. |
| `cacheMaxEntries` | `128` | Hard bound, oldest-first eviction. |

It is deliberately conservative:

- the key covers the tool namespace, preset, endpoint, model, protocol version,
  state, questions **with their criteria**, and the policy version for a
  higher-level result — never the question text alone;
- no secret reaches a key: userinfo and credential-looking query parameters are
  stripped, and the key is an opaque digest that is safe to log;
- a **non-secret** query parameter is kept, so `?tenant=a` and `?tenant=b`
  cannot share entries;
- the store is rebuilt when the provider identity changes, including the
  credential, because a different key can address a different tenant on the same
  host. The fingerprint is opaque and never leaves the process;
- only successful answers are stored, so an error, timeout or malformed response
  is never replayed as a result;
- values are cloned in and out, so a caller cannot corrupt the store;
- the generic decision namespace is separate from any policy outcome.

It cannot calibrate anything and cannot make a positive verdict reachable.
Benchmark evidence is still missing, which is why it stays disabled by default.
See [providers, egress and cache](docs/PROVIDERS.md).

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

## Advisory acceptance-criteria check (experiment)

`semantic_verify_task` asks a small decision model whether **one** acceptance
criterion is actually satisfied by the evidence you supply, after your
deterministic checks have run. It is an **experiment**, not a completion gate.

```json
{
  "criterionId": "ac-1",
  "criterion": "The timeout setting is bounded between 1 and 120000 ms.",
  "issueId": "#4",
  "evidence": {
    "summary": "Added a numeric timeout setting validated at construction.",
    "diffExcerpts": ["+ if (settings.timeoutMs > 120000) throw ..."],
    "deterministicTestResults": ["ok 1 - settings defaults and invalid configuration"]
  },
  "evidenceRefs": ["src/providers/system-one.ts", "test/provider.test.ts#timeout-bounds"]
}
```

One criterion per call. `evidenceRefs` are recorded in the report for your own
traceability and are **never transmitted**; only the criterion, summary, diff
excerpts and test output leave the machine. Oversized evidence is rejected
rather than truncated, so a cut excerpt can never become a silent false pass.

The result is always advisory:

| Status | Meaning |
| --- | --- |
| `unknown` | Not decided: missing evidence, uncertainty band, uncommitted answer, or no calibration |
| `needs-verification` | The criterion does not look satisfied, or a deeper pass is advised |
| `insufficient-evidence` | The evidence does not directly address the criterion |
| `off-scope` | The change touches unrelated behaviour |
| `pass-candidate` | **Not reachable today** (see below) |

**There is currently no `pass-candidate` outcome in production.** The shipped
policy is explicitly uncalibrated: no labelled run against a real provider has
been performed, so even when every gate is met the tool reports `unknown` and
falls back to the normal verification path. This is deliberate — a positive
verdict is the dangerous direction for this use case, and the false-pass rate is
unknown rather than zero.

A failed call (provider error, timeout, cancellation, blocked egress) returns
`success: false` with a controlled code. It is never a verdict.

**Origin and egress:** this tool always assembles repository/session-derived
content, so it always declares an `automatic` call origin. With
`egressPolicy: block-remote-automatic` and a remote endpoint, it fails with
`egress_blocked` before any request is sent. Explicit `semantic_decide` calls
remain allowed under the same policy.

**Not implemented, on purpose:** no workflow transition, no hook, no
completion signal, no automatic "done" behaviour. The tool cannot accept a task
or close a criterion. Workflow integration is a separate decision (issue #12)
gated on measured false-pass evidence.

### Measuring the check

```bash
npm run verify:experiment            # offline, scripted transport, no credentials
```

This replays a labelled fixture set (positive, negative and adversarial cases)
through the real tool and the real policy, and writes
`benchmark/results/verify/{report.json,runs.json,summary.md}`.

It is **plumbing evidence only**. The transport is scripted, so the answers are
authored rather than inferred, and the report therefore records
`measured: false` with `falsePassRate: null`. A null rate is not a zero rate.
Token savings, avoided verifier calls and task regressions remain unmeasured.

For an opt-in live run, set `SEMANTIC_ENDPOINT` (and `SEMANTIC_API_KEY` if
required) and pass `--live`. The live path replaces only the transport; the tool
and the policy under test are identical. It is excluded from CI.

```bash
SEMANTIC_ENDPOINT=... npm run verify:experiment -- --live
```

### Replaying the recorded campaigns

```bash
npm run verify:replay                   # offline, no credentials
```

Two live `verify-0.2.1` campaigns are committed as sanitized, number-only
snapshots under `benchmark/snapshots/verify-0.2.1/`, with a readable companion
at `benchmark/snapshots/provider-smoke-2026-10-01.md`. They carry the observed
status, the reasons and the per-gate numbers, and nothing else: no state, no
evidence, no criterion text, no endpoint, no credential.

The replay re-derives those recorded numbers under the frozen `verify-0.2.1`
rules and under the shipped policy. The frozen rules must reproduce the status
each run recorded — if they do not, the comparison column means nothing, and
the replay fails. This is **arithmetic on recorded numbers, not a measurement**:
it never writes a rate and never claims a false-pass count.

## Usage skills

The plugin registers two usage skills through the public `registerSkillSource`
API (present in the Plugin API v2 baseline):

- `semantic-verification` — when to use the check, when **not** to, which
  evidence to assemble, how to read each status, and when to fall back to the
  normal verifier. It states that tests, typechecks, linters and human review
  remain mandatory.
- `semantic-code-discovery` — when semantic search and scoring actually reduce
  repository exploration, and when grep, symbols or tests already answer the
  question.

The skills carry no provider name, endpoint, URL or model id, and they never
imply they grant tool access: the matching tools must still be listed in the
agent's allowed tools.

### Permissions, as observed on a real host

Verified with `npm run harness:agent-e2e` against isolated OpenFox `2.0.157` and
`2.0.160`, 67/67 checks on each; see `docs/TRACEABILITY.md` for the full
evidence.

| Configuration | Observed behaviour |
| --- | --- |
| Skill loaded, tool not in `allowedTools` | the host refuses the call with an allow-list message; no provider request is made |
| Tool in `allowedTools`, skill never loaded | the tool executes normally; the skill is guidance, not a precondition |
| Tool in `allowedTools` and `load_skill` called | both skills load through the normal `load_skill` tool, then the tool executes |

One host caveat is worth knowing: a plugin tool is only permission-checked when
the agent's `allowedTools` names **at least one** non-builtin tool. An agent
whose list is builtins-only is not restricted from plugin tools at all.

### Advisory workflow: the agent is opt-in

The advisory workflow's semantic step runs as the agent named in the workflow
document. The shipped default is the stock `builder`, which does **not** have
`semantic_verify_task` in its `allowedTools`, so the step reports the tool as
unavailable and continues to the normal verifier. That is safe, but it means the
advice is never actually produced.

To really get the advice, write the workflow with an agent that has the tool:

```ts
import { advisoryWorkflowFor } from 'openfox-semantic-tools'

const workflow = advisoryWorkflowFor('my-agent-with-verification')
```

Only the advisory step's `agentId` changes. The deterministic checks, the normal
verifier and every transition condition are identical in both forms, so opting
in cannot shorten verification.

## Provider calibration and self-test

Semantic-provider numeric scales are not treated as interchangeable. Verification now supports a versioned calibration profile plus explicit operator overrides with the precedence:

`explicit override > active calibration profile > conservative defaults`.

A profile is never applied unless its own `active` field is true, and a profile whose configured provider/model/version no longer matches is reported as stale/unverified and is not applied.

Two advisory tools are available:

- `semantic_provider_self_test` — runs a small embedded synthetic smoke test against the configured endpoint and reports protocol reachability, profile freshness, observed gate ranges, warnings and fallback categories. It reads no repository/session content and never changes settings.
- `semantic_calibration_candidate` — turns an operator-owned labelled numeric case set into an inactive, observation-only candidate profile. It never invents thresholds or activates the result.

Configure `calibrationProfileJson`, `calibrationOverridesJson`, and optionally `runtimeVersion` in plugin settings. See `docs/CALIBRATION.md` for the schema, freshness rules and safety model.

The dated Jev/Kev/Laya snapshot is evidence for why this layer exists, not a leaderboard and not a built-in permissive profile.
