# Implementation order and delivery status

Baseline inspected: semantic-tools `79344d0`; OpenFox released tag `v2.0.157` (`4806791`) and current `develop`. No OpenFox core modifications.

| Order | Issues | Delivery / gate |
| --- | --- | --- |
| 1 | #1 | Generic HTTP adapter, request/answer validation, timeout, cancellation, bounded responses. Implemented in this branch. |
| 2 | #2 | Explicit `semantic_decide` tool, global runtime settings and secret key. Implemented in this branch. |
| 3 | #3 | Synthetic protocol fixture runner and import/report of measured baseline/candidate records. Implemented; real quality/performance measurements remain pending. |
| 4 | #13 (CI/package part) | CI and package build checks are moved forward. No published release or registry submission yet. |
| 5 | #7, #10 | Run provider conformance; add endpoint/egress policy before automated collection of source/session data. **Implemented on `feat/7-10-conformance-egress`**: 13-case conformance suite with `capabilities`/`deviations` report, offline `conformance:smoke` stub, endpoint classification with override, and `egressPolicy` guards. Verified offline only. |
| 6 | #8, #9 | Add only evidence-backed presets; compare providers on the same labeled fixtures. Requires reachable endpoints and runtime/hardware access. |
| 7 | #4, #14 (verification) | Experimental post-build criterion checks, then matching usage skill. No automatic completion. **Implemented on `feat/4-14-semantic-verification`**: `semantic_verify_task` (one criterion per call, automatic origin, versioned uncalibrated policy), offline labelled fixture runner, `semantic-verification` skill. Verified offline only. |
| 8 | #5, #14 (discovery) | Bounded scan/search experiments, then matching usage skill if useful. |
| 9 | #11, #12 | Cache and workflow optimization only after correctness and false-pass measurements justify them. |
| 10 | #6 | Context transform only after released API compatibility and task-regression tests. |
| 11 | #13 (release part) | Publish a usable release after install/runtime smoke tests and provider conformance. |

Each issue is implemented and checked separately. Experimental tools are not advertised through skills before they exist and are validated. A fixture run is protocol evidence, not decision-quality or OpenFox end-to-end evidence.

## Current boundaries

- V0 reads global plugin settings. Per-project egress policy is a later deliverable.
- Endpoint class and egress policy are global settings in this lot. A blocked call fails with `egress_blocked` before any request leaves the process and is never rerouted.
- A `DecisionOptions.origin` of `automatic` is what the egress policy restricts. The shipped `semantic_decide` tool never sets it, so explicit tool calls stay allowed unless the policy is `block-remote-all`. Higher-level tools (#4, #5) must set it when they assemble repository/session content.
- `semantic_verify_task` (#4) always sets `origin: 'automatic'`: it assembles criterion, diff excerpts and test output taken from the repository/session. It exposes no explicit mode, so a remote endpoint under `block-remote-automatic` rejects it before any request is sent, while an explicit `semantic_decide` call stays allowed.
- Endpoint is a full POST URL; it is deliberately required, including for the `jev` selector. The selector is a label, not a preset with guessed defaults.
- No endpoint discovery or inference call happens at plugin registration.
- Source/state is sent only when `semantic_decide` is explicitly invoked. Configure an appropriate endpoint before enabling this tool in an agent.
- Score criteria use an ordered array. Object score rubrics are rejected rather than silently reinterpreted. Choice criteria support arrays and description objects.
- Response parsing currently targets typed `answers` with `noul`, choice distributions and score distributions. Other runtime shapes need conformance evidence and an explicit transport shim.
- Arbitrary HTTP/network error bodies are deliberately omitted to avoid reflecting secrets or submitted state. HTTP status remains available.
- Real provider quality, false-pass rates, savings, and a running OpenFox installation smoke test remain unmeasured.

## semantic_verify_task experiment (#4) and its skill (#14)

Implemented on `feat/4-14-semantic-verification`, based on the merged Lot 1
baseline (`f0a1d9c`).

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
against OpenFox 2.0.157 and 2.0.160), so the minimum supported version is
unchanged. `semantic-code-discovery` (#14 discovery half, #5) is intentionally
not published: it would teach usage of tools that do not exist.

## Next operational check

1. Build and install this plugin into a test OpenFox instance.
2. Configure a full hosted or local System One endpoint and optional key in plugin settings.
3. Enable `semantic_decide` in the test agent's allowed tools.
4. Execute mixed question batches and verify failed/cancelled calls remain failed.
5. Record provider conformance and labeled decision results before adding semantic verification.

No change to the user's production OpenFox installation has been performed by this implementation.

## First provider selected

The user selected hosted Jev as the first real evaluation target. Configure its verified endpoint and key in the execution environment; no hosted URL or credential is guessed or embedded.

`npm run conformance` runs the full protocol case matrix against `SEMANTIC_ENDPOINT`, with optional `SEMANTIC_API_KEY` and `SEMANTIC_MODEL` and an optional `SEMANTIC_UNSUPPORTED_MODEL` for the negative model case. It persists a redacted JSON report carrying `compatible`, `capabilities` and `deviations`. `npm run conformance:smoke` runs the identical suite against a local offline stub, so conformance is reproducible in CI without credentials.

No paid or hosted request has been executed. The only conformance evidence produced so far is from the offline stub, which proves the transport, the case matrix and the report shape, and says nothing about a real runtime. #9 labeled quality benchmarks and real provider deviations remain open.
