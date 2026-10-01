# Roadmap

This roadmap exists to keep development sequential and evidence-driven.

Current implementation and the adjusted delivery order are recorded in
[IMPLEMENTATION.md](./IMPLEMENTATION.md). Publication remains gated.

## Phase 0 — bootstrap

Already present in the repository:

- project architecture;
- provider-neutral decision types;
- OpenFox settings scaffold;
- evaluation doctrine;
- provider/runtime landscape.

## Phase 1 — V0 primitive

Done:

1. **#1 — generic System One HTTP adapter**
2. **#2 — OpenFox `semantic_decide` tool**
3. **#3 — reproducible evaluation harness**

Exit criteria, all met:

- plugin loads in OpenFox;
- `semantic_decide` works against a configurable endpoint;
- `noul`, `choice`, `score` and batched questions work;
- errors fail safely;
- measurements can be recorded reproducibly.

## Phase 2 — interoperability and provider evidence

4. **#7 — System One conformance suite**
5. **#8 — provider presets / capability discovery**
6. **#9 — Jev vs Kev vs Laya vs jev-rs benchmark**
7. **#10 — explicit/bounded data egress policy**

#7, #8 and #10 are implemented. Conformance is reproducible in CI against a
local stub; beyond that, one hosted live run exists, plus two live 7-case
`verify-0.2.1` campaigns against Kev and Laya that are **verification**
campaigns, not the conformance matrix. Those snapshots are not a quality
certification: dated comparison observations are scoped in #9, which remains
open, and no runtime is claimed better than another.

Presets must remain thin. Provider benchmarks must use the same fixtures.

## Phase 3 — high-value OpenFox experiments

8. **#4 — semantic_verify_task** — implemented as an advisory experiment; no
   false-pass measurement yet, so no positive verdict is reachable.
9. **#5 — semantic_scan / semantic_search** — implemented, advisory, candidates
   only.
10. **#14 — plugin skills for semantic tool usage** — both halves shipped:
    `semantic-verification` and `semantic-code-discovery`, each with the tools
    it describes. They teach decision boundaries, not provider details.

Primary goal:

> reduce expensive generative work without losing task quality, then teach OpenFox when to use the proven semantic capabilities.

Promotion into normal agent usage still requires measured results. Everything
today is opt-in and advisory.

## Phase 4 — conditional automation / optimization

11. **#12 — workflow integration for semantic_verify_task** — shipped as an
    **opt-in workflow file**, not as a plugin gate. The plugin registers no
    transition handler and no hook, and the workflow's deterministic checks and
    normal verifier always run. Making the agent that owns the step actually
    carry `semantic_verify_task` is an operator decision
    (`advisoryWorkflowFor(agentId)`).

12. **#11 — semantic decision cache** — shipped, disabled by default, inert on
    error. Stays off until a benchmark shows a real repeated-call benefit.

13. **#6 — context relevance/message transforms** — **blocked**. The
    `registerMessageTransform` API exists only on OpenFox `develop`; it is not
    in any released 2.0.0.x version (`v2.0.157` and `v2.0.160` were both
    checked against `src/plugin/index.ts`). Do not start before it ships in a
    release.

## Phase 5 — distribution

14. **#13 — CI, packaging and first usable release** — in progress. CI, the
    offline suite, the isolated-host harnesses and the install recipes are in
    place; the release tag and registry submission are the remaining steps and
    belong to the delivery workflow.

A curated OpenFox registry submission should happen only after this is
installable, tested and useful outside the author's machine.

## Dependency graph

```text
#1 System One adapter
   |
   +--> #2 semantic_decide
   |       |
   |       +--> #4 semantic_verify_task -----> #12 workflow integration
   |       |          \
   |       |           +--> #14 semantic-verification skill
   |       |
   |       +--> #5 semantic scan/search
   |       |          \
   |       |           +--> #14 semantic-code-discovery skill
   |       |
   |       +--> #14 skill-source scaffold
   |       |
   |       +--> #11 cache (later)
   |
   +--> #7 conformance -----> #8 presets
   |             |
   |             +---------> #9 provider benchmark
   |
   +--> #10 data egress policy

#3 evaluation harness --------> #4 / #5 / #9 / #11 / #12

OpenFox released message transforms -----> #6

#1 + #2 + #3 ---------------------------> #13 release
```

## Development rule for agents

When working autonomously:

- take one issue at a time;
- read dependencies first;
- do not implement downstream issues opportunistically;
- update tests/docs within the same issue;
- stop after delivery and report evidence;
- do not reinterpret an experimental issue as permission to enable an automatic gate.

The purpose of the roadmap is to prevent the plugin from becoming a collection of speculative features before its semantic primitive is proven useful.
