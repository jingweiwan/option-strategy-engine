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
const setup = (sym: string) => ({ sym, strategy: '铁鹰' })

test('empty / missing / active board all key distinctly', () => {
  const empty = narrativeCacheKey(snap({ qualifiedCount: 0, emptyReason: 'x' }))
  const missing = narrativeCacheKey(snap(undefined))
  const active = narrativeCacheKey(snap({ qualifiedCount: 2, setups: [setup('GOOGL'), setup('UNH')] }))
  assert.ok(empty.endsWith('-standby'), empty)
  assert.ok(missing.endsWith('-nb'), missing)
  assert.notEqual(empty, missing)
  assert.notEqual(active, empty)
  assert.notEqual(active, missing)
})

test('cache key follows the board contents — different setups → different key', () => {
  const spy = narrativeCacheKey(snap({ qualifiedCount: 1, setups: [setup('SPY')] }))
  const googlUnh = narrativeCacheKey(snap({ qualifiedCount: 2, setups: [setup('GOOGL'), setup('UNH')] }))
  // The exact bug: a narrative cached for "SPY" must not be served for "GOOGL, UNH".
  assert.notEqual(spy, googlUnh, 'board change within a day must bust the narrative cache')
  // Order-independent: same symbols → same key.
  const ab = narrativeCacheKey(snap({ qualifiedCount: 2, setups: [setup('AMZN'), setup('GOOGL')] }))
  const ba = narrativeCacheKey(snap({ qualifiedCount: 2, setups: [setup('GOOGL'), setup('AMZN')] }))
  assert.equal(ab, ba)
})
