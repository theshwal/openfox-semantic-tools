import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SCORE_MEANS,
  buildRelevanceEnvelope,
  thresholdStatus,
  SCORE_UNVERIFIED_MEANS,
} from '../src/relevance/envelope.ts'

/**
 * The relevance envelope is the plugin's honesty contract with its caller.
 *
 * It answers four questions on every single result: what was looked at, what
 * was NOT looked at and why, what the number is worth, and what the number
 * does not guarantee. Criteria A1-1..A1-4 make those four answers mandatory
 * and non-optional, and A2-9 makes the threshold incapable of turning a
 * technical failure into a success.
 */

test(
  'the disclaimer is present on EVERY envelope, whatever number kind is used',
  () => {
    // A1-3: unconditional. The tempting shortcut is to blank the disclaimer
    // when there is no number to disclaim, so every number kind is asserted,
    // including the empty one.
    for (const numberKind of [
      'provider-confidence',
      'provider-score',
      'local-recall-score',
      'none',
    ] as const) {
      const envelope = buildRelevanceEnvelope({
        searched: { filesScanned: 3, candidatesScored: 2 },
        skipped: [],
        numberKind,
        threshold: 0.75,
      })
      assert.equal(
        envelope.caveats.scoreUnverifiedMeans,
        SCORE_UNVERIFIED_MEANS,
        `numberKind=${numberKind} must still carry the disclaimer`,
      )
      assert.ok(envelope.caveats.scoreUnverifiedMeans.length > 0, numberKind)
      assert.ok(envelope.caveats.coverageCaveat.length > 0, numberKind)
    }
    // And the number description is the only part that legitimately varies.
    const withNumber = buildRelevanceEnvelope({
      searched: { filesScanned: 1, candidatesScored: 1 },
      skipped: [],
      numberKind: 'provider-confidence',
      threshold: 0.75,
    })
    const withoutNumber = buildRelevanceEnvelope({
      searched: { filesScanned: 1, candidatesScored: 0 },
      skipped: [],
      numberKind: 'none',
      threshold: 0.75,
    })
    assert.equal(withNumber.caveats.scoreMeans, SCORE_MEANS)
    assert.notEqual(withoutNumber.caveats.scoreMeans, SCORE_MEANS)
  },
)

test('the disclaimer text is fixed and cannot vary per call site', () => {
  const first = buildRelevanceEnvelope({
    searched: { filesScanned: 1, candidatesScored: 1 },
    skipped: [],
    numberKind: 'provider-confidence',
    threshold: 0.75,
  })
  const second = buildRelevanceEnvelope({
    searched: { filesScanned: 9, candidatesScored: 0 },
    skipped: [{ path: 'a.ts', reason: 'too-large' }],
    numberKind: 'local-recall-score',
    threshold: 0.2,
  })
  assert.equal(first.caveats.scoreUnverifiedMeans, second.caveats.scoreUnverifiedMeans)
  assert.equal(first.caveats.scoreMeans, second.caveats.scoreMeans)
})

test('what was skipped is named per file with a reason, never a bare count', () => {
  const envelope = buildRelevanceEnvelope({
    searched: { filesScanned: 10, candidatesScored: 1 },
    skipped: [
      { path: 'big.ts', reason: 'too-large' },
      { path: 'logo.png', reason: 'binary' },
      { path: 'notes.md', reason: 'empty' },
    ],
    numberKind: 'provider-confidence',
    threshold: 0.75,
  })
  assert.equal(envelope.skipped.length, 3)
  for (const entry of envelope.skipped) {
    assert.match(entry.path, /\S/)
    assert.match(entry.reason, /\S/)
  }
  // The reasons are distinguishable, not one shared catch-all.
  assert.equal(new Set(envelope.skipped.map((e) => e.reason)).size, 3)
  // And every one of them is counted, so a bounded list never hides a total.
  assert.equal(envelope.skippedTotal, 3)
  assert.deepEqual(
    envelope.skippedByReason.map((r) => `${r.reason}=${r.count}`).sort(),
    ['binary=1', 'empty=1', 'too-large=1'],
  )
})

test('a long skip list is bounded but its counts stay exact', () => {
  // The walk can see thousands of files; naming each one would dominate the
  // result. Measured: 300 binary files produced ~11 KB around ONE candidate.
  const skipped = Array.from({ length: 300 }, (_, i) => ({
    path: `src/blob-${i}.bin`,
    reason: 'binary' as const,
  }))
  const envelope = buildRelevanceEnvelope({
    searched: { filesScanned: 301, candidatesScored: 1 },
    skipped,
    numberKind: 'provider-confidence',
    threshold: 0.75,
  })

  assert.equal(envelope.skippedTotal, 300, 'the total must stay exact')
  assert.equal(envelope.skippedTruncated, true)
  assert.equal(envelope.skipped.length, 10, 'the named list is capped')
  const bucket = envelope.skippedByReason[0]!
  assert.equal(bucket.count, 300)
  assert.equal(bucket.sample.length, 10)
  assert.equal(bucket.notShown, 290, 'the remainder is reported, not dropped')
})

test('an empty skipped list stays an explicit empty list, not undefined', () => {
  const envelope = buildRelevanceEnvelope({
    searched: { filesScanned: 2, candidatesScored: 1 },
    skipped: [],
    numberKind: 'provider-confidence',
    threshold: 0.75,
  })
  assert.deepEqual(envelope.skipped, [])
  assert.deepEqual(envelope.skippedByReason, [])
  assert.equal(envelope.skippedTotal, 0)
  assert.equal(envelope.skippedTruncated, false)
  assert.equal(envelope.searched.candidatesScored, 1)
})

test('threshold status classifies above, at, and below the threshold', () => {
  assert.equal(thresholdStatus(0.8, 0.75), 'above')
  assert.equal(thresholdStatus(0.75, 0.75), 'above')
  assert.equal(thresholdStatus(0.74, 0.75), 'below')
})

test('a missing number is never classified against the threshold', () => {
  // A1-9 / A2-9: an unavailable, unusable or unverified number must not be
  // turned into a pass by a permissive threshold. It stays "unknown".
  assert.equal(thresholdStatus(null, 0.75), 'unknown')
  assert.equal(thresholdStatus(null, 0), 'unknown')
})

test('the envelope reports the search scope and the coverage caveat together', () => {
  const envelope = buildRelevanceEnvelope({
    searched: { filesScanned: 120, candidatesScored: 1 },
    skipped: [],
    numberKind: 'provider-confidence',
    threshold: 0.75,
  })
  // B1-17: searched vs not-searched is explicit.
  assert.equal(envelope.searched.filesScanned, 120)
  assert.equal(envelope.searched.candidatesScored, 1)
  // B1-19: an empty result never reads as proof of absence.
  assert.match(envelope.caveats.coverageCaveat, /absence|empty/i)
  assert.match(envelope.caveats.coverageCaveat, /not|never/i)
})