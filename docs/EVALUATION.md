# Evaluation plan

The project exists to improve **end-to-end OpenFox work**, not to win an isolated model micro-benchmark.

A semantic feature is useful only when its total benefit exceeds its added inference, complexity and error risk.

## 1. Compare against a baseline

For each experiment, run the same task set through:

### Baseline

Normal OpenFox behavior without the semantic feature.

### Candidate

OpenFox with exactly one semantic feature enabled.

Keep model, repository revision, task prompt and deterministic test commands as constant as practical.

## 2. Required measurements

Record at least:

| Metric | Why |
| --- | --- |
| Main-model input tokens | Primary context/token saving |
| Main-model output tokens | Detect extra retry/recovery generation |
| Semantic-provider input/cost | Optimization is not free |
| End-to-end wall time | User-visible outcome |
| Main-model calls | Detect avoided/added reasoning passes |
| Verifier/sub-agent calls | Key for verification experiments |
| Semantic calls | Detect overuse |
| Fallback count/rate | Measures how often the semantic layer actually decides |
| Task/AC success | Quality guardrail |
| False-pass rate | Critical for verification gates |
| False-negative / unnecessary fallback | Efficiency cost |
| Provider timeout/error rate | Operational reliability |
| Cache hit rate | Only if caching is introduced |

Where OpenFox observability already exposes session statistics, prefer those measurements over ad-hoc estimation.

## 3. Evaluation stages

### Stage A — protocol correctness

Fixture tests only.

Prove:

- `noul`, `choice`, `score` parsing;
- multi-question request/response;
- errors/timeouts;
- abort propagation;
- endpoint/model overrides;
- secret handling.

No performance claim is allowed at this stage.

### Stage B — decision quality

Create small labeled examples for each proposed use case.

For each example store:

- state supplied to the semantic provider;
- question(s);
- expected interpretation;
- provider result/probabilities;
- final policy action.

Do not tune and evaluate on exactly the same examples.

### Stage C — OpenFox end-to-end

Run real coding tasks with and without the feature.

The output should make it possible to answer:

1. Did the task still succeed?
2. Did the main model consume fewer tokens/calls?
3. Was total wall time lower?
4. Did the feature create retries or false passes?
5. Was the reduction large enough to justify the new moving part?

## 4. Use-case-specific metrics

### semantic_verify_task

Primary risk: false positive / false pass.

Measure:

- ACs incorrectly marked satisfied;
- verifier calls avoided;
- verifier calls still triggered;
- time/tokens saved;
- task regressions.

Do not make this an automatic "done" gate until the labeled suite and real-task runs show acceptable behavior.

Current status: the tool is implemented but **unmeasured**. The shipped policy
is `calibrated: false`, so it cannot emit a positive verdict at all: every
result is `unknown` or a follow-up status, and the normal verification path
stays authoritative. `npm run verify:experiment` replays labelled fixtures
through a scripted transport, which proves wiring and report shape only. Its
report deliberately records `measured: false` and `falsePassRate: null`; a null
rate is not a zero rate.

### semantic_scan

Measure:

- recall of known relevant functions/files;
- number of candidates returned;
- OpenFox reads avoided;
- total scan time;
- misses that would cause the agent to overlook a defect.

Ranking quality matters more than a pretty probability score.

### semantic_search

Measure:

- whether the true relevant file/chunk appears in top K;
- exploratory file reads avoided;
- additional semantic calls/tokens;
- time to first useful context.

Compare with OpenFox's existing repository/search tools, not just grep.

### context relevance / reduction

Measure:

- prompt tokens before/after transform;
- messages/tool outputs removed;
- later re-reads/retries caused by missing context;
- task success;
- total time.

A smaller prompt that forces OpenFox to rediscover discarded context is not a win.

### context reduction — recorded verdict: **DEFER**

The message transform (`semantic-context-reduce`, registered through
`registerMessageTransform`, released in OpenFox 2.0.161) is **implemented and
opt-in**, and it is **not promoted**. The `contextReduce` setting defaults to
`false` and there is no code path that turns it on.

**What was measured.** `npm run transform:benchmark` runs three synthetic
conversations through the transform offline against a deterministic stub and
records main-model input tokens, semantic-provider calls and input tokens,
provider **cost**, wall time and fallback rate. Offline results (character-based
token estimate of `len/4`, not a real tokenizer):

| Conversation | Baseline input | Candidate input | Semantic calls | Dropped |
| --- | ---: | ---: | ---: | ---: |
| long-tool-heavy-session | 172 | 172 | 1 | 0 |
| short-session | 46 | 46 | 1 | 0 |
| tool-only-session | 34 | 34 | 0 | 0 |

The neutral stub reports every segment as still needed, so the honest result is
**zero reduction**. The harness also runs a labelled `synthetic-drop-all`
variant (172 → 57 estimated tokens) purely so the saving path executes and is
visible; it is one canned answer applied to every conversation and is **not a
result**.

Provider **cost** is reported as `null`, never `0`, when no price is supplied:
a zero would be the claim "this is free". Set `SEMANTIC_INPUT_USD_PER_MTOK` to
price a run; the report then records a real figure, and the baseline still
reads `0` because the transform disabled spends nothing.

**The quality axis.** The token arithmetic says nothing about whether a
provider can actually judge a segment. The harness therefore also runs the
transform's own question ("is this segment still needed?") through the project's
`evaluateReferenceAgreement` — the shipped labelled evaluator, not a second
implementation that could drift — against four hand-labelled cases (a live
request, a superseded read, a settled conclusion, an ambiguous note).

Offline, against the neutral stub: 4 answered, 2 agreed, **accuracy 0.5**. That
is the expected result for a stub that always answers "still needed": it agrees
with the two cases labelled `true` and misses both labelled `false`. It is a
plumbing measurement, not a provider claim.

This axis is still **not task quality**: it never runs a model after a
reduction, so it cannot detect the cost of a model having to rediscover
discarded context. The report keeps `qualityMeasured: false` for the task axis
and records the provider capability separately.

**Why DEFER rather than PROMOTE or REJECT.**

- *Not REJECT*: the plumbing is proven. Segmentation, batching, egress,
  fail-open, the confidence floor and a reported reason on every no-op are
  covered by `test/transform.test.ts`, and the host loads the transform
  (harness `messageTransforms=1` on 2.0.161). The mechanism can reduce a
  prompt when a provider says so.
- *Not PROMOTE*: the decisive axis is still unmeasured. No model ran after a
  reduction, so nothing is known about the cost of a model that has to
  rediscover the discarded context — which is precisely the failure this
  section warns about. The provider capability axis measures the provider, not
  the task.
- Offline runs use a stub, not a provider. No real runtime was asked which
  segments are obsolete, so the provider-side premise is unvalidated.

**What would change the verdict.** A real OpenFox A/B run, same tasks and same
model, recording main-model input/output tokens, wall time, task success and
re-read/retries caused by missing context. Promote only if tokens fall *and*
task success is unchanged. Until then the setting stays off and no saving may
be claimed in the README, the registry description or a release note.

## 5. Promotion rules

Do not set universal probability thresholds in the provider layer.

Each use case must define:

- what result is actionable;
- uncertainty band;
- fallback behavior;
- what evidence remains mandatory.

Start conservative. Optimize thresholds only from measured cases.

## 6. Benchmark output

Prefer machine-readable JSONL or JSON plus a compact Markdown summary.

Suggested per-run shape:

```json
{
  "task": "fixture-or-task-id",
  "variant": "baseline|candidate",
  "openfoxVersion": "...",
  "mainModel": "...",
  "semanticProvider": "...",
  "semanticModel": "...",
  "wallMs": 0,
  "mainInputTokens": 0,
  "mainOutputTokens": 0,
  "mainCalls": 0,
  "verifierCalls": 0,
  "semanticCalls": 0,
  "fallbacks": 0,
  "taskSuccess": true,
  "falsePasses": 0,
  "notes": ""
}
```

Keep raw sensitive code/session content out of committed benchmark outputs unless it is intentionally public fixture data.

## 7. Initial question to answer

The first project-level decision is not "which System One model is best?"

It is:

> On which OpenFox decisions does a typed semantic call reduce total generative work without reducing task quality?

Provider comparison comes after that.
