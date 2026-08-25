/**
 * Managed-exit — the single close-out definition shared by the live engine and
 * the backtester. Marked with Black–Scholes at remaining time, so a credit
 * spread does NOT show full credit on entry.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runManagedExit, managedThresholds, markPnL } from '../src/engine/managedExit.js'
import { totalPnL } from '../src/engine/payoff.js'
import { readFileSync } from 'node:fs'
import { storedLegsToOptionLegs } from '../src/feedback/legAdapter.js'
import { toScannedLegs } from '../src/engine/oppScanner.js'
import type { StoredLeg } from '../src/feedback/types.js'
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

/**
 * FEEDBACK-LOOP CLOSURE: a snapshot's stored legs must settle on the same vol
 * surface the card was displayed with. Before this, `makeOpp` dropped `iv` when
 * building ScannedLeg, so every outcome was marked at one ATM sigma while the
 * card's POP/EV came from per-leg marking — the learning loop trained on exits
 * the displayed sim never produced.
 */
test('storedLegsToOptionLegs: round-trips per-leg iv, omits it when absent', () => {
  const stored = [
    { type: 'put' as const, action: 'sell' as const, strike: 276, premium: 2.015, quantity: 1, iv: 0.2389 },
    { type: 'call' as const, action: 'sell' as const, strike: 321, premium: 0.635, quantity: 1 }
  ]
  const legs = storedLegsToOptionLegs(stored)
  assert.equal(legs[0].iv, 0.2389)
  // Absent stays absent — markPnL must fall back to the context sigma for
  // pre-skew snapshots, i.e. behave exactly as before.
  assert.equal('iv' in legs[1], false)
})

test('feedback loop: stored per-leg iv reproduces the displayed mark, ATM does not', () => {
  // Real 2026-08-20 IWM condor. Marked at t=0 the P&L must be ~0 (you just paid
  // what it is worth). Stripping the stored IVs re-introduces the phantom loss.
  const stored = iwmCondor.map((l) => ({
    type: l.type, action: l.action, strike: l.strike,
    premium: l.premium, quantity: l.quantity, iv: l.iv
  }))
  const perLeg = markPnL(storedLegsToOptionLegs(stored), IWM_S, IWM_T, 0.04, 0.012, IWM_ATM)
  const atmOnly = markPnL(
    storedLegsToOptionLegs(stored.map(({ iv, ...rest }) => rest)),
    IWM_S, IWM_T, 0.04, 0.012, IWM_ATM
  )
  assert.ok(Math.abs(perLeg) < 0.05, `per-leg entry mark ${perLeg} should be ~0`)
  assert.ok(Math.abs(atmOnly) > 5 * Math.abs(perLeg), `ATM-only ${atmOnly} vs per-leg ${perLeg}`)
  // And the gap is material against the structure's own take-profit target.
  const tp = managedThresholds(0.8575).takeProfit
  assert.ok(Math.abs(atmOnly) > tp * 0.15, `phantom ${atmOnly} vs TP target ${tp}`)
})

/**
 * Same invariant, the SHADOW half of it. The tuner ranks arms on realized
 * outcomes, so an arm whose metrics came from a per-leg vol surface must also
 * be SETTLED on that surface. The shadow row used to be built by its own
 * inlined leg mapping that dropped `iv` — main cards learned correctly while
 * the tuner's evidence stayed ATM-marked. One shared `toScannedLegs` now feeds
 * both, and this walks the whole path: engine legs → ScannedLeg → StoredLeg →
 * back to OptionLeg → markPnL.
 */
test('scan → snapshot → outcome: the stored leg marks identically to the scan side', () => {
  const stored: StoredLeg[] = toScannedLegs(iwmCondor) // ScannedLeg is StoredLeg + optional iv
  const roundTripped = storedLegsToOptionLegs(stored)

  for (const S of [270, 297.67, 325]) {
    const scanSide = markPnL(iwmCondor, S, IWM_T, 0.04, 0.012, IWM_ATM)
    const learnSide = markPnL(roundTripped, S, IWM_T, 0.04, 0.012, IWM_ATM)
    assert.ok(
      Math.abs(scanSide - learnSide) < 1e-9,
      `S=${S}: scan ${scanSide} vs learning ${learnSide}`
    )
  }

  // And the thing that would silently break it: a dropped iv is NOT equivalent.
  const dropped = storedLegsToOptionLegs(stored.map(({ iv, ...l }) => l))
  assert.ok(
    Math.abs(markPnL(iwmCondor, 297.67, IWM_T, 0.04, 0.012, IWM_ATM) -
             markPnL(dropped, 297.67, IWM_T, 0.04, 0.012, IWM_ATM)) > 0.05,
    'dropping iv must visibly change the mark — otherwise this test proves nothing'
  )
})

test('oppScanner builds every snapshot leg through toScannedLegs (no inlined copy)', () => {
  // This exact bug shipped twice: makeOpp was fixed while the shadow push kept
  // its own inlined mapping. A structural check is the only thing that catches
  // a third copy appearing.
  const src = readFileSync(new URL('../src/engine/oppScanner.ts', import.meta.url), 'utf8')
  const inlined = src.match(/legs:\s*\w+\.legs\.map\(/g) ?? []
  assert.deepEqual(inlined, [], `inlined leg mapping found: ${inlined.join(', ')}`)
})

/**
 * VRP HARVEST: without `convergeTo` every leg stays marked at its ENTRY IV for
 * the whole path, so a seller who collected 28.9% on a name realizing 22.8%
 * never books the spread — at the close-out the residual time value is still
 * priced at 28.9%. Measured on the 2026-08-24 chain, that inversion made the
 * RICHEST name in the watchlist (XOM, +6.1pp of edge) score the WORST EV and
 * the thinnest (TLT, +1.2pp) the only positive one.
 */
test('convergeTo: decaying IV toward realized vol pays the seller, and only the seller', () => {
  const S = 297.67
  const short = [iwmCondor[0], iwmCondor[2]] // the two SOLD legs
  const ctxBase = { tauAt: (i: number) => Math.max(0, (43 - i) / 365), r: 0.04, q: 0.012 }
  // Mark the short strangle mid-window, with and without convergence.
  const mid = 20
  const flat = markPnL(short, S, ctxBase.tauAt(mid), 0.04, 0.012, IWM_ATM, 1)
  const conv = markPnL(short, S, ctxBase.tauAt(mid), 0.04, 0.012, IWM_ATM, 0.8)
  assert.ok(conv > flat, `converged mark ${conv} should beat flat ${flat} for a seller`)

  // The SAME ratio must hurt the long side by the same mechanism — otherwise
  // convergence is inventing money rather than moving it.
  const long = short.map((l) => ({ ...l, action: 'buy' as const }))
  const flatL = markPnL(long, S, ctxBase.tauAt(mid), 0.04, 0.012, IWM_ATM, 1)
  const convL = markPnL(long, S, ctxBase.tauAt(mid), 0.04, 0.012, IWM_ATM, 0.8)
  assert.ok(convL < flatL, `converged mark ${convL} should hurt the buyer vs ${flatL}`)
  assert.ok(Math.abs((conv - flat) + (convL - flatL)) < 1e-9, 'zero-sum across the trade')
})

test('convergeTo: no-op when the target is at or above the entry vol', () => {
  const path = Array.from({ length: 20 }, () => IWM_S)
  const base = { tauAt: (i: number) => Math.max(0, (43 - i) / 365), r: 0.04, q: 0.012,
    sigma: IWM_ATM, maxSteps: 20 }
  const none = runManagedExit(iwmCondor, path, 0.8575, base)
  // target == sigma, and target > sigma: both must leave the result untouched.
  for (const target of [IWM_ATM, IWM_ATM * 1.5]) {
    const r = runManagedExit(iwmCondor, path, 0.8575, { ...base, convergeTo: target })
    assert.equal(r.pnl, none.pnl, `convergeTo=${target} must be a no-op`)
    assert.equal(r.reason, none.reason)
  }
})

test('convergeTo: an earnings crush and convergence do not stack below the target', () => {
  // Both mechanisms model the SAME collapse. Composed naively they would mark
  // the position below the diffusion vol and pay the seller twice for it.
  const path = Array.from({ length: 20 }, () => IWM_S)
  const target = IWM_ATM * 0.6
  const base = { tauAt: (i: number) => Math.max(0, (43 - i) / 365), r: 0.04, q: 0.012,
    sigma: IWM_ATM, maxSteps: 20 }
  const crushOnly = runManagedExit(iwmCondor, path, 0.8575,
    { ...base, sigmaAt: (i) => (i >= 5 ? target : IWM_ATM) })
  const both = runManagedExit(iwmCondor, path, 0.8575,
    { ...base, sigmaAt: (i) => (i >= 5 ? target : IWM_ATM), convergeTo: target })
  // Convergence may only ADD decay before the crush lands, never after it.
  assert.ok(both.pnl >= crushOnly.pnl - 1e-9,
    `combined ${both.pnl} must not fall below crush-only ${crushOnly.pnl}`)
  const floored = markPnL(iwmCondor, IWM_S, base.tauAt(19), 0.04, 0.012, IWM_ATM, target / IWM_ATM)
  const combined = markPnL(iwmCondor, IWM_S, base.tauAt(19), 0.04, 0.012, IWM_ATM,
    Math.max((target / IWM_ATM) * (target / IWM_ATM), target / IWM_ATM))
  assert.equal(combined, floored, 'the floor pins the combined ratio at the target')
})

// The settlement engine must mark on the SCAN-TIME information set. An earlier
// revision aimed convergeTo at the holding window's realized vol, so a day-5
// mark already carried day-30's move — and take-profit/stop TIMING is exactly
// what the tuner learns from. A source check is the only way to catch it:
// the bug produced perfectly plausible numbers.
test('outcome: convergeTo uses scan-time vol, never the realized window', () => {
  const src = readFileSync(new URL('../src/feedback/outcome.ts', import.meta.url), 'utf8')
  const line = src.split('\n').find((l) => l.includes('convergeTo:'))
  assert.ok(line, 'outcome.ts must pass convergeTo')
  assert.ok(
    /deriveSimSigma\(\s*s\.iv\s*,\s*s\.rvAtScan/.test(line!),
    `convergeTo must be deriveSimSigma(s.iv, s.rvAtScan) — same target the card used; got: ${line!.trim()}`
  )
  assert.ok(
    !/\brv\b(?!AtScan)/.test(line!),
    `convergeTo must not reference the post-hoc realized vol \`rv\`: ${line!.trim()}`
  )
})

// The settlement engine must walk the SAME management window the card walked.
// Without maxSteps it defaulted to the bar count, and a calendar-day window
// holds ~5/7 as many trading bars — so learning ran a shorter window than the
// display AND, since `steps` drives the convergence schedule, decayed vol
// faster, moving take-profit/stop timing away from what the card showed.
test('outcome: passes the same managed horizon the card used', () => {
  const src = readFileSync(new URL('../src/feedback/outcome.ts', import.meta.url), 'utf8')
  const i = src.indexOf('runManagedExit(')
  assert.ok(i > 0, 'expected outcome.ts to run the shared managed exit')
  const call = src.slice(i, i + 2600)
  assert.match(
    call, /maxSteps:\s*managedHoldDays\(/,
    'outcome must bound the walk with managedHoldDays, not the raw bar count'
  )
})

test('managedExit: maxSteps shortens the walk and the convergence schedule', () => {
  const legs = storedLegsToOptionLegs([
    { type: 'put', action: 'sell', strike: 100, premium: 3, quantity: 1 },
    { type: 'put', action: 'buy', strike: 95, premium: 1, quantity: 1 }
  ] as any)
  const path = Array.from({ length: 30 }, () => 100)
  const ctx = {
    tauAt: (i: number) => Math.max(0, (60 - i) / 365),
    r: 0.045, q: 0, sigma: 0.4, convergeTo: 0.2
  }
  const long = runManagedExit(legs, path, 2, ctx)
  const short = runManagedExit(legs, path, 2, { ...ctx, maxSteps: 10 })
  assert.ok(short.exitIndex <= 9, `capped walk must stop inside maxSteps, got ${short.exitIndex}`)
  assert.notEqual(
    long.pnl, short.pnl,
    'a different horizon must actually change the result — otherwise the cap is inert'
  )
})
