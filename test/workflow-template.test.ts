import assert from 'node:assert/strict'
import test from 'node:test'

import { ADVISORY_VERIFICATION_WORKFLOW, advisoryWorkflowFor, listAdvisoryWorkflows } from '../src/workflow/templates.ts'
import { parseSettings } from '../src/settings.ts'
import { DEFAULT_POLICY, evaluateVerifyPolicy } from '../src/verify/policy.ts'

const template = ADVISORY_VERIFICATION_WORKFLOW

// The minimum a file needs for OpenFox to load it, per the 2.0.160 contract:
// a metadata.id and a non-empty steps array. Invalid files are silently skipped.
const SLUG = /^[a-z0-9-]+$/

test('the exported document is a loadable workflow file, not a placeholder', () => {
  assert.match(template.metadata.id, SLUG, 'the id must be a lowercase slug')
  assert.ok(template.metadata.name.length > 0)
  assert.ok(template.metadata.description.length > 0)
  assert.match(template.metadata.version, /^\d+\.\d+\.\d+$/)
  assert.ok(Array.isArray(template.steps) && template.steps.length > 0)
  assert.ok(Number.isInteger(template.settings.maxIterations) && template.settings.maxIterations > 0)
  // The entry step must exist, and every goto must resolve.
  const ids = new Set(template.steps.map((s) => s.id))
  assert.ok(ids.has(template.entryStep), 'entryStep must reference a real step')
  for (const step of template.steps) {
    assert.ok(step.transitions.length > 0, `${step.id} needs at least one transition`)
    for (const transition of step.transitions) {
      assert.equal(typeof transition.when.type, 'string', `${step.id}: condition must be typed`)
      assert.ok(
        transition.goto === '$done' || ids.has(transition.goto),
        `${step.id}: unresolved goto ${transition.goto}`,
      )
    }
    // Step ids are unique and the required base fields are present.
    assert.equal(typeof step.name, 'string')
    assert.ok(['build', 'verification', 'waiting', 'blocked', 'done'].includes(step.phase), step.id)
  }
  assert.equal(ids.size, template.steps.length, 'step ids must be unique')
})

test('the workflow is advisory: no transition inspects a semantic status', () => {
  // Even if a future tool returned a positive verdict, the graph could not
  // branch on it, because no condition reads a semantic result.
  for (const step of template.steps) {
    for (const transition of step.transitions) {
      const condition = JSON.stringify(transition.when)
      assert.ok(
        !/pass-candidate|needs-verification|insufficient-evidence|off-scope|semantic/i.test(condition),
        `${step.id}: a transition must not condition on a semantic status`,
      )
    }
  }
})

test('every path reaches the normal verifier', () => {
  // Walk the graph from the entry step: no reachable path may end before the
  // verifier, and no step may target only a terminal state.
  const byId = new Map(template.steps.map((s) => [s.id, s]))
  const seen = new Set<string>()
  const visit = (id: string): void => {
    if (id === '$done' || id === '$blocked' || seen.has(id)) return
    seen.add(id)
    for (const transition of byId.get(id)!.transitions) visit(transition.goto)
  }
  visit(template.entryStep)
  assert.ok(seen.has('normal-verifier'), 'the verifier must be reachable')
  // And nothing but the verifier may terminate the workflow.
  for (const step of template.steps) {
    const terminates = step.transitions.every((t) => t.goto === '$done' || t.goto === '$blocked')
    assert.equal(terminates, step.id === 'normal-verifier', `${step.id} must not terminate early`)
  }
})

test('the semantic step cannot block the workflow when the tool is unavailable', () => {
  const step = template.steps.find((s) => s.id === 'semantic-advice')!
  assert.equal(step.type, 'agent')
  assert.ok(step.prompt, 'the semantic step must carry a prompt')
  assert.match(step.prompt, /allowed tools/i)
  assert.match(step.prompt, /never block the workflow/i)
  // It targets the verifier unconditionally, so an agent that does nothing still
  // advances rather than stalling.
  assert.deepEqual(step.transitions, [{ when: { type: 'always' }, goto: 'normal-verifier' }])
})

test('the deterministic checks run in a shell step that branches on the exit code', () => {
  const step = template.steps.find((s) => s.id === 'deterministic-checks')!
  assert.equal(step.type, 'shell')
  assert.deepEqual(step.successExitCodes, [0])
  // A failing run still continues to the advice step, so nothing is short-circuited
  // and the verifier always runs.
  assert.deepEqual(step.transitions, [{ when: { type: 'always' }, goto: 'semantic-advice' }])
})

test('no prompt instructs a skip, a completion or a shortened verification', () => {
  for (const step of template.steps) {
    const text = (step.prompt ?? '').toLowerCase()
    for (const forbidden of [
      'skip the verifier',
      'skip verification',
      'mark complete',
      'mark as done',
      'task complete',
      'no longer needed',
      'accept without',
      'never shorten this verification',
    ].filter((phrase) => phrase !== 'never shorten this verification')) {
      assert.ok(!text.includes(forbidden), `${step.id} must not say "${forbidden}"`)
    }
    // The only shortening wording allowed is an explicit prohibition.
    assert.ok(!/skip|shorten/.test(text) || /not skip|never shorten|must not shorten/.test(text), step.id)
  }
})

test('the semantic step lists only reachable statuses and forbids a verdict', () => {
  const step = template.steps.find((s) => s.id === 'semantic-advice')!
  const prompt = step.prompt!
  for (const status of ['unknown', 'needs-verification', 'insufficient-evidence', 'off-scope']) {
    assert.ok(prompt.includes(status), `status ${status} must be listed`)
  }
  assert.ok(!prompt.includes('pass-candidate'), 'an unreachable status must not be offered')
  // The prompt is prose, so compare against a single-line form.
  const flat = prompt.replace(/\n\s*/g, ' ')
  // Tolerate a line break inside the phrase.
  assert.match(flat, /not treat any status as a pass or a fail/i)
  assert.match(flat, /do not mark anything complete/i)
})

test('the semantic step names the tool, its arguments and the skill', () => {
  const prompt = template.steps.find((s) => s.id === 'semantic-advice')!.prompt!
  // The tool must be named explicitly, not described vaguely.
  assert.ok(prompt.includes('semantic_verify_task'), 'the tool name must appear')
  // And the arguments must be constructible, not left to guesswork.
  for (const arg of ['criterionId', 'criterion', 'evidence', 'diffExcerpts', 'deterministicTestResults']) {
    assert.ok(prompt.includes(arg), `argument ${arg} must be shown`)
  }
  // The skill must be loaded on demand, and be optional.
  assert.ok(prompt.includes('load_skill("semantic-verification")'))
  assert.match(prompt, /If it is not available, continue/i)
  // The fallback must be explicit: unavailable or failed is not a failure.
  assert.match(prompt, /If .* is not in your allowed tools, or the call fails/i)
  assert.match(prompt, /never block the workflow/i)
})

test('scope: the prompt text is reviewed, not a runtime proof of the agent', () => {
  // Honest boundary. These tests assert what the file says, not what an agent
  // will do when it runs. The fallback behaviour of case 2 is therefore
  // specified and reviewable, but remains UNVERIFIED at runtime until a real
  // agent turn executes this workflow.
  const flat = ADVISORY_VERIFICATION_WORKFLOW.steps
    .map((s) => `${s.id} ${s.prompt ?? ''}`)
    .join(' ')
    .replace(/\n\s*/g, ' ')
  assert.ok(flat.includes('allowed tools'), 'the fallback is specified in the prompt')
  assert.ok(flat.includes('never block the workflow'), 'the fallback is specified in the prompt')
  // The structural guarantees ARE proven, because they live in the graph rather
  // than in prose: no transition condition mentions a semantic status.
  for (const step of ADVISORY_VERIFICATION_WORKFLOW.steps) {
    for (const transition of step.transitions) {
      assert.ok(
        !/semantic|pass|verdict|score/i.test(JSON.stringify(transition.when)),
        `${step.id}: no condition may branch on a semantic result`,
      )
    }
  }
})

test('the prompt does not claim a positive status is reachable today', () => {
  const flat = template.steps.find((s) => s.id === 'semantic-advice')!.prompt!.replace(/\n\s*/g, ' ')
  // The shipped policy is uncalibrated, so a positive status is unreachable.
  // The prompt must say so rather than implying it can happen.
  assert.match(flat, /A positive status is not reachable today/i)
  assert.match(flat, /uncalibrated/i)
  // And if a future calibration produced one, it is still only a candidate.
  assert.match(flat, /future calibration .* candidate for further checking/i)
  assert.ok(!/It can return a positive status/i.test(flat), 'must not imply it is possible now')
})

test('the workflow is listed and uniquely identified', () => {
  const workflows = listAdvisoryWorkflows()
  assert.equal(workflows.length, 1)
  assert.equal(new Set(workflows.map((w) => w.metadata.id)).size, workflows.length)
})

test('the advisory step agent is opt-in, because a stock agent cannot use the tool', () => {
  // The shipped default points at `builder`, which has no
  // `semantic_verify_task` in its allowedTools: the step then reports the tool
  // as unavailable and continues. That is safe, but it is NOT a silent
  // no-op the operator asked for, so the agent must be selectable.
  const defaultStep = ADVISORY_VERIFICATION_WORKFLOW.steps.find((s) => s.id === 'semantic-advice')
  assert.equal(defaultStep?.agentId, 'builder')

  const opted = advisoryWorkflowFor('reviewer-with-verification')
  const optedStep = opted.steps.find((s) => s.id === 'semantic-advice')
  assert.equal(optedStep?.agentId, 'reviewer-with-verification', 'the advisory agent must be selectable')

  // Only the advisory step changes. The deterministic and verifier steps are
  // what make the run safe, so they must be identical in both forms.
  for (const id of ['deterministic-checks', 'normal-verifier']) {
    assert.deepEqual(
      opted.steps.find((s) => s.id === id),
      ADVISORY_VERIFICATION_WORKFLOW.steps.find((s) => s.id === id),
      `${id} must not change between the default and opt-in forms`,
    )
  }
  // Every path must still reach the normal verifier after the substitution.
  assert.equal(opted.steps.length, ADVISORY_VERIFICATION_WORKFLOW.steps.length)
  assert.equal(opted.metadata.id, ADVISORY_VERIFICATION_WORKFLOW.metadata.id)
  assert.deepEqual(
    opted.steps.flatMap((s) => s.transitions.map((t) => t.when)),
    ADVISORY_VERIFICATION_WORKFLOW.steps.flatMap((s) => s.transitions.map((t) => t.when)),
    'no transition condition may change',
  )
})

test('an empty advisory agent leaves the shipped default untouched', () => {
  // Guarding the default: an empty value must not blank the field and produce an
  // invalid document.
  const step = advisoryWorkflowFor('').steps.find((s) => s.id === 'semantic-advice')
  assert.equal(step?.agentId, 'builder')
})

test('the advisory workflow is opt-in: it is never installed automatically', async () => {
  // There is deliberately no setting for it. A workflow is a file an operator
  // copies; a boolean that changed nothing would be a misleading placeholder.
  const { SETTINGS } = await import('../src/index.ts')
  assert.ok(
    !SETTINGS.fields.some((f) => f.key === 'workflowAdvisoryEnabled'),
    'an inert setting must not exist',
  )
  const fields = SETTINGS.fields.map((f) => f.key)
  assert.ok(!fields.some((k) => k.toLowerCase().includes('workflow')))
  // Installing is an explicit act, never a side effect of registration.
  assert.equal(DEFAULT_POLICY.calibrated, false, 'the policy stays uncalibrated')
})

test('the plugin registers no transition handler and no hook', async () => {
  // The templates are documentation. The plugin itself must not be able to
  // branch a workflow on a semantic result.
  const { register } = await import('../src/index.ts')
  const { fakeRegistry } = await import('./helpers/registry.ts')
  const fake = fakeRegistry()
  const registry = fake.registry as unknown as Record<string, unknown>
  register(fake.registry)
  // The fake records only what it implements; the plugin must not reach for
  // anything else, so a handler or hook registration would be impossible here.
  assert.equal(registry.registerTransitionHandler, undefined)
  assert.equal(registry.registerHook, undefined)
  assert.deepEqual([...fake.tools.keys()].sort(), [
    'semantic_calibration_candidate',
    'semantic_decide',
    'semantic_issue_coverage',
    'semantic_provider_self_test',
    'semantic_scan',
    'semantic_search',
    'semantic_verify_task',
  ])
})

test('a positive verdict is still unreachable, so no workflow can skip verification', () => {
  // The strongest possible answers must still not produce a pass, which is what
  // makes an advisory-only template the only safe integration today.
  // `criterionTestable` is part of the answer set since verify-0.3.0: leaving it
  // out would make the answer set unusable and prove nothing about the gate
  // that actually blocks the positive.
  const best = {
    criterionTestable: { type: 'noul', probability: 1 },
    satisfied: { type: 'noul', probability: 1 },
    evidenceSufficiency: { type: 'score', score: 2, probabilities: { 0: 0, 1: 0, 2: 1 } },
    offScope: { type: 'noul', probability: 0 },
    needsDeeperVerification: { type: 'noul', probability: 0 },
  }
  const decision = evaluateVerifyPolicy(best)
  assert.notEqual(decision.status, 'pass-candidate')
  assert.ok(decision.reasons.includes('policy_not_calibrated'))
})
