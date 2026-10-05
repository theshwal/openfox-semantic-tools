import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { loadManifest, summarize, type NormalizedVisualResult } from '../scripts/visual-spike-lib.ts'

const root = new URL('../', import.meta.url)

function readJson(relative: string): any {
  return JSON.parse(readFileSync(fileURLToPath(new URL(relative, root)), 'utf8'))
}

function isIgnored(relative: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', relative], { cwd: fileURLToPath(root) })
    return true
  } catch {
    return false
  }
}

// The contract's hard safety bar: a candidate must never receive credit for
// returning `success` on an ambiguous, blocked, error or auth-required case.
const UNSAFE_SUCCESS_STATES = new Set(['ambiguous', 'blocked', 'error', 'auth_required', 'unknown'])

const manifest = readJson('benchmark/visual/action-state-manifest.json')
const sidecar = readJson('benchmark/visual/action-state-sidecar.json')

test('action-state manifest is honest about its coverage', () => {
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.measured, true)
  assert.equal(manifest.status, 'partial-blocked')
  assert.equal(manifest.coverage.allImageHashesDistinct, true)
  assert.equal(manifest.coverage.allFilenamesDistinct, true)
})

test('every admitted case has a distinct full sha256 and a distinct filename', () => {
  const shas = manifest.cases.map((c: any) => c.sha256)
  const names = manifest.cases.map((c: any) => c.image)
  assert.equal(shas.length, new Set(shas).size)
  assert.equal(names.length, new Set(names).size)
  for (const sha of shas) assert.match(sha, /^[0-9a-f]{64}$/)
})

test('every case carries non-visual ground truth evidence from the OpenFox API', () => {
  assert.equal(sidecar.cases.length, manifest.cases.length)
  for (const c of sidecar.cases) {
    const evidence = c.source?.deterministicEvidence
    assert.ok(Array.isArray(evidence) && evidence.length > 0, `${c.id} has no deterministic evidence`)

    // At least one line per case must establish the label from a source that is
    // not the image: a named HTTP endpoint, the route, or a recorded backend
    // field. Other lines may describe what the pixels happen to show.
    const nonVisual = evidence.filter(
      (line: string) =>
        /\/api\//i.test(line) || /^route\b/i.test(line) || /session phase|workflow execution status/i.test(line),
    )
    assert.ok(
      nonVisual.length > 0,
      `${c.id} has no non-visual ground truth, only: ${evidence.join(' | ')}`,
    )
    assert.equal(c.sanitization.reviewed, true)
  }
})

test('every ambiguous case documents why the pixels cannot justify a verdict', () => {
  const unknown = sidecar.cases.filter((c: any) => c.state === 'unknown')
  assert.ok(unknown.length > 0)
  for (const c of unknown) {
    assert.ok(c.ambiguityNote && c.ambiguityNote.length > 20, `${c.id} lacks an ambiguity note`)
    assert.ok(c.source.derivedFrom, `${c.id} must record the frame it was cropped from`)
  }
})

test('a success answer on an unsafe state can never be scored as correct', () => {
  const unsafe: NormalizedVisualResult[] = ['blocked', 'error', 'auth_required', 'unknown'].map(
    (state) => ({
      caseId: `unsafe-${state}`,
      expected: state,
      answer: 'success',
      correct: false,
      malformed: false,
      latencyMs: 10,
      providerConfidence: 0.99,
      rawProbability: 0.99,
      model: 'm',
      backend: 'systemone',
      error: null,
    }),
  )
  for (const result of unsafe) {
    assert.notEqual(result.answer, result.expected, 'a success answer must not match a non-success label')
  }
  const summary = summarize(unsafe)
  // Every such case is a false-positive success and drags the rate off zero.
  assert.ok(summary.falsePositiveSuccessRate !== null && summary.falsePositiveSuccessRate > 0)
})

test('the measured gate run reports no false-positive success', () => {
  const run = readJson('benchmark/results/visual-action-state-openjev-2026-10-04.json')
  assert.equal(run.measured, true)

  const positives = run.results.filter((r: any) => r.answer === 'success')
  for (const r of positives) {
    assert.equal(
      r.expected,
      'success',
      `${r.caseId} answered success on a non-success state and must not be admitted as a GO`,
    )
  }

  assert.equal(run.summary.falsePositiveSuccessRate, 0)
})

test('no provider or malformed failure was silently turned into a positive answer', () => {
  const run = readJson('benchmark/results/visual-action-state-openjev-2026-10-04.json')
  for (const r of run.results) {
    if (r.malformed || r.error !== null) {
      assert.equal(r.answer, null, `${r.caseId} failed but still returned an answer`)
      assert.notEqual(r.answer, 'success')
    }
  }
  assert.equal(run.summary.malformed, 0)
})

test('the corpus records which contract states remain unreachable', () => {
  const byState = manifest.coverage.byState
  for (const state of ['processing', 'blocked', 'auth_required']) {
    assert.equal(byState[state].admitted, 0, `${state} must be reported as unacquired, not invented`)
    assert.ok(
      String(byState[state].reason).length > 20,
      `${state} must state why it could not be captured honestly`,
    )
  }
  assert.ok(String(manifest.acquisition.blocker.detail).length > 100)
})

test('the measured results are versionable so a review does not lose the evidence', () => {
  // The primary run and the calibration run are the evidence behind the DEFER
  // decision. If they fall under benchmark/results/ they would be silently
  // dropped from the PR, so the .gitignore exception must keep them trackable.
  for (const result of [
    'benchmark/results/visual-action-state-openjev-2026-10-04.json',
    'benchmark/results/visual-action-state-calibration-2026-10-04.json',
    'benchmark/results/visual-openjev-2026-10-03.json',
  ]) {
    assert.equal(isIgnored(result), false, `${result} must be versionable, not ignored`)
  }
})

test('the gitignore exception stays scoped to measured visual results', () => {
  // Nothing else under benchmark/results may be unlocked: local replays and
  // ad-hoc run output are still ignored.
  for (const local of [
    'benchmark/results/verify/replay.json',
    'benchmark/results/scratch.json',
    'benchmark/results/action-state-openjev.json',
  ]) {
    assert.equal(isIgnored(local), true, `${local} must stay ignored`)
  }
})

test('both measured runs record a complete and consistent provenance block', () => {
  for (const file of [
    'benchmark/results/visual-action-state-openjev-2026-10-04.json',
    'benchmark/results/visual-action-state-calibration-2026-10-04.json',
  ]) {
    const run = readJson(file)
    const p = run.provenance
    assert.ok(p, `${file} must carry a provenance block`)
    // Model identity: the alias that was actually sent, plus the runtime it
    // resolves to, so a reader is not left guessing which checkpoint ran.
    assert.equal(p.modelAlias, 'openjev-latest')
    assert.equal(p.modelRuntime, 'openjev-0.1')
    assert.equal(p.endpointClass, 'operator-supplied')
    assert.match(p.endpoint, /^https:\/\//)
    assert.match(p.imagePreprocessing, /no resize/i)
    assert.equal(p.captureViewport, '1440x900')
    assert.equal(p.sourceCommit, 'f18eef6')
    assert.ok(p.rerunCommand.includes('npm run visual:spike'))
    // The credential must be described as operator-supplied, never embedded.
    assert.match(p.credentialHandling, /never (read from this repository|persisted)/)
    // The merged baselines must be discoverable from the result itself.
    assert.ok(
      p.relatedBaselines.some((b: string) => b.includes('visual-qwen-2026-10-03.json')),
      `${file} must reference the merged Qwen baseline`,
    )
    assert.ok(p.relatedBaselines.some((b: string) => b.includes('visual-openjev-2026-10-03.json')))
  }
})

test('the primary run still carries the measured numbers untouched', () => {
  // The provenance work must never silently rewrite a measurement.
  const run = readJson('benchmark/results/visual-action-state-openjev-2026-10-04.json')
  assert.equal(run.results.length, manifest.coverage.admitted)
  assert.equal(run.summary.accuracy, 9 / 14)
  assert.equal(run.summary.falsePositiveSuccessRate, 0)
  assert.equal(run.summary.malformed, 0)
  assert.equal(run.summary.medianLatencyMs, 836)
  assert.equal(run.summary.p95LatencyMs, 2199)
  // Unmeasured stays unmeasured: the backend exposes no abstention channel.
  assert.equal(run.summary.unknownFallbackRate, null)
  for (const row of run.results) {
    assert.ok('rawProbability' in row)
    assert.ok('providerConfidence' in row)
  }
})

test('the closure document agrees with the recorded measurements', () => {
  const doc = readFileSync(fileURLToPath(new URL('docs/ACTION-STATE-GATE.md', root)), 'utf8')
  const run = readJson('benchmark/results/visual-action-state-openjev-2026-10-04.json')
  // Every headline number quoted in the document must match the stored result.
  assert.match(doc, new RegExp(`${run.summary.medianLatencyMs}`))
  assert.match(doc, new RegExp(`${run.summary.p95LatencyMs}`))
  assert.match(doc, /0\.64/)
  assert.match(doc, /14 of the 31/)
  // Coverage gaps stay explicit rather than being smoothed away.
  assert.match(doc, /processing/)
  assert.match(doc, /auth_required|authentication required/)
  assert.match(doc, /unknownFallbackRate` \| null/)
  // The DEFER decision, the resolved model runtime and the merged VLM
  // baseline must all be stated in the closure document.
  assert.match(doc, /Decision: \*\*DEFER\*\*/)
  assert.match(doc, /openjev-0\.1/)
  assert.match(doc, /Qwen3\.8-27B/)
})

// Every repository-relative path a result file or the closure document records
// must actually exist. A stale path silently breaks reproduction, which is the
// defect this check was added to prevent.
function repoPath(relative: string): string {
  return fileURLToPath(new URL(relative, root))
}

test('every path recorded in the result files exists on disk', () => {
  // Only these freeze keys are paths. `note` is prose and must not be probed.
  const PATH_KEYS = [
    'corpusManifest',
    'corpusCatalogue',
    'corpusSidecar',
    'calibrationCatalogue',
  ]
  for (const file of [
    'benchmark/results/visual-action-state-openjev-2026-10-04.json',
    'benchmark/results/visual-action-state-calibration-2026-10-04.json',
  ]) {
    const run = readJson(file)
    const paths: string[] = []
    if (typeof run.fixtureSource?.ref === 'string') paths.push(run.fixtureSource.ref)
    for (const key of PATH_KEYS) {
      const value = run.freeze?.[key]
      if (typeof value === 'string') paths.push(value)
    }
    assert.ok(paths.length > 0, `${file} records no paths at all`)
    for (const p of paths) {
      assert.ok(existsSync(repoPath(p)), `${file}: recorded path does not exist: ${p}`)
    }
  }
})

test('the recorded corpus manifest is the harness-loadable one, not the catalogue', async () => {
  // freeze.corpusManifest and fixtureSource.ref must both name a file the
  // harness can actually parse. The catalogue is an inventory, not an input.
  for (const [file, expected] of [
    ['benchmark/results/visual-action-state-openjev-2026-10-04.json', 'benchmark/visual/action-state-cases.json'],
    [
      'benchmark/results/visual-action-state-calibration-2026-10-04.json',
      'benchmark/visual/action-state-calibration-manifest.json',
    ],
  ] as const) {
    const run = readJson(file)
    assert.equal(run.fixtureSource.ref, expected, `${file}: fixtureSource.ref`)
    assert.equal(run.freeze?.corpusManifest, expected, `${file}: freeze.corpusManifest`)
    // And it must really load.
    const parsed = await loadManifest(repoPath(expected))
    assert.equal(parsed.cases.length, manifest.coverage.admitted)
  }
})

test('the document, freeze and fixtureSource name the same manifest', () => {
  const doc = readFileSync(fileURLToPath(new URL('docs/ACTION-STATE-GATE.md', root)), 'utf8')
  const run = readJson('benchmark/results/visual-action-state-openjev-2026-10-04.json')
  const manifestPath = run.fixtureSource.ref

  // The reproduction block and the summary table must quote the same manifest.
  assert.match(doc, new RegExp(`VISUAL_MANIFEST=${manifestPath.replace(/[/.]/g, '\\$&')}`))
  assert.ok(doc.includes(`\`${manifestPath}\``), 'the summary table must name the manifest path')

  // The catalogue is referenced under its own distinct name, never as the input.
  assert.ok(
    doc.includes('benchmark/visual/action-state-manifest.json'),
    'the catalogue must still be documented',
  )
})

test('the closure document links the dataset contract at its real location', () => {
  const doc = readFileSync(fileURLToPath(new URL('docs/ACTION-STATE-GATE.md', root)), 'utf8')
  const link = doc.match(/\]\((\.\.\/[^)]*ACTION-STATE-DATASET\.md)\)/)
  assert.ok(link, 'the document must link the dataset contract')
  const target = fileURLToPath(new URL(link[1]!, new URL('docs/', root)))
  assert.ok(existsSync(target), `dataset contract link does not resolve: ${link[1]}`)
})
