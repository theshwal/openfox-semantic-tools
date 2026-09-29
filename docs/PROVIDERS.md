# Provider / runtime landscape

This project targets the **System One wire contract** first and treats individual models/runtimes as interchangeable backends where practical.

The ecosystem is moving quickly. This file records candidates worth testing; it is not a compatibility guarantee.

## Current landscape

| Project | What it is | System One / Jev compatibility | Local | Notes for OpenFox |
| --- | --- | --- | --- | --- |
| TypeSafe Jev | Hosted reference service | Native | No | Baseline hosted provider and compatibility target |
| [Kev](https://github.com/jaredpalmer/kev) | Open decision-model family (0.8B / 4B / 9B / 27B) + server | `POST /v1/systemone` | Yes | Strong candidate for local/private use; trained specifically as a Jev-like decision model |
| [Laya](https://github.com/NandhaKishorM/laya) | Small non-autoregressive decision models | choice / score / noul; local HTTP/runtime options | Yes | Very small/fast model family; interesting for low-latency semantic primitives |
| [System One](https://github.com/LiteVar/system-one) | Native local-first runtime | Jev-shaped `POST /v1/systemone` | Yes | Model-independent runtime; currently ships a Laya backend |
| [sys1](https://github.com/alvarobartt/sys1) | Rust System One server/runtime | `/v1/systemone` and `/v1/decide` | Yes | Efficient Laya serving on CPU/Metal/CUDA |
| [jev-rs](https://github.com/yijunyu/jev-rs) | Rust scoring/runtime harness around multiple models/backends | Wire-compatible `POST /v1/systemone` | Yes | Interesting because it can wrap GGUF/OpenAI-compatible backends and exposes MCP too |
| [local-jev](https://github.com/amithgc/local-jev) | Offline Jev-compatible server with several local models | Jev-compatible `/v1/systemone` | Yes | Useful general local baseline; includes Qwen and NLI backends |
| [Lichen](https://github.com/Mushroom-Systems/lichen) | Jev-compatible inference over open-weight causal models | Drop-in `/v1/systemone` | Yes | Uses next-token probabilities rather than a dedicated decision encoder |
| [EdgeJev](https://github.com/yzfly/edgejev) | ONNX/INT8 local deployment path for several decision-model families | `POST /v1/systemone` | Yes | CPU/offline-oriented; can package Laya/Kev-style models for very cheap inference |

## Important distinction: model vs runtime

Do not treat every repository above as the same kind of thing.

### Decision-model families

- **Jev** — hosted reference.
- **Kev** — trained open decision models built specifically around typed questions.
- **Laya** — small encoder-style typed-decision models.

These are primarily about **decision quality, calibration, latency and model size**.

### Serving/runtime layers

- **System One**
- **sys1**
- **jev-rs**
- **local-jev**
- **Lichen**
- **EdgeJev**

These are primarily about **how a decision model or generic model is exposed locally**.

Some projects blur the boundary by shipping both model support and an HTTP server.

## Why the OpenFox plugin should not have one adapter per project

Most useful candidates already expose or target the same high-level contract:

```text
POST /v1/systemone

{
  "state": ...,
  "model": "...",
  "questions": {
    "q1": { "type": "noul", ... },
    "q2": { "type": "choice", ... },
    "q3": { "type": "score", ... }
  }
}
```

Therefore V0 should implement:

```text
OpenFox
   |
   v
semantic_decide
   |
   v
generic SystemOneHttpProvider
   |
   +---- Jev
   +---- Kev server
   +---- Laya-compatible server
   +---- system-one
   +---- sys1
   +---- jev-rs
   +---- local-jev
   +---- Lichen
   +---- EdgeJev
```

Only add a backend-specific adapter if a real protocol incompatibility cannot be handled by a small preset/capability layer.

## Candidate evaluation matrix

When the first adapter exists, test candidates on the same fixture set.

Record:

- request/response compatibility;
- supported question types;
- batching behavior;
- maximum practical state length;
- cold start;
- median/p95 latency;
- CPU/GPU requirements;
- memory footprint;
- calibration/probability behavior;
- task accuracy;
- multilingual behavior;
- licensing;
- whether source/state leaves the machine.

Do not rank providers from their own README benchmark numbers alone. Re-run a shared fixture/evaluation set through the plugin.

## Likely first providers to test

For the OpenFox use case, the most informative first comparison is:

1. **Jev hosted** — reference behavior.
2. **Kev 4B or 9B** — open model designed explicitly for the same typed-decision problem.
3. **Laya** — radically smaller/faster architecture.
4. **jev-rs + a local model** — tests whether a general model + logprob harness can be "good enough" without a dedicated decision model.

Then evaluate the serving runtimes (system-one, sys1, EdgeJev, etc.) mainly on deployment/latency/compatibility.

## What not to assume

- "Jev-compatible" does not mean identical probabilities or identical decision quality.
- Same endpoint shape does not imply identical edge-case semantics.
- Project-published accuracy numbers are not directly comparable when datasets/hardware differ.
- A 15 ms local classifier is not automatically useful if it needs too little context for the OpenFox question.
- A larger model is not automatically better if network/runtime overhead erases the benefit.

The plugin exists partly to make those comparisons reproducible.
