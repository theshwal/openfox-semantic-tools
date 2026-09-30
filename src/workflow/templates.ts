/**
 * Advisory workflow template, shipped as a real OpenFox workflow file.
 *
 * Issue #12 is explicitly conditional: it must not shorten a verification pass
 * until #4 has real-task results and an understood false-pass rate. Neither
 * exists yet, so this workflow **never skips anything**.
 *
 * The shape follows the OpenFox 2.0.160 workflow contract: a declarative state
 * machine with `metadata`, `entryStep`, `settings.maxIterations` and `steps`,
 * each step carrying an ordered transition list where the first match wins. The
 * file is valid as-is and can be copied to
 * `{projectDir}/.openfox/workflows/{id}.workflow.json`, or to
 * `{configDir}/workflows/` for a machine-local copy.
 *
 * Why it is safe:
 * - the deterministic checks run first, in a `shell` step that branches on the
 *   exit code, and a failure goes straight to the verifier as well;
 * - the semantic step is a sibling input, never a replacement, and its prompt
 *   forbids treating the result as a pass or a fail;
 * - every path reaches the normal verifier: there is no transition whose target
 *   skips it;
 * - no transition condition inspects a semantic status, so the workflow cannot
 *   branch on one even if a future tool returned a positive verdict.
 *
 * Removing the semantic step leaves the checks and the verifier intact, which is
 * what makes the opt-in safe.
 */

export interface WorkflowTransition {
  readonly when: Record<string, unknown>
  readonly goto: string
}

export interface AdvisoryWorkflowStep {
  readonly id: string
  readonly name: string
  readonly type: 'agent' | 'sub_agent' | 'shell' | 'user'
  readonly phase: 'build' | 'verification'
  readonly prompt?: string
  readonly command?: string
  readonly agentId?: string
  readonly subAgentType?: string
  readonly successExitCodes?: number[]
  readonly timeout?: number
  readonly transitions: readonly WorkflowTransition[]
}

export interface AdvisoryWorkflowFile {
  readonly metadata: {
    readonly id: string
    readonly name: string
    readonly description: string
    readonly version: string
  }
  readonly entryStep: string
  readonly settings: { readonly maxIterations: number }
  readonly steps: readonly AdvisoryWorkflowStep[]
  readonly startCondition: { readonly type: 'always' }
}

/**
 * The workflow file content. The id matches the filename convention
 * `{id}.workflow.json`, so the exported document is directly usable.
 */
export const ADVISORY_VERIFICATION_WORKFLOW: AdvisoryWorkflowFile = {
  metadata: {
    id: 'semantic-advisory-verification',
    name: 'Build, advise, verify',
    description:
      'Deterministic checks, an optional advisory semantic check, then the normal verifier. The semantic step never shortens verification.',
    version: '1.0.0',
  },
  entryStep: 'deterministic-checks',
  settings: { maxIterations: 20 },
  startCondition: { type: 'always' },
  steps: [
    {
      id: 'deterministic-checks',
      name: 'Deterministic checks',
      type: 'shell',
      phase: 'verification',
      command: 'npm run check',
      timeout: 600000,
      successExitCodes: [0],
      transitions: [
        // Both outcomes go to the advisory step; a failure is never short-circuited.
        { when: { type: 'always' }, goto: 'semantic-advice' },
      ],
    },
    {
      id: 'semantic-advice',
      name: 'Semantic advice',
      type: 'agent',
      phase: 'verification',
      agentId: 'builder',
      prompt: [
        'The deterministic checks have run. Their output is in {{stepOutput.stdout}} of the previous step.',
        '',
        '## 1. Load the guidance (if available)',
        'Call load_skill("semantic-verification") to read how and when to use the check. If it is not available, continue to step 2 without it.',
        '',
        '## 2. Call the check (only if it is in your allowed tools)',
        'Call the tool `semantic_verify_task` once, with arguments shaped like this:',
        '{',
        '  "criterionId": "ac-1",',
        '  "criterion": "<the acceptance criterion, verbatim>",',
        '  "issueId": "<issue reference, optional>",',
        '  "evidence": {',
        '    "summary": "<what was changed, one or two sentences>",',
        '    "diffExcerpts": ["<only the excerpts bearing on this criterion>"],',
        '    "deterministicTestResults": ["<the actual test output lines>"]',
        '  }',
        '}',
        'Quote real values from this session. Do not invent a criterion or evidence.',
        '',
        '## 3. Report, do not decide',
        'The tool returns an advisory status: unknown, needs-verification,',
        'insufficient-evidence or off-scope. It can return a positive status, and',
        'when it does it is a candidate for further checking, never a verdict.',
        'Do not treat any status as a pass or a fail. Do not fix anything here, do',
        'not skip or reorder a later step because of the result, and do not mark',
        'anything complete.',
        '',
        '## 4. If the tool is unavailable or fails',
        'If `semantic_verify_task` is not in your allowed tools, or the call fails,',
        'say so in one line and continue. This step must never block the workflow,',
        'and a missing semantic result is never a failure of this step.',
        '',
        'Then call step_done().',
      ].join('\n'),
      transitions: [{ when: { type: 'always' }, goto: 'normal-verifier' }],
    },
    {
      id: 'normal-verifier',
      name: 'Normal verifier',
      type: 'sub_agent',
      phase: 'verification',
      subAgentType: 'verifier',
      prompt: [
        'Verify the change with the normal process.',
        'Use the deterministic results and, if present, the semantic advice as one more input among others.',
        'The semantic advice is never sufficient on its own and must not shorten this verification.',
      ].join('\n'),
      transitions: [{ when: { type: 'always' }, goto: '$done' }],
    },
  ],
}

export function listAdvisoryWorkflows(): readonly AdvisoryWorkflowFile[] {
  return [ADVISORY_VERIFICATION_WORKFLOW]
}
