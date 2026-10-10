# Live provider findings — hosted Jev (declarative label `jev-hosted-official`)

These are **observations from one bounded run**, recorded honestly. They are not
a calibration, and they do not enable any production behaviour.

- Endpoint: the officially configured hosted System One endpoint (redacted here
  and in every artefact, as for all provider endpoints in this repository)
- Requested model: `jev-latest`; the runtime reported `jev-1.13.0`
- Provider label: `jev-hosted-official` — a **declarative label**, not a verified
  identity. Nothing here proves which system answered.
- Credential: supplied through an operator-provided key file, injected only into
  the child process environment. The value was never logged, printed, or stored.

## 1. Protocol conformance — reached the runtime, one real incompatibility

`npm run conformance` against the live endpoint:

- `endpointReachable: true`, `remoteEndpointObserved: true`
- `compatible: false`, `strictCompatible: false`
- `blanketRejection: false` (so the runtime does discriminate, it is not a blanket 400)
- `unverified: []` — every probed capability is an observation, none is unknown
- **Single deviation:** `choice-array-criteria` returned HTTP error, while
  object-map choice criteria worked.

Per-case outcome (12 cases, 11 matched):

| Case | Expectation | Observed | Matched |
| --- | --- | --- | --- |
| noul-single | pass | pass | yes |
| choice-object-criteria | pass | pass | yes |
| **choice-array-criteria** | pass | **fail (http)** | **no** |
| score-ordered-array | pass | pass | yes |
| batched-mixed-questions | pass | pass | yes |
| state-string / object / array | pass | pass | yes (3/3) |
| model-omitted / model-supplied | pass | pass | yes (2/2) |
| malformed-question-rejected-client-side | fail | fail | yes |
| malformed-wire-payload-rejected | fail | fail (http_422) | yes |

Observed capabilities: `noul`, `choice` (object criteria only), `score`,
`batchedQuestions`, `objectState`, `arrayState`, client-side malformed
rejection, runtime wire rejection — all true. `choiceArrayCriteria` — **false**.

This is a **real capability difference between Jev-compatible runtimes** and is
exactly what the conformance suite exists to surface. It must be handled
explicitly, either by falling back to object criteria for this runtime or by
documenting the array form as unsupported here.

## 2. Decision quality — the run is honest and negative

`npm run verify:experiment -- --live`:

- `transportFailures: 0` — the transport and egress path work against a real
  remote endpoint.
- `observedPositiveStatuses: []` — **no false pass occurred**; the production
  policy stayed uncalibrated and non-positive throughout.
- `falsePassRate: null`, `fallbackRate: null`, `measured: false` — one run over
  7 synthetic fixtures cannot state a rate.
- 4/7 fixtures reached the labelled status; 3 reached `unknown` instead of a
  follow-up status.
- Per-fixture wall time, all one batched call each (`semanticCalls: 1`):

| Fixture | Wall ms | Policy routing |
| --- | ---: | --- |
| positive-direct-evidence | 427 | fallback |
| positive-under-calibrated-policy | 230 | fallback |
| negative-criterion-not-implemented | 262 | fallback |
| adversarial-assertive-summary-without-code | 223 | fallback |
| adversarial-test-log-for-another-test | 231 | fallback |
| adversarial-off-scope-change | 244 | fallback |
| adversarial-ambiguous-criterion | 242 | fallback |
| **total** | **1 859** | 7/7 non-positive |

Latency is small and stable (~220–430 ms per 4-question batch), so the cost of
the semantic step itself is not the problem. Note this is provider latency only:
it is **not** an end-to-end OpenFox task measurement.

### Root cause of the 3 `unknown` results

Every live case carried `answer_unusable`, so the shipped policy rejected the
answers before routing. The campaign report intentionally does not persist raw
provider payloads, so the cause was identified from one bounded representative
response obtained during diagnosis (no threshold was changed to accommodate it):

```json
{ "type": "score", "score": 0.15, "confidence": 0.78,
  "legend": { "0": "none", "1": "partial", "2": "full" },
  "probabilities": { "0": 0.9, "1": 0.06, "2": 0.04 } }
```

The runtime answers a `score` question with a **continuous scalar plus a label
legend**, not a rubric index. The shipped policy deliberately requires a score
answer to be internally consistent (the score is a rubric index **and** the
distribution favours that index). A continuous score with a legend fails that
check and is treated as unusable — **by design, and in the safe direction**: it
produced `unknown`, never a pass.

This is a genuine, previously unknown protocol difference between the offline
smoke stub (integer scores) and the real runtime (continuous scores + legend).
The current `score` policy is **not yet compatible** with this runtime. The
smoke stub passed because it emitted integer scores, so the offline suite could
not have caught this. That is a concrete gap in the offline evidence.

## Correction applied — `verify-0.2.2` (`unusable` split into two verdicts)

The root cause above was diagnosed from a single representative response. Once
two more live campaigns recorded their per-gate `observedNumbers`
(`benchmark/results/verify/laya`, `.../kev`), the recorded numbers showed
something more precise: **the `score` shape was never the problem in those
runs.** All 14 recorded rubric answers are internally coherent — every `score`
equals the expectation its own distribution implies within the documented
tolerance. They were rejected because of the *other* condition folded into
`unusable`: a `confidence` below the floor, or a distribution with no level above
the decisive-mass floor.

Because `unusable` short-circuits the whole decision, a merely hesitant answer
discarded every **other** gate's reading as well. That is why all 14 cases read
`unknown`, and why `criterion_not_satisfied` / `off_scope_detected` appeared
alongside `answer_unusable` without ever being able to route.

`verify-0.2.2` adds the `low-confidence` gate verdict for exactly that case:

- coherence (`score ≠ E[level]`, malformed, out of range) stays `unusable`;
- a coherent but uncommitted answer is `low-confidence`, with its value read and
  reported, never decisive;
- `low-confidence` routes as an additional undecided state: a decisively unmet
  gate beside it still routes to its risk status, otherwise the status is
  `unknown` with reason `answer_low_confidence`;
- it can **never** reach `pass-candidate`, calibrated or not.

No threshold, gate, label or fixture changed, and `calibrated` stays `false`.
`npm run verify:replay` re-derives every recorded case offline under both the
frozen `0.2.1` rules — which reproduce the recorded statuses 7/7 on both
campaigns — and the shipped policy, so the effect of the change is separated
from any change in provider behaviour. It is arithmetic on recorded numbers, not
a measurement, and it states no rate.

**Not corrected here:** the transport normalizes a `noul` answer without its
`confidence`, so a hesitant `noul` answer is still invisible to the policy. That
is a transport-shape change in `src/providers/system-one.ts` and is left to a
separate batch.

## What this does NOT establish

- No false-pass rate. Seven synthetic fixtures, one run, no ground truth beyond
  the labels. `falsePassRate` stays `null`.
- No claim about decision quality in general.
- No provider identity: the label is declarative.
- No threshold calibration. The shipped policy remains `calibrated: false` and
  the production pass stays disabled.

## Consequences for the roadmap

Two contract defects are **demonstrated** by the run. They are recorded here as
a correction plan, not implemented in this change.

### Defect 1 — `score` answer shape is runtime-dependent (demonstrated)
Evidence: the live runtime returns a continuous `score` plus a `legend`, while
the offline stub returns an integer index. The policy rejects the live shape.

Correction, in order:

1. Make the offline smoke stub able to emit **both** shapes (integer index and
   continuous + legend), selected per case, so the suite covers the difference
   instead of only the shape we happened to implement.
2. Decide the normalisation explicitly: either (a) treat a continuous score as a
   position on the rubric declared by the caller and map it through the
   distribution, or (b) declare that this runtime's `score` is not usable for
   rubric routing. Either way the decision belongs in the policy module, is
   versioned, and is documented — not silently guessed from a live response.
3. Re-run the labelled suite against the real runtime only after (2), and record
   the outcome honestly, including a null rate if one run still cannot state it.

Explicitly **not** part of the correction: lowering the internal-consistency
check, or widening the confidence floor, to make live answers pass. The observed
behaviour (rejecting an inconsistent answer as `unknown`) is the safe one and
must be preserved.

### Defect 2 — `choice` with array criteria is unsupported here (demonstrated)

Evidence: `choiceArrayCriteria: false` against the live runtime, while
`choiceObjectCriteria: true`, with a targeted HTTP error rather than a blanket
rejection.

Correction: make the criteria form a **declared capability** rather than an
assumption. The questions module should be able to emit object criteria for a
runtime whose conformance report says array criteria are unsupported, and the
capability should be surfaced rather than hard-coded per vendor.

### Roadmap consequences

1. #7 conformance has now produced a real, actionable deviation for a hosted
   runtime. #8 (presets) should carry such capability metadata, not assume one
   protocol shape.
2. #4 cannot be promoted. The score policy needs Defect 1 resolved and a larger
   labelled set on a real runtime before any calibration question is even asked.
3. #9 (provider benchmark) is now unblocked in principle — a reachable endpoint
   exists — but remains a multi-runtime, multi-run study, not a single run.
4. #5 (`semantic_scan` / `semantic_search`) is unaffected by these findings: it
   relies on `noul`/`score` ranking, so Defect 1 must be resolved before its
   measurements would be meaningful.

## Reproduction

The live campaigns are opt-in and never run in CI. The key is read from an
operator-provided file, injected only into the child environment, and is never
deleted by the runner. No raw provider payload, credential or private snippet
is stored in this document or in any report.
