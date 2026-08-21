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

/**
 * Regression — the IWM 2026-10-02 condor that surfaced this. The nearest level
 * to the short put 276 was 278.71 (ABOVE it) and to the short call 321 was
 * 303.95 (BELOW it). Nearest-in-either-direction paired each short with a level
 * that cannot defend it, and the sign-based label dressed that up as
 * "resistance" / "support".
 */
test('shortLegLevels: picks the DEFENDING side, not the nearest level', () => {
  const keyLevels = [
    { price: 262.0, touches: 4 },  // real support under the short put
    { price: 278.71, touches: 2 }, // above the put — cannot defend it
    { price: 303.95, touches: 2 }, // below the call — cannot defend it
    { price: 330.0, touches: 3 }   // real resistance over the short call
  ]
  const legs = [
    { type: 'put' as const, action: 'sell' as const, strike: 276, premium: 1.99, quantity: 1 },
    { type: 'call' as const, action: 'sell' as const, strike: 321, premium: 0.62, quantity: 1 }
  ]
  const sl = shortLegLevels(legs, keyLevels)

  const put = sl.find((x) => x.type === 'put')!
  assert.equal(put.side, 'support')
  assert.equal(put.level, 262.0, 'short put must take the level BELOW it, not 278.71')
  assert.ok(put.distPct !== null && put.distPct < 0)

  const call = sl.find((x) => x.type === 'call')!
  assert.equal(call.side, 'resistance')
  assert.equal(call.level, 330.0, 'short call must take the level ABOVE it, not 303.95')
  assert.ok(call.distPct !== null && call.distPct > 0)
})

test('shortLegLevels: no level on the defending side → null, never the wrong side', () => {
  // Only levels ABOVE the short put exist. Reporting 278.71 as "support" would
  // be a lie; the honest answer is "there is none".
  const keyLevels = [{ price: 278.71, touches: 4 }, { price: 290, touches: 3 }]
  const [put] = shortLegLevels(
    [{ type: 'put', action: 'sell', strike: 276, premium: 1.99, quantity: 1 }],
    keyLevels
  )
  assert.equal(put.side, 'support')
  assert.equal(put.level, null)
  assert.equal(put.distPct, null)
  assert.equal(put.touches, null)
})

test('shortLegLevels: `tested` still scans BOTH sides (pin risk ignores defence)', () => {
  // 278.71 cannot defend the 276 put, but sitting 1% under a 4-touch level is
  // exactly the contested placement the flag exists to warn about.
  const keyLevels = [{ price: 200, touches: 5 }, { price: 278.71, touches: 4 }]
  const [put] = shortLegLevels(
    [{ type: 'put', action: 'sell', strike: 276, premium: 1.99, quantity: 1 }],
    keyLevels
  )
  assert.equal(put.tested, true, 'nearest level is 1% away with 4 touches')
  assert.equal(put.contestedLevel, 278.71)
  assert.equal(put.level, 200, 'defending level is still the one below')
})
