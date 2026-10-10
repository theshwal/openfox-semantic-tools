### Summary

<!-- What does this PR do? Why? -->

Adds `openfox-semantic-tools` to the curated plugin registry.

The plugin contributes typed semantic **decision tools** (`semantic_decide`,
`semantic_verify_task`, `semantic_issue_coverage`, `semantic_search`,
`semantic_scan` and calibration helpers) that return `noul` / `choice` /
`score` probabilities from any System One-compatible HTTP endpoint, hosted or
local. It is provider-agnostic by design: the endpoint is configured by the
user, and a preset supplies defaults and *declared* capabilities only, never a
host.

Every tool is **advisory**. None replaces a test, a typecheck or a linter, and
none can mark a task complete. Provider errors, timeouts and malformed
responses return a structured failure instead of a positive result, and a data
egress policy blocks automatic remote calls before any request is sent.

The manifest declares an opt-in message transform (`semantic-context-reduce`),
which **is off by default and is explicitly unmeasured** — the recorded verdict
is DEFER in the project's `docs/EVALUATION.md`. The registry description says
so, and no token or cost saving is claimed anywhere.

Only `plugins-registry.json` is touched: one entry added, +8 lines.

### AI-Enhanced Development

Tell what models helped shape this PR:

- **AI Models:** this PR (registry entry, description and icon) was drafted with OpenFox (MiniMax-M3.1-Flash-Preview). The plugin itself was developed with OpenFox; its recorded benchmarks and verdicts are in its own repository.

_No AI used? Enter 'none'_

### Cache Impact

Does this PR affect anything cached — system prompts, tool definitions, skills, or other context?

- **No** — this PR adds one entry to the static registry list only. It changes no system prompt, tool definition, skill or cached context.