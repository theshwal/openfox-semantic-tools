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
| 4.1 | "a bounded semantic check after implementation/tests and before spending another full verifier pass" | F: `src/verify/tool.ts` takes exactly one criterion plus bounded evidence; T: `test/verify-tool.test.ts` "one batched call asks exactly the four policy questions"; T: `test/verify-state.test.ts` "oversized evidence is rejected rather than silently truncated" | verified |
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
| 4.7 | "Batch several questions where useful" (criterion satisfied / evidence sufficient / off-scope / deeper verification) | F: `src/verify/questions.ts` builds the four questions with policy gate ids; T: `test/verify-tool.test.ts` "one batched call asks exactly the four policy questions" asserts a single provider call carrying exactly those four ids | verified |

### Policy stays outside the provider adapter

| # | Requirement (issue text) | Proof | Verdict |
| --- | --- | --- | --- |
| 4.8 | "Keep policy outside the provider adapter." | F: thresholds exist only in `src/verify/policy.ts`; the adapter `src/providers/system-one.ts` is unmodified by this change; T: `test/verify-policy.test.ts` is the only consumer of thresholds | verified |

### Possible outcome mapping

| # | Requirement (issue text) | Proof | Verdict |
| --- | --- | --- | --- |
| 4.9 | "strong + safe result -> candidate to skip/limit a verifier pass" | F: `VerifyStatus 'pass-candidate'`; T: `test/verify-policy.test.ts` "an uncalibrated policy can never emit a positive verdict" — the code path exists but is unreachable without a measured calibration | **unverified** (code path implemented; behaviour unmeasured) |
| 4.10 | "uncertain -> normal OpenFox verifier" | T: `test/verify-policy.test.ts` "values inside the uncertainty band are undecided, not a pass" → `status: 'unknown'`; README documents the fallback | verified |
| 4.11 | "negative -> targeted builder/verifier follow-up" | F: statuses `off-scope`, `insufficient-evidence`, `needs-verification`; T: `test/verify-policy.test.ts` "a decisive failure routes to the documented follow-up status" | verified |
| 4.12 | "provider failure -> normal OpenFox path" | T: `test/verify-tool.test.ts` "provider failures never surface as a positive or negative verdict", "cancellation and timeouts stay failures with their own codes" | verified |
| 4.13 | "Do not enable automatic 'done' behavior in this issue." | F: no `registerTransitionHandler`, no `registerHook`, no `step_done` in `src/`; T: `test/verify-tool.test.ts` asserts `advisory: true` and no completion wording | verified |

### Evaluation

| # | Requirement (issue text) | Proof | Verdict |
| --- | --- | --- | --- |
| 4.14 | "Experiment can run on a labeled fixture set." | F: `fixtures/verify/cases.json` (positive / negative / adversarial); R: `npm run verify:experiment` → "7/7 fixtures matched the labelled policy status"; T: `test/verify-experiment.test.ts` "the labelled suite is reproduced offline with no credentials" | verified (plumbing only; the quality metric itself is 4.18) |
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
| 14.1 | "Use the public Plugin API v2" (`registerSkillSource`) | F: `src/skills/source.ts`; F: `src/openfox-plugin.d.ts` mirrors `PluginSkill` / `PluginSkillSource`; upstream contract verified against OpenFox `v2.0.157` and `v2.0.160` `src/plugin/index.ts`; T: `test/skills.test.ts` "the skill source is registered through the public plugin API" | verified |
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
| 14.15 | "Document the expected agent configuration and test behavior when: skill available but tool not allowed; tool allowed but skill not loaded; both available." | F: README "Usage skill" section; T: `test/skills.test.ts` "the skill source is registered through the public plugin API" (skill loads independently of settings) and `test/register.test.ts` "every semantic tool reads global settings only" (tools work without the skill) | verified |
| 14.16 | "The skill text should not assume a tool is callable if it is unavailable." | F: prompt "Limits you must keep" — explicitly tells the agent not to work around an unavailable tool | verified |

### Tests

| # | Requirement (issue text) | Proof | Verdict |
| --- | --- | --- | --- |
| 14.17 | "skill source registration" | T: `test/skills.test.ts` "the skill source is registered through the public plugin API" | verified |
| 14.18 | "both skill metadata entries are discoverable" (issue assumed two skills) | T: `test/skills.test.ts` "the verification skill is discoverable with concise metadata". **Deviation:** only one skill is published; `semantic-code-discovery` is deliberately withheld until #5 exists | verified with documented deviation |
| 14.19 | "prompts load correctly" | T: `test/skills.test.ts` "the verification skill is discoverable with concise metadata" | verified |
| 14.20 | "no provider-specific endpoint/model names leak into skill guidance" | T: `test/skills.test.ts` "the skill is provider-neutral: no provider, endpoint, URL or model id" | verified |
| 14.21 | "skill registration is independent of provider availability" | T: `test/skills.test.ts` "skill registration never reads settings or performs a request" | verified |
| 14.22 | "plugin manifest declares `skills` once implemented" | T: `test/skills.test.ts` "the manifest declares the skills capability exactly once" | verified |
| 14.23 | "Where practical, add an integration fixture demonstrating that OpenFox can discover and load the plugin skill through the normal `load_skill` path." | — | **unverified** — requires a running OpenFox instance; out of scope for an offline unit suite. Not implemented. |
| 14.24 | "`npm run check` passes." | R: `npm run check` → 122 tests pass, typecheck and build succeed | verified |

## Scope discipline

| Requirement | Proof | Verdict |
| --- | --- | --- |
| No workflow gate in this lot | `src/` registers only settings, tools and a skill source; no `registerTransitionHandler`, no `registerHook` | verified |
| Reuse Lot 1 transport / egress / settings | `src/verify/tool.ts` imports `SystemOneHttpProvider`, `parseSettings`, `ProviderError`; T: `test/verify-tool.test.ts` "repository-derived evidence is always sent with an automatic origin" and "an explicit semantic_decide call stays allowed under the same policy" | verified |
| No secret or provider detail in the skill | T: `test/skills.test.ts` provider-neutrality test; T: `test/verify-tool.test.ts` "the API key is never echoed in the report or the error" | verified |
| No upstream OpenFox patch | F: only `openfox/plugin` public API is used; `package.json` `apiVersion` remains 2 | verified |

## Summary

Counts are recomputed from the tables above by
`test/traceability.test.ts`, so they cannot silently drift.

- Verified: 38 requirements.
- Verified with a documented deviation: 1 (#14.18, one skill instead of two).
- **Unverified: 4** — the real-provider false-pass rate (4.18), the
  OpenFox end-to-end savings metrics (4.19), the unreached `pass-candidate`
  behaviour (4.9), and the `load_skill` integration fixture (14.23). Each
  requires a live provider or a running OpenFox instance, and none is claimed
  as satisfied.
