# Implementation order and delivery status

Current delivery state updated through the #35 Phase A evidence cycle on
2026-10-03. The OpenFox compatibility baseline is `2.0.161`; the recorded
harness evidence still comes from released tags `v2.0.157` and `v2.0.160`,
which are history rather than the current minimum. No OpenFox core
modifications.

## Current shape

Nine tools (`semantic_decide`, `semantic_verify_task`,
`semantic_issue_coverage`, `semantic_search`, `semantic_scan`,
`semantic_provider_self_test`, `semantic_calibration_candidate`,
`semantic_question_calibration`, `semantic_reference_agreement`),
two usage skills, global settings, presets,
an optional cache, explicit egress policy, a calibration layer, an opt-in
advisory workflow file and one registered message transform
(`semantic-context-reduce`, inert unless `contextReduce` is enabled). Nothing
registers a hook or a workflow transition. #35 currently adds
benchmark/evidence artifacts only.

| Order | Issues | Delivery / gate |
| --- | --- | --- |
| 1 | #1 | Generic HTTP adapter, request/answer validation, timeout, cancellation, bounded responses. Implemented in this branch. |
| 2 | #2 | Explicit `semantic_decide` tool, global runtime settings and secret key. Implemented in this branch. |
| 3 | #3 | Synthetic protocol fixture runner and import/report of measured baseline/candidate records. Implemented; real quality/performance measurements remain pending. |
| 4 | #13 (CI/package part) | CI and package build checks are moved forward. No published release or registry submission yet. |
| 5 | #7, #10 | Run provider conformance; add endpoint/egress policy before automated collection of source/session data. Implemented: 13-case conformance suite with `capabilities`/`deviations` report, offline `conformance:smoke` stub, endpoint classification with override, and `egressPolicy` guards. Reproducible in CI offline; one hosted live run recorded a single `choice` deviation, and two live 7-case `verify-0.2.1` campaigns against Kev/Laya are committed as number-only snapshots. Those are **verification** campaigns, not the conformance matrix, and none of them measures quality. |
| 6 | #8, #9 | #8 presets shipped as thin data-only capability declarations. #9 remains open: comparing runtimes on labelled fixtures needs reachable endpoints and hardware access. |
| 7 | #4, #14 (verification) | Experimental post-build criterion checks, then matching usage skill. No automatic completion. Implemented: `semantic_verify_task` (one criterion per call, automatic origin, versioned uncalibrated policy), offline labelled fixture runner, `semantic-verification` skill. Verified offline only. |
| 8 | #5, #14 (discovery) | Implemented: `semantic_search` and `semantic_scan` over a caller-narrowed candidate list, plus the `semantic-code-discovery` skill. Advisory only; the agent confirms candidates with normal code tools. |
| 9 | #11, #12 | Implemented: optional decision cache (off by default) and an opt-in advisory workflow file. The plugin registers no hook and no transition, so verification cannot be shortened. |
| 10 | #6 | **Implemented, opt-in, unmeasured**: `registerMessageTransform` and the `transforms` capability shipped in OpenFox 2.0.161, so the minimum supported version moved there. `semantic-context-reduce` is registered but inert unless the `contextReduce` setting is enabled; it fails open. Token and task-quality effects are unmeasured, so the setting stays off by default. |
| 11 | #13 (release readiness) | Completed: CI, offline suite, package/install recipes and isolated-host validation are in place; package version 0.1.0 is prepared. No Git tag, GitHub release or registry publication is implied. |
| 12 | #33 | **Completed**: `semantic_issue_coverage` aggregates explicit criteria through the existing verification policy/calibration/egress path. Advisory only; no merge gate. |
| 13 | #34 | **Completed**: bounded local recall feeds true per-file semantic reranking in `semantic_search`; explicit candidates remain supported and `semantic_scan` stays explicit-candidate. No persistent index/vector DB. |
| 14 | #35 | **Backend viability GO / production DEFER**: labelled smoke manifest + versioned harness + Qwen VLM baseline + typed OpenJev System One baseline are recorded. OpenJev is 7/7 on the smoke set at 875 ms median with typed probabilities. Production API remains blocked on the 31-case action-state safety gate. |

Completed issues above were implemented and checked separately. #33 and #34 are now delivered. #35 remains evidence-only for production: backend viability is now demonstrated by the typed OpenJev smoke run, but the production GO/DEFER gate still requires the frozen action-state corpus and safety metrics. #9 collects measured impact after functionality exists; it is not a provider-tuning loop. #6 is implemented and opt-in; what it still lacks is the #9 measurement that would justify enabling it. A fixture run is protocol evidence, not decision-quality or OpenFox end-to-end evidence.

## Current boundaries

- Settings are **global** plugin settings. Per-project egress policy is a later
  deliverable.
- Endpoint class and egress policy are global settings. A blocked call fails
  with `egress_blocked` before any request leaves the process and is never
  rerouted.
- A `DecisionOptions.origin` of `automatic` is what the egress policy restricts.
  The shipped `semantic_decide` tool never sets it, so explicit tool calls stay
  allowed unless the policy is `block-remote-all`. Higher-level tools that
  assemble repository/session content (`semantic_verify_task`, `semantic_search`,
  `semantic_scan`) do set it.
- `semantic_verify_task` (#4) always sets `origin: 'automatic'`: it assembles
  criterion, diff excerpts and test output taken from the repository/session. It
  exposes no explicit mode, so a remote endpoint under `block-remote-automatic`
  rejects it before any request is sent, while an explicit `semantic_decide` call
  stays allowed.
- Endpoint is a full POST URL; it is deliberately required, including for the
  `jev` selector. The selector is a label, not a preset with guessed defaults.
- No endpoint discovery or inference call happens at plugin registration.
- Source/state is sent only when a semantic tool is explicitly invoked.
  Configure an appropriate endpoint before enabling these tools in an agent.
- Score criteria use an ordered array. Object score rubrics are rejected rather
  than silently reinterpreted. Choice criteria support arrays and description
  objects.
- Response parsing currently targets typed `answers` with `noul`, choice
  distributions and score distributions. Other runtime shapes need conformance
  evidence and an explicit transport shim.
- Arbitrary HTTP/network error bodies are deliberately omitted to avoid
  reflecting secrets or submitted state. HTTP status remains available.
- Core text-provider quality, false-pass rates and end-to-end savings remain
  **unmeasured**. #35 now has both a measured conventional-VLM smoke baseline
  and a measured typed System One OpenJev smoke baseline, but its action-state
  false-positive-success/fallback metrics remain null. What is
  also measured is the host behaviour: the built package loads on both
  declared OpenFox releases, 20/20 harness and 67/67 agent-e2e checks each, with
  no hook and no transition.

## semantic_verify_task experiment (#4) and its skill (#14)

Implemented on `feat/4-14-semantic-verification`, based on the merged Lot 1
baseline (`f0a1d9c`), and merged to `main`.

Shape:

- one acceptance criterion per call; the four policy questions are batched into
  a single provider call;
- bounded state: criterion, optional summary, diff excerpts and deterministic
  test output. Oversized evidence is **rejected**, never truncated, so a cut
  excerpt cannot silently turn into a false pass;
- `evidenceRefs` stay local: they appear in the report trace and are never
  transmitted;
- the report carries `reportId` and a `trace` block (`issueId`, `criterionId`,
  `criterionText`, `evidenceRefs`) so coverage of many requirements can be
  aggregated later without changing the format;
- thresholds live in `src/verify/policy.ts` only, as versioned constants. No
  threshold was added to the settings schema.

Safety properties, each covered by a named test:

- the shipped policy is `calibrated: false`, so `pass-candidate` is structurally
  unreachable and production output is `unknown` or a follow-up status;
- a missing, malformed or out-of-range answer yields `unknown`, never a pass;
- values inside a gate's uncertainty band are `undecided`, never a pass;
- provider error, timeout, cancellation and blocked egress return
  `success: false` with a controlled code and no verdict;
- no upstream body, endpoint or API key is ever reflected in output or errors;
- no workflow transition, hook, completion signal or "done" behaviour exists.

What has **not** been measured: false-pass rate, false-negative rate, avoided
verifier calls, token savings, wall time and task regressions. The offline
fixture run uses a scripted transport, so its answers are authored rather than
inferred; its report therefore says `measured: false` with
`falsePassRate: null`. A null rate is not a zero rate.

`npm run verify:experiment` reproduces the labelled suite offline with no
credentials. `SEMANTIC_ENDPOINT=... npm run verify:experiment -- --live`
replaces only the transport and is excluded from CI.

The `semantic-verification` skill ships with this tool through
`registerSkillSource`, which exists in the Plugin API v2 baseline (verified
against OpenFox 2.0.157 and 2.0.160). It did not by itself raise the minimum
supported version; that moved to 2.0.161 when the message transform was added.
`semantic-code-discovery` shipped with #5; it teaches `semantic_search` and
`semantic_scan`, which now exist, so guidance is never advertised for a tool
the agent cannot call.

## Compatibility validated on both ends of the range

**The compatibility baseline is now `2.0.161`** (`>=2.0.161` in
`peerDependencies`), raised from `2.0.157` because the released
message-transform API this plugin registers arrived in 2.0.161.

The table below is the recorded history. The former declared minimum `2.0.157`,
the then-current `2.0.160`, and the current baseline `2.0.161` were each
installed into their own throwaway tree, through the host's own public
`POST /api/plugins/install` route, and loaded the plugin:

| Release | `npm run harness` | `npm run harness:agent-e2e` |
| --- | --- | --- |
| `2.0.157` | 20/20 | 67/67 |
| `2.0.160` | 20/20 | 67/67 |

The two earlier releases each reported six tools, one skill source and
thirteen settings fields, with zero hooks and zero transitions.

| `2.0.161` | 23/23 | not run |

The `2.0.161` row is the current baseline and was actually executed:
`HARNESS_PKG_DIR=/tmp/of-harness-2.0.161 npm run harness` installed OpenFox
2.0.161 into a throwaway tree and reported 23/23, including two checks that
only exist because of this release — the manifest declares the `transforms`
capability, and the host itself reported `messageTransforms=1`, proving the
released message-transform API loaded our transform instead of ignoring it.
The harness also reported nine tools, one skill source, fourteen settings
fields, and still zero hooks and zero transitions.

`harness:agent-e2e` was **not** re-run against 2.0.161: that suite needs a live
LLM provider and a real agent turn, so it is not reproducible offline. No
`agent-e2e` count is claimed for 2.0.161.

No private API is used. The reported version is always read back from the installed tree; a report can
no longer name a release it did not run against. See
[docs/INSTALLATION.md](./INSTALLATION.md) for the install recipes and
[docs/TRACEABILITY.md](./TRACEABILITY.md) for the mapped requirements.

## What an operator still has to do

1. Install the plugin in an OpenFox instance — see [INSTALLATION.md](./INSTALLATION.md).
2. Configure a full hosted or local System One endpoint, and a key if the
   endpoint needs one, in global plugin settings.
3. Allow the tools you want in the agent's `allowedTools`. Registration does
   not grant access.
4. Optionally install the advisory workflow file with
   `openfox-semantic-workflow --out <dir>`.

No change to a production OpenFox installation is performed by this repository:
the harnesses point `HOME`, `XDG_CONFIG_HOME` and `XDG_DATA_HOME` at a fresh
temporary tree and bind loopback only.

## First provider selected

The user selected hosted Jev as the first real evaluation target. Configure its verified endpoint and key in the execution environment; no hosted URL or credential is guessed or embedded.

`npm run conformance` runs the full protocol case matrix against `SEMANTIC_ENDPOINT`, with optional `SEMANTIC_API_KEY` and `SEMANTIC_MODEL` and an optional `SEMANTIC_UNSUPPORTED_MODEL` for the negative model case. It persists a redacted JSON report carrying `compatible`, `capabilities` and `deviations`. `npm run conformance:smoke` runs the identical suite against a local offline stub, so conformance is reproducible in CI without credentials.

CI and every required check run offline against that stub. Live runs are opt-in
and were performed by the maintainer, not by CI: one campaign reached the hosted
endpoint and recorded a single deviation (`choice` with array criteria), and two
`verify-0.2.1` campaigns are committed as number-only snapshots under
`benchmark/snapshots/`. Those runs prove transport wiring and report shape only.
#9 labelled quality benchmarks between runtimes remain open, so no runtime is
known to be better than another, and no false-pass rate exists.
