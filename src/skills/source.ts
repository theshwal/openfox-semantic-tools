import type { PluginSkill, PluginSkillSource } from 'openfox/plugin'

/**
 * Usage-oriented skill guidance.
 *
 * Design rules enforced here:
 * - one skill per usage pattern, never one per tool;
 * - the description stays short because it sits in the permanent prompt, the
 *   detailed guidance loads only on demand;
 * - no provider name, endpoint, URL or model id ever appears in this text;
 * - the skill teaches a decision boundary, and never implies it grants access
 *   to a tool: plugin tools still require the agent's `allowedTools`.
 */
export const SKILL_SOURCE_ID = 'semantic-skills'

export const SEMANTIC_VERIFICATION_SKILL: PluginSkill = {
  id: 'semantic-verification',
  name: 'Semantic verification',
  description:
    'Use a bounded semantic check after deterministic tests pass to decide whether a deeper review of one acceptance criterion is still needed.',
  prompt: `## When to use this

Call \`semantic_verify_task\` after implementing a change and after its
deterministic checks (tests, typecheck, lint) have run, when:

- a single acceptance criterion is close to satisfied but the evidence is
  large enough that reading it end to end is expensive;
- the change touches several files and you want a second opinion on whether the
  criterion is really covered, not just plausibly touched;
- a previous attempt on the same criterion regressed and you need a focused
  re-check rather than a full re-verification.

## When NOT to use it

Do not call it when:

- the deterministic checks already fail: fix the failure first;
- the task is done and only a mechanical confirmation is needed;
- you have no code and no test output to show it;
- you need to decide on many criteria at once: it takes exactly one criterion
  per call, so batch of criteria means several calls;
- the question is answerable by reading a specific file or by grep.

## What to supply

The call takes one criterion and the evidence for it:

- \`criterionId\`: a stable id, e.g. the acceptance criterion number.
- \`criterion\`: the criterion text as written, not a paraphrase.
- \`issueId\`: optional, used only to label the report.
- \`evidence.summary\`: what was changed, in one or two sentences.
- \`evidence.diffExcerpts\`: only the excerpts that bear on this criterion.
- \`evidence.deterministicTestResults\`: the actual test output, not "tests pass".
- \`evidenceRefs\`: local file references for your own traceability. They are
  recorded in the report and are never transmitted.

Keep it bounded. Oversized evidence is rejected rather than truncated, so trim
your excerpts instead of relying on a cut.

## How to read the result

The result is always advisory. It never means the task is complete.

- \`unknown\`: the evidence is missing, inside the uncertainty band, or the
  policy is not calibrated. Treat it as "not decided".
- \`needs-verification\`: the criterion does not look satisfied, or a deeper
  pass is recommended. Fix it, or run the normal verifier.
- \`insufficient-evidence\`: the supplied evidence does not directly address
  the criterion. Gather better evidence before concluding anything.
- \`off-scope\`: the change touches behaviour unrelated to the criterion.
- \`pass-candidate\`: not currently reachable. It requires a measured
  calibration that does not exist yet.

A failed call (provider error, timeout, cancellation, blocked egress) is not a
negative verdict. It carries a code and nothing else.

## Limits you must keep

- This skill does not grant tool access. \`semantic_verify_task\` must also be
  listed in the agent's allowed tools; if it is not callable, this guidance is
  not usable and you should not try to work around that.
- It never replaces tests, typechecks or linters; those stay mandatory.
- It never replaces human review of a risky or security-relevant change.
- It cannot accept a task, close a criterion, or trigger completion on its own.
- It is a bounded opinion about one criterion from a small decision model. A
  confident-looking answer is not evidence.
- When the result is \`unknown\` or when you doubt it, use the normal
  verification path instead of arguing with the number.
`,
}

/**
 * `semantic-code-discovery` is intentionally NOT published here. It would guide
 * `semantic_search` / `semantic_scan`, which do not exist yet: exposing usage
 * guidance for a missing tool would advertise a capability the agent cannot
 * call. It ships with issue #5.
 */
export const SKILL_SOURCE: PluginSkillSource = {
  id: SKILL_SOURCE_ID,
  label: { en: 'Semantic tools', fr: 'Outils sémantiques' },
  load: () => [SEMANTIC_VERIFICATION_SKILL],
}
