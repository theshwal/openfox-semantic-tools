# Architecture

## 1. Problem boundary

`openfox-semantic-tools` adds **bounded semantic decisions** to OpenFox.

It does not add another agent orchestrator and it does not replace OpenFox's generative model. The plugin supplies explicit tools/policies that can decide or rank small questions with a fast decision model, then hand control back to OpenFox.

The architecture separates four concerns:

```text
OpenFox Plugin API
       |
       v
OpenFox contributions
(settings / tools / later transforms)
       |
       v
Use-case policy
(verify / scan / search / relevance)
       |
       v
DecisionProvider
       |
       v
System One HTTP transport
       |
       +---- hosted Jev
       |
       +---- compatible local/open-source runtime
```

## 2. Why one System One adapter first

The useful interoperability boundary is the typed decision protocol, not a vendor SDK.

A Jev-compatible `POST /v1/systemone` endpoint accepts a shared state and typed questions. Multiple open-source runtimes implement or target the same shape. A generic adapter therefore gives us:

- hosted-provider support;
- local/private inference;
- easier A/B comparison;
- less provider-specific code;
- a stable OpenFox-facing contract.

Provider presets may supply defaults, but they must not leak into use-case logic.

## 3. Core types

The exact implementation may evolve, but the conceptual contract should stay close to this:

```ts
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

type NoulQuestion = {
  type: 'noul'
  instructions: string
}

type ChoiceQuestion = {
  type: 'choice'
  instructions: string
  criteria: string[] | Record<string, string>
}

type ScoreQuestion = {
  type: 'score'
  instructions: string
  criteria: string[] | Record<string, string>
}

type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion

type DecisionRequest = {
  state: string | JsonValue
  model?: string
  questions: Record<string, DecisionQuestion>
}

interface DecisionProvider {
  id: string
  decide(request: DecisionRequest, options?: {
    signal?: AbortSignal
  }): Promise<DecisionResponse>
}
```

The response must retain enough information for the use-case layer to reason about probability/confidence without assuming every question type has identical semantics.

### Important semantic rule

Do **not** normalize all three question types into a single `boolean + confidence`.

For example, a yes/no probability and a choice confidence are not automatically interchangeable. Thresholds belong to the specific use case.

## 4. V0 OpenFox contribution

V0 should expose one primitive:

```text
semantic_decide
```

It receives:

- state;
- one or more typed questions;
- optionally a model override.

It returns provider-neutral structured results.

It should not decide what probability means "safe", "complete" or "correct". Higher-level tools own that policy.

### Settings

Suggested initial settings:

- backend/preset: hosted Jev or custom System One endpoint;
- endpoint;
- optional model;
- API key (secret);
- timeout.

Avoid a single global "confidence threshold": different use cases require different calibration.

## 5. Higher-level use cases

### 5.1 semantic_verify_task

Purpose: answer bounded questions about whether implementation evidence satisfies a task/acceptance criterion before spending another full generative verification pass.

Input should be intentionally bounded, for example:

- original requirement / AC;
- relevant diff or changed-file excerpts;
- deterministic test results;
- implementation summary.

Candidate questions can be batched:

- requirement satisfied?
- evidence sufficient?
- more verification needed?
- implementation appears off-scope?

Policy decides whether to:

- accept the deterministic evidence;
- invoke the normal OpenFox verifier;
- request a targeted check;
- return to the builder.

**Primary risk:** false pass. This is the metric to optimize against, not just token reduction.

### 5.2 semantic_scan

Purpose: rank code units by a semantic predicate.

Example:

```text
"Does this function perform a database query inside a loop?"
"Can this endpoint access tenant-owned data without tenant scoping?"
"Does this code appear to implement acceptance criterion #3?"
```

The semantic result identifies candidates. OpenFox must inspect/verify candidates with normal code tools before acting on them.

This is not a replacement for static analysis when a deterministic rule exists.

### 5.3 semantic_search

Purpose: reduce exploratory repository reads by ranking likely relevant files/functions/chunks.

Potential references:

- jevgrep;
- function/chunk scoring patterns from Jev ecosystem experiments.

The main design question is whether repository chunking + decision calls actually beats OpenFox's existing search/read behavior end to end.

### 5.4 context relevance / reduction

Purpose: score historical messages/tool outputs against the current goal and remove or compress low-value items before the main LLM call.

OpenFox `develop` currently has a public `registerMessageTransform` contribution that can mutate messages/system prompt before LLM dispatch. This is a much cleaner integration point than observational hooks.

However the transform is not in the 2.0.157 compatibility baseline. Treat this feature as a later experiment after the API lands in a release.

Design rules:

- opt-in;
- fail open;
- preserve system/safety/instruction messages;
- never drop the current user request;
- record what was removed and estimated token impact;
- benchmark task quality, not just prompt size.

## 6. Failure model

The semantic layer is an optimization and decision aid. Its failure must be explicit.

```text
provider success
  -> structured result
  -> use-case policy

provider timeout/error/malformed response
  -> semantic tool failure
  -> caller may use normal OpenFox path

low/ambiguous probability
  -> use-case-specific fallback
  -> typically normal verifier/model
```

Never translate transport failure into "false" or "true".

## 7. Security / privacy

OpenFox plugins run in-process with Node.js privileges. Treat this plugin as trusted code.

Remote provider calls may carry:

- source snippets;
- diffs;
- issue text;
- test output;
- session context.

Therefore:

- API keys use secret settings;
- never log authorization headers or secrets;
- document what each tool sends;
- make custom/local endpoints first-class;
- avoid sending more context than the decision needs;
- future context transforms must be explicit/opt-in.

## 8. Compatibility strategy

### Stable baseline

OpenFox 2.0.157:

- Plugin API v2;
- tools;
- settings;
- hooks;
- workflow transition handlers.

V0 must fit here.

### Future capability

OpenFox `develop` exposes `registerMessageTransform` and the `transforms` capability. Before using it:

- verify the API in an actual release;
- update package compatibility;
- add integration tests against that release.

## 9. Candidate providers/runtimes

The project should test compatibility rather than assume it.

References currently worth evaluating:

- TypeSafe/Jev hosted System One API;
- https://github.com/LiteVar/system-one
- https://github.com/alvarobartt/sys1
- https://github.com/yijunyu/jev-rs

Do not bake one local runtime into the plugin. The generic HTTP adapter is the product boundary.

## 10. Deliberate non-goals

For the initial project:

- no autonomous agent orchestration;
- no replacement of OpenFox's verifier;
- no model/skill router unless later evidence justifies it;
- no silent automatic code approval;
- no semantic substitute for deterministic tests;
- no mandatory OpenFox core patch;
- no provider benchmark claims without reproducible measurements.
