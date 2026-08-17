/**
 * Feedback-degradation surfacing.
 *
 * The snapshot-safety fix stops a corrupt book from being OVERWRITTEN, but the
 * best-effort load sites still fall back to neutral defaults so a scan can run.
 * That fallback used to be silent, which is how an emptied book let
 * hard-disabled strategies (long_straddle at 0×) back onto the board unnoticed.
 * These lock in that the degradation is recorded and clearable.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  noteFeedbackLoadFailure,
  clearFeedbackLoadFailure,
  feedbackDegradations
} from '../src/feedback/health.js'

function reset() {
  clearFeedbackLoadFailure('calibration')
  clearFeedbackLoadFailure('tuner')
}

test('a failed load is recorded with its source and message', () => {
  reset()
  noteFeedbackLoadFailure('calibration', new Error('snapshots.json is corrupt'))
  const d = feedbackDegradations()
  assert.equal(d.length, 1)
  assert.equal(d[0].what, 'calibration')
  assert.match(d[0].message, /corrupt/)
  assert.ok(Date.parse(d[0].at) > 0, 'timestamped')
  reset()
})

test('sources are tracked independently and de-duplicated', () => {
  reset()
  noteFeedbackLoadFailure('calibration', new Error('a'))
  noteFeedbackLoadFailure('tuner', new Error('b'))
  noteFeedbackLoadFailure('calibration', new Error('c')) // replaces, not appends
  const d = feedbackDegradations()
  assert.equal(d.length, 2)
  assert.equal(d.find((x) => x.what === 'calibration')!.message, 'c')
  reset()
})

test('a later success clears only its own source', () => {
  reset()
  noteFeedbackLoadFailure('calibration', new Error('a'))
  noteFeedbackLoadFailure('tuner', new Error('b'))
  clearFeedbackLoadFailure('calibration')
  const d = feedbackDegradations()
  assert.deepEqual(d.map((x) => x.what), ['tuner'])
  reset()
})

test('clean state reports nothing (banner stays hidden)', () => {
  reset()
  assert.deepEqual(feedbackDegradations(), [])
})

test('non-Error throwables still record a message', () => {
  reset()
  noteFeedbackLoadFailure('tuner', 'plain string failure')
  assert.match(feedbackDegradations()[0].message, /plain string failure/)
  reset()
})
