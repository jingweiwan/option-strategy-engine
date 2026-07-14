/**
 * Key-level detection (technicals.computeKeyLevels) + short-strike proximity
 * (oppScanner.shortLegLevels):
 *   - an oscillating series surfaces clustered swing-high / swing-low levels
 *   - a short strike sitting on a well-tested level is flagged `tested`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeKeyLevels } from '../src/engine/technicals.js'
import { shortLegLevels } from '../src/engine/oppScanner.js'
import type { OhlcBar } from '../src/api/marketdata.js'

// Oscillates 90↔110 with ~20-bar period → repeated swing highs ~110, lows ~90.
const bars: OhlcBar[] = Array.from({ length: 120 }, (_, i) => {
  const close = 100 + 10 * Math.sin((i * 2 * Math.PI) / 20)
  return { date: `d${i}`, open: close, high: close + 1, low: close - 1, close, volume: 1000 }
})

test('computeKeyLevels: finds clustered resistance ~110 and support ~90', () => {
  const levels = computeKeyLevels(bars)
  assert.ok(levels.length >= 2, `expected ≥2 levels, got ${levels.length}`)
  const near = (p: number) => levels.some((l) => Math.abs(l.price - p) / p < 0.03)
  assert.ok(near(110), `no level near 110: ${levels.map((l) => l.price)}`)
  assert.ok(near(90), `no level near 90: ${levels.map((l) => l.price)}`)
  // Repeated pivots → touches accumulate above the ≥2 threshold.
  assert.ok(levels.every((l) => l.touches >= 2))
})

test('computeKeyLevels: too few bars → empty (no spurious levels)', () => {
  assert.deepEqual(computeKeyLevels(bars.slice(0, 8)), [])
})

test('shortLegLevels: short strike on a well-tested level is flagged tested', () => {
  const keyLevels = [{ price: 90, touches: 5 }, { price: 110, touches: 5 }]
  const legs = [
    { type: 'call' as const, action: 'sell' as const, strike: 108, premium: 1, quantity: 1 },
    { type: 'put' as const, action: 'sell' as const, strike: 92, premium: 1, quantity: 1 },
    { type: 'call' as const, action: 'buy' as const, strike: 120, premium: 0.2, quantity: 1 } // wing, ignored
  ]
  const sl = shortLegLevels(legs, keyLevels)
  assert.equal(sl.length, 2, 'only the two SHORT legs')
  const call = sl.find((x) => x.type === 'call')!
  assert.equal(call.level, 110)
  assert.ok(call.distPct > 0 && Math.abs(call.distPct - 1.85) < 0.2) // (110-108)/108
  assert.equal(call.tested, true) // within 3% AND touches ≥ 3
  const put = sl.find((x) => x.type === 'put')!
  assert.equal(put.level, 90)
  assert.ok(put.distPct < 0) // level below the strike
  assert.equal(put.tested, true)
})

test('shortLegLevels: far-from-level short is not flagged; no levels → empty', () => {
  const keyLevels = [{ price: 90, touches: 5 }, { price: 110, touches: 5 }]
  const far = shortLegLevels([{ type: 'call', action: 'sell', strike: 100, premium: 1, quantity: 1 }], keyLevels)
  assert.equal(far[0].tested, false) // 100 is 10% from either level
  assert.deepEqual(shortLegLevels([{ type: 'put', action: 'sell', strike: 95, premium: 1, quantity: 1 }], []), [])
})
