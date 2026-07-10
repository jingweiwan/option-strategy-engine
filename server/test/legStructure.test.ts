/**
 * validateLegStructure — the inverted-vertical guard (the HOOD bug):
 *   - a valid iron condor / credit spread / debit spread passes
 *   - an inverted vertical (spec wants the sell nearer the money, but it landed
 *     on the FARTHER strike → a "condor" call side that's really a bullish debit
 *     spread) is rejected
 * specs[i] ↔ legs[i] by construction (legsFromSpec builds them in order).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateLegStructure, type LegSpec } from '../src/engine/liveStrategies.js'
import type { OptionLeg } from '../src/engine/types.js'

const g = { delta: 0, gamma: 0, theta: 0, vega: 0 }
const leg = (type: 'call' | 'put', action: 'buy' | 'sell', strike: number): OptionLeg =>
  ({ type, action, strike, premium: 1, quantity: 1, greeks: g })

// Asymmetric condor spec (put 20Δ/10Δ, call 13Δ/7Δ) — matches the shipped spec.
const condorSpecs: LegSpec[] = [
  { type: 'put', action: 'sell', targetDelta: 0.2 },
  { type: 'put', action: 'buy', targetDelta: 0.1 },
  { type: 'call', action: 'sell', targetDelta: 0.13 },
  { type: 'call', action: 'buy', targetDelta: 0.07 }
]

test('valid iron condor passes', () => {
  const legs = [
    leg('put', 'sell', 92.5), leg('put', 'buy', 90),   // sell nearer (higher strike) ✓
    leg('call', 'sell', 110), leg('call', 'buy', 115)  // sell nearer (lower strike) ✓
  ]
  assert.equal(validateLegStructure(condorSpecs, legs), true)
})

test('inverted CALL side is rejected (the HOOD case: sell 150 / buy 135)', () => {
  const legs = [
    leg('put', 'sell', 99), leg('put', 'buy', 80),     // put side fine
    leg('call', 'sell', 150), leg('call', 'buy', 135)  // sell (0.13Δ) is HIGHER than buy → inverted
  ]
  assert.equal(validateLegStructure(condorSpecs, legs), false)
})

test('inverted PUT side is rejected', () => {
  const legs = [
    leg('put', 'sell', 80), leg('put', 'buy', 99),     // sell (0.20Δ) is LOWER than buy → inverted
    leg('call', 'sell', 110), leg('call', 'buy', 115)
  ]
  assert.equal(validateLegStructure(condorSpecs, legs), false)
})

test('valid debit spread (bull call: buy near, sell far) passes', () => {
  const specs: LegSpec[] = [
    { type: 'call', action: 'buy', targetDelta: 0.45 },
    { type: 'call', action: 'sell', targetDelta: 0.25 }
  ]
  // buy (0.45Δ, nearer) is the LOWER strike — correct.
  assert.equal(validateLegStructure(specs, [leg('call', 'buy', 100), leg('call', 'sell', 110)]), true)
  // inverted: buy landed on the higher strike → rejected.
  assert.equal(validateLegStructure(specs, [leg('call', 'buy', 110), leg('call', 'sell', 100)]), false)
})

test('valid credit spread (bull put: sell higher, buy lower) passes', () => {
  const specs: LegSpec[] = [
    { type: 'put', action: 'sell', targetDelta: 0.3 },
    { type: 'put', action: 'buy', targetDelta: 0.1 }
  ]
  assert.equal(validateLegStructure(specs, [leg('put', 'sell', 95), leg('put', 'buy', 85)]), true)
})

test('long straddle (one call + one put) has no vertical to order → passes', () => {
  const specs: LegSpec[] = [
    { type: 'call', action: 'buy', targetDelta: 0.5 },
    { type: 'put', action: 'buy', targetDelta: 0.5 }
  ]
  assert.equal(validateLegStructure(specs, [leg('call', 'buy', 100), leg('put', 'buy', 100)]), true)
})
