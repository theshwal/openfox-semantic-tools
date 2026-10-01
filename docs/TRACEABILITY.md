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
| 14.23 | "Where practical, add an integration fixture demonstrating that OpenFox can discover and load the plugin skill through the normal `load_skill` path." | R: `npm run harness:agent-e2e` on an isolated OpenFox `2.0.160`: a real agent turn calls `load_skill` for `semantic-verification` and `semantic-code-discovery` (observed tool calls `load_skill, load_skill, semantic_verify_task, semantic_search, semantic_scan, step_done`) | verified |
| 14.24 | "`npm run check` passes." | R: `npm run check` → 251 tests pass, typecheck and build succeed | verified |

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

## Issue #2 — real isolated OpenFox agent

Proof for this section comes from `npm run harness:agent-e2e`
(`scripts/agent-e2e.ts`): a real OpenFox `2.0.160` host, the built package
installed into a temporary `configDir`, real agent turns driven only through the
public `/mcp` endpoint, a scripted OpenAI-compatible LLM and a deterministic
System One stub, both on loopback. 67/67 checks pass, reproduced over three
consecutive runs.

| # | Requirement (issue text) | Proof | Verdict |
| --- | --- | --- | --- |
| 2.1 | "Install/build the package in an isolated host; do not use production configuration or sessions DB." | R: harness sets `HOME`, `XDG_CONFIG_HOME` and `XDG_DATA_HOME` to a fresh temp tree and removes it in `finally`; T: `test/harness-isolation.test.ts` | verified |
| 2.2 | "An allowed agent executes noul, choice and score, including a mixed batch, against a local deterministic System One stub." | R: observed wire body carries all three question ids in one request; the tool result is `{"answers":{"is_boolean":{"type":"noul","probability":0.75},"which_side":{"type":"choice","choice":"tenant_scoped",…},"how_bad":{"type":"score","score":2,…}}}` | verified |
| 2.3 | "Demonstrate that an agent without permission cannot invoke the tool." | R: the denied agent's call is refused by the host with the allow-list message, and the System One stub records **zero** requests for that turn | verified — see finding H2 for the caveat |
| 2.4 | "Failures/cancellation remain failed results on the real host path." | R: provider 5xx → `{"code":"http","message":"System One HTTP 500"}`; hanging provider → `{"code":"timeout","message":"Semantic provider timed out"}`; a stopped turn produces no answer and no cache hit. Each uses a distinct state string, so a warmed cache cannot mask it | verified |
| 2.5 | "Record the released OpenFox version and reproducible commands; no paid provider credential is required." | R: `benchmark/results/agent-e2e/report.json` records `openfoxVersion: 2.0.160`; the only key is a loopback fixture value | verified |
| 2.6 | Workflow advice must reach the normal verifier in every state (issue #12) | R: `npm run harness:agent-e2e` launches the real workflow three times — advice ACTIVE, advice DISABLED, provider 5xx. For each, it proves the **verifier turn itself ran**: a model request carrying the verifier step's own prompt that consumed a real scripted answer (not the harness's no-script placeholder), plus `step_done` returned by that same turn. A `currentStepId` projection is deliberately not used as proof | verified |

### Host findings (behaviour, not plugin defects)

| # | Finding | Evidence |
| --- | --- | --- |
| H1 | `registry.context` is readable only **during** `register()`. The host clears it in `endPlugin()`, so a tool that closes over `registry.context` fails on its first real execution. This was a **real defect in this plugin**, found only by the E2E run. | Fixed in `src/index.ts` by capturing the context object during registration; `test/plugin-context-lifetime.test.ts` reproduces the lifecycle and fails on the old code. |
| H2 | A plugin tool is treated as an "MCP" tool by the host, and it is denied **only** when the agent's `allowedTools` names at least one non-builtin tool (`hasMcpSpecific`). An agent whose allow-list contains builtins only has no plugin restriction at all. | The harness's denied agent therefore allows `semantic_scan` while omitting `semantic_decide`. This is host behaviour and is recorded rather than worked around. |
| H3 | The advisory workflow's agent is baked into the workflow document, and the shipped default (`builder`) has no `semantic_verify_task` in its `allowedTools`, so the step can never use the tool its own prompt tells the agent to call. | Fixed in `src/workflow/templates.ts` by `advisoryWorkflowFor(agentId)`, with T: `test/workflow-template.test.ts` "the advisory step agent is opt-in, because a stock agent cannot use the tool". The E2E installs the opt-in form and proves the advice really runs. |
| H4 | A workflow run leaves no terminal status on the public surface: `openfox_session_status` reports `workflow: null` once the run ends, so a completed run cannot be distinguished from a never-started one by status alone. | The harness therefore proves a step ran by a model request carrying that step's own prompt **that consumed a real scripted answer**, and proves the run ended by the host STOPPING to report an active workflow. A `currentStepId` poll is not sufficient: it can miss a step that really ran. |
| H5 | `server.host` in `config.json` does **not** reliably control the bind: `runServe` resolves `env.server.host ?? globalConfig.server.host`, so without the documented `OPENFOX_HOST` override the host is expected to bind `0.0.0.0` and serve an **unauthenticated** API. | Fixed: the harness sets `OPENFOX_HOST=127.0.0.1` and asserts the REAL listener via `ss -ltnpH` (not the banner), failing closed if it is not loopback-only. Evidence: the precedence is read from the host source, and an independent verifier observed the pre-fix host reachable over the LAN (HTTP 200 on a private IPv4). A controlled A/B with the variable removed was **not** run, so the causal link is source-derived and observed, not experimentally isolated. Found by independent verification, not by the build. |

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

- Verified: 63 requirements.
- Verified with a documented deviation: 0.
- **Unverified: 3** — the real-provider false-pass rate (4.18), the
  OpenFox end-to-end savings metrics (4.19), and the unreached `pass-candidate`
  behaviour (4.9). Each requires a live provider run, and none is claimed as
  satisfied. The functional `load_skill` path (14.23) is now verified against a
  real isolated host; what remains unmeasured is decision quality (#9), which the
  E2E deliberately does not claim.
