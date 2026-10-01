import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Static guards for the agent E2E harness.
 *
 * These assert properties of the harness SOURCE that a live run can only show
 * by accident. They exist because two of the defects found in review were
 * exactly this shape: an isolation property that was assumed rather than
 * enforced, and a proof that looked real but was reading the wrong place.
 */
const PROJECT = resolve(import.meta.dirname, '..')
const E2E = resolve(PROJECT, 'scripts/agent-e2e.ts')
const source = readFileSync(E2E, 'utf8')

test('the host is pinned to loopback with the documented public override', () => {
  // `server.host` in config.json is only a FALLBACK: runServe resolves
  // `env.server.host ?? globalConfig.server.host`, so without OPENFOX_HOST the
  // host binds 0.0.0.0 and serves an unauthenticated API to the network.
  assert.match(source, /OPENFOX_HOST:\s*'127\.0\.0\.1'/)
})

test('the bind address is observed, not inferred from the banner', () => {
  // The banner only reports what the host believes about itself; the real
  // listener is read from the OS instead.
  assert.match(source, /execFile\('ss'/)
  assert.match(source, /loopback only/)
  // A run that is not loopback-only must abort, not continue and report success.
  assert.match(source, /not bound to loopback only/)
  // `[].every(...)` is `true` in JavaScript, so an empty listener list would
  // silently turn this guard into a no-op and let a LAN-exposed host pass.
  assert.match(
    source,
    /listener\.length > 0\s*&&/,
    'the loopback guard must require a NON-EMPTY listener list',
  )
})

test('the build spawn cannot escape cleanup on a missing binary', () => {
  // An 'error'-less ChildProcess raises an unhandled 'error' event, which kills
  // the process BEFORE try/finally and leaks the stubs and the temp tree.
  assert.match(source, /build\.once\('error'/)
})

test('an interrupted run exits instead of polling a dead host', () => {
  // Registering a signal handler suppresses Node's default terminate behaviour,
  // so the harness must exit explicitly once its children are signalled.
  assert.match(source, /process\.exit\(signal === 'SIGINT' \? 130 : 143\)/)
})

test('evidence is written into a directory created up front', () => {
  // benchmark/results/ is gitignored, so a mid-run writeFile before the mkdir
  // throws ENOENT and jumps to finally, losing report.json as well.
  const firstWrite = source.indexOf("observed-args.json")
  const mkdir = source.indexOf('const reportPath')
  assert.ok(mkdir >= 0 && firstWrite > mkdir, 'the report dir must be created before the first write')
  assert.equal(source.split('const reportPath').length - 1, 1, 'reportPath must be declared exactly once')
})

test('the child processes are tracked by PID and killed as a group', () => {
  // The host re-executes itself with a larger heap, so a kill aimed at the
  // direct child would leave a grandchild listening.
  assert.match(source, /detached:\s*true/)
  assert.match(source, /process\.kill\(-host!\.pid!/)
  assert.ok(
    !/pkill|killall/.test(source),
    'cleanup must never pattern-match processes, only the ones this run spawned',
  )
})

test('an interrupted run releases the children it started', () => {
  assert.match(source, /process\.once\('SIGINT'/)
  assert.match(source, /process\.once\('SIGTERM'/)
})

test('a scripted turn is never answered with a neighbour’s step', () => {
  // Per-turn routing: the queue is selected by the turn's own token, and an
  // unidentified turn gets an explicit placeholder instead of a plausible
  // answer, so a mis-sequenced turn fails loudly.
  assert.match(source, /queues\.get\(token\)|const token = String\(marker\?\.\[1\]/)
  assert.match(source, /E2E_NO_SCRIPT/)
  assert.ok(
    !/queues\.get\(WORKFLOW\)\s*\?\?\s*queues\.get\(WORKFLOW\)/.test(source),
    'there must be no shared-queue fallback',
  )
})

test('workflow steps cannot fall back to a shared queue', () => {
  // The advisory and verifier steps are host-driven and carry no turn token, so
  // each is matched by its own prompt and served from its OWN queue. A single
  // shared queue would let one step consume another’s script.
  assert.match(source, /ADVICE_STEP_MARKER[\s\S]{0,400}queues\.get\(WORKFLOW\)/)
  assert.match(source, /VERIFIER_STEP_MARKER[\s\S]{0,400}queues\.get\(VERIFIER\)/)
})

test('the verifier proof reads the verifier turn, not a global scan', () => {
  // A global `step_done` scan also matches the ADVISORY step, so it proves
  // nothing about the verifier. The result must come from the verifier's own
  // request chain.
  assert.match(source, /verifierTurnsWithScript/)
  assert.match(source, /consumed a real scripted answer \(not the no-script placeholder\)/)
  assert.match(source, /step_done issued by the verifier turn itself/)
})

test('a currentStepId projection is never used as the proof a step ran', () => {
  // The projection is a snapshot a poll can miss; it is recorded for
  // diagnostics only.
  const usesAsProof = /currentStepId[\s\S]{0,200}?\bok:\s*seen\.includes|seen\.includes\('normal-verifier'\)/.test(
    source,
  )
  assert.ok(!usesAsProof, 'a step must not be proven by its currentStepId projection')
})

test('the run never claims a quality, calibration or savings result', () => {
  assert.match(source, /NOT a quality, calibration, false-pass or impact measurement/)
  assert.ok(
    !/falsePassRate\s*[:=]\s*[0-9]/.test(source),
    'the harness must never report a measured false-pass rate',
  )
  assert.match(source, /measured:\s*false/)
})

test('the harness owns its cleanup and removes its temporary tree', () => {
  const finallyBlock = source.slice(source.indexOf('} finally {'))
  assert.match(finallyBlock, /rm\(root, \{ recursive: true, force: true \}\)/)
  assert.match(finallyBlock, /llm\?\.stop\(\)/)
  assert.match(finallyBlock, /systemOne\?\.stop\(\)/)
})
