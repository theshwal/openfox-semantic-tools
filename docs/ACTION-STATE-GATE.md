# Action-state gate: measured run and decision (issue #35)

Status date: **2026-10-04**.
Decision: **DEFER** — do not ship a production visual primitive yet.

This closes the acquisition attempt that the
[action-state dataset contract](../benchmark/visual/ACTION-STATE-DATASET.md)
asked for, and records what the measured evidence actually supports. It does
**not** promote the spike to production.

## What was measured

One primary run of the existing visual harness against a frozen corpus, plus one
separately labelled calibration run comparing question formulations.

| | |
| --- | --- |
| Source commit | `f18eef6` (`upstream/main`) |
| Backend | `systemone` |
| Endpoint class | operator-supplied |
| Model | `openjev-latest` (alias of `openjev-0.1`) |
| Capture application | OpenFox v2.0.160-dev |
| Preprocessing | PNG bytes inlined verbatim as base64; no resize, crop or re-encode |
| Corpus manifest (harness-loadable) | `benchmark/visual/action-state-cases.json` |
| Corpus catalogue (coverage + blocker + sha256) | `benchmark/visual/action-state-manifest.json` |
| Sidecar ground truth | `benchmark/visual/action-state-sidecar.json` |
| Primary result | `../benchmark/results/visual-action-state-openjev-2026-10-04.json` |
| Calibration result | `../benchmark/results/visual-action-state-calibration-2026-10-04.json` |
| Viewport | 1440x900 |
| Retries | none, per the contract's primary-run discipline |

Two corpus files exist and they are not interchangeable. The **manifest**
(`action-state-cases.json`) is the only one `loadManifest` can parse; it is what
`VISUAL_MANIFEST` must point at. The **catalogue**
(`action-state-manifest.json`) is not a harness input — it records coverage,
the blocker narrative and the sha256 of each frozen image. The manifest was
generated from the sidecar, and the result files record both paths separately.

### Relationship to the already-merged baselines

The conventional-VLM comparison required by the issue was already delivered and
is reused as-is; nothing was re-run.

| run | model | backend | cases | accuracy | origin |
| --- | --- | --- | ---: | ---: | --- |
| OpenJev page-form smoke | `openjev-latest` | systemone | 7 | 1.00 | PR #44 |
| Qwen page-form smoke | `Qwen3.8-27B-UD-IQ4_XS.gguf` | openai-compatible | 7 | 1.00 | PR #40 |
| Qwen harness replay | `Qwen3.8-27B-UD-IQ4_XS.gguf` | replay | 7 | 1.00 | PR #41 |
| **OpenJev action-state gate** | `openjev-latest` | systemone | **14** | **0.64** | this document |

The Qwen baseline answers the issue's "is a conventional VLM equally good?"
question on the 7 page-form cases, where both backends score 1.00. That
comparison does **not** transfer to the action-state gate: the Qwen baseline was
never run on these 14 frames, so no per-backend action-state comparison is
claimed here. What the merged baselines do establish is that the transport and
the harness work, which is why the 0.64 below is a property of the task and the
model, not of the plumbing.


Reproduce:

```sh
npm ci --ignore-scripts

export VISUAL_BACKEND=systemone
export VISUAL_MANIFEST=benchmark/visual/action-state-cases.json
export VISUAL_FIXTURE_ROOT=benchmark/visual
export VISUAL_ENDPOINT=https://api.codiv.ai/v1/systemone
export VISUAL_MODEL=openjev-latest
export VISUAL_API_KEY="<operator key>"

npm run visual:spike
```

The calibration run uses the same environment with the `noul` manifest instead:

```sh
export VISUAL_MANIFEST=benchmark/visual/action-state-calibration-manifest.json
npm run visual:spike
```

The key is never read from the repository. Integration runs against a hosted
provider stay opt-in; the local suite runs without credentials.

## Corpus coverage: 14 of the 31 target cases

Every image is a real OpenFox screenshot, labelled only from the OpenFox HTTP API
at capture time. All 14 hashes and all 14 filenames are distinct.

| state | contract target | admitted | note |
| --- | ---: | ---: | --- |
| success / completed | 5 | 1 | session backend reports `phase: done` |
| processing | 4 | **0** | see blocker |
| blocked | 5 | **0** | see blocker |
| explicit error | 5 | 5 | provider failure, `isRunning` true |
| authentication required | 4 | **0** | see blocker |
| wrong / unexpected page | 4 | 4 | project route with no session selected |
| ambiguous / unknown | 4 | 4 | explicit crops of genuine frames |
| **total** | **31** | **14** | |

### The blocker, precisely

The only active provider in the OpenFox dev instance is `Local` ->
`http://localhost:1234/v1` (LM Studio). That port **refuses connections**. The
Ollama server on port 11434 answers `/v1/models` but exposes **zero models**.

Because the agent never receives a completion:

- a running session renders the provider-failure retry banner, so `processing`
  and `explicit error` are the *same frame* and cannot be separated honestly;
- `blocked` and `waiting` require a workflow execution that must first complete an
  LLM step — three launches of the built-in `Build & Verify` workflow never left
  `phase: plan`;
- `authentication required` needs the OpenFox network auth strategy enabled, which
  is an environment change deliberately **not** made to manufacture a fixture.

Four frames were initially captured as `processing` on the strength of
`isRunning: true`. Visual inspection showed the decisive error banner in each, so
they were relabelled to `explicit error` and the sidecar records that
relabelling. Padding them back to `processing` would have been fabrication.

## Measured results

### Primary run — 7-way `choice`

| metric | value |
| --- | --- |
| accuracy | 0.64 (9/14) |
| **false-positive success rate** | **0.00** |
| malformed / provider error rate | 0.00 |
| median latency | 836 ms |
| p95 latency | 2199 ms |
| `unknownFallbackRate` | null (no declared abstention channel) |

Per-state outcome: all 5 `error` frames and all 4 `unknown` frames were recovered,
the single `success` frame was recovered, and all 4 `wrong_page` frames were lost
(three answered `unknown`, one answered `processing`).

### Calibration — binary `noul`, reported separately

| metric | choice (7-way) | noul (binary) |
| --- | --- | --- |
| accuracy | 0.64 | 0.93 |
| false-positive success | 0 | 0 |
| false-negative success | 0 | 1 |
| median latency | 836 ms | 658 ms |
| p95 latency | 2199 ms | 1647 ms |

The binary question is the more conservative of the two: it answered `true` on
none of the 13 non-success frames. Its cost is a single false negative — it
answered `false` on the one genuine `success` frame (p=0.010), because a binary
axis cannot express "completed" versus "still running" and therefore abstains.
For a post-action verification gate that bias is the safe direction, but the loss
of recall on true successes is a real cost that only a full 31-case corpus could
quantify.

## Decision: DEFER

Bar applied: the issue's continue conditions plus the contract's hard safety bar.
The safety bar is met; the evidence bar is not.

- **Materially useful signal — not established.** 0.64 accuracy is not a usable
  post-action gate, and 4 of 4 `wrong_page` frames were lost.
- **Confident false-positive success acceptably rare — met.** Zero false-positive
  successes at n=14, under both formulations. This is the metric that mattered
  most and it is clean.
- **Ambiguity exposed as unknown rather than guessed — partially met.** The
  choice rubric did return `unknown` for the ambiguous crops, but only because
  `unknown` was one of its seven options. The backend exposes no abstention
  channel, so `unknownFallbackRate` is still null. Abstention is an artefact of
  the rubric here, not a capability of the primitive.
- **Plausible latency/cost — met.** 836 ms median, 2199 ms p95.
- **Conventional VLM is not clearly better on this workload — not established.**
  The merged Qwen baseline (PR #40/#41) matches System One on the 7 page-form
  cases, and the issue's stop condition "a normal VLM is equally cheap/fast for
  this workload" is therefore not excluded. Qwen was not run on these 14
  action-state frames, so the action-state comparison remains open rather than
  lost.

A GO cannot be issued: three of seven critical states were never observed by the
model, so the false-positive safety result is unmeasured on exactly the states
where a wrong positive is most dangerous (`blocked`, `auth_required`,
`processing`).

**A negative result is a valid completion of this spike.** #35 stays a spike. No
production visual tool is registered, which is the contract's stated precondition
for that state.

## What would unblock the next attempt

1. A reachable LLM provider (start LM Studio on 1234, or install a model for the
   Ollama server already listening on 11434). This alone recovers `processing`.
2. Then re-run the built-in `Build & Verify` workflow to obtain real `waiting` /
   `blocked` frames.
3. `authentication required` still needs an operator decision to enable the
   network auth strategy in an isolated dev instance; that is a deliberate
   environment change, not something a fixture run should do silently.
4. Re-run the primary gate and only then revisit the decision.
