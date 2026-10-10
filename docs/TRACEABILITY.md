# Traceability — issue #4 and #14

Each real acceptance criterion taken from the GitHub issues is mapped to a named
proof in this repository. A requirement with no proof is recorded as
**unverified**, never as satisfied.

Proof kinds used below:

- `T:` a named automated test (`npm test` runs it)
- `R:` a runnable command with its observed output
- `F:` a named file and construct

## Issue #4 — semantic_verify_task

### Goal: bounded semantic check after implementation/tests, before another full verifier pass

| # | Requirement (issue text) | Proof | Verdict |
| --- | --- | --- | --- |
| 4.1 | "a bounded semantic check after implementation/tests and before spending another full verifier pass" | F: `src/verify/tool.ts` takes exactly one criterion plus bounded evidence; T: `test/verify-tool.test.ts` "one batched call asks every policy question exactly once"; T: `test/verify-state.test.ts` "oversized evidence is rejected rather than silently truncated" | verified |
| 4.2 | "This is an **experiment**, not an automatic completion gate." | F: `src/verify/tool.ts` registers no transition handler/hook; the report sets `advisory: true`; T: `test/verify-tool.test.ts` "the production report is advisory and never a positive verdict" and "a calibrated policy can surface a positive status as a candidate only" (asserts the report never claims task completion) | verified |

### Inputs: one criterion, evidence/diff excerpts, deterministic test results, short summary

| # | Requirement (issue text) | Proof | Verdict |
| --- | --- | --- | --- |
| 4.3 | "one requirement/acceptance criterion" | F: `buildVerifyState` requires `criterionId` + `criterion`; T: `test/verify-state.test.ts` "malformed or empty required material is rejected before any request" | verified |
| 4.4 | "relevant changed-code evidence/diff excerpts" | F: `VerifyState.diffExcerpts`; T: `test/verify-state.test.ts` "the state is compact, JSON-safe and carries exactly the supplied material" | verified |
| 4.5 | "deterministic test results" | F: `VerifyState.deterministicTestResults`; T: same test as 4.4 | verified |
| 4.6 | "short implementation summary" | F: `VerifyState.implementationSummary`; T: `test/verify-state.test.ts` "absent optional evidence is simply omitted, never invented" | verified |

### Batch several questions

| # | Requirement (issue text) | Proof | Verdict |
| --- | --- | --- | --- |
| 4.7 | "Batch several questions where useful" (criterion satisfied / evidence sufficient / off-scope / deeper verification) | F: `src/verify/questions.ts` builds the four questions with policy gate ids; T: `test/verify-tool.test.ts` "one batched call asks every policy question exactly once" asserts a single provider call carrying exactly those four ids | verified |

### Policy stays outside the provider adapter

| # | Requirement (issue text) | Proof | Verdict |
| --- | --- | --- | --- |
| 4.8 | "Keep policy outside the provider adapter." | F: thresholds exist only in `src/verify/policy.ts`; the adapter `src/providers/system-one.ts` is unmodified by this change; T: `test/verify-policy.test.ts` is the only consumer of thresholds | verified |

### Possible outcome mapping

| # | Requirement (issue text) | Proof | Verdict |
| --- | --- | --- | --- |
| 4.9 | "strong + safe result -> candidate to skip/limit a verifier pass" | F: `VerifyStatus 'pass-candidate'`; T: `test/verify-policy.test.ts` "an uncalibrated policy can never emit a positive verdict" — the code path exists but is unreachable without a measured calibration | **unverified** (code path implemented; behaviour unmeasured) |
| 4.10 | "uncertain -> normal OpenFox verifier" | T: `test/verify-policy.test.ts` "values inside the uncertainty band are undecided, not a pass", "a decisively uncommitted criterion is a distinct unknown, never a verdict", `test/verify-policy-replay.test.ts` "a hesitant answer is read for what it says, not for how the runtime felt" → `status: 'unknown'`; README documents the fallback | verified |
| 4.11 | "negative -> targeted builder/verifier follow-up" | F: statuses `off-scope`, `insufficient-evidence`, `needs-verification`; T: `test/verify-policy.test.ts` "a decisive failure routes to the documented follow-up status" | verified |
| 4.12 | "provider failure -> normal OpenFox path" | T: `test/verify-tool.test.ts` "provider failures never surface as a positive or negative verdict", "cancellation and timeouts stay failures with their own codes" | verified |
| 4.13 | "Do not enable automatic 'done' behavior in this issue." | F: no `registerTransitionHandler`, no `registerHook`, no `step_done` in `src/`; T: `test/verify-tool.test.ts` asserts `advisory: true` and no completion wording | verified |

### Evaluation

| # | Requirement (issue text) | Proof | Verdict |
| --- | --- | --- | --- |
| 4.14 | "Experiment can run on a labeled fixture set." | F: `fixtures/verify/cases.json` (41 fixtures in 8 declared families); F: `scripts/verify-fixture-set.ts` is the single schema/balance contract; R: `npm run verify:experiment` → "41/41 fixtures matched the labelled policy status"; T: `test/verify-experiment.test.ts` "the labelled suite is reproduced offline with no credentials" and "a fixture set that breaks the schema rules refuses to run at all"; T: `test/verify-fixture-set.test.ts` "the shipped fixture set loads, and is balanced, unique and justified" | verified (plumbing only; the quality metric itself is 4.18) |
| 4.15 | "Results are persisted in the evaluation format." | F: `scripts/verify-experiment.ts` writes `report.json`, `runs.json` via `validateRecord`, and `summary.md` via `summarize`; T: `test/verify-experiment.test.ts` "the persisted RunRecords keep every unmeasured metric null, never zero" | verified |
| 4.16 | "README is updated only with measured findings." | README states `measured: false`, `falsePassRate: null`, "not reachable today"; R: report field `falsePassRate === null`; T: `test/verify-experiment.test.ts` "a scripted transport can never produce a positive status or a false-pass claim" | verified |
| 4.17 | "Automatic workflow integration is a separate decision/issue after evidence exists." | F: no transition/hook registration; `docs/ROADMAP.md` keeps #12 conditional; `docs/IMPLEMENTATION.md` records #12 as still open | verified |

### Measurement honesty (primary metric: false pass rate)

| # | Requirement (issue text) | Proof | Verdict |
| --- | --- | --- | --- |
| 4.18 | "Primary metric: **false pass rate**." | R: `npm run verify:experiment` reports "false-pass rate: unknown"; report has `falsePassRate: null`, `falseNegativeRate: null`, `falsePassRateReason`; T: `test/verify-experiment.test.ts` asserts both rates are `null` and `measured: false` | **unverified** — no real-provider run has been performed, so the rate is unknown by construction |
| 4.19 | "Also measure: verifier calls avoided, main-model tokens/calls, wall time, fallback rate, task regressions." | R: offline run records `wallMs` and `fallbacks`; `mainInputTokens`, `mainCalls`, `verifierCalls`, `taskSuccess` remain `null`; T: `test/verify-experiment.test.ts` "the persisted RunRecords keep every unmeasured metric null, never zero" | **unverified** — requires an OpenFox end-to-end run |

## Issue #14 — plugin skills

### Skill source registration

| # | Requirement (issue text) | Proof | Verdict |
| --- | --- | --- | --- |
| 14.1 | "Use the public Plugin API v2" (`registerSkillSource`) | F: `src/skills/source.ts`; F: `src/openfox-plugin.d.ts` mirrors `PluginSkill` / `PluginSkillSource`; upstream contract verified against OpenFox `v2.0.157`, `v2.0.160` and the current `2.0.161` baseline `src/plugin/index.ts`; T: `test/skills.test.ts` "the skill source is registered through the public plugin API" | verified |
| 14.2 | "Add the `skills` capability to the plugin manifest only when this is implemented." | F: `package.json` `openfox.capabilities` contains `skills`; T: `test/skills.test.ts` "the manifest declares the skills capability exactly once" | verified |
| 14.3 | "Do **not** create one skill per tool. Create skills per **usage pattern**." | F: one skill, `semantic-verification`, covering a usage pattern; T: `test/skills.test.ts` "the verification skill is discoverable with concise metadata" | verified |

### semantic-verification content

| # | Requirement (issue text) | Proof | Verdict |
| --- | --- | --- | --- |
| 14.4 | "guide use of `semantic_verify_task`" | F: `SEMANTIC_VERIFICATION_SKILL.prompt` "When to use this"; T: `test/skills.test.ts` "the skill documents every status the tool can return" | verified |
| 14.5 | "define what evidence should be supplied" | F: prompt section "What to supply"; T: same test plus "the skill teaches when NOT to use the tool and how to fall back" | verified |
| 14.6 | "define when to fall back to the normal verifier" | F: prompt "Limits you must keep" and `unknown` interpretation; T: `test/skills.test.ts` "the skill teaches when NOT to use the tool and how to fall back" | verified |
| 14.7 | "Their descriptions are concise enough for permanent skill discovery." | F: 138-character description; T: `test/skills.test.ts` asserts `description.length <= 200` and that detail only loads on demand | verified |
| 14.8 | "Detailed instructions are loaded only on demand." | F: `load()` returns the full prompt; T: `test/skills.test.ts` "the verification skill is discoverable with concise metadata" | verified |
| 14.9 | "Guidance clearly states when **not** to use semantic tools." | F: prompt section "When NOT to use it"; T: `test/skills.test.ts` "the skill teaches when NOT to use the tool and how to fall back" | verified |
| 14.10 | "Provider implementation details remain outside the skills." | F: no provider/endpoint/model text; T: `test/skills.test.ts` "the skill is provider-neutral: no provider, endpoint, URL or model id" | verified |
| 14.11 | "Prompt discipline" — no long explanations, no hard-coded thresholds | F: prompt is operational; T: `test/skills.test.ts` "the skill does not hard-code thresholds without evidence" | verified |
| 14.12 | "The skill should teach a **decision boundary**, not advertise the plugin." | F: `src/skills/source.ts`; T: `test/skills.test.ts` "the discovery skill is published now that its tools exist" and "the verification skill is discoverable with concise metadata" | verified |
| 14.13 | "never treat a semantic result as a replacement for mandatory tests/typechecks/linters" | F: prompt "Limits you must keep"; T: `test/skills.test.ts` asserts the prompt mentions tests, typechecks, linters and human review | verified |

### Tool availability constraint

| # | Requirement (issue text) | Proof | Verdict |
| --- | --- | --- | --- |
| 14.14 | "Plugin skills do **not** grant tool access." | F: prompt states it does not grant access; F: `src/index.ts` comment; T: `test/skills.test.ts` "the skill teaches when NOT to use the tool and how to fall back" | verified |
| 14.15 | "Document the expected agent configuration and test behavior when: skill available but tool not allowed; tool allowed but skill not loaded; both available." | F: README "Usage skill"; T: `test/skills.test.ts`; R: `npm run harness:agent-e2e` runs all three cases on the real host — denied (refusal, no provider request), allowed-without-loading, and allowed-with-`load_skill` | verified |
| 14.16 | "The skill text should not assume a tool is callable if it is unavailable." | F: prompt "Limits you must keep" — explicitly tells the agent not to work around an unavailable tool | verified |

### Tests

| # | Requirement (issue text) | Proof | Verdict |
| --- | --- | --- | --- |
| 14.17 | "skill source registration" | T: `test/skills.test.ts` "the skill source is registered through the public plugin API" | verified |
| 14.18 | "both skill metadata entries are discoverable" (issue assumed two skills) | T: `test/skills.test.ts` "the discovery skill is published now that its tools exist" and "the verification skill is discoverable with concise metadata" | verified — `semantic-code-discovery` now ships with #5 |
| 14.19 | "prompts load correctly" | T: `test/skills.test.ts` "the verification skill is discoverable with concise metadata"; R: `npm run harness:agent-e2e` — both skills load through the host's real `load_skill` tool | verified |
| 14.20 | "no provider-specific endpoint/model names leak into skill guidance" | T: `test/skills.test.ts` "the skill is provider-neutral: no provider, endpoint, URL or model id" | verified |
| 14.21 | "skill registration is independent of provider availability" | T: `test/skills.test.ts` "skill registration never reads settings or performs a request" | verified |
| 14.22 | "plugin manifest declares `skills` once implemented" | T: `test/skills.test.ts` "the manifest declares the skills capability exactly once" | verified |
| 14.23 | "Where practical, add an integration fixture demonstrating that OpenFox can discover and load the plugin skill through the normal `load_skill` path." | R: `npm run harness:agent-e2e` on isolated OpenFox `2.0.157` **and** `2.0.160`, 67/67 on each: a real agent turn calls `load_skill` for `semantic-verification` and `semantic-code-discovery` (observed tool calls `load_skill, load_skill, semantic_verify_task, semantic_search, semantic_scan, step_done`) | verified |
| 14.24 | "`npm run check` passes." | R: `npm run check` exits 0 — typecheck, typecheck:tests, the full test suite with 0 failures and 0 skips, and the build. The exact count is deliberately not cited here, because it changes whenever another lot lands and a stale number is worse than none | verified |

## Provider evaluation baseline — requirements carried by this lot

| # | Requirement (issue text) | Proof | Verdict |
| --- | --- | --- | --- |
| 7.15 | "The `score` gate follows the documented `E[level]` contract, without weakening a guard." | F: `docs/SCORE-CONTRACT.md` option A; F: `src/verify/policy.ts` `DIRECT_EVIDENCE_THRESHOLD`; T: `test/verify-policy.test.ts` "direct evidence means the expectation reached the top level, per the score contract" and "the band between the rungs never reads as direct evidence" | verified |
| 7.16 | "A live run must persist what an analysis needs, and nothing sensitive." | F: `scripts/verify-experiment.ts` per-case `observedNumbers`; T: `test/verify-experiment.test.ts` "a live run persists the numbers the analysis needs, and nothing else" and "the persisted live numbers carry no state, no evidence and no secret" | verified |
| 7.17 | "A question's polarity must match the gate that reads it." | F: `src/verify/questions.ts` `offScope`; T: `test/verify-tool.test.ts` "the offScope question states one polarity, matching its high-is-risk gate" | verified |

## Issue #27 — provider calibration profiles and self-test

| # | Requirement (issue text) | Proof | Verdict |
| --- | --- | --- | --- |
| 27.1 | "Generic semantic policy structure remains provider-neutral." | F: `src/calibration/profile.ts` overlays numeric gate data onto `VerifyPolicy`; routing remains in `src/verify/policy.ts` | verified |
| 27.2 | "Numeric gate calibration can vary by runtime/model profile." | F: `CalibrationProfile.gateOverrides`; T: `test/calibration-profile.test.ts` "precedence is explicit override > active profile > conservative defaults" | verified |
| 27.3 | "Explicit user settings override shipped profile defaults." | T: `test/calibration-profile.test.ts` "precedence is explicit override > active profile > conservative defaults"; T: `test/verify-tool.test.ts` "verification resolves explicit calibration overrides above an active profile" | verified |
| 27.4 | "A runtime can be used with no profile via conservative generic defaults." | T: `test/calibration-profile.test.ts` "inactive or absent profiles never change the conservative defaults" | verified |
| 27.5 | "Profiles carry provenance/freshness metadata and can be marked stale/unverified." | F: `src/calibration/profile.ts` `CalibrationProfile`, `CalibrationProfileStatus`, `assessProfileFreshness`; T: `test/calibration-profile.test.ts` "profile freshness is visible for provider/model/version drift" | verified |
| 27.6 | "A provider/model change cannot silently inherit a supposedly validated profile without a visible freshness decision." | F: `src/verify/tool.ts` disables stale/unverified profiles before policy resolution and reports `calibration.freshness`; T: `test/calibration-profile.test.ts` "profile freshness is visible for provider/model/version drift" | verified |
| 27.7 | "A user can run a provider self-test against the actual configured endpoint/model." | F: `src/calibration/self-test.ts` uses `parseSettings` and `SystemOneHttpProvider`; T: `test/calibration-tools.test.ts` "provider self-test uses only embedded synthetic state and never changes settings" | verified |
| 27.8 | "Self-test reports protocol compatibility separately from semantic/calibration behavior." | F: `src/calibration/self-test.ts` returns separate `protocol`, `activeProfile`, `semanticSmoke`, `gateObservations` and `profileComparison`; `protocol.scope` states `smoke-not-conformance` | verified |
| 27.9 | "Self-test can identify categories/questions that should remain on fallback." | F: `src/calibration/self-test.ts` `warnings`, `fallbackCategories`, `recommendation`; T: `test/calibration-tools.test.ts` "provider self-test uses only embedded synthetic state and never changes settings" | verified |
| 27.10 | "Users can provide a labelled local test set and derive a candidate profile without changing plugin source." | F: `src/calibration/candidate-tool.ts`; F: `src/calibration/profile.ts` `deriveCandidateProfile`; T: `test/calibration-profile.test.ts` "a user-labelled set yields an inactive observation-only candidate" | verified |
| 27.11 | "Candidate profiles require explicit opt-in before use." | F: generated candidates are `active: false`, `calibrated: false`; T: `test/calibration-tools.test.ts` "candidate tool returns an inactive JSON profile and never activates it" | verified |
| 27.12 | "No secrets or private repository content are persisted by the built-in self-test." | F: `src/calibration/self-test.ts` uses embedded synthetic states and has no persistence path; T: `test/calibration-tools.test.ts` "provider self-test uses only embedded synthetic state and never changes settings" | verified |
| 27.13 | "Tests prove precedence: explicit override > calibration profile > conservative defaults." | T: `test/calibration-profile.test.ts` "precedence is explicit override > active profile > conservative defaults" | verified |
| 27.14 | "Documentation states clearly that provider/model behavior can change over time and that shipped profiles are dated observations, not guarantees." | F: `docs/CALIBRATION.md`; F: README "Provider calibration and self-test" section | verified |

## Issue #45 — arbitrary question calibration

| # | Requirement (issue text) | Proof | Verdict |
| --- | --- | --- | --- |
| 45.1 | "An operator can evaluate one arbitrary `noul`, `choice`, or `score` question against their own labelled examples without editing plugin source." | F: `src/calibration/question-tool.ts` exposes the question and the labelled set as tool arguments; T: `test/question-calibration-tool.test.ts` "the tool evaluates labelled noul cases and never leaks state or secrets" | verified |
| 45.2 | "Results preserve the native semantic primitive and its numeric domain." | F: `src/calibration/question-eval.ts` reports `noul` as a probability, `choice` as a label plus its distribution, `score` in level units with `rubricRange`; T: `test/question-calibration.test.ts` "score cases keep the native rubric range and report the absolute error" | verified |
| 45.3 | "Relevant agreement/error/calibration metrics are produced; unsupported metrics remain null." | F: `QuestionEvaluationReport.metrics` with one non-null branch per primitive; every rate is `number | null` and an empty answered set yields `null`, never `0` (including `choice.accuracy`); raw counts such as `choice.matched` stay numeric because a count of zero is a real count; T: `test/question-calibration.test.ts` "noul cases report false positives, false negatives and a Brier score", "choice cases report a confusion matrix and per-class agreement" and "an unmeasured rate is null, never zero, for every primitive" | verified |
| 45.4 | "Provider/model/question provenance is explicit and stale calibration cannot silently carry over." | F: `fingerprintQuestion`, `QuestionIdentity`, `questionIsApplicableTo`; `effectiveProvider` resolves the model as requested override > provider echo > configured model, and the report and its candidate carry the SAME identity; T: `test/question-calibration.test.ts` "the question fingerprint changes with the question and ignores key order", "a candidate from another question is not applicable to this one" and "the report names the model actually evaluated, not the configured one" | verified |
| 45.5 | "Candidate thresholds/bands, if derived, are advisory and inactive by default." | F: `InactiveCandidate.active` is the literal `false` and carries observations only; T: `test/question-calibration.test.ts` "an unusable answer and a missing case never become a matched observation" | verified |
| 45.6 | "Raw private states are not persisted by default." | F: the report carries `expected`/`observed`/numbers and never the `state`; T: `test/question-calibration-tool.test.ts` "the tool evaluates labelled noul cases and never leaks state or secrets" | verified |
| 45.7 | "No universal 0..1 normalization layer is introduced." | F: no normalized field exists; the only division is a reported MAE in level units; T: `test/question-calibration.test.ts` "score cases keep the native rubric range and report the absolute error" asserts the serialized report contains no `normalized` field | verified |
| 45.8 | "Tests cover all three question types, malformed answers, provider failure and question/profile mismatch." | T: `test/question-calibration.test.ts` and `test/question-calibration-tool.test.ts` cover the three primitives, `score_distribution_mismatch`, `invalid_noul_probability`, a per-case `http` failure and a fingerprint mismatch | verified |
| 45.9 | "A provider failure must remain visible and must not become a semantic answer." | F: `FATAL_ERROR_CODES` splits cancellation/egress/configuration from data-point failures; T: `test/question-calibration-tool.test.ts` "a total provider failure is reported per case and still yields a report" and "cancellation propagates instead of producing a report" | verified |
| 45.10 | "A generic question-evaluation primitive is preferred over a second policy engine." | F: `src/calibration/question-eval.ts` holds no threshold and no gate; the verification `CalibrationProfile` is untouched; T: `test/question-calibration.test.ts` exercises the module directly, without the tool boundary | verified |
| 45.11 | "A rubric is addressed exactly as the shipped adapter addresses it." | F: `questionLabels` mirrors `normalizeResponse`: a `choice` array rubric is addressed by its VALUES and a `score` rubric by its level index, so a valid provider answer is never scored malformed; T: `test/question-calibration.test.ts` "an array-rubric choice uses the criteria values as labels, like the adapter" | verified |

## Issue #46 — reference agreement against a reference LLM

| # | Requirement | Proof | Verdict |
| --- | --- | --- | --- |
| 46.1 | "Same frozen question/cases can be evaluated independently by a reference LLM and semantic provider." | F: `src/calibration/reference-agreement.ts` maps the frozen `referenceAnswer` onto the shipped `evaluateLabelledCases` label, so both sides see the identical question and case ids; T: `test/reference-agreement.test.ts` "the same frozen input produces the same question fingerprint and runs each frozen case" asserts an identical fingerprint across two runs and the exact per-case id sequence | verified |
| 46.2 | "Semantic answer is not leaked into the reference judgment." | F: `ALLOWED_CASE_KEYS` is `{id, state, referenceAnswer, disposition}` — there is no field a semantic answer could travel in, and the reference is frozen before `decide` is ever called; T: `test/reference-agreement.test.ts` "a case cannot carry a semantic answer, so the reference judgment is never contaminated" and `test/reference-agreement-tool.test.ts` "a missing provenance record or a leaked semantic answer fails before any provider call" | verified |
| 46.3 | "Output clearly distinguishes LLM-reference agreement from human-labelled accuracy." | F: `ReferenceAgreementReport.metric` is `agreement`/`concordance` for an LLM reference and `accuracy` for a human one, and no accuracy-labelled field exists on the LLM path; T: `test/reference-agreement.test.ts` "an LLM reference reports agreement, a human reference reports accuracy, and the report says which" asserts `/accuracy/` is absent from the whole serialized LLM report | verified |
| 46.4 | "Disagreements are surfaced as first-class review items." | F: `ReferenceAgreementReport.review` is a dedicated list of `DisagreementItem` carrying both answers, the raw numbers and the reason; T: `test/reference-agreement.test.ts` "disagreements are first-class review items carrying both answers" | verified |
| 46.5 | "Semantic raw probabilities/distributions/confidence remain visible." | F: `report.cases` carries every observation as `referenceAnswer` plus `probability`, `distribution`, `score` and `confidence` in the primitive's own domain; the operator-label name `expected` is deliberately not reused on this surface; T: `test/reference-agreement.test.ts` "raw probabilities, distributions and confidence stay visible for every primitive" and "a case row names the reference answer referenceAnswer, never the operator-label expected" | verified |
| 46.6 | "Low-confidence/ambiguous semantic answers are surfaced." | F: `lowConfidenceAgreements` with a stated `lowConfidencePolicy`; the cut-offs are reading conventions, not decision boundaries. Uncertainty is first-class on BOTH sides: the reference side has `referenceAmbiguous` plus a per-case `disposition`; T: `test/reference-agreement.test.ts` "a low-confidence agreement stays visible and still counts as an agreement" covers a near-boundary `noul`, a low declared confidence and a flat distribution, each still counted in `aggregate.agreement`, and "an ambiguous reference is locatable from the report, not only counted" pins the reference-side mirror | verified |
| 46.7 | "Reference model/prompt/version provenance is recorded." | F: `ReferenceProvenance` (`source`, `model`, `promptVersion`, `recordedAt`) is echoed verbatim and the run's own date is reported as `runAt`; `parseReference` REJECTS an LLM reference without a model instead of defaulting it; T: `test/reference-agreement.test.ts` "an LLM reference without a model identifier is rejected before any run", "reference provenance is echoed verbatim and an unreported date is null", "the report carries a run date, and a pinned one is honoured" and "the report's own reference block is valid input for the next run" (a `null` field parses exactly like an omitted one, so the same frozen reference can be re-measured; an LLM `null` model is still rejected) | verified |
| 46.8 | "No hidden second-LLM provider is added to the plugin." | F: the reference is caller input; no new settings field, no new credential, no new outbound call site. OpenFox exposes no plugin API for invoking the active main LLM, which is why the reference crosses a caller/workflow boundary; T: `test/reference-agreement-tool.test.ts` "the plugin adds no second LLM client, no new setting and no new outbound call site" walks `src/` RECURSIVELY (33 `.ts` files, asserted with a `>= 30` floor so a broken walk fails loudly) and greps each for a chat-completions client, and asserts the `SETTINGS` key list is unchanged; T: `test/reference-agreement-tool.test.ts` "both calibration tools share one wrapper implementation, not a copy" proves the two wrappers are specs over ONE shared builder, so the reference cannot reach one tool and miss the other | verified |
| 46.9 | "Reviewed disagreements can be reused as labelled cases by the arbitrary-question calibration flow." | F: `promotionCases` emits `{id, state, expected}`, the exact `parseQuestionCalibrationInput` shape, and returns `null` when nothing was reviewed so the provider never labels itself; T: `test/reference-agreement.test.ts` "reviewed disagreements are reusable as labelled cases by the question calibration flow" round-trips them through the shipped parser, and "promoted labelled cases carry the reviewed cases own frozen state back into the report" pins the state-echo boundary the promotion deliberately makes | verified |
| 46.10 | "No universal threshold or provider ranking is generated automatically." | F: the report is `advisory: true, active: false` and carries no threshold, band or ranking field; T: `test/reference-agreement.test.ts` "the report carries the required fields, a null ambiguous count and no threshold" asserts `/threshold|rank|recommend/i` is absent from the serialized report | verified |
| 46.11 | Required output and safe failures. | F: `aggregate` (total/answered/agreed/agreement/errors/malformed/ambiguous/latencyMs), `perClassAgreement`, `review`, `lowConfidenceAgreements`, `cases`, `reference`; `FATAL_ERROR_CODES` still aborts on cancellation/egress/configuration while a per-case provider failure stays a per-case observation; T: `test/reference-agreement.test.ts` "a provider error and a malformed answer stay visible instead of counting as agreement", "a fatal provider failure stops the run instead of producing a report" and "the report carries the required fields, a null ambiguous count and no threshold" (absent dispositions give `ambiguous: null`, never `0`) | verified |

## Issue #2 — real isolated OpenFox agent

Proof for this section comes from `npm run harness:agent-e2e`
(`scripts/agent-e2e.ts`): a real OpenFox host, the built package installed into
a temporary `configDir`, real agent turns driven only through the public
`/mcp` endpoint, a scripted OpenAI-compatible LLM and a deterministic
System One stub, both on loopback. **67/67 checks pass on both declared
releases** — `2.0.157` (tree `/tmp/of-harness-2.0.157`) and `2.0.160` (tree
`/tmp/of-harness-2.0.160-clean`), each re-run for this lot.

| # | Requirement (issue text) | Proof | Verdict |
| --- | --- | --- | --- |
| 2.1 | "Install/build the package in an isolated host; do not use production configuration or sessions DB." | R: harness sets `HOME`, `XDG_CONFIG_HOME` and `XDG_DATA_HOME` to a fresh temp tree and removes it in `finally`; T: `test/harness-isolation.test.ts` | verified |
| 2.2 | "An allowed agent executes noul, choice and score, including a mixed batch, against a local deterministic System One stub." | R: observed wire body carries all three question ids in one request; the tool result is `{"answers":{"is_boolean":{"type":"noul","probability":0.75},"which_side":{"type":"choice","choice":"tenant_scoped",…},"how_bad":{"type":"score","score":2,…}}}` | verified |
| 2.3 | "Demonstrate that an agent without permission cannot invoke the tool." | R: the denied agent's call is refused by the host with the allow-list message, and the System One stub records **zero** requests for that turn | verified — see finding H2 for the caveat |
| 2.4 | "Failures/cancellation remain failed results on the real host path." | R: provider 5xx → `{"code":"http","message":"System One HTTP 500"}`; hanging provider → `{"code":"timeout","message":"Semantic provider timed out"}`; a stopped turn produces no answer and no cache hit. Each uses a distinct state string, so a warmed cache cannot mask it | verified |
| 2.5 | "Record the released OpenFox version and reproducible commands; no paid provider credential is required." | F: `scripts/setup-harness.sh` takes the version from `OPENFOX_VERSION`, refuses to reuse a tree holding a different release, and prints the version **read back from the installed tree** rather than the one requested; `scripts/agent-e2e.ts` and `scripts/openfox-harness.ts` likewise read `node_modules/openfox/package.json`. Observed on two separate clean trees: `openfox@2.0.157` and `openfox@2.0.160`, 20/20 harness checks and 67/67 agent-e2e checks each. A run also writes `benchmark/results/agent-e2e/report.json` locally, which is gitignored and therefore NOT cited as durable proof. The only key is a loopback fixture value, so no paid credential is needed | verified |
| 2.6 | Workflow advice must reach the normal verifier in every state (issue #12) | R: `npm run harness:agent-e2e` launches the real workflow three times — advice ACTIVE, advice DISABLED, provider 5xx. For each, it proves the **verifier turn itself ran**: a model request carrying the verifier step's own prompt that consumed a real scripted answer (not the harness's no-script placeholder), plus `step_done` returned by that same turn. A `currentStepId` projection is deliberately not used as proof | verified |

## Issue #13 — release readiness (CI, packaging, install compatibility)

Both ends of the declared support range were validated by installing the
package into a **real isolated OpenFox host**, in a separate throwaway tree per
version (`scripts/openfox-harness.ts`, `npm run harness`). Each run reports the
version it read back from `node_modules/openfox/package.json`; no version string
in the harness or its report is hardcoded. Each release reported the same six
tools, one skill source and thirteen settings fields, with zero hooks and zero
transitions.

| # | Requirement | Proof | Verdict |
| --- | --- | --- | --- |
| 13.1 | Verify installation/invocation against the declared minimum. | R (recorded at the time, when `2.0.157` was the declared minimum): `npm run harness` with `HARNESS_PKG_DIR=/tmp/of-harness-2.0.157` → "Harness: 20/20 checks passed", first line "isolated OpenFox package present — openfox@2.0.157"; `npm run harness:agent-e2e` on the same tree → 67/67 | verified |
| 13.2 | Verify against the target release in a **separate** clean tree. | R (recorded history): same commands with `HARNESS_PKG_DIR=/tmp/of-harness-2.0.160-clean` → "Harness: 20/20 checks passed", `openfox@2.0.160`, agent-e2e 67/67. R (current baseline, re-run): `HARNESS_PKG_DIR=/tmp/of-harness-2.0.161 npm run harness` → "Harness: 23/23 checks passed", `openfox@2.0.161`, including the host-reported `messageTransforms=1` | verified |
| 13.3 | Report the real installed version, never a hardcoded one. | F: `scripts/openfox-harness.ts` uses the read-back `installedVersion` for the report field, the scope string and the finding detail; F: `scripts/setup-harness.sh` prints the read-back version and fails if it differs from the requested one; F: `scripts/agent-e2e.ts` reads the same file. A `2.0.160` literal remains only in prose comments describing the host contract under test | verified |
| 13.4 | Attempt the declared minimum; only raise it on demonstrated incompatibility. | T: `test/skill-api-compat.test.ts` "the compatibility baseline recorded in the docs is unchanged" asserts `peerDependencies.openfox === '>=2.0.161'` and that `docs/IMPLEMENTATION.md` still names that baseline; R: the minimum is now raised to 2.0.161 because `registerMessageTransform` and the `transforms` capability are only released there, not because an earlier version failed: the 2.0.157/2.0.160 harness and agent-e2e results below are unchanged recorded history. The harness **was** re-run at the new minimum: 23/23 on `openfox@2.0.161`. `harness:agent-e2e` was **not** re-run there — it needs a live LLM provider and a real agent turn — so no agent-e2e count is claimed for 2.0.161 | verified |
| 13.5 | No private API workaround. | F: only the public `openfox/plugin` API is imported; R: both hosts loaded the package through normal discovery and the public settings route, with no host patch and no privileged access | verified |
| 13.6 | Reproducible source-checkout → offline checks → absolute local-path install recipe, **executed**, not only described. | F: `docs/INSTALLATION.md`, Recipe A. R: `npm run harness` calls the host's own `POST /api/plugins/install` with `{ path }` on the full checkout and observes `success: true`, then asserts `dist/index.js` exists **inside the host's copy** under `<configDir>/plugins/<basename>/` — proving `buildIfNeeded()` rebuilt it. A copy-by-hand would skip the installer, so the harness no longer does that. Checked against `src/server/routes/plugins.ts` and `src/server/plugins/install.ts` at `v2.0.157` and `v2.0.160` | verified |
| 13.7 | Document that a GitHub tree/tag URL does not pin the installer or a ref. | F: `docs/INSTALLATION.md`, "What the host actually does": `parseGithubUrl()` keeps only `owner/repo` and the clone is `--depth 1` from default-branch HEAD | verified |
| 13.8 | Document that a packed tarball is NOT installable. | F: `docs/INSTALLATION.md`, Recipe B: the `files` allowlist ships only `dist`, `README.md`, `docs`, so no `src/` and no `tsconfig.json`. The manifest still declares `scripts.build`, so `buildIfNeeded()` compiles, `tsc` fails, and in both released hosts the error is not caught: the install is rejected with HTTP 500. Recipe A is the only supported path | verified |
| 13.9 | No new distribution subsystem, no mandatory npm publication. | F: `package.json` declares no `publishConfig`, no publish script; `npm view openfox-semantic-tools` → 404 | verified |
| 13.10 | ESM/declarations, API v2, Node >= 24, packaged contents, no private credentials. | R: `npm pack --dry-run` lists the packed contents; T: `npm run check` compiles `src/` and `test/`; F: `package.json` `type: module`, `main`/`types`, `engines.node >=24`, `openfox.apiVersion: 2`; the harness recorded `tools=9 skillSources=1 settingsFields=14 messageTransforms=1` from the host itself at 2.0.161 | verified |
| 13.11 | First release version prepared, not published. | F: `package.json` `version: 0.2.0` (minor bump for the 2.0.161 baseline and the transform); no npm publication and no release exists (`git ls-remote --tags` empty, `gh release list` empty), because publication belongs to the delivery workflow | verified |
| 13.12 | Contributor instructions, offline, no paid key. | F: `docs/CONTRIBUTING.md` | verified |
| 13.13 | The harness bind must be observed, not assumed. | F: `scripts/openfox-harness.ts` sets `OPENFOX_HOST=127.0.0.1` as an explicit override and reads the real listener with `ss -ltnpH`, failing closed when the bind cannot be read or is not loopback-only. R: both runs recorded "the isolated host is bound to loopback only - listening on 127.0.0.1:<port>". The override is defence in depth, not a fix: the released host resolves `env.server.host ?? globalConfig.server.host ?? "127.0.0.1"` and this harness already seeds `server.host`. No LAN-exposure incident is established or claimed by this patch | verified |
| 13.14 | The installer's npm must not write outside the temporary tree. | F: `scripts/openfox-harness.ts` drops `npm_config_prefix` and `NPM_CONFIG_PREFIX` from the host child environment, alongside the `HOME`/`XDG_*` overrides, so `buildIfNeeded()`'s `npm install` resolves under the temporary HOME. This is isolation of the trial, not a plugin feature | verified |

### Host findings (behaviour, not plugin defects)

| # | Finding | Evidence |
| --- | --- | --- |
| H1 | `registry.context` is readable only **during** `register()`. The host clears it in `endPlugin()`, so a tool that closes over `registry.context` fails on its first real execution. This was a **real defect in this plugin**, found only by the E2E run. | Fixed in `src/index.ts` by capturing the context object during registration; `test/plugin-context-lifetime.test.ts` reproduces the lifecycle and fails on the old code. |
| H2 | A plugin tool is treated as an "MCP" tool by the host, and it is denied **only** when the agent's `allowedTools` names at least one non-builtin tool (`hasMcpSpecific`). An agent whose allow-list contains builtins only has no plugin restriction at all. | The harness's denied agent therefore allows `semantic_scan` while omitting `semantic_decide`. This is host behaviour and is recorded rather than worked around. |
| H3 | The advisory workflow's agent is baked into the workflow document, and the shipped default (`builder`) has no `semantic_verify_task` in its `allowedTools`, so the step can never use the tool its own prompt tells the agent to call. | Fixed in `src/workflow/templates.ts` by `advisoryWorkflowFor(agentId)`, with T: `test/workflow-template.test.ts` "the advisory step agent is opt-in, because a stock agent cannot use the tool". The E2E installs the opt-in form and proves the advice really runs. |
| H4 | A workflow run leaves no terminal status on the public surface: `openfox_session_status` reports `workflow: null` once the run ends, so a completed run cannot be distinguished from a never-started one by status alone. | The harness therefore proves a step ran by a model request carrying that step's own prompt **that consumed a real scripted answer**, and proves the run ended by the host STOPPING to report an active workflow. A `currentStepId` poll is not sufficient: it can miss a step that really ran. |
| H5 | `server.host` in `config.json` does **not** reliably control the bind: `runServe` resolves `env.server.host ?? globalConfig.server.host`, so without the documented `OPENFOX_HOST` override the host is expected to bind `0.0.0.0` and serve an **unauthenticated** API. | Fixed: the harness sets `OPENFOX_HOST=127.0.0.1` and asserts the REAL listener via `ss -ltnpH` (not the banner), failing closed if it is not loopback-only. Evidence: the precedence is read from the host source, and an independent verifier observed the pre-fix host reachable over the LAN (HTTP 200 on a private IPv4). A controlled A/B with the variable removed was **not** run, so the causal link is source-derived and observed, not experimentally isolated. Found by independent verification, not by the build. |

## Issue #6 — pre-LLM context reduction (unblocked by OpenFox 2.0.161)

OpenFox 2.0.161 released `registerMessageTransform` with the `transforms`
capability, which retired the blocker this issue was waiting on.

| # | Requirement | Proof | Verdict |
| --- | --- | --- | --- |
| 6.1 | Verify the API exists in a **released** OpenFox package before using it | R: OpenFox 2.0.161 installed into `/tmp/of-harness-2.0.161`; `npm run harness` → 23/23 including the host's own `messageTransforms=1` | verified |
| 6.2 | Update the minimum supported OpenFox version | F: `package.json` `peerDependencies.openfox: ">=2.0.161"`, version `0.2.0`; T: `test/skill-api-compat.test.ts` pins both | verified |
| 6.3 | The transform is **opt-in** | F: `contextReduce` boolean setting, `default: false`; F: `src/transform/index.ts` returns the input array untouched unless `contextReduce === true`; T: `test/transform.test.ts` "the transform is registered but inert while the setting is off"; T: `test/register.test.ts` "the context-reduction transform is registered once and is off by default" | verified |
| 6.4 | Fail open on error | F: every failure path returns the original message array; T: `test/transform.test.ts` covers network failure, HTTP 500, malformed response, unconfigured endpoint, abort, an unreadable settings store, and a malformed message that does not crash it | verified |
| 6.4a | Every outcome is **observable**, not silent | F: `src/transform/index.ts` returns `{ messages, metadata }` on every path, with `semantic.applied` and `semantic.reason` (`disabled`, `settings_unavailable`, `no_candidates`, `not_configured`, `egress_blocked`, `provider_unavailable`, `invalid_response`, `low_confidence`, `total_wipe_refused`); F: the `semantic_transform_status` tool is the operator-visible read path, backed by a bounded store that keeps counts and reasons only; T: `test/transform.test.ts` "every outcome reports exactly one reason, and no outcome is silent"; T: `test/transform-status.test.ts` "the status tool reports the DEFER verdict and what the transform did", "the status tool explains why a turn was left unchanged", "the store counts applied turns and never stores content", "the status tool contacts no provider"; T: `test/transform-benchmark.test.ts` "every run reports a reason, so a silent no-op is impossible" | verified |
| 6.4b | The **live turn** can never be dropped | F: `src/transform/messages.ts` anchors the live window on the last tool result (or the trailing `user` turn) and stops candidacy there, so the current request is never offered to the provider at all; F: the reduction guard is on the RESULT, not on a candidate count | T: `test/transform.test.ts` "the newest user message is never a reduction candidate", "nothing at or after the last tool result is a candidate", "a provider cannot make the live turn droppable", "the live turn survives even when the newest message is an assistant reply"; T: "dropping ALL the history is allowed: only the live turn may never go" | verified |
| 6.4c | The submitted request respects a real character budget | F: `buildRequest` accumulates the budget while building questions and returns the indices actually asked about, so an over-budget segment is never treated as droppable; T: `test/transform.test.ts` "the submitted request never exceeds the character budget" | verified |
| 6.5 | Measure token savings **and** quality regressions | F: `scripts/transform-benchmark.ts` records main-model input/output tokens, semantic calls, semantic input tokens, provider **cost**, wall time, fallback rate and a per-run reason; F: the quality axis runs the transform's own question through `evaluateReferenceAgreement` (the shipped labelled evaluator, not a second implementation); T: `test/transform-benchmark.test.ts`; R: verdict **INCONCLUSIVE / DEFER** in `docs/EVALUATION.md` | verified — measured, and deliberately **not** promoted |
| 6.5a | An unknown cost is never a zero cost | F: `providerCostUsd` returns `null` unless `SEMANTIC_INPUT_USD_PER_MTOK` is supplied, and a non-numeric value is refused; T: "provider cost is reported as null when no price is supplied, never zero", "a supplied price produces a real cost, and the baseline stays free", "an invalid price is refused rather than silently treated as zero" | verified |
| 6.5b | The quality axis is not confused with task quality | F: the report keeps `qualityMeasured: false` for the task axis and records the provider capability separately with its own `scope` string; T: "the quality axis is measured through the project evaluator, not a second copy" | verified |
| 6.5c | The API mirror cannot drift from the released host | F: `src/openfox-plugin.d.ts` carries the full `PluginSettingsField` and `PluginSettingsLinkButton` bodies from 2.0.161; T: `test/plugin-api-mirror.test.ts` diffs the mirror against the installed `openfox@2.0.161` declarations and fails on any missing property or union mismatch (skipped when no OpenFox tree is present) | verified |
| 6.6 | Egress policy applies before any request | F: the call uses `origin: 'automatic'` and the provider enforces egress before any network work; T: `test/transform.test.ts` asserts a blocked remote endpoint is **never contacted** for both `block-remote-automatic` and `block-remote-all` | verified |
| 6.7 | A transform may not touch the system prompt or tool traffic | F: `src/transform/messages.ts` restricts candidates to `user`/`assistant` string content; T: `test/transform.test.ts` "only user and assistant text segments are eligible for reduction" | verified |
| 6.8 | No saving may be claimed without evidence | F: the setting description, the README and the registry entry all state it is unmeasured; the report carries `measured: false` | verified |
| 6.9 | No regression to the existing tools | T: full suite 464 passed / 0 failed (2 skipped: the API-mirror drift guard, which needs an installed OpenFox tree and passes 5/5 when one is present via `HARNESS_PKG_DIR`); the transform adds one setting, one registered method and one read-only status tool | verified |
| 6.10 | The compatibility baseline lives in **one** place | F: `package.json` `openfox.compatibilityBaseline`, read by `scripts/setup-harness.sh` and by `test/helpers/baseline.ts`; T: `test/skill-api-compat.test.ts` "the baseline is declared in exactly one place" fails on any hard-coded literal in `scripts/`, `src/` or `test/` and on a hard-coded shell fallback | verified |
| 6.11 | One conformance suite, not two copies | F: `scripts/conformance.ts` is now CLI-only (environment, campaign metadata, report writing) and delegates to `runConformanceSuite` in `scripts/conformance-suite.ts`, which `conformance-campaign.ts` and the tests already import; the two implementations were diffed and produce identical reports apart from timing values | verified |

## Curated registry declaration

| # | Requirement | Proof | Verdict |
| --- | --- | --- | --- |
| R1 | Declare the plugin in `plugins-registry.json` with the documented fields | F: `docs/registry-entry.patch` adds one entry — `name`, `displayName`, `description`, `githubUrl`, plus `author` and `icon` as every existing entry carries | verified |
| R2 | The description must be factual | F: states what the tools are and that the transform is opt-in and unmeasured; no provider name, no certification, no saving claim | verified |
| R3 | One file changed, nothing else | R: PR co-l/openfox#430 touches `plugins-registry.json` only, +8 lines, JSON re-validated with no duplicate `name` | verified |
| R4 | The PR body answers the upstream template | F: `docs/registry-PR-BODY.md` fills Summary, "AI-Enhanced Development" and "Cache Impact" | verified |

## Two-level documentation

| # | Requirement | Proof | Verdict |
| --- | --- | --- | --- |
| D1 | A user-facing guide exists, separate from the reference docs | F: `docs/USER-GUIDE.md` (install → configure → allow → each tool → what it never does → troubleshooting → honest limits); F: README links it near the top and keeps the evaluation material itself | verified |
| D2 | Every registered tool is documented | T: `test/user-guide.test.ts` "every registered tool is documented in the user guide" — the test caught three calibration tools missing on first run | verified |
| D3 | The guide cannot name a setting that does not exist | T: `test/user-guide.test.ts` "every documented setting key exists, and the guide names no phantom one" | verified |
| D4 | The guide's guarantees are the ones the code keeps | T: `test/user-guide.test.ts` "the guarantees the guide advertises are the ones the code keeps" — asserts no hook/transition, the live-turn anchor, `redirect: 'error'`, no reflected error body, no logging | verified |
| D5 | The guide claims no unmeasured saving | T: `test/user-guide.test.ts` "the guide does not promise a saving that was never measured" | verified |
| D6 | The guide defers depth to the reference docs | T: `test/user-guide.test.ts` "the guide points at the deep reference docs instead of duplicating them" | verified |

## Scope discipline

| Requirement | Proof | Verdict |
| --- | --- | --- |
| A larger fixture set may not become a fatter claim | F: `fixtures/verify/cases.json` carries no `pass-candidate` label and no threshold; F: `scripts/verify-fixture-set.ts` refuses `positive_label_before_calibration`; T: `test/verify-fixture-set.test.ts` "the suite covers every status the uncalibrated policy can emit" and "a pass-candidate label is refused while the policy is uncalibrated" | verified |
| A suite may not be padded with paraphrases | F: `scripts/verify-fixture-set.ts` `LEXICAL_DUPLICATE_THRESHOLD`; T: `test/verify-fixture-set.test.ts` "a lexically duplicated criterion is refused, so the suite cannot be padded" and "a duplicated label on unrelated content is NOT a duplicate" | verified |
| No workflow gate in this lot | `src/` registers only settings, tools and a skill source; no `registerTransitionHandler`, no `registerHook` | verified |
| Reuse Lot 1 transport / egress / settings | `src/verify/tool.ts` imports `SystemOneHttpProvider`, `parseSettings`, `ProviderError`; T: `test/verify-tool.test.ts` "repository-derived evidence is always sent with an automatic origin" and "an explicit semantic_decide call stays allowed under the same policy" | verified |
| No secret or provider detail in the skill | T: `test/skills.test.ts` provider-neutrality test; T: `test/verify-tool.test.ts` "the API key is never echoed in the report or the error" | verified |
| No upstream OpenFox patch | F: only `openfox/plugin` public API is used; `package.json` `apiVersion` remains 2 | verified |

## Summary

Counts are recomputed from the tables above by
`test/traceability.test.ts`, so they cannot silently drift.

- Verified: 99 requirements.
- Verified with a documented deviation: 0.
- **Unverified: 3** — the real-provider false-pass rate (4.18), the
  OpenFox end-to-end savings metrics (4.19), and the unreached `pass-candidate`
  behaviour (4.9). Each requires a live provider run, and none is claimed as
  satisfied. The functional `load_skill` path (14.23) is now verified against a
  real isolated host; what remains unmeasured is decision quality (#9), which the
  E2E deliberately does not claim.
