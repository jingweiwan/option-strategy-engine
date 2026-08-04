/**
 * fix/condor-reward-metric — iron condor structural fix.
 *
 * The shipped condor derived both long wings by DELTA offset
 * (CONDOR_PUT_WING=0.10Δ vs CONDOR_CALL_WING=0.06Δ). Under real put-skew that
 * produced grossly UNEQUAL dollar wing widths (e.g. 25-wide put / 5-wide call),
 * so maxLoss was non-comparable across tuner arms and normalizedReward (÷maxLoss)
 * ranked arms inversely to realized $ — the 2,388-trade offline replay caught it:
 * the 0.16 arm made the MOST money yet scored the LOWEST reward.
 *
 * Fix: short legs keep their delta/skew; both long wings are placed an EQUAL
 * dollar width (k × same-side short strike) from their short. Equal, bounded,
 * arm-comparable maxLoss → reward tracks $ again (validated empirically by the
 * replay, not asserted here — monotonicity only holds across equal-wing arms).
 *
 * The re-parameterization epochs the condor tuner variant ids (`@w2`) so legacy
 * sd0.20 snapshots (old structure) no longer match a live arm and cannot
 * pollute the new Beta posterior.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { legsForShortDelta, variantId, CONDOR_ARMS, CONDOR_STRUCT_EPOCH } from '../src/feedback/tuner.js'
import { legsFromSpec } from '../src/engine/liveStrategies.js'
import type { OptionContract } from '../src/api/types.js'

// Synthetic chain with PUT-SKEW: below spot the delta curve is stretched (a
// given delta sits further OTM in strikes than the mirror call), which is what
// turns equal-DELTA wings into unequal-DOLLAR wings on the old structure.
function skewedChain(spot = 500): OptionContract[] {
  const out: OptionContract[] = []
  for (let k = 300; k <= 700; k += 5) {
    const scale = k < spot ? 45 : 22 // put side stretched → skew
    const callDelta = 1 / (1 + Math.exp((k - spot) / scale))
    for (const type of ['call', 'put'] as const) {
      out.push({
        symbol: `X${k}${type[0]}`,
        strike: k,
        optionType: type,
        bid: 1.0,
        ask: 1.1,
        mid: 1.05,
        last: 1.05,
        openInterest: 100,
        volume: 50,
        expiration: '2026-09-18',
        greeks: {
          delta: type === 'call' ? callDelta : callDelta - 1,
          gamma: 0.01,
          theta: -0.1,
          vega: 0.1
        }
      })
    }
  }
  return out
}

function condorWingWidths(shortDelta: number, chain: OptionContract[]): { putWidth: number; callWidth: number } {
  const specs = legsForShortDelta('iron_condor', shortDelta)
  assert.ok(specs, 'condor specs must build')
  const legs = legsFromSpec(specs, chain)
  assert.ok(legs, `condor legs must resolve for arm ${shortDelta}`)
  const puts = legs.filter((l) => l.type === 'put').map((l) => l.strike).sort((a, b) => a - b)
  const calls = legs.filter((l) => l.type === 'call').map((l) => l.strike).sort((a, b) => a - b)
  return { putWidth: puts[1] - puts[0], callWidth: calls[1] - calls[0] }
}

test('iron condor: put and call wings are equal dollar width (within one strike step)', () => {
  const chain = skewedChain()
  for (const sd of CONDOR_ARMS) {
    const { putWidth, callWidth } = condorWingWidths(sd, chain)
    assert.ok(
      Math.abs(putWidth - callWidth) <= 5,
      `arm ${sd}: put wing ${putWidth} vs call wing ${callWidth} — must be equal dollar width`
    )
  }
})

test('condor tuner variant ids are epoched; single-sided credit spreads are not', () => {
  // Legacy old-structure condor snapshots recorded "sd0.20" must NOT match the
  // new epoched arm, so they cannot pollute the fresh posterior.
  assert.ok(variantId(0.2, 'iron_condor').endsWith(`@${CONDOR_STRUCT_EPOCH}`))
  assert.notEqual(variantId(0.2, 'iron_condor'), 'sd0.20')
  assert.equal(variantId(0.3, 'bull_put_spread'), 'sd0.30')
  assert.equal(variantId(0.3, 'bear_call_spread'), 'sd0.30')
})
