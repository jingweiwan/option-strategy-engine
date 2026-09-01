/**
 * Market-vol cross-check (engine/index.ts, MarketVolCheck).
 *
 * The published POP/EV ride a variance-risk-premium wager that enters in two
 * places at once: paths DIFFUSE at simSigma = max(0.7·RV + 0.3·IV, 0.6·IV), and
 * legs are MARKED DOWN toward that same simSigma across the hold. Both were
 * invisible on the card. The cross-check re-scores the identical structure in
 * the world where the market's price of vol is the truth — paths and marks both
 * at the sold-leg IV — so the wager can be seen rather than assumed.
 *
 * These tests pin that contract: the check exists exactly where the gap does, it
 * is apples-to-apples with the published number, its sigma is the SHORT-strike
 * vol (so the gap carries skew, not just RV-vs-IV), and it moves BOTH sides of
 * the wager — a variant that changed only the diffusion is a different, and
 * incoherent, number.
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

test('dropping the VRP wager cannot raise a credit structure POP', () => {
  const res = run({ currentRv: RV })
  const checked = res.results.filter((x) => x.marketVolCheck)
  assert.ok(checked.length > 0, 'nothing to compare — the fixture must emit checks')
  for (const r of checked) {
    const mv = r.marketVolCheck!
    assert.ok(
      mv.pop <= r.metrics.probabilityProfit + 1e-9,
      `${r.strategy}: market-vol POP ${mv.pop} must not exceed published ${r.metrics.probabilityProfit} — ` +
        'wider paths and a mark schedule that no longer decays both cut against a credit seller'
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
  policies: Partial<Record<string, ExitPolicy>> = {},
  /** `convergeTo: 'sim'` builds the INCORRECT variant (published mark schedule
   *  on market-vol paths) so a test can assert the shipped one is not that. */
  variant: { convergeTo?: 'market' | 'sim' } = {}
) {
  const { iv, rv, spot, dteDays, seed, sims } = opts
  const T = dteDays / 365
  const r = 0.045
  const q = 0
  const simSigma = deriveSimSigma(iv, rv)
  const marketSigma = soldIvOf(legs)
  const policyFor = (st: string): ExitPolicy => policies[st] ?? 'user'
  const steps = Math.max(...STRATEGY_SPECS.map((sp) => managedHoldDays(sp.type, dteDays, policyFor(sp.type))))
  const paths = simulatePaths({
    S0: spot, sigma: marketSigma, dtYears: 1 / 252, steps, r, q, simulations: sims, seed,
    earningsStep: -1, earningsJump: 0
  })
  const m = evaluateStrategyManaged(paths, legs, {
    tauAt: (i) => Math.max(0, T - (i + 1) / 252),
    r, q,
    sigma: iv,
    convergeTo: variant.convergeTo === 'sim' ? simSigma : marketSigma,
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

// --- Skew: the gap is NOT "RV vs IV" ----------------------------------------
// A flat fixture makes soldLegIv === ATM iv, so every claim about WHERE the gap
// comes from passes vacuously. This chain is put-skewed the way an index chain
// is: the short strikes a credit structure sells quote well above ATM, and the
// gap against simSigma exists even before the RV blend is applied.
const PUT_SKEW = (strike: number, spot: number) =>
  IV + Math.max(0, (spot - strike) / spot) * 0.60 // 100→30%, 90→36%, 80→42%

function skewed(extra: Record<string, unknown> = {}) {
  const { chain, expiration, spot } = syntheticChain({ iv: IV, ivAt: PUT_SKEW })
  return runEngineLive({
    symbol: 'TEST', spot, expiration, chain, ivRank: 60, seed: 42, simulations: 800, ...extra
  })
}

test('marketSigma is the vol at the SHORT strikes, not ATM — skew alone opens a gap', () => {
  // No currentRv → deriveSimSigma returns ATM iv, so the RV blend contributes
  // NOTHING. Any surviving gap is skew, which is exactly the point.
  const res = skewed()
  const withSkewGap = res.results.filter(
    (r) => r.marketVolCheck && r.marketVolCheck.marketSigma > r.marketVolCheck.simSigma + 1e-9
  )
  assert.ok(
    withSkewGap.length > 0,
    'a put-skewed chain must produce a sold-leg IV above the ATM-derived simSigma with RV out of the picture'
  )
  for (const r of withSkewGap) {
    assert.ok(
      Math.abs(r.marketVolCheck!.simSigma - res.state.iv) < 1e-9,
      'guard: simSigma must equal ATM iv here, or this test is no longer about skew'
    )
  }
})

test('the check drops the VRP wager on BOTH sides — marks too, not just paths', () => {
  // The published run marks legs DOWN toward simSigma across the hold; the check
  // marks toward marketSigma. Where the sold legs are richer than ATM, convergeTo
  // is a documented no-op, so the check harvests no mark decay at all. Pin that:
  // a check built with the published mark schedule (convergeTo: simSigma) must
  // differ from the shipped one — otherwise only the diffusion is being varied
  // and every comment and tooltip about this feature is wrong.
  const res = skewed({ currentRv: RV })
  const checked = res.results.filter((r) => r.marketVolCheck)
  assert.ok(checked.length > 0, 'fixture must emit checks')

  const iv = res.state.iv
  const dte = res.state.dte
  let differed = 0
  for (const r of checked) {
    const publishedMarks = expectedCheck(
      { iv, rv: RV, spot: res.state.spot, dteDays: dte, seed: 42, sims: 800 },
      r.legs, r.strategy, {},
      { convergeTo: 'sim' }
    )
    if (
      Math.abs(publishedMarks.pop - r.marketVolCheck!.pop) > 1e-9 ||
      Math.abs(publishedMarks.ev - r.marketVolCheck!.ev) > 1e-9
    ) differed++
  }
  assert.ok(
    differed > 0,
    'the shipped check must NOT reduce to "published marks on wider paths" — the mark side moves too'
  )
})

// --- Earnings limb ----------------------------------------------------------
// The jump the check shocks its paths with must be the excess of ATM IV over
// MARKET sigma, not the published excess over simSigma. Those differ by exactly
// the amount this whole feature is about, and reusing the published jump would
// smuggle the VRP wager back in through the event.
function inDays(n: number): string {
  return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10)
}

test('the event jump is market-implied too — a sold-leg vol above ATM leaves nothing to shock', () => {
  // Put-skewed chain: the structures that sell those strikes have
  // marketSigma > ATM iv, so marketImpliedJump(iv, marketSigma, T) is 0 and
  // their market-vol paths must be jump-free — identical to the no-earnings run.
  // The published run, whose jump is measured against the much narrower
  // simSigma, does shock. If the check reused that jump these would diverge.
  const withEarnings = skewed({ currentRv: RV, earningsDate: inDays(5) })
  const without = skewed({ currentRv: RV })

  const byStrategy = new Map(without.results.map((r) => [r.strategy, r]))
  let richer = 0
  let publishedMoved = 0
  for (const r of withEarnings.results) {
    const mv = r.marketVolCheck
    const base = byStrategy.get(r.strategy)
    if (!mv || !base?.marketVolCheck) continue
    if (mv.marketSigma < withEarnings.state.iv) continue // has excess to shock; not this test
    richer++
    assert.deepEqual(
      mv, base.marketVolCheck,
      `${r.strategy}: sold-leg IV ${mv.marketSigma} ≥ ATM ${withEarnings.state.iv} — ` +
        'no event premium remains above the diffusion, so the market-vol paths must carry no jump'
    )
    if (Math.abs(r.metrics.probabilityProfit - base.metrics.probabilityProfit) > 1e-9) publishedMoved++
  }
  assert.ok(richer > 0, 'fixture must produce a structure whose sold legs price above ATM')
  assert.ok(
    publishedMoved > 0,
    'guard: the earnings date must actually reach the published run, or this proves nothing'
  )
})
