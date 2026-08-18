/**
 * fix/credit-spread-wing-geometry — the two-leg credit spreads take the SAME
 * fix the iron condor already took (see condorWings.test.ts).
 *
 * bull_put_spread / bear_call_spread placed their long wing at a fixed 10Δ.
 * A delta is not a geometry: under skew the 10Δ strike drifts, so the SAME rule
 * produced wildly different wing widths across names. Measured on the real
 * 2026-10-02 chains at the 2026-08-17 close:
 *
 *   IWM 304.06 → 290/270, $20 wide = 6.6% of spot, credit/width 10.8%, maxLoss $1,785
 *   TLT  81.45 → 79/76,   $3  wide = 3.7% of spot, credit/width 13.3%, maxLoss $260
 *
 * The IWM long leg cost $1.05 and bought protection only below 270 — while
 * being priced at 25.7% IV against the short's 21.2% (you buy the richer vol).
 * With CREDIT_SPREAD_WING_PCT the wing is a chosen fraction of the short strike:
 *   IWM → 290/285, credit/width 16.1%, maxLoss $420
 *   TLT → 79/77,   credit/width 15.5%, maxLoss $169
 *
 * The narrow wing is NOT free — loss saturates sooner and equal capital buys
 * more contracts (more short gamma). The assertion here is only that the width
 * is a STABLE fraction of the short, not a skew accident.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { legsFromSpec, STRATEGY_SPECS, CREDIT_SPREAD_WING_PCT } from '../src/engine/liveStrategies.js'
import { legsForShortDelta, variantId, CREDIT_SPREAD_STRUCT_EPOCH } from '../src/feedback/tuner.js'
import type { OptionContract } from '../src/api/types.js'

/** Put-skewed chain: below spot the delta curve is stretched, so a given delta
 *  sits much further OTM in strikes than its call mirror. */
function skewedChain(spot: number, lo: number, hi: number, step: number): OptionContract[] {
  const out: OptionContract[] = []
  for (let k = lo; k <= hi; k += step) {
    const scale = k < spot ? spot * 0.09 : spot * 0.044 // put side stretched
    const callDelta = 1 / (1 + Math.exp((k - spot) / scale))
    for (const type of ['call', 'put'] as const) {
      out.push({
        symbol: `X${k}${type[0]}`, strike: k, optionType: type,
        bid: 1.0, ask: 1.1, mid: 1.05, last: 1.05,
        openInterest: 100, volume: 50, expiration: '2026-10-02',
        greeks: { delta: type === 'call' ? callDelta : callDelta - 1, gamma: 0.01, theta: -0.1, vega: 0.1 }
      })
    }
  }
  return out
}

function widthOf(strategy: 'bull_put_spread' | 'bear_call_spread', chain: OptionContract[]): number {
  const spec = STRATEGY_SPECS.find((s) => s.type === strategy)
  assert.ok(spec, `${strategy} spec must exist`)
  const legs = legsFromSpec(spec.legs, chain)
  assert.ok(legs, `${strategy} legs must resolve`)
  const ks = legs.map((l) => l.strike).sort((a, b) => a - b)
  return ks[1] - ks[0]
}

test('credit-spread wing width is a stable % of the short strike, not a delta accident', () => {
  // Two names an order of magnitude apart in price, both put-skewed.
  for (const [spot, lo, hi, step] of [[304, 240, 340, 1], [81, 60, 100, 1]] as const) {
    const chain = skewedChain(spot, lo, hi, step)
    for (const strat of ['bull_put_spread', 'bear_call_spread'] as const) {
      const w = widthOf(strat, chain)
      const legs = legsFromSpec(STRATEGY_SPECS.find((s) => s.type === strat)!.legs, chain)!
      const short = legs.find((l) => l.action === 'sell')!.strike
      const expected = short * CREDIT_SPREAD_WING_PCT
      assert.ok(
        Math.abs(w - expected) <= step,
        `${strat} @spot ${spot}: wing ${w} wide, expected ≈${expected.toFixed(2)} (${CREDIT_SPREAD_WING_PCT * 100}% of short ${short})`
      )
    }
  }
})

test('wing lands strictly OTM of the short (never inverts the vertical)', () => {
  const chain = skewedChain(304, 240, 340, 1)
  const bps = legsFromSpec(STRATEGY_SPECS.find((s) => s.type === 'bull_put_spread')!.legs, chain)!
  const bpShort = bps.find((l) => l.action === 'sell')!.strike
  const bpLong = bps.find((l) => l.action === 'buy')!.strike
  assert.ok(bpLong < bpShort, `bull put: long ${bpLong} must sit BELOW short ${bpShort}`)

  const bcs = legsFromSpec(STRATEGY_SPECS.find((s) => s.type === 'bear_call_spread')!.legs, chain)!
  const bcShort = bcs.find((l) => l.action === 'sell')!.strike
  const bcLong = bcs.find((l) => l.action === 'buy')!.strike
  assert.ok(bcLong > bcShort, `bear call: long ${bcLong} must sit ABOVE short ${bcShort}`)
})

test('tuned path and static specs build the SAME geometry (no "two spreads")', () => {
  // The condor review's High #1: a second spec source silently kept the old
  // structure whenever the tuner path ran. Same trap here — assert both agree.
  const chain = skewedChain(304, 240, 340, 1)
  for (const strat of ['bull_put_spread', 'bear_call_spread'] as const) {
    const tuned = legsForShortDelta(strat, 0.30)
    assert.ok(tuned, `${strat} tuned specs must build`)
    const tunedLegs = legsFromSpec(tuned, chain)!
    const staticLegs = legsFromSpec(STRATEGY_SPECS.find((s) => s.type === strat)!.legs, chain)!
    assert.deepEqual(
      tunedLegs.map((l) => l.strike).sort((a, b) => a - b),
      staticLegs.map((l) => l.strike).sort((a, b) => a - b),
      `${strat}: tuner arm 0.30 must reproduce the static default structure`
    )
  }
})

test('credit-spread tuner variant ids are epoched so legacy sd0.30 cannot match', () => {
  // Same trap the condor hit: 10Δ-wing outcomes recorded as "sd0.30" must not
  // teach the live 2%-wing arm. Epoch is required on BOTH one-sided spreads.
  for (const st of ['bull_put_spread', 'bear_call_spread'] as const) {
    assert.ok(variantId(0.3, st).endsWith(`@${CREDIT_SPREAD_STRUCT_EPOCH}`))
    assert.notEqual(variantId(0.3, st), 'sd0.30')
    assert.equal(variantId(0.3, st), `sd0.30@${CREDIT_SPREAD_STRUCT_EPOCH}`)
  }
})
