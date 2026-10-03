# Visual semantic decision spike (#35)

Status date: **2026-10-03**.

This document records the evidence boundary for issue #35. It does **not**
enable a visual tool in the OpenFox plugin and it does not change
`DecisionRequest`.

## Why this remains a spike

The target is a bounded typed decision over screenshots, not generic
chat-with-image:

```text
screenshot
  -> typed question
  -> probability / bounded answer
  -> advisory accept or fallback
```

A production API is allowed only after a real vision-capable decision backend
has been measured on labelled OpenFox screenshots.

## Environment discovery

The current OpenFox server was inspected read-only.

### Reachable System One endpoints

The currently reachable TypeSafe/Jev, Laya and Kev endpoints are text-only for
their observed request schemas. None exposes an image input in its current
`/v1/systemone` contract.

The local OpenFox host is also unsuitable for a heavy visual model: no NVIDIA
GPU/CUDA device is available, and its local Ollama instance has no models
installed.

A separately configured Windows/Qwen OpenAI-compatible endpoint was initially
unreachable from the OpenFox server on 2026-10-03. After the operator corrected
its Ajean launch parameters and restarted it, the endpoint became reachable and
was measured as the conventional-VLM baseline below. No synthetic result was
substituted during the unavailable period.

### Current external candidates

Two current open projects demonstrate the contract we want to evaluate:

- OpenJev: <https://github.com/razorback16/openjev> — extends the Jev-compatible
  request with image inputs while retaining typed `noul`, `choice` and
  `score` questions.
- Jev-Vision: <https://github.com/sseanliu/Jev-Vision> — an open-weight
  screenshot step verifier exposing Jev-shaped typed decisions over one or more
  screenshots.

These are **candidate backends**, not dependencies and not evidence that #35
passes.

## Labelled smoke set

The first fixture manifest is
[`benchmark/visual/cases.json`](../benchmark/visual/cases.json).

The source screenshots already exist in the OpenFox repository under
`docs/screenshots`. They were manually inspected visually before the labels
below were recorded; the labels are not inferred from filenames.

| image | page choice | vision fallback form visible |
| --- | --- | --- |
| `homepage.png` | `homepage` | false |
| `providers.png` | `providers` | false |
| `agents.png` | `agents` | false |
| `workflows.png` | `workflows` | false |
| `vision-fallback.png` | `other` | true |

Two cases are intentionally non-trivial:

- `vision-fallback.png` is another step of the setup wizard but is **not** the
  Providers page, so `providers` is a plausible false positive.
- `workflows.png` is titled **Build & Verify**; the word "workflow" is not
  visible, so a filename/text-keyword shortcut should not be enough.

This seven-question set is a **smoke set only**. It validates image transport,
typed output and basic UI discrimination. It is not the 25–50 action-state
dataset required for the production GO gate.

## Reproducible harness

The harness is intentionally outside `src/`:

```bash
npm run visual:spike
```

Required environment:

```text
VISUAL_BACKEND=systemone | openai
VISUAL_FIXTURE_ROOT=/path/to/openfox/docs/screenshots
VISUAL_ENDPOINT=<full POST endpoint>
VISUAL_MODEL=<model id>
VISUAL_API_KEY=<optional secret>
```

Optional:

```text
VISUAL_MANIFEST=benchmark/visual/cases.json
VISUAL_SYSTEMONE_IMAGE_FIELD=images   # default; use image for a single-image API
```

### System One candidate

Example shape for a backend such as OpenJev:

```bash
VISUAL_BACKEND=systemone \
VISUAL_FIXTURE_ROOT=/path/to/openfox/docs/screenshots \
VISUAL_ENDPOINT=http://host:port/v1/systemone \
VISUAL_MODEL=model-id \
npm run visual:spike
```

The harness sends one image and one typed question per case. It accepts only the
typed answer corresponding to the fixture kind.

### Conventional VLM baseline

For an OpenAI-compatible vision endpoint:

```bash
VISUAL_BACKEND=openai \
VISUAL_FIXTURE_ROOT=/path/to/openfox/docs/screenshots \
VISUAL_ENDPOINT=http://host:port/v1/chat/completions \
VISUAL_MODEL=model-id \
npm run visual:spike
```

The baseline prompt demands a strict JSON object. Prose or markdown fences are
counted as malformed rather than repaired. This keeps the comparison honest:
the harness does not turn a chat model into a typed-decision service by adding
post-hoc interpretation.

## Metrics and deliberate nulls

The smoke report records:

- per-case expected/observed answer;
- accuracy over usable answers;
- malformed-response rate;
- median and p95 request latency;
- provider-declared confidence when present;
- raw `noul` probability when present;
- backend/model identity.

Some safety metrics remain deliberately `null` in this smoke set:

- `falsePositiveSuccessRate`: no action-state `success` taxonomy exists yet;
- `unknownFallbackRate`: no universal abstention threshold is invented across
  models/providers.

Those fields become measurable only after the action-state fixture set and
provider-specific calibration policy exist.

## Measured conventional VLM baseline — Qwen3.8 27B

On 2026-10-03 the previously configured private LAN Qwen endpoint was restarted
and became reachable. Vision capability was verified empirically with three
synthetic color images plus a text-only control before using it on the OpenFox
fixtures.

Observed endpoint/runtime:

- OpenAI-compatible `llama.cpp`;
- private LAN endpoint at `192.168.0.1:8080`;
- model `Qwen3.8-27B-UD-IQ4_XS.gguf`;
- no API key used;
- image input via `image_url` data URLs;
- no calibrated probabilities or provider confidence exposed.

The seven smoke decisions were all correct on the first strict-JSON response:

| case | expected | observed | latency |
| --- | --- | --- | ---: |
| homepage page class | homepage | homepage | 2,945 ms |
| providers page class | providers | providers | 2,871 ms |
| agents page class | agents | agents | 2,693 ms |
| workflows page class | workflows | workflows | 42,327 ms |
| vision-fallback page class | other | other | 42,437 ms |
| providers vision form visible | false | false | 43,896 ms |
| vision-fallback form visible | true | true | 44,359 ms |

Aggregate:

- accuracy: **7/7**;
- malformed JSON: **0/7**;
- median latency: **42,327 ms**;
- p95 latency: **44,359 ms**.

The machine-readable result is
[`benchmark/results/visual-qwen-2026-10-03.json`](../benchmark/results/visual-qwen-2026-10-03.json).

This is useful as a **quality baseline**, but not as evidence for the intended
fast System One path. The endpoint does not expose typed probability
distributions, and the observed median latency is orders of magnitude above the
fast decision layer this project is trying to validate.

No confidence is inferred from response text or generation behavior.

## Reproducibility replay with the versioned harness

After PR #39 was merged, the exact repository harness was replayed from a clean
detached worktree at commit `bddc9541`, rather than from the older dirty OpenFox
workspace used during environment discovery.

Command shape:

```bash
VISUAL_BACKEND=openai \
VISUAL_FIXTURE_ROOT=/path/to/openfox/docs/screenshots \
VISUAL_ENDPOINT=http://private-host:8080/v1/chat/completions \
VISUAL_MODEL=Qwen3.8-27B-UD-IQ4_XS.gguf \
npm run visual:spike
```

No API key was used. There were no per-case retries and no response repair.

The versioned harness independently reproduced **7/7 correct, 0/7 malformed**:

| case | latency |
| --- | ---: |
| homepage page class | 41,483 ms |
| providers page class | 40,810 ms |
| agents page class | 41,161 ms |
| workflows page class | 41,254 ms |
| vision-fallback page class | 40,971 ms |
| providers vision form visible | 40,801 ms |
| vision-fallback form visible | 38,695 ms |

Aggregate:

- accuracy: **7/7**;
- malformed JSON: **0/7**;
- median latency: **40,971 ms**;
- p95 latency: **41,483 ms**;
- provider confidence/probability: **not available**;
- total harness wall time: approximately **4 min 49 s**;
- repository `npm run check`: **PASS**, 323 tests / 0 failures.

The machine-readable replay is
[`benchmark/results/visual-qwen-harness-replay-2026-10-03.json`](../benchmark/results/visual-qwen-harness-replay-2026-10-03.json).

The first probe and the versioned replay agree on correctness but differ in
per-case latency shape. That variability is itself evidence against treating
this conventional VLM as a deterministic low-latency System One substitute.
Both runs remain smoke evidence only.

## Current decision

**PARTIALLY UNBLOCKED: the conventional VLM baseline is measured; the System One visual comparison remains blocked.**

What is complete:

- environment capability inventory;
- manually grounded smoke labels;
- provider-neutral benchmark harness;
- conventional-VLM comparison path;
- System One visual comparison path.

What is still required before the issue can reach its decision gate:

1. a reachable image-capable System One backend;
2. 25–50 sanitized action-state screenshots including success, processing,
   blocked, error, authentication and ambiguous cases;
3. measured false-positive `success`, fallback/unknown and latency;
4. a recorded GO/DEFER decision based on those measurements.

Until then, **do not register a production visual tool and do not widen the
generic decision contract**.
