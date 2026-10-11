import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_CONFIDENCE_THRESHOLD_PERCENT,
  MAX_CONFIDENCE_THRESHOLD,
  MIN_CONFIDENCE_THRESHOLD,
  resolveConfidenceThreshold,
} from '../src/relevance/threshold.ts'

/**
 * The threshold is the operator's dial: the one number that decides whether a
 * result is presented as usable or as a lead. It must be readable at call time
 * (A2-6), bounded (A2-5), and incapable of masking a failure (A2-9).
 */

test('the default threshold is 75 percent', () => {
  // The exported constant is in PERCENT, so it matches the registered settings
  // default exactly. A second literal in a description would drift silently.
  assert.equal(DEFAULT_CONFIDENCE_THRESHOLD_PERCENT, 75)
  assert.equal(resolveConfidenceThreshold({}), 0.75)
})

test('the threshold is bounded between 0 and 100 percent', () => {
  assert.equal(MIN_CONFIDENCE_THRESHOLD, 0)
  assert.equal(MAX_CONFIDENCE_THRESHOLD, 1)
})

test('an absent setting falls back to the default', () => {
  assert.equal(resolveConfidenceThreshold({}), DEFAULT_CONFIDENCE_THRESHOLD_PERCENT / 100)
  assert.equal(
    resolveConfidenceThreshold({ confidenceThreshold: undefined }),
    DEFAULT_CONFIDENCE_THRESHOLD_PERCENT / 100,
  )
})

test('a value between 1 and 2 is a typo, not 1.5 percent', () => {
  // Dividing 1.5 by 100 would silently produce a 1.5% dial, and every candidate
  // would then read "below" with no visible explanation. Clamp instead.
  assert.equal(resolveConfidenceThreshold({ confidenceThreshold: 1.5 }), MAX_CONFIDENCE_THRESHOLD)
  assert.equal(resolveConfidenceThreshold({ confidenceThreshold: 1.01 }), MAX_CONFIDENCE_THRESHOLD)
})

test('an explicit percentage above 100 percent is clamped, not rejected', () => {
  // A clamped dial is usable; a rejected one strands the operator with no
  // signal at all, and 100% simply means "mark everything as a lead".
  assert.equal(resolveConfidenceThreshold({ confidenceThreshold: 150 }), MAX_CONFIDENCE_THRESHOLD)
  assert.equal(resolveConfidenceThreshold({ confidenceThreshold: -20 }), MIN_CONFIDENCE_THRESHOLD)
})

test('fractional and percentage spellings are both accepted', () => {
  assert.equal(resolveConfidenceThreshold({ confidenceThreshold: 0.6 }), 0.6)
  assert.equal(resolveConfidenceThreshold({ confidenceThreshold: 60 }), 0.6)
  assert.equal(resolveConfidenceThreshold({ confidenceThreshold: 75 }), 0.75)
})

test('an unusable threshold value falls back to the default rather than throwing', () => {
  for (const bad of ['high', null, true, {}, [], Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      resolveConfidenceThreshold({ confidenceThreshold: bad }),
      DEFAULT_CONFIDENCE_THRESHOLD_PERCENT / 100,
      `confidenceThreshold=${JSON.stringify(bad)}`,
    )
  }
})

test('the setting is read on every call, so a change applies immediately', () => {
  let stored = 0.4
  const read = (): Record<string, unknown> => ({ confidenceThreshold: stored })
  assert.equal(resolveConfidenceThreshold(read()), 0.4)
  stored = 0.9
  assert.equal(resolveConfidenceThreshold(read()), 0.9)
})