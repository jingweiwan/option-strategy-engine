/**
 * Simulator invariants — guard the Monte Carlo core and the earnings-jump
 * feature added on top of it. These are pure-math properties: determinism,
 * positivity, risk-neutral mean, and "the earnings jump must widen the
 * distribution". They protect against silent regressions in the part of the
 * code most people can't eyeball.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { simulatePrices } from '../src/engine/simulator.js'
import { earningsJumpSigma } from '../src/engine/index.js'
import { runManagedExit } from '../src/engine/managedExit.js'
import type { OptionLeg } from '../src/engine/types.js'

function stdev(xs: number[]): number {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  const v = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length
  return Math.sqrt(v)
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
function skewness(xs: number[]): number {
  const m = mean(xs)
  const sd = stdev(xs)
  const m3 = xs.reduce((a, b) => a + (b - m) ** 3, 0) / xs.length
  return m3 / sd ** 3
}
function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(p * s.length)]
}

const BASE = { S0: 100, sigma: 0.3, T: 0.25, r: 0.045, q: 0, simulations: 20000, seed: 7 }

test('simulator: shape, positivity, determinism', () => {
  const a = simulatePrices(BASE)
  const b = simulatePrices(BASE)
  assert.equal(a.length, BASE.simulations)
  assert.ok(a.every((x) => Number.isFinite(x) && x > 0), 'all prices finite and positive')
  assert.deepEqual(a, b, 'same seed must produce identical paths')
})

test('simulator: risk-neutral mean ≈ S0·e^((r-q)T)', () => {
  const paths = simulatePrices(BASE)
  const expected = BASE.S0 * Math.exp((BASE.r - BASE.q) * BASE.T)
  const got = mean(paths)
  assert.ok(Math.abs(got - expected) / expected < 0.02, `mean ${got.toFixed(2)} vs expected ${expected.toFixed(2)}`)
})

test('simulator: earnings jump widens the distribution but keeps the mean', () => {
  const withoutJump = simulatePrices(BASE)
  const withJump = simulatePrices({ ...BASE, earningsJump: 0.08 })

  // Wider dispersion when the event is present.
  assert.ok(stdev(withJump) > stdev(withoutJump), 'jump must increase stdev')

  // Mean preserved (jump multiplier is mean-1 / martingale).
  const m0 = mean(withoutJump)
  const m1 = mean(withJump)
  assert.ok(Math.abs(m1 - m0) / m0 < 0.02, `jump should not bias the mean (${m0.toFixed(2)} -> ${m1.toFixed(2)})`)
})

test('simulator: negative skew fattens the left tail, keeps the mean', () => {
  const symmetric = simulatePrices(BASE)
  const leftSkewed = simulatePrices({ ...BASE, skew: -0.8 })

  // Skew shifts the distribution's third moment downward.
  assert.ok(
    skewness(leftSkewed) < skewness(symmetric),
    `skewed (${skewness(leftSkewed).toFixed(3)}) should be more negative than symmetric (${skewness(symmetric).toFixed(3)})`
  )

  // Fatter left tail: the 1st-percentile outcome is lower (worse) under skew.
  assert.ok(
    percentile(leftSkewed, 0.01) < percentile(symmetric, 0.01),
    'left tail should be heavier with negative skew'
  )

  // Martingale preserved (EMS makes the mean exact regardless of shape).
  const expected = BASE.S0 * Math.exp((BASE.r - BASE.q) * BASE.T)
  assert.ok(Math.abs(mean(leftSkewed) - expected) / expected < 1e-9, 'mean must equal forward')
})

test('earningsJumpSigma: fires only inside [today, expiration], sized by iv vs simSigma', () => {
  const iv = 0.5
  const simSigma = 0.3
  const today = new Date('2026-05-29T12:00:00-04:00')
  const within = '2026-06-05' // before a 2026-06-19 expiry
  const expiration = '2026-06-19'

  // No date → no jump.
  assert.equal(earningsJumpSigma(iv, simSigma, expiration, undefined, today), 0)
  // Past earnings → no jump.
  assert.equal(earningsJumpSigma(iv, simSigma, expiration, '2026-05-01', today), 0)
  // After expiration → no jump.
  assert.equal(earningsJumpSigma(iv, simSigma, expiration, '2026-07-10', today), 0)

  // Inside window → market-implied magnitude sqrt((iv² − simSigma²)·T).
  const exp = new Date(expiration + 'T16:00:00-04:00').getTime()
  const T = (exp - today.getTime()) / (365 * 86_400_000)
  const got = earningsJumpSigma(iv, simSigma, expiration, within, today)
  const expected = Math.sqrt((iv * iv - simSigma * simSigma) * T)
  assert.ok(Math.abs(got - expected) < 1e-9, `expected ${expected}, got ${got}`)

  // No event premium (iv ≤ simSigma) → no jump, even inside the window.
  assert.equal(earningsJumpSigma(0.3, 0.3, expiration, within, today), 0)
  assert.equal(earningsJumpSigma(0.25, 0.4, expiration, within, today), 0)
})

test('IV crush (sigmaAt): rewards the premium seller, punishes the vol buyer', () => {
  const g = { delta: 0, gamma: 0, theta: 0, vega: 0 }
  const path = [100, 100, 100, 100, 100] // flat through the earnings step
  const base = { tauAt: (i: number) => Math.max(0, (20 - (i + 1)) / 365), r: 0.045, q: 0, maxSteps: 5 }
  const crushAt = (i: number) => (i >= 1 ? 0.3 : 0.6) // IV halves after the earnings step

  // Short OTM call that survives the (no-)move: crush collapses its extrinsic →
  // the seller marks a bigger gain than at the constant elevated IV.
  const shortCall: OptionLeg[] = [{ type: 'call', action: 'sell', strike: 110, premium: 2, quantity: 1, greeks: g }]
  const sNo = runManagedExit(shortCall, path, 2, { ...base, sigma: 0.6 }, 'runner').pnl
  const sCrush = runManagedExit(shortCall, path, 2, { ...base, sigma: 0.6, sigmaAt: crushAt }, 'runner').pnl
  assert.ok(sCrush > sNo, `seller: crush ${sCrush} should beat no-crush ${sNo}`)

  // Long straddle with no move: crush guts its extrinsic → the buyer marks worse.
  const straddle: OptionLeg[] = [
    { type: 'call', action: 'buy', strike: 100, premium: 4, quantity: 1, greeks: g },
    { type: 'put', action: 'buy', strike: 100, premium: 4, quantity: 1, greeks: g }
  ]
  const lNo = runManagedExit(straddle, path, -8, { ...base, sigma: 0.6 }, 'runner').pnl
  const lCrush = runManagedExit(straddle, path, -8, { ...base, sigma: 0.6, sigmaAt: crushAt }, 'runner').pnl
  assert.ok(lCrush < lNo, `buyer: crush ${lCrush} should trail no-crush ${lNo}`)
})

test('R4: stop-loss slips PAST −stop on a gap, but only by STOP_GAP_SLIP of the overshoot', () => {
  const g = { delta: 0, gamma: 0, theta: 0, vega: 0 }
  // Short 100 call, $3 credit. tau=0 → intrinsic mark: P&L = 3 − max(0, S−100).
  const shortCall: OptionLeg[] = [{ type: 'call', action: 'sell', strike: 100, premium: 3, quantity: 1, greeks: g }]
  const ctx = { tauAt: () => 0, r: 0.045, q: 0, maxSteps: 2 } // credit 3 → 2× stop = −6

  // Gap: day0 S=105 (P&L −2, fine) → day1 S=115 (mark −12, blew through −6).
  // Realized = −stop − SLIP·overshoot = −6 − 0.35·(−6−(−12)) = −6 − 0.35·6 = −8.1.
  const gap = runManagedExit(shortCall, [105, 115], 3, ctx, 'managed')
  assert.equal(gap.reason, 'stop_loss')
  assert.ok(gap.pnl < -6 && gap.pnl > -12, `gap fill ${gap.pnl} must be between −stop and the full mark`)
  assert.ok(Math.abs(gap.pnl - -8.1) < 1e-9, `gap should fill at −8.1 (35% overshoot), got ${gap.pnl}`)

  // Smooth touch: day1 S=109 → mark exactly −6 → no overshoot → fills at −6.
  const smooth = runManagedExit(shortCall, [105, 109], 3, ctx, 'managed')
  assert.equal(smooth.reason, 'stop_loss')
  assert.ok(Math.abs(smooth.pnl - -6) < 1e-9, `smooth should fill at −6, got ${smooth.pnl}`)
})
