# Provider calibration and self-test

Semantic runtimes do not necessarily use the same numeric scale for the same
question. The plugin therefore keeps **semantic policy** separate from
**provider calibration**.

## Precedence

Verification resolves numeric policy values in this order:

1. explicit operator overrides (`calibrationOverridesJson`);
2. an explicitly active calibration profile (`calibrationProfileJson`);
3. the shipped conservative `verify-0.3.0` defaults.

Provider presets remain transport/capability metadata. They do not contain
provider-specific verification branches.

## Calibration profile

A profile is JSON with `schemaVersion: 1`. It records provider identity,
provenance/freshness metadata and optional gate overrides.

Example:

```json
{
  "schemaVersion": 1,
  "id": "my-kev-profile",
  "provider": {
    "presetId": "kev",
    "model": "jaredpalmer/kev-4b",
    "runtimeVersion": "2026-10-01"
  },
  "policyVersion": "verify-0.3.0",
  "fixtureSetVersion": "local-v1",
  "testedAt": "2026-10-01T18:00:00Z",
  "status": "user-calibrated",
  "provenance": "operator-labelled-set",
  "active": true,
  "calibrated": false,
  "gateOverrides": {
    "satisfied": {
      "threshold": 0.82,
      "undecided": [0.55, 0.82]
    }
  }
}
```

`active: true` is required before a profile can affect verification. Importing
or generating a profile does not activate it.

`calibrated: true` is a separate, explicit assertion. It can make the existing
`pass-candidate` path reachable, so do not set it merely because a small smoke
test looked good.

## Freshness

The plugin compares a profile with the configured provider identity:

- **matched** — preset/model/version match what the profile records;
- **stale** — a recorded provider/model/version changed;
- **unverified** — identity cannot be checked, for example because the profile
  records a runtime version but the operator did not configure one.

A stale or unverified profile stays visible but is **not applied** by
`semantic_verify_task`. Explicit operator overrides remain explicit and are
still honored.

`runtimeVersion` is optional plugin metadata used only for this freshness check.

## Provider self-test

`semantic_provider_self_test` sends only embedded synthetic examples to the
configured endpoint. It never reads repository/session content and never writes
a profile.

It reports separately:

- provider reachability and exercised protocol primitives;
- declared choice capability/deviations;
- active profile id/status/freshness;
- a three-case semantic smoke test;
- observed per-gate numeric ranges;
- warnings and categories that should remain on fallback;
- a conservative recommendation.

The smoke test is a diagnostic, not a benchmark and not a certification. A
provider/model update can change behavior even when the name stays the same.

## User-labelled calibration set

`semantic_calibration_candidate` accepts labelled cases whose gate values were
observed by the operator. It produces a JSON `CalibrationProfile` candidate with
per-gate min/max/median/count observations.

The candidate is deliberately:

- `status: "user-calibrated"`;
- `active: false`;
- `calibrated: false`;
- observation-only: no thresholds are invented automatically.

This lets an operator export/import the result, review it, and add explicit
`gateOverrides` only when their own evidence justifies doing so.

## Arbitrary question calibration

The `CalibrationProfile` above describes the five `semantic_verify_task` gates
and nothing else. An operator who wants to test the configured runtime on
**their own** question uses `semantic_question_calibration`, which takes:

- `question`: one typed `DecisionQuestion` (`noul`, `choice` or `score`);
- `cases`: `{ id, state, expected }`, where `expected` is a boolean for `noul`,
  a criterion key for `choice` and a rubric level index for `score`;
- optional `questionVersion` and `model`.

Input is validated with the same request validator `semantic_decide` uses, so a
question that is accepted here is one the adapter could also send. A case set is
bounded (at most 50 cases, 24 kB per state) and is rejected rather than
truncated.

### What it reports

Every number stays in its primitive's own domain. There is deliberately no
universal 0..1 normalization and no fabricated value:

| Primitive | Reported |
| --- | --- |
| `noul` | probability, false-positive/false-negative counts and rates, Brier score |
| `choice` | chosen label, distribution, confusion matrix, per-class agreement |
| `score` | raw level value, native `rubricRange`, absolute error, MAE |

A metric that was not measured is `null`: an unanswered case makes the
agreement `null`, a missing labelled class makes its per-class agreement
`null`, and a case set with no finite probability makes the Brier score `null`.
They are never reported as `0`.

A `score` answer is checked against its own distribution
(`score = E[level]`, see `docs/SCORE-CONTRACT.md`). A contradiction is recorded
as a malformed case, not dropped.

### Comparison boundary

`noul` has no inherent decision boundary, so the report states the one it used:
`observed` is `probability > 0.5`. It is a reading of the reported number, not a
tuned threshold, and it is echoed in `comparisonBoundary` so a reader knows
exactly what `matched` meant.

### Provenance and the candidate

The report is always `advisory: true` and `active: false`, and carries the
provider identity plus `question.fingerprint`: a hash of the canonical question
definition (object criteria are key-sorted, so a re-ordered object is the same
question and any change of text, type or criteria is a different one).
`questionIsApplicableTo` uses it, so a candidate measured on one question
cannot be read as calibration for another.

`candidate` is observation-only: observed probability/score/top-label ranges for
the matched and mismatched cases, the declared confidence range, and the
observed separation between labelled positives and negatives. No threshold, band
or score is derived. Activation is the operator's explicit decision, with their
own evidence, exactly like a `CalibrationProfile`.

### Failure semantics

- Malformed arguments fail before any provider call.
- A provider failure on one case is recorded on that case with its code, and the
  remaining cases still run, so a single run stays a reproducible evaluation
  report.
- Cancellation, blocked egress and configuration errors fail the whole tool:
  they are not data points about this question.
- The report contains no state, no endpoint and no secret.

## Reference agreement

`semantic_question_calibration` needs labels. An operator who has none yet can
still get a first signal with `semantic_reference_agreement`: the same frozen
question and case set, judged twice — once by the reference and once by the
configured semantic provider.

### The reference crosses a caller boundary

OpenFox exposes no plugin API for invoking the active main LLM, so the plugin
adds no second LLM client and no second credential. The reference judgments are
**input**, produced before the tool is called: by the operator's own model in a
workflow step, or by a human.

That also settles the ordering. A case accepts only
`{ id, state, referenceAnswer, disposition }`; there is no field for a semantic
answer, so the reference cannot be contaminated by the provider result. The
provider runs afterwards, over the same frozen states.

### What it reports

| Field | Meaning |
| --- | --- |
| `reference` | `source` (`llm` or `human`), `model`, `promptVersion`, `recordedAt` |
| `metric` | `agreement`/`concordance` for an LLM reference, `accuracy` for a human one |
| `aggregate.agreement` | agreed / answered; `null` when nothing was answered |
| `aggregate.ambiguous` | count of `ambiguous` reference dispositions; `null` when none was supplied |
| `aggregate.latencyMs` | total, mean and max per case |
| `perClassAgreement` | per-class agreement for a `choice` question, `null` for the others |
| `perClassAgreementUnavailable` | the classes with no case, i.e. why a per-class rate is `null` |
| `lowConfidencePolicy` | the cut-offs used to flag a low-confidence agreement |
| `cases` | every case: `referenceAnswer`, `disposition` and the raw provider numbers |
| `runAt` | when this run happened, so two reports can be compared |
| `review` | every disagreement, provider error and malformed answer |
| `lowConfidenceAgreements` | agreements the provider itself was unsure about |
| `referenceAmbiguous` | the cases whose REFERENCE judgment was declared ambiguous |
| `promotion` | the labelled cases built from `reviewed`, or `null` when nothing was reviewed |

On **this** surface a case row names the reference judgment `referenceAnswer`,
never `expected`. `expected` means "operator ground-truth label" on
`semantic_question_calibration`, and reusing that name here would let an
operator read an LLM's second opinion as their own ground truth.

`disposition` is the operator's own verdict on a reference judgment — `clear` or
`ambiguous` — not a comment on the provider. It appears on each case row and on
each `review` item, and the ambiguous ones are collected in
`referenceAmbiguous`. An ambiguous reference is still counted in
`aggregate.agreement`, so without this list a reader would see a rate with no
way to know how much of it rests on judgments they did not trust. It is the
mirror of `lowConfidenceAgreements`: uncertainty is first-class on both sides of
the comparison. With no disposition anywhere, `aggregate.ambiguous` is `null`,
every row's `disposition` is `null` and `referenceAmbiguous` is empty.

**An LLM reference is a second opinion, not ground truth.** With
`reference.source: "llm"` the report is named agreement/concordance and the word
"accuracy" appears nowhere in it. Only `source: "human"` — a deliberate human
label — reports accuracy. This is the same "unmeasured is `null`, never `0`"
rule the rest of this document follows: an absent reference disposition is
unknown, not zero.

`reference.model` is **required** when `source` is `llm`. A reference without a
model identifier would read as a repeatable measurement when it is not, so it is
rejected rather than defaulted; `promptVersion` is required in both modes, and a
`human` reference must omit `model`.

A field that may be omitted may also be `null`, so a report's own `reference`
block is valid input for the next run. That is what makes `runAt` useful: the
same frozen reference can be re-measured against a newer provider by feeding the
previous report's `reference` straight back. An LLM reference with a `null` model
is still rejected — the null form is accepted where omission is allowed, not as
a way around the provenance requirement.

### Low-confidence agreements

An agreement the provider was unsure about is not evidence of a reliable answer,
so it is surfaced next to the rate instead of being absorbed into it. The cut-offs
are stated in `lowConfidencePolicy` and are reading conventions, not decision
boundaries:

- a declared `confidence` below `minDeclaredConfidence`;
- a `noul` probability within `noulBoundaryMargin` of the `0.5` comparison
  boundary — it has not decided;
- a `choice`/`score` distribution whose peak probability is below
  `minDistributionPeak` — it is flat between criteria.

Such a case still counts as an agreement in `aggregate.agreement`, because it
did agree with the reference.

### Reviewed disagreements become labelled cases

`reviewed: [{ id, expected }]` records what a human decided about a
disagreement. The report returns `promotion.labelledCases` in exactly the shape
`semantic_question_calibration` already accepts, so reviewed cases are reusable
without reformatting. With nothing reviewed, `promotion.labelledCases` is `null`:
an unreviewed disagreement is not a label, and promoting the provider's own
answer would make the next run agree with itself.

**The promoted cases carry your own `state` back into the report.** That is a
deliberate exception to the rule that the report holds no state: the promoted
cases exist precisely so the states do not have to be retyped. It applies only
once cases are reviewed — with nothing reviewed the report is state-free, as
elsewhere. If your states carry clinical or customer text, treat the reviewed
report with the same care as the input you just handed to the provider.

### What it is not

The report is `advisory: true` and `active: false`. It derives no threshold, no
band and no ranking, and it never declares the main LLM to be correct. A small
agreement run can justify "worth trying" or expose an obvious mismatch; turning
that into a decision boundary is the operator's explicit decision, made against
their own labelled data.

## Current Jev / Kev / Laya snapshot

The dated 2026-10-01 provider work in
`benchmark/snapshots/provider-smoke-2026-10-01.md` is a baseline observation,
not a leaderboard and not a permanent calibration table.

The current data showed materially different gate ranges between Jev, Kev and
Laya, but it does **not** justify shipping permissive numeric profiles that
silently change policy. For that reason no built-in provider profile is
auto-selected and no current provider snapshot changes the defaults.

Future model/runtime releases should be checked with the self-test or an
operator-owned labelled set rather than requiring maintainers to continuously
re-benchmark every available model.
