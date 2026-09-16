/**
 * Two board gates that sit AFTER the vol/geometry gates in boardTierDecision,
 * plus the breakeven bar the card shows.
 *
 *   negative_at_market_vol — the published EV rides a VRP bet (paths and marks at
 *     simSigma, below the sold IV). marketVolCheck re-scores the same legs at the
 *     market's price of vol. EV ≤ 0 there means the bet IS the edge → reference.
 *     2026-09 XLE/XOM cards were +EV published and −EV at market vol, and still
 *     sat on the board.
 *   illiquid — GS 1090/1110C passed every per-leg liquidity check (spreads 26%,
 *     OI 21/17) while one round trip cost 210% of the credit.
 *
 * requiredWinRate — the card showed 1 − credit/width, the bar for a trade that
 * banks the WHOLE credit. The user's rule takes 75%, so the true bar is higher.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boardTierDecision, ROUND_TRIP_SPREAD_CEILING } from '../src/engine/oppScanner.js'
import { structureLiquidity } from '../src/engine/liveStrategies.js'
import { requiredWinRate } from '../src/engine/managedExit.js'
import type { OptionLeg } from '../src/engine/types.js'

const G = { delta: 0, gamma: 0, theta: 0, vega: 0 }
const RICH = { ivr: 55, iv: 0.4, rv: 0.3, spansEarnings: false, creditWidth: 0.2 }
const LIQUID = { roundTripSpreadPct: 0.1, minOpenInterest: 5000 }

test('market-vol EV ≤ 0 demotes an otherwise-qualified condor', () => {
  const d = boardTierDecision('iron_condor', { ...RICH, marketEv: -0.12, liquidity: LIQUID })
  assert.deepEqual(d, { tier: 'reference', reason: 'negative_at_market_vol' })
  // Exactly zero is not an edge either.
  assert.equal(boardTierDecision('bull_put_spread', { ...RICH, marketEv: 0 }).reason, 'negative_at_market_vol')
})

test('market-vol EV > 0, or check not run (null), leaves it qualified', () => {
  assert.equal(boardTierDecision('iron_condor', { ...RICH, marketEv: 0.05, liquidity: LIQUID }).tier, 'qualified')
  assert.equal(boardTierDecision('iron_condor', { ...RICH, marketEv: null, liquidity: LIQUID }).tier, 'qualified')
  assert.equal(boardTierDecision('iron_condor', RICH).tier, 'qualified')
})

test('the new gates never rescue or relabel an earlier demotion / drop', () => {
  const thin = boardTierDecision('iron_condor', { ...RICH, iv: 0.3, rv: 0.3, marketEv: -1, liquidity: { roundTripSpreadPct: 9, minOpenInterest: 0 } })
  assert.equal(thin.reason, 'vol_not_rich')
  const spans = boardTierDecision('iron_condor', { ...RICH, spansEarnings: true, marketEv: 1 })
  assert.equal(spans.tier, null)
})

test('market-vol gate is sell-vol only; debit spreads ignore marketEv', () => {
  assert.equal(boardTierDecision('bull_call_spread', { ...RICH, marketEv: -1 }).tier, 'qualified')
})

test('illiquid: round trip above the ceiling (GS 1090/1110C, 210%)', () => {
  const wide = boardTierDecision('bear_call_spread', {
    ...RICH, marketEv: 0.3, liquidity: { roundTripSpreadPct: 2.1, minOpenInterest: 17 }
  })
  assert.deepEqual(wide, { tier: 'reference', reason: 'illiquid' })
  // At the ceiling it still boards.
  const edge = boardTierDecision('iron_condor', {
    ...RICH, liquidity: { roundTripSpreadPct: ROUND_TRIP_SPREAD_CEILING, minOpenInterest: 5000 }
  })
  assert.equal(edge.tier, 'qualified')
})

test('thin open interest alone does not demote a tightly quoted structure', () => {
  // 2026-09-14 scan: SPY 10/30 put spread round trip 5.6% with thinnest OI 99,
  // IWM 10/30 call spread 11.6% with OI 9. Weekly index strikes, tight quotes.
  for (const liquidity of [
    { roundTripSpreadPct: 0.056, minOpenInterest: 99 },
    { roundTripSpreadPct: 0.116, minOpenInterest: 9 }
  ]) {
    assert.equal(boardTierDecision('iron_condor', { ...RICH, liquidity }).tier, 'qualified')
  }
})

test('illiquid applies to debit spreads too — they pay the same round trip', () => {
  const d = boardTierDecision('bull_call_spread', { ...RICH, liquidity: { roundTripSpreadPct: 1, minOpenInterest: 500 } })
  assert.equal(d.reason, 'illiquid')
})

test('no edge outranks cannot-fill when both fail', () => {
  const d = boardTierDecision('iron_condor', { ...RICH, marketEv: -0.2, liquidity: { roundTripSpreadPct: 0.9, minOpenInterest: 10 } })
  assert.equal(d.reason, 'negative_at_market_vol')
})

test('ceiling is calibrated between the XOM condor (tradable) and XLE (not)', () => {
  assert.ok(ROUND_TRIP_SPREAD_CEILING > 0.496)
  assert.ok(ROUND_TRIP_SPREAD_CEILING < 0.62)
})

function leg(action: 'buy' | 'sell', strike: number, premium: number, spread?: number, openInterest?: number): OptionLeg {
  return {
    type: 'call', action, strike, premium, quantity: 1, greeks: G,
    ...(spread != null ? { spread } : {}),
    ...(openInterest != null ? { openInterest } : {})
  }
}

test('structureLiquidity: Σ spread over |net premium|, thinnest OI', () => {
  // GS-like: sell 1090C, buy 1110C, credit 1.00, spreads 1.20 + 0.90.
  const l = structureLiquidity([leg('sell', 1090, 5, 1.2, 21), leg('buy', 1110, 4, 0.9, 17)], 1)
  assert.ok(l)
  assert.equal(l.minOpenInterest, 17)
  assert.ok(Math.abs(l.roundTripSpreadPct - 2.1) < 1e-9)
})

test('structureLiquidity: null without quote data or premium', () => {
  assert.equal(structureLiquidity([leg('sell', 100, 2, 0.1, 500), leg('buy', 105, 1)], 1), null)
  assert.equal(structureLiquidity([leg('sell', 100, 2, 0.1, 500)], 0), null)
  assert.equal(structureLiquidity([], 1), null)
})

test("requiredWinRate under 'user' (TP 75%, no stop) = (1−r)/(1−0.25r)", () => {
  // width 5, credit 0.75 → r = 0.15; full-credit bar 85%, true bar 88.3%.
  const bar = requiredWinRate(0.75, 0.75, 4.25, 'user')
  assert.ok(bar != null)
  const r = 0.15
  assert.ok(Math.abs(bar - (1 - r) / (1 - 0.25 * r)) < 1e-12)
  assert.ok(bar > 1 - r)
})

test("requiredWinRate under 'managed' (TP 50%, stop 2×) is the flat 80% bar", () => {
  assert.ok(Math.abs((requiredWinRate(1, 1, 4, 'managed') as number) - 0.8) < 1e-12)
  // Stop wider than max loss → capped at max loss.
  assert.ok(Math.abs((requiredWinRate(1, 1, 1, 'managed') as number) - 1 / 1.5) < 1e-12)
})

test('requiredWinRate: null for debit and unbounded payoffs', () => {
  assert.equal(requiredWinRate(-1, 4, 1, 'user'), null)
  assert.equal(requiredWinRate(1, 1, null, 'user'), null)
  assert.equal(requiredWinRate(1, null, 4, 'user'), null)
})
