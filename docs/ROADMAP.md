# Roadmap

This roadmap exists to keep development sequential and evidence-driven.

## Phase 0 — bootstrap

Already present in the repository:

- project architecture;
- provider-neutral decision types;
- OpenFox settings scaffold;
- evaluation doctrine;
- provider/runtime landscape.

## Phase 1 — V0 primitive

Do these in order:

1. **#1 — generic System One HTTP adapter**
2. **#2 — OpenFox `semantic_decide` tool**
3. **#3 — reproducible evaluation harness**

Exit criteria:

- plugin installs in OpenFox;
- `semantic_decide` works against a configurable endpoint;
- `noul`, `choice`, `score` and batched questions work;
- errors fail safely;
- measurements can be recorded reproducibly.

Do not start workflow automation before this phase is stable.

## Phase 2 — interoperability and provider evidence

4. **#7 — System One conformance suite**
5. **#8 — provider presets / capability discovery**
6. **#9 — Jev vs Kev vs Laya vs jev-rs benchmark**
7. **#10 — explicit/bounded data egress policy**

These issues answer two architectural questions:

- Is one generic transport really sufficient?
- Which backend(s) are useful for OpenFox workloads?

Presets must remain thin. Provider benchmarks must use the same fixtures.

## Phase 3 — high-value OpenFox experiments

8. **#4 — semantic_verify_task**
9. **#5 — semantic_scan / semantic_search**
10. **#14 — plugin skills for semantic tool usage**
    - the skill source mechanism can be scaffolded after #2;
    - only expose guidance for higher-level tools once the corresponding tool exists and has useful evidence;
    - skills teach decision boundaries, not provider details.

Primary goal:

> reduce expensive generative work without losing task quality, then teach OpenFox when to use the proven semantic capabilities.

Promotion into normal agent usage requires measured results and the matching skill guidance.

## Phase 4 — conditional automation / optimization

11. **#12 — workflow integration for semantic_verify_task**
    - only after #4 demonstrates acceptable false-pass behavior.

12. **#11 — semantic decision cache**
    - only after correctness and provider identity/key semantics are stable.

13. **#6 — context relevance/message transforms**
    - only after the public message-transform API exists in a released OpenFox version.

These are deliberately conditional. They may be closed as not planned if evidence is weak.

## Phase 5 — distribution

14. **#13 — CI, packaging and first usable release**

A curated OpenFox registry submission should happen only after V0 is installable, tested and useful outside the author's machine.

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
