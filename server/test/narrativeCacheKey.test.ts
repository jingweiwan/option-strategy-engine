/**
 * narrativeCacheKey — v2 (board-grounded) + empty/active split so a stand-aside
 * narrative and an active one don't clobber each other within a day.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { narrativeCacheKey, type MarketSnapshot } from '../src/ai/marketNarrative.js'

const snap = (board?: MarketSnapshot['board']): MarketSnapshot => ({
  asof: '', spy: { v: 0, chg: 0 }, vixy: { v: 0, chg: 0 }, ivRankMedian: 50, board
})

test('empty board keys to -standby; active and missing key to the base', () => {
  const active = narrativeCacheKey(snap({ qualifiedCount: 3 }))
  const empty = narrativeCacheKey(snap({ qualifiedCount: 0, emptyReason: 'x' }))
  const missing = narrativeCacheKey(snap(undefined))

  assert.ok(active.startsWith('narrative-v2-'), active)
  assert.ok(empty.endsWith('-standby'), empty)
  assert.ok(!active.endsWith('-standby'), active)
  assert.notEqual(active, empty)
  assert.equal(missing, active) // no board info → treat as active, not standby
})
