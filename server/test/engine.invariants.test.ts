/**
 * Invariant tests — encode "common-sense correctness" that must hold no matter
 * how the math evolves. These don't lock exact numbers (that's the golden
 * test's job); they assert relationships a developer can reason about without
 * any quant background, e.g. "probability can't exceed 100%", "a credit
 * strategy must collect a credit", "max loss can't be worse than the math says".
 */

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { runEngineLive } from '../src/engine/index.js'
import type { StrategyType } from '../src/engine/types.js'
import { syntheticChain } from './fixtures.js'

const FIXED_NOW = new Date('2026-05-29T12:00:00-04:00').getTime()

const CREDIT: Set<StrategyType> = new Set([
  'iron_condor', 'short_strangle', 'bear_call_spread', 'bull_put_spread'
])

const SCENARIOS = [
  { name: 'base', opts: {}, ivRank: 50 },
  { name: 'low-iv', opts: { iv: 0.15 }, ivRank: 15, currentRv: 0.2 },
  { name: 'high-iv', opts: { iv: 0.7 }, ivRank: 90, currentRv: 0.3 },
  { name: 'short-dte', opts: { dteDays: 10, iv: 0.4 }, ivRank: 55 }
] as const

for (const sc of SCENARIOS) {
  test(`invariants: ${sc.name}`, () => {
    mock.timers.reset()
    mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
    const { chain, expiration, spot } = syntheticChain(sc.opts)
    const res = runEngineLive({
      symbol: 'TEST', spot, expiration, chain,
      ivRank: sc.ivRank,
      currentRv: 'currentRv' in sc ? sc.currentRv : undefined,
      seed: 42, simulations: 2000
    })

    assert.ok(res.results.length > 0, 'engine should produce at least one strategy')

    for (const r of res.results) {
      const tag = `${sc.name}/${r.strategy}`
      const m = r.metrics

      // Probability of profit is a probability.
      assert.ok(m.probabilityProfit >= 0 && m.probabilityProfit <= 1, `${tag}: POP out of [0,1] (${m.probabilityProfit})`)

      // EV / CVaR must be finite numbers.
      assert.ok(Number.isFinite(m.ev), `${tag}: EV not finite`)
      assert.ok(Number.isFinite(m.cvar95), `${tag}: CVaR not finite`)

      // Credit strategies collect premium (>0); debit strategies pay it (<0).
      if (CREDIT.has(r.strategy)) {
        assert.ok(r.netPremium > 0, `${tag}: credit strategy must have netPremium>0 (got ${r.netPremium})`)
      } else {
        assert.ok(r.netPremium < 0, `${tag}: debit strategy must have netPremium<0 (got ${r.netPremium})`)
      }

      // Max profit must be >= max loss.
      assert.ok(m.theoMaxProfit >= m.theoMaxLoss, `${tag}: maxProfit < maxLoss`)

      // Finite extremes have the expected sign.
      if (Number.isFinite(m.theoMaxLoss)) {
        assert.ok(m.theoMaxLoss <= 1e-6, `${tag}: finite maxLoss should be <= 0 (got ${m.theoMaxLoss})`)
      }
      if (Number.isFinite(m.theoMaxProfit)) {
        assert.ok(m.theoMaxProfit >= -1e-6, `${tag}: finite maxProfit should be >= 0 (got ${m.theoMaxProfit})`)
      }

      // Breakevens must be sane price levels.
      for (const be of m.breakevens) {
        assert.ok(Number.isFinite(be) && be > 0 && be < spot * 3, `${tag}: breakeven out of range (${be})`)
      }

      // Legs well-formed.
      assert.ok(r.legs.length >= 1, `${tag}: no legs`)
      for (const l of r.legs) {
        assert.ok(l.premium > 0, `${tag}: leg premium must be > 0`)
        assert.equal(l.quantity, 1, `${tag}: leg quantity must be 1`)
      }

      // Long straddle: the most you can lose is exactly the debit paid.
      if (r.strategy === 'long_straddle') {
        assert.ok(
          Math.abs(m.theoMaxLoss - r.netPremium) < 0.01,
          `${tag}: straddle maxLoss (${m.theoMaxLoss}) should equal net debit (${r.netPremium})`
        )
      }

      // Naked short strangle must be flagged as unbounded loss.
      if (r.strategy === 'short_strangle') {
        assert.equal(m.unboundedLoss, true, `${tag}: short strangle should flag unboundedLoss`)
      }
    }
  })
}
