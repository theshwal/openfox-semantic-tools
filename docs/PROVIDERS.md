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

## Conformance suite

`npm run conformance` runs a runtime-agnostic protocol suite against any
System One-compatible endpoint. Cases are declared once and are not edited per
runtime, so the same evidence is comparable across providers.

Covered: `noul`, `choice` (array and key/description criteria), `score`,
batched mixed questions, string/object/array state, model omitted, model
supplied, a client-side rejected question, a malformed wire payload, and an
unsupported model id when `SEMANTIC_UNSUPPORTED_MODEL` is set.

The report is machine-readable and carries `schemaVersion: 2`. It asserts
**no provider identity and no provider verification** — nothing a protocol
probe can do establishes *which* system answered. There is deliberately no
field or option to certify a provider.

What it does report are observations:

| Field | Meaning |
| --- | --- |
| `remoteEndpointObserved` | Something answered, and the URL classified as remote |
| `localEndpointObserved` | Something answered, and the URL classified as non-remote |
| `protocolConformanceObserved` | The probed protocol was satisfied |
| `providerLabelExplicitlyConfigured` | The operator typed a label. No verification value |
| `endpointClassification` | `local`/`private`/`remote`, a **syntactic** URL property |

`endpointClassification` is deliberately *not* identity: a public-looking
hostname can resolve to loopback (`nip.io` and similar), and a private address
can be a tunnel to a hosted provider.

### Two verdicts

- **`compatible`** — the runtime can serve the documented base protocol.
- **`strictCompatible`** — additionally, every negative path probed behaved
  correctly, including refusing a deliberately unsupported model id.

A runtime may legitimately be `compatible: true` with
`strictCompatible: false`. **Never read `compatible` alone as "no deviation was
found".** `deviations` is the authoritative list, and
`failedBaseCapabilities` / `failedStrictCapabilities` / `unverified` name exactly
which checks did not hold. The command exits non-zero unless both verdicts hold.

### Rejection evidence

A negative capability is only satisfied when the runtime actually answered and
rejected the input. A transport failure (`network`, `timeout`, `aborted`) is
reported as `unverified`, never as a pass, and a blanket 4xx across the suite is
recorded as `blanketRejection`.

Two rejection checks are reported separately because they prove different
things:

- `clientRejectsMalformedQuestion` — **this plugin** refused the input before
  opening a socket. It is a property of the client and stays true even when the
  endpoint is unreachable.
- `runtimeRejectsMalformedWirePayload` — the **runtime** answered a malformed
  payload with a rejection.

The endpoint is always written as `redacted` and credentials are never
persisted.

| Variable | Purpose |
| --- | --- |
| `SEMANTIC_ENDPOINT` | Required full POST endpoint |
| `SEMANTIC_API_KEY` | Optional; sent as a bearer header, never written to the report |
| `SEMANTIC_MODEL` | Optional model id, exercised by the `model-supplied` case |
| `SEMANTIC_UNSUPPORTED_MODEL` | Optional deliberately invalid model id for the negative case |
| `SEMANTIC_PROVIDER_ID` | Label stored in the report instead of the endpoint |

`npm run conformance:smoke` runs the same suite against a local offline stub.
It needs no credentials and no network, and is the only conformance evidence
reproducible in CI. A stub proves the transport and the suite, **not** decision
quality or compatibility with a real runtime.

### Verified and unverified

Verified offline: the suite, the generic adapter, and the egress guards against
a local stub.

Observed once against the official hosted endpoint, through an opt-in campaign
that is never run in CI: the base protocol was served, and a single deviation
was found — `choice` with array criteria was rejected while object-map criteria
worked. That single run is a **declaration with a provenance**, recorded in the
hosted preset, not a certification of the runtime.

Not verified: behaviour against Kev, Laya, system-one, sys1, jev-rs, local-jev,
Lichen or EdgeJev. Only the hosted endpoint has ever been reached, and only
once, which is far too little to characterise any runtime. Real per-runtime
deviations must be recorded here as they are measured, not assumed.

## Provider presets

A preset is **data, not a transport**. There is exactly one adapter
(`SystemOneHttpProvider`); a preset only supplies defaults and declared
capabilities, so switching backends can never change an OpenFox tool contract.

| Preset | Endpoint | Status |
| --- | --- | --- |
| `custom` (default) | required, operator-supplied | Any System One-compatible endpoint. No assumptions applied. |
| `jev-hosted` | required, operator-supplied | Observed once. See the capabilities note below. |
| `kev` | required, operator-supplied | Declared, unverified |
| `laya` | required, operator-supplied | Declared, unverified |
| `system-one` | required, operator-supplied | Declared, unverified |
| `sys1` | required, operator-supplied | Declared, unverified |
| `jev-rs` | required, operator-supplied | Declared, unverified |
| `local-jev` | required, operator-supplied | Declared, unverified |
| `lichen` | required, operator-supplied | Declared, unverified |
| `edgejev` | required, operator-supplied | Declared, unverified |

A **declared** preset is a way to select a runtime the project already knows
about, not a claim about it. It supplies no default and every capability stays
`unverified`, so an operator is never forced into `custom` for a named backend,
and nothing is asserted before a conformance run proves it.

`system-one` and `sys1` are **separate presets** because they are separate
runtimes, not aliases of one another. `laya` carries the `laya-compatible` alias
for the spelling used in the issue.

### Backward compatibility

`jev` is accepted as an alias of `jev-hosted`, so a configuration saved before
the rename keeps working. The alias resolves to the current id and is never
offered in the selector. `systemone` and `laya-compatible` resolve likewise.

Rules the implementation enforces:

- **`custom` is always available and always the default.** A custom endpoint
  works exactly as before, with no preset lookup and no capability assumption.
- **A preset never supplies a host.** The full POST endpoint stays mandatory in
  settings. The hosted preset deliberately ships an empty endpoint, so no
  hostname is ever guessed at request time.
- **Explicit values always win**, including an empty string, which means "no
  override". A preset fills in what is missing and never overwrites a choice.
- **Presets carry no credential** — only a hint about whether auth is usually
  required. Keys stay in the existing secret setting.
- **Presets carry no policy**: no threshold, no score, no calibration flag. A
  preset cannot make a positive verdict reachable.

### Capabilities are tri-state, with a provenance

A declared capability is `true`, `false`, or `unverified`:

| Value | Meaning |
| --- | --- |
| `true` | Observed to work |
| `false` | Observed to fail |
| `unverified` | Nobody asked. **Not** a failure. |

`capabilityOf()` returns `unverified` for any capability a preset does not
declare, and for any unknown preset. Absence of evidence is never turned into a
failure.

The hosted preset records `choiceArrayCriteria: false` because a conformance run
against the official endpoint observed array criteria rejected with a targeted
error while object-map criteria worked (see the live findings document). This is
a **declaration with a provenance, not a certification**: it describes one
observed run, it is not a permanent property of the runtime, and it must be
re-observed rather than assumed. The generic transport is unchanged, so nothing
is faked to make the case pass.

Capability discovery is opt-in and failure-safe. No probe runs when a preset is
applied, at plugin registration, or on the settings path.

## Decision cache

The cache is an **optional optimization**, off by default. It reuses an
identical previous answer instead of calling the provider again, which helps
during retries and verifier loops that ask the same question about unchanged
state.

| Setting | Default | Meaning |
| --- | --- | --- |
| `cacheEnabled` | `false` | Turns the cache on. Off means behaviour is unchanged. |
| `cacheTtlMs` | `300000` | How long an entry may be reused. `0` disables reuse entirely. |
| `cacheMaxEntries` | `128` | Hard bound, with deterministic oldest-first eviction. |

It is built so that a mistake is inert rather than dangerous:

- **The key is canonical and complete.** It covers the tool namespace, the
  preset identity, the endpoint, the model, the protocol version, the state,
  the questions *with their criteria*, and the policy version when a
  higher-level result is cached. Keying on the question text alone is not
  enough: the same wording against different state is a different answer.
- **No secret reaches a key.** Userinfo is stripped, and query parameters whose
  name looks like a credential (`token`, `api_key`, `key`, `signature`, …) are
  dropped before hashing, so a key is safe to log. A key is a digest: it exposes
  nothing.
- **Non-secret query parameters are kept.** `?tenant=a` and `?tenant=b` are
  different providers and must not share entries; dropping the whole query
  would cause a cross-tenant reuse.
- **The store is rebuilt when the provider identity changes.** An opaque
  in-memory fingerprint covers the raw endpoint, the model, the preset, the
  credential, the endpoint class, the egress policy and the cache settings. A
  changed key is a different tenant on the same host, so a credential change
  invalidates the store. The fingerprint is never logged and never leaves the
  process.
- **Only successful answers are stored.** A provider error, timeout, abort or
  malformed response throws before the store, so it can never be replayed as a
  result.
- **Values are cloned at both boundaries.** A caller mutating the object it
  passed in, or the object it got back, cannot corrupt the store.
- **Namespaces are separate.** A generic `semantic_decide` answer is never reused
  as a higher-level policy outcome.
- **Hit/miss counters are exposed** for evaluation. They contain counters only:
  no key, no state content, no credential.

The cache cannot influence policy: it does not calibrate anything and cannot
make a positive verdict reachable. Caching is opt-in until a benchmark shows a
real repeated-call benefit.

## Data egress

Endpoints are classified as `local`, `private` or `remote` from the hostname
(loopback, RFC1918/CGNAT/link-local/ULA ranges, `.local`-style suffixes),
with an explicit `endpointClass` override when detection is wrong or ambiguous.

`egressPolicy` controls what may leave the machine:

| Policy | Automatic calls to a remote endpoint | Explicit calls |
| --- | --- | --- |
| `allow` (default) | allowed | allowed |
| `block-remote-automatic` | blocked | allowed |
| `block-remote-all` | blocked | blocked |

Local and private endpoints are never blocked by any policy. A blocked call
returns a structured `egress_blocked` failure before any request is sent and is
never silently rerouted to another provider. Errors expose the status and a
sanitized message; API keys and authorization headers are never logged or
included in conformance reports.

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
