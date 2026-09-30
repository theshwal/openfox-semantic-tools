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
| 7 | #4, #14 (verification) | Experimental post-build criterion checks, then matching usage skill. No automatic completion. |
| 8 | #5, #14 (discovery) | Bounded scan/search experiments, then matching usage skill if useful. |
| 9 | #11, #12 | Cache and workflow optimization only after correctness and false-pass measurements justify them. |
| 10 | #6 | Context transform only after released API compatibility and task-regression tests. |
| 11 | #13 (release part) | Publish a usable release after install/runtime smoke tests and provider conformance. |

Each issue is implemented and checked separately. Experimental tools are not advertised through skills before they exist and are validated. A fixture run is protocol evidence, not decision-quality or OpenFox end-to-end evidence.

## Current boundaries

- V0 reads global plugin settings. Per-project egress policy is a later deliverable.
- Endpoint class and egress policy are global settings in this lot. A blocked call fails with `egress_blocked` before any request leaves the process and is never rerouted.
- A `DecisionOptions.origin` of `automatic` is what the egress policy restricts. The shipped `semantic_decide` tool never sets it, so explicit tool calls stay allowed unless the policy is `block-remote-all`. Higher-level tools (#4, #5) must set it when they assemble repository/session content.
- Endpoint is a full POST URL; it is deliberately required, including for the `jev` selector. The selector is a label, not a preset with guessed defaults.
- No endpoint discovery or inference call happens at plugin registration.
- Source/state is sent only when `semantic_decide` is explicitly invoked. Configure an appropriate endpoint before enabling this tool in an agent.
- Score criteria use an ordered array. Object score rubrics are rejected rather than silently reinterpreted. Choice criteria support arrays and description objects.
- Response parsing currently targets typed `answers` with `noul`, choice distributions and score distributions. Other runtime shapes need conformance evidence and an explicit transport shim.
- Arbitrary HTTP/network error bodies are deliberately omitted to avoid reflecting secrets or submitted state. HTTP status remains available.
- Real provider quality, false-pass rates, savings, and a running OpenFox installation smoke test remain unmeasured.

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
