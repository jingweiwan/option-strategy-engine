/**
 * Golden tests — lock the engine's full output for fixed inputs.
 *
 * The simulator is seeded, so identical inputs must produce identical outputs.
 * Any unintended change to pricing, payoff, scoring, sigma blending, or the
 * earnings jump will move these numbers and fail the test. You do NOT need to
 * know why a value is "correct" — only that it must not change unless you meant
 * to change it. When a change is intentional: UPDATE_GOLDEN=1 npm test
 */

import { test, mock } from 'node:test'
import { runEngineLive, type LiveEngineResult } from '../src/engine/index.js'
import { syntheticChain, r2 } from './fixtures.js'
import { matchGolden } from './golden.js'

// Pin the clock so DTE (and everything derived from it) is identical no matter
// what hour the suite runs. Without this, dteFromExpiration reads wall-clock
// time and the goldens flake by ±1 day.
const FIXED_NOW = new Date('2026-05-29T12:00:00-04:00').getTime()
function freezeClock() {
  mock.timers.reset()
  mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
}

/** Extract a stable, rounded view of the engine result (drops volatile fields). */
function normalize(res: LiveEngineResult) {
  return {
    state: {
      iv: r2(res.state.iv, 4),
      ivRank: res.state.ivRank,
      dte: res.state.dte,
      regime: res.state.regime,
      volatility: res.state.volatility,
      expectedMove: r2(res.state.expectedMove, 2)
    },
    skipped: res.skipped.map((s) => s.strategy).sort(),
    results: res.results
      .map((r) => ({
        strategy: r.strategy,
        tier: r.tier ?? null,
        netPremium: r2(r.netPremium, 2),
        pop: r2(r.metrics.probabilityProfit, 3),
        ev: r2(r.metrics.ev, 2),
        cvar95: r2(r.metrics.cvar95, 2),
        maxProfit: Number.isFinite(r.metrics.theoMaxProfit) ? r2(r.metrics.theoMaxProfit, 2) : 'inf',
        maxLoss: Number.isFinite(r.metrics.theoMaxLoss) ? r2(r.metrics.theoMaxLoss, 2) : '-inf',
        breakevens: r.metrics.breakevens.map((b) => r2(b, 1)),
        legs: r.legs.map((l) => ({
          type: l.type,
          action: l.action,
          strike: l.strike,
          premium: r2(l.premium, 2)
        }))
      }))
      // sort by strategy name so ordering is deterministic regardless of score ties
      .sort((a, b) => a.strategy.localeCompare(b.strategy))
  }
}

test('golden: base case (spot 100, IV 30%, 30 DTE)', () => {
  freezeClock()
  const { chain, expiration, spot } = syntheticChain()
  const res = runEngineLive({ symbol: 'TEST', spot, expiration, chain, ivRank: 50, seed: 42, simulations: 2000 })
  matchGolden('engine-base', normalize(res))
})

test('golden: sell regime (high IV vs low RV)', () => {
  freezeClock()
  const { chain, expiration, spot } = syntheticChain({ iv: 0.6 })
  const res = runEngineLive({
    symbol: 'TEST', spot, expiration, chain,
    ivRank: 85, currentRv: 0.25, seed: 42, simulations: 2000
  })
  matchGolden('engine-sell-regime', normalize(res))
})

test('golden: earnings jump within window', () => {
  freezeClock()
  const { chain, expiration, spot } = syntheticChain({ iv: 0.45, dteDays: 20 })
  // earnings 10 days out — inside the 20-DTE window
  const earn = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10)
  const res = runEngineLive({
    symbol: 'TEST', spot, expiration, chain,
    ivRank: 60, currentRv: 0.3, earningsDate: earn, seed: 42, simulations: 2000
  })
  matchGolden('engine-earnings-jump', normalize(res))
})
