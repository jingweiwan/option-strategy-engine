/**
 * Managed-exit — the single close-out definition shared by the live engine and
 * the backtester. Marked with Black–Scholes at remaining time, so a credit
 * spread does NOT show full credit on entry.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runManagedExit, managedThresholds, markPnL } from '../src/engine/managedExit.js'
import { totalPnL } from '../src/engine/payoff.js'
import type { OptionLeg } from '../src/engine/types.js'

const g = (delta: number) => ({ delta, gamma: 0, theta: 0, vega: 0 })
const shortPut: OptionLeg[] = [
  { type: 'put', action: 'sell', strike: 100, premium: 2, quantity: 1, greeks: g(-0.3) }
]
// Defined-risk put credit spread: net credit 2, width 10, maxLoss 8. At S=94 it
// marks −4 (== the old 2× stop) but the long 90 wing caps the loss at −8.
const putCreditSpread: OptionLeg[] = [
  { type: 'put', action: 'sell', strike: 100, premium: 3, quantity: 1, greeks: g(-0.3) },
  { type: 'put', action: 'buy', strike: 90, premium: 1, quantity: 1, greeks: g(-0.1) }
]
// Marking at tau=0 == expiration intrinsic, so these reduce to totalPnL.
const intrinsic = { tauAt: () => 0, r: 0.045, q: 0, sigma: 0.3 }

test('managedThresholds: credit vs debit', () => {
  assert.deepEqual(managedThresholds(2), { takeProfit: 1, stop: 4 })
  assert.deepEqual(managedThresholds(-2), { takeProfit: 2, stop: 1 })
})

test('managedThresholds: defined-risk credit (long wing) → 75% TP, no stop', () => {
  assert.deepEqual(
    managedThresholds(2, 'managed', putCreditSpread),
    { takeProfit: 1.5, stop: Infinity }
  )
})

test('managedThresholds: undefined-risk credit (naked, no long wing) keeps 50% / 2× stop', () => {
  assert.deepEqual(managedThresholds(2, 'managed', shortPut), { takeProfit: 1, stop: 4 })
})

test('markPnL at tau=0 equals expiration intrinsic (totalPnL)', () => {
  for (const S of [88, 95, 100, 110]) {
    assert.equal(markPnL(shortPut, S, 0, 0.045, 0, 0.3), totalPnL(shortPut, S))
  }
})

test('markPnL: an OTM credit spread is ~flat at entry, NOT full credit', () => {
  // sell 95 put / buy 90 put, spot 100, ~30 DTE, vol 30% → entry mark near 0
  const spread: OptionLeg[] = [
    { type: 'put', action: 'sell', strike: 95, premium: 1.6, quantity: 1, greeks: g(-0.3) },
    { type: 'put', action: 'buy', strike: 90, premium: 0.7, quantity: 1, greeks: g(-0.15) }
  ]
  const entry = markPnL(spread, 100, 30 / 365, 0.045, 0, 0.3)
  assert.ok(Math.abs(entry) < 0.4, `entry mark ${entry.toFixed(3)} should be ~0, not the ~0.9 credit`)
})

test('managedExit (intrinsic ctx): take-profit / stop / end-of-window', () => {
  assert.equal(runManagedExit(shortPut, [100, 99], 2, intrinsic).reason, 'take_profit')
  const sl = runManagedExit(shortPut, [97, 94], 2, intrinsic)
  assert.equal(sl.reason, 'stop_loss')
  assert.equal(sl.pnl, -4)
  const eow = runManagedExit(shortPut, [97, 96, 95], 2, intrinsic)
  assert.equal(eow.reason, 'end_of_window')
  assert.equal(eow.pnl, -3)
})

test('managedExit: defined-risk credit rides a drawdown that would have stopped', () => {
  // At S=94 the spread marks −4 (== old 2× stop). No-stop rule holds; the
  // recovery to S=98 exits flat at end-of-window instead of locking −4.
  const held = runManagedExit(putCreditSpread, [94, 98], 2, intrinsic)
  assert.equal(held.reason, 'end_of_window')
  assert.equal(held.pnl, 0)
  // Contrast: the runner policy retains the 2× stop, so the same path stops out.
  const stopped = runManagedExit(putCreditSpread, [94, 98], 2, intrinsic, 'runner')
  assert.equal(stopped.reason, 'stop_loss')
  assert.equal(stopped.pnl, -4)
})

test('managedExit: defined-risk credit takes profit at 75% of the credit', () => {
  const tp = runManagedExit(putCreditSpread, [101], 2, intrinsic)
  assert.equal(tp.reason, 'take_profit')
  assert.equal(tp.pnl, 1.5)
})

test('managedExit: maxSteps caps the window', () => {
  const r = runManagedExit(shortPut, [97, 94], 2, { ...intrinsic, maxSteps: 1 })
  assert.equal(r.reason, 'end_of_window')
  assert.equal(r.exitIndex, 0)
})
