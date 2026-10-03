# Action-state visual dataset plan (#35)

Status date: **2026-10-03**.

This document defines the dataset needed to move the visual semantic-decision
spike from page-classification smoke evidence to a real post-action verification
gate.

It is a **capture contract**, not an implementation of Playwright or an
OpenFox workflow. Downstream projects may produce the screenshots, but this
repository owns the benchmark labels, evidence requirements and acceptance
rules.

## Why the current screenshots are insufficient

A read-only inventory of the currently relevant OpenFox screenshots found:

- **15 PNG files**;
- **15 unique SHA-256 contents**;
- 11 documentation screenshots;
- 1 E2E debug screenshot;
- 3 recipe/proof screenshots.

All 15 were visually inspected. The corpus is useful for page/form
classification but it is not an action-state corpus.

The important gap is semantic, not just numeric:

| target state | usable examples currently visible | main gap |
| --- | ---: | --- |
| success / completed | 1–2 | too few transitions |
| processing | 1 | too few transitions |
| blocked | 0 | completely missing |
| explicit error | 0 | completely missing |
| authentication required | 0 | completely missing |
| wrong / unexpected page | about 1 | too few controlled negatives |
| ambiguous / unknown | 0 | completely missing |

The lower target of 25 examples therefore cannot be reached honestly from the
existing corpus, and four of the seven critical states are absent.

Do **not** duplicate screenshots, relabel page screenshots as action states, or
infer labels from filenames merely to reach a target count.

## Dataset target

Target **31 unique action-state examples** for the first real gate:

| state | target count |
| --- | ---: |
| success / completed | 5 |
| processing | 4 |
| blocked | 5 |
| explicit error | 5 |
| authentication required | 4 |
| wrong / unexpected page | 4 |
| ambiguous / unknown | 4 |
| **total** | **31** |

31 is large enough to exercise every state while remaining small enough to
audit manually. Growing beyond this should be driven by observed failure modes,
not by an arbitrary desire for a bigger dataset.

## Ground-truth rule

Every screenshot must have a **non-visual source of truth** captured at the same
step. The label must not come from the screenshot filename or from a model.

Recommended metadata per case:

```json
{
  "id": "workflow-blocked-01",
  "image": "workflow-blocked-01.png",
  "expected": "blocked",
  "source": {
    "scenario": "workflow verification reports a blocker",
    "route": "/...",
    "sessionState": "blocked",
    "workflowPhase": "blocked",
    "deterministicEvidence": [
      "session/status snapshot",
      "workflow event or test assertion"
    ]
  },
  "sanitization": {
    "reviewed": true,
    "notes": "no secrets or personal data"
  }
}
```

At least one deterministic field must independently establish the expected
state. Prefer two when available.

## Capture scenarios

### success / completed

Examples should include several visually different successful outcomes:

- workflow reaches its real completed/done state;
- action produces the expected destination page;
- dev server or operation reaches its known ready state;
- a bounded form/action visibly succeeds;
- a completed task/session state where the environment also reports completed.

Ground truth: workflow/session state, route, DOM assertion, or test success.

### processing

Capture genuine intermediate states rather than adding artificial spinners:

- model/session actively running;
- workflow step in progress;
- operation with a real loading/progress indicator;
- action submitted but destination not reached yet.

Ground truth: active execution state or a deterministic progress condition.

### blocked

This is a critical safety class. Capture real blockers such as:

- workflow/session state explicitly blocked;
- missing required input causing a workflow pause/block;
- deterministic dependency unavailable and represented in the UI;
- permission/path confirmation that prevents continuation.

Ground truth: session/workflow state must explicitly report the blocker.

### explicit error

Examples must contain a real failed operation:

- provider/service error surfaced in the UI;
- failed command/test represented by the UI;
- invalid configuration error;
- request failure with visible error state.

Ground truth: known error code/event/test result, not merely red text.

### authentication required

Capture real authentication barriers:

- login screen;
- expired/invalid session;
- route redirected to authentication;
- provider/service requests that genuinely require credentials, if the UI
  displays that state.

Ground truth: route/HTTP/auth state.

Never commit credentials, tokens, email addresses or personal account data in
the screenshot.

### wrong / unexpected page

Create controlled route/action mismatches:

- action expected page A but environment is on page B;
- unexpected modal/overlay replaces the intended destination;
- external/test page appears where OpenFox is expected.

Ground truth: expected route/state from the scenario plus actual route/DOM.

### ambiguous / unknown

This class tests abstention. It must not mean "we did not bother to label it".

Use real screenshots where pixels alone do not justify a safe action verdict,
for example:

- transition caught before a status indicator appears;
- partial/occluded UI where the decisive state is outside the captured region;
- visually identical UI states paired with different non-visual execution
  state;
- a deliberately cropped copy of a real state where the discriminating
  evidence has been removed.

The expected benchmark outcome is `unknown` / fallback. The sidecar metadata
must explain why the screenshot is insufficient.

## Sanitization

Before a fixture is admitted:

- remove or mask tokens, API keys, email addresses and personal identifiers;
- avoid production/customer/business data;
- prefer test projects/sessions and synthetic names;
- preserve the visual evidence needed to classify the state;
- record any crop/mask operation in metadata;
- hash the final sanitized image and use that hash in the manifest.

Sanitization must not accidentally expose the label by adding a textual
annotation such as "ERROR" or "BLOCKED" that was not present in the original UI.

## Split and prompt discipline

For the first 31-case gate:

- freeze the images and labels before running candidate models;
- use the same fixed question formulation for all providers in the primary
  comparison;
- test alternative formulations only as a separately reported calibration
  experiment;
- do not repeatedly rewrite prompts against the same cases until one provider
  wins;
- preserve every malformed response and failure;
- no per-case retry in the primary run.

The smoke page/form cases in `benchmark/visual/cases.json` remain useful as
transport/basic-discrimination checks, but they are **not** counted as the
31-case action-state gate unless a case genuinely has action-state ground truth.

## Metrics required for GO / DEFER

At minimum:

- overall accuracy;
- per-state accuracy;
- **false-positive success rate**;
- false-negative success rate;
- unknown/fallback rate;
- provider/malformed/error rate;
- median/p95 latency;
- probability/confidence distribution where the backend actually exposes it;
- high-confidence errors;
- model/runtime/version and image preprocessing.

For the production gate, a candidate must never gain credit for returning
`success` on an ambiguous, blocked, error or authentication-required case.

## Acquisition boundary

This repository should not implement browser automation solely to create these
images.

The capture work may be produced by existing OpenFox/Playwright tooling in a
separate workspace. What comes back here is only:

1. sanitized screenshots;
2. deterministic sidecar evidence;
3. frozen manifest entries.

Until that corpus exists and a vision-capable typed System One backend is
measured against it, issue #35 remains a spike and no production visual tool
should be registered.
