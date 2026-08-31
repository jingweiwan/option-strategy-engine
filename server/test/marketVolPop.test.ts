/**
 * Market-vol cross-check (engine/index.ts, MarketVolCheck).
 *
 * The published POP/EV are simulated at simSigma = 0.7·RV + 0.3·IV, which is
 * NARROWER than the vol the market charges for the legs a credit structure
 * sells. That gap is a modeling bet, and it used to be invisible on the card.
 * These tests pin the contract: the cross-check exists exactly where the gap
 * does, it is apples-to-apples with the published number, and it moves the way
 * a wider diffusion must.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runEngineLive, MARKET_VOL_CHECK_MIN_GAP, deriveSimSigma } from '../src/engine/index.js'
import { netPremium } from '../src/engine/payoff.js'
import { simulatePaths } from '../src/engine/simulator.js'
import { evaluateStrategyManaged } from '../src/engine/scorer.js'
import { managedHoldDays, type ExitPolicy } from '../src/engine/managedExit.js'
import { STRATEGY_SPECS } from '../src/engine/liveStrategies.js'
import { syntheticChain } from './fixtures.js'

const IV = 0.30
const RV = 0.18 // simSigma = max(0.7·0.18 + 0.3·0.30, 0.18) = 0.216 → 39% below the sold IV

function run(extra: Record<string, unknown> = {}) {
  const { chain, expiration, spot } = syntheticChain({ iv: IV })
  return runEngineLive({
    symbol: 'TEST', spot, expiration, chain, ivRank: 60, seed: 42, simulations: 800, ...extra
  })
}

test('credit structures get the check, and the market sigma is the one they SELL', () => {
  const res = run({ currentRv: RV })
  const credits = res.results.filter((r) => netPremium(r.legs) > 0)
  assert.ok(credits.length > 0, 'fixture must produce at least one credit structure')

  for (const r of credits) {
    const mv = r.marketVolCheck
    assert.ok(mv, `${r.strategy} should carry a market-vol check`)
    assert.equal(mv!.simSigma, deriveSimSigma(IV, RV), 'simSigma must be the published one')
    assert.ok(
      mv!.marketSigma > mv!.simSigma,
      `${r.strategy}: sold-leg IV ${mv!.marketSigma} should exceed simSigma ${mv!.simSigma}`
    )
  }
})

test('a wider diffusion cannot raise a credit structure POP', () => {
  const res = run({ currentRv: RV })
  const checked = res.results.filter((x) => x.marketVolCheck)
  assert.ok(checked.length > 0, 'nothing to compare — the fixture must emit checks')
  for (const r of checked) {
    const mv = r.marketVolCheck!
    assert.ok(
      mv.pop <= r.metrics.probabilityProfit + 1e-9,
      `${r.strategy}: market-vol POP ${mv.pop} must not exceed published ${r.metrics.probabilityProfit}`
    )
  }
})

test('no gap → no check (never pay 30ms for a number that rounds to the same thing)', () => {
  // currentRv absent → deriveSimSigma returns IV → simSigma IS the ATM vol.
  // The fixture chain is flat, so sold-leg IV lands within the min gap.
  const res = run()
  for (const r of res.results) {
    const mv = r.marketVolCheck
    if (mv) {
      assert.ok(
        Math.abs(mv.marketSigma - mv.simSigma) / mv.simSigma >= MARKET_VOL_CHECK_MIN_GAP,
        `${r.strategy}: check emitted for a sub-threshold gap`
      )
    }
  }
})

test('debit structures never get one — they sell nothing', () => {
  const res = run({ currentRv: RV })
  for (const r of res.results.filter((x) => netPremium(x.legs) <= 0)) {
    assert.equal(r.marketVolCheck ?? null, null, `${r.strategy} is a debit structure`)
  }
})

test('same seed → identical check (common random numbers, not sampling noise)', () => {
  const a = run({ currentRv: RV })
  const b = run({ currentRv: RV })
  const pick = (res: typeof a) =>
    res.results.filter((r) => r.marketVolCheck).map((r) => [r.strategy, r.marketVolCheck])
  assert.ok(pick(a).length > 0, 'nothing to compare — the fixture must emit checks')
  assert.deepEqual(pick(a), pick(b))
})

/**
 * Reconstruct what the cross-check MUST be, independently of the engine. This is
 * the test with teeth: it pins the whole frame — paths at the market sigma,
 * marks converging to the market sigma, the structure's own exit policy and its
 * own hold window. Asserting only "the number moved" is not enough; changing
 * convergeTo or hardcoding the policy also moves it, and both are wrong.
 */
function expectedCheck(
  opts: { iv: number; rv: number; spot: number; dteDays: number; seed: number; sims: number },
  legs: Parameters<typeof evaluateStrategyManaged>[1],
  strategy: Parameters<typeof managedHoldDays>[0],
  policies: Partial<Record<string, ExitPolicy>> = {}
) {
  const { iv, rv, spot, dteDays, seed, sims } = opts
  const T = dteDays / 365
  const r = 0.045
  const q = 0
  const simSigma = deriveSimSigma(iv, rv)
  const marketSigma = soldIvOf(legs)
  const policyFor = (st: string): ExitPolicy => policies[st] ?? 'managed'
  const steps = Math.max(...STRATEGY_SPECS.map((sp) => managedHoldDays(sp.type, dteDays, policyFor(sp.type))))
  const paths = simulatePaths({
    S0: spot, sigma: marketSigma, dtYears: 1 / 252, steps, r, q, simulations: sims, seed,
    earningsStep: -1, earningsJump: 0
  })
  const m = evaluateStrategyManaged(paths, legs, {
    tauAt: (i) => Math.max(0, T - (i + 1) / 252),
    r, q,
    sigma: iv,
    convergeTo: marketSigma,
    maxSteps: managedHoldDays(strategy, dteDays, policyFor(strategy))
  }, policyFor(strategy))
  return { simSigma, marketSigma, pop: m.probabilityProfit, ev: m.ev }
}

function soldIvOf(legs: Parameters<typeof evaluateStrategyManaged>[1]): number {
  let wsum = 0, w = 0
  for (const l of legs) {
    if (l.action !== 'sell') continue
    const weight = Math.abs(l.premium) * l.quantity
    wsum += (l.iv as number) * weight
    w += weight
  }
  return wsum / w
}

test('the check is exactly: same legs, same policy, paths AND marks at the market vol', () => {
  const { chain, expiration, spot } = syntheticChain({ iv: IV })
  const base = {
    symbol: 'TEST', spot, expiration, chain, ivRank: 60, seed: 42, simulations: 800, currentRv: RV
  }
  for (const policies of [{}, { iron_condor: 'runner' as const }]) {
    const res = runEngineLive({ ...base, exitPolicies: policies })
    const iv = res.state.iv
    const dte = res.state.dte
    const checked = res.results.filter((x) => x.marketVolCheck)
    assert.ok(checked.length > 0, 'nothing to reconstruct — the fixture must emit checks')
    for (const r of checked) {
      assert.deepEqual(
        r.marketVolCheck,
        expectedCheck({ iv, rv: RV, spot, dteDays: dte, seed: 42, sims: 800 }, r.legs, r.strategy, policies),
        `${r.strategy} under ${JSON.stringify(policies)}`
      )
    }
  }
})
