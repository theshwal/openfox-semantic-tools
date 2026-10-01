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

- \`unknown\`: the evidence is missing, inside the uncertainty band, the answer
  was not committed to, or the policy is not calibrated. Treat it as "not
  decided".
- \`needs-verification\`: the criterion does not look satisfied, or a deeper
  pass is recommended. Fix it, or run the normal verifier.
- \`insufficient-evidence\`: the supplied evidence does not directly address
  the criterion. Gather better evidence before concluding anything.
- \`off-scope\`: the change touches behaviour unrelated to the criterion.
- \`pass-candidate\`: reachable only when the operator has explicitly activated
  a calibration that marks the policy calibrated. It is still advisory and
  never means the task is complete.

A failed call (provider error, timeout, cancellation, blocked egress) is not a
negative verdict. It carries a code and nothing else.

## Provider calibration

When a provider/model or its version changed, or before relying on an active
calibration profile, use \`semantic_provider_self_test\` if that tool is allowed.
It uses embedded synthetic examples only and reports profile freshness, gate
ranges and fallback categories; it never changes settings.

\`semantic_calibration_candidate\` can turn an operator-owned labelled numeric
set into an inactive profile candidate. Treat that output as material for human
review: it does not invent thresholds, activate itself or prove model quality.

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
 * `semantic-code-discovery` guides the two discovery tools. It teaches a
 * decision boundary, not a workflow: the point is to reach the tool only when
 * it saves exploration, and to prefer deterministic tools otherwise.
 */
export const SEMANTIC_CODE_DISCOVERY_SKILL: PluginSkill = {
  id: 'semantic-code-discovery',
  name: 'Semantic code discovery',
  description:
    'Use semantic search and scoring only after narrowing candidates, to rank a short list of files. Prefer grep, symbols and tests when they already answer the question.',
  prompt: `## When to use these tools

Call \`semantic_search\` or \`semantic_scan\` when:

- you know the behaviour or concept but not where it lives, and text search
  returned nothing useful or too many candidates;
- you already have a short list of files and want to know which few deserve a
  read, instead of opening all of them;
- you want to check the same behavioural predicate over several candidates at
  once, for example whether an endpoint scopes its data.

## When NOT to use them

Do not call them when:

- grep, a symbol lookup, or reading a known file already answers the question;
- the answer is one or two deterministic tool calls away;
- a test, a linter or a typechecker already gives an exact answer;
- you have no candidate list yet. These tools rank what you give them. They do
  not search the repository, and they must never be used to sweep it.
## Supplying candidates

- \`candidates\`: relative paths, narrowed by deterministic search first. Keep
  the list short; the tool refuses an oversized list or oversized files rather
  than truncating them, because a cut file could hide the relevant code.
- \`query\` for \`semantic_search\`, \`predicate\` for \`semantic_scan\`: one clear
  question or behaviour, stated concretely.
- \`root\`: defaults to the session working directory. Paths outside it, and
  symbolic links, are refused.

## Reading the result

- \`candidates\` is a ranked list of **candidates**, each with the score, its
  distribution and its confidence. A high score means "read this first", not
  "this is correct".
- Entries with \`usable: false\` carry no score. The answer was missing,
  inconsistent or undecided. Do not treat them as relevant; read the file
  yourself instead.
- \`reasons\` explains why nothing was ranked, when that happens.
- A failed call is not a result. Fall back to normal code tools.

## Limits

- This skill does not grant tool access. \`semantic_search\` and \`semantic_scan\`
  must both be in the agent's allowed tools; if they are not callable, use
  deterministic tools.
- The result is advisory. It never accepts a task or closes a criterion.
- Ranking is not verification: always confirm a candidate by reading it and
  running the relevant tests.
- Keep the state small and relevant. Unrelated files in the list cost accuracy
  as well as tokens.
`,
}

export const SKILL_SOURCE: PluginSkillSource = {
  id: SKILL_SOURCE_ID,
  label: { en: 'Semantic tools', fr: 'Outils sémantiques' },
  load: () => [SEMANTIC_CODE_DISCOVERY_SKILL, SEMANTIC_VERIFICATION_SKILL],
}
