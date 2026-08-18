/**
 * fix/ivrv-gate-sold-strike — the IV/RV richness gate judges the vol being SOLD,
 * not the ATM point.
 *
 * SELL_IVRV_FLOOR asks "is the premium actually rich?" but was fed
 * `result.state.iv` — the ATM implied vol. You do not sell ATM. Under put skew
 * the sold strike is materially richer; under call skew it is cheaper. Measured
 * on the real IWM 2026-10-02 chain (2026-08-17 close, ATM IV 17.4%, RV 14.1%):
 *
 *   sold 290P  IV 21.2%  → IV/RV 1.50   (ATM said 1.23 — barely over the 1.20 floor)
 *   wing 270P  IV 25.7%
 *
 * So this is NOT a one-way loosening: a bear_call_spread selling a call BELOW
 * the ATM vol gets correctly demoted where the ATM number would have passed it.
 *
 * NOT MEASURED HERE: the net effect on board composition. That needs a live
 * rescan / replay A/B — which is exactly why this ships on its own branch,
 * separate from the credit/width gate that tightens in the opposite direction.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sellVolDecision, boardTierDecision, SELL_IVRV_FLOOR } from '../src/engine/oppScanner.js'
import { soldLegIv } from '../src/engine/liveStrategies.js'
import type { OptionLeg } from '../src/engine/types.js'

const leg = (o: Partial<OptionLeg> & Pick<OptionLeg, 'action' | 'strike' | 'premium'>): OptionLeg => ({
  type: 'put', quantity: 1, greeks: { delta: 0, gamma: 0, theta: 0, vega: 0 }, ...o
} as OptionLeg)

test('soldLegIv: premium-weighted across sold legs only', () => {
  // Condor: put short carries 3x the credit of the call short → weighted toward it.
  const legs = [
    leg({ action: 'sell', strike: 290, premium: 3.0, iv: 0.22 }),
    leg({ action: 'buy', strike: 285, premium: 2.4, iv: 0.99 }), // long leg must be ignored
    leg({ action: 'sell', strike: 320, premium: 1.0, iv: 0.14, type: 'call' }),
    leg({ action: 'buy', strike: 325, premium: 0.6, iv: 0.99, type: 'call' })
  ]
  const got = soldLegIv(legs)!
  assert.ok(Math.abs(got - (0.22 * 3 + 0.14 * 1) / 4) < 1e-9, `weighted IV was ${got}`)
})

test('soldLegIv: null unless EVERY sold leg has a sane IV (no partial mix)', () => {
  assert.equal(soldLegIv([leg({ action: 'sell', strike: 290, premium: 3, iv: 0.22 }),
                          leg({ action: 'sell', strike: 320, premium: 1 })]), null)
  assert.equal(soldLegIv([leg({ action: 'sell', strike: 290, premium: 3, iv: 0 })]), null)
  assert.equal(soldLegIv([leg({ action: 'buy', strike: 290, premium: 3, iv: 0.22 })]), null)
})

test('the real IWM card: ATM says 1.23 (marginal), the SOLD strike says 1.50', () => {
  // ATM path — what shipped before this change.
  assert.equal(sellVolDecision('bull_put_spread', 44, false, false, 0.174, 0.141).tier, 'qualified')
  // Sold-strike path: same name, richer true reading. Still qualified, but now
  // for the right reason and with real margin over the floor.
  const d = sellVolDecision('bull_put_spread', 44, false, false, 0.174, 0.141, null, 0.212)
  assert.equal(d.tier, 'qualified')
  assert.ok(0.212 / 0.141 > SELL_IVRV_FLOOR)
})

test('NOT a one-way loosening: a sold strike CHEAPER than ATM gets demoted', () => {
  // Call skew: ATM 30% clears 1.20 vs RV 24%, but the call actually sold is 26%.
  assert.equal(sellVolDecision('bear_call_spread', 55, false, false, 0.30, 0.24).tier, 'qualified')
  const d = sellVolDecision('bear_call_spread', 55, false, false, 0.30, 0.24, null, 0.26)
  assert.equal(d.tier, 'reference')
  assert.equal(d.reason, 'vol_not_rich')
})

test('falls back to ATM iv when the chain supplied no per-strike IV', () => {
  const d = sellVolDecision('iron_condor', 55, false, false, 0.13, 0.14, null, null)
  assert.equal(d.reason, 'vol_not_rich', 'null soldIv must not disable the gate')
})

test('boardTierDecision wiring: soldIv reaches the gate and beats ctx.iv', () => {
  const thinAtm = { ivr: 55, iv: 0.13, rv: 0.14, spansEarnings: false }
  assert.equal(boardTierDecision('iron_condor', thinAtm).reason, 'vol_not_rich')
  // Same ATM reading, but what is actually sold is rich → qualifies.
  assert.equal(boardTierDecision('iron_condor', { ...thinAtm, soldIv: 0.20 }).tier, 'qualified')
})
