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
// Marking at tau=0 == expiration intrinsic, so these reduce to totalPnL.
const intrinsic = { tauAt: () => 0, r: 0.045, q: 0, sigma: 0.3 }

test('managedThresholds: credit vs debit', () => {
  assert.deepEqual(managedThresholds(2), { takeProfit: 1, stop: 4 })
  assert.deepEqual(managedThresholds(-2), { takeProfit: 2, stop: 1 })
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

test('managedExit: maxSteps caps the window', () => {
  const r = runManagedExit(shortPut, [97, 94], 2, { ...intrinsic, maxSteps: 1 })
  assert.equal(r.reason, 'end_of_window')
  assert.equal(r.exitIndex, 0)
})

/**
 * Per-leg IV marking (skew). Premiums come from the real chain, which is
 * skewed; marking every leg at one ATM vol makes the position show a P&L before
 * anything has happened. Reproduces the IWM 2026-10-02 condor that surfaced it:
 * puts at ~24-25% IV, calls at ~15%, ATM 18.2%.
 */
const iwmCondor: OptionLeg[] = [
  { type: 'put', action: 'sell', strike: 276, premium: 2.015, quantity: 1, greeks: g(-0.154), iv: 0.2389 },
  { type: 'put', action: 'buy', strike: 270, premium: 1.435, quantity: 1, greeks: g(-0.111), iv: 0.2535 },
  { type: 'call', action: 'sell', strike: 321, premium: 0.635, quantity: 1, greeks: g(0.091), iv: 0.1525 },
  { type: 'call', action: 'buy', strike: 327, premium: 0.290, quantity: 1, greeks: g(0.046), iv: 0.1531 }
]
const IWM_S = 297.67
const IWM_T = 43 / 365
const IWM_ATM = 0.182

test('markPnL: per-leg IV kills the phantom entry P&L a flat ATM vol invents', () => {
  const stripped = iwmCondor.map(({ iv, ...l }) => l as OptionLeg)
  const flat = markPnL(stripped, IWM_S, IWM_T, 0.04, 0.012, IWM_ATM)
  const perLeg = markPnL(iwmCondor, IWM_S, IWM_T, 0.04, 0.012, IWM_ATM)

  // Flat ATM marking invents ~-0.105 at t=0 — 23% of this condor's own 0.463
  // take-profit target, before a single day passes.
  assert.ok(flat < -0.08, `flat-vol entry mark ${flat.toFixed(4)} should be materially negative`)
  // Per-leg marking prices each leg on the surface its premium came from; what
  // is left is only the execution-premium/mid residual, an order smaller.
  assert.ok(Math.abs(perLeg) < 0.02, `per-leg entry mark ${perLeg.toFixed(4)} should be ~0`)
  assert.ok(Math.abs(perLeg) < Math.abs(flat) / 5, 'per-leg must shrink the residual by >5x')
})

test('markPnL: legs without iv still fall back to the ATM sigma (no behaviour change)', () => {
  const noIv = iwmCondor.map(({ iv, ...l }) => l as OptionLeg)
  assert.equal(
    markPnL(noIv, IWM_S, IWM_T, 0.04, 0.012, IWM_ATM),
    markPnL(noIv, IWM_S, IWM_T, 0.04, 0.012, IWM_ATM, 1)
  )
})

test('markPnL: an insane leg iv is ignored in favour of the ATM sigma', () => {
  const bad = iwmCondor.map((l) => ({ ...l, iv: 0 }))
  const stripped = iwmCondor.map(({ iv, ...l }) => l as OptionLeg)
  assert.equal(
    markPnL(bad, IWM_S, IWM_T, 0.04, 0.012, IWM_ATM),
    markPnL(stripped, IWM_S, IWM_T, 0.04, 0.012, IWM_ATM)
  )
})

test('markPnL: volRatio crushes every strike proportionally, keeping skew shape', () => {
  // A 30% ATM crush must scale each leg's own vol by 0.7, not flatten them all
  // to one number — otherwise the wings lose their skew exactly at the event.
  const crushed = markPnL(iwmCondor, IWM_S, IWM_T, 0.04, 0.012, IWM_ATM, 0.7)
  const explicit = markPnL(
    iwmCondor.map((l) => ({ ...l, iv: l.iv! * 0.7 })),
    IWM_S,
    IWM_T,
    0.04,
    0.012,
    IWM_ATM
  )
  assert.ok(Math.abs(crushed - explicit) < 1e-9, 'volRatio must equal scaling each leg iv')
  // And a crush is good for a short-vol structure.
  assert.ok(crushed > markPnL(iwmCondor, IWM_S, IWM_T, 0.04, 0.012, IWM_ATM))
})
