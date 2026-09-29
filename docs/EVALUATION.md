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
