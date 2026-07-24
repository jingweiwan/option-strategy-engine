/**
 * Online tuner (Thompson sampling) — invariants:
 *   1. Legacy snapshots (no variant) seed the default 0.30 arm.
 *   2. With strong evidence, sampling overwhelmingly picks the winning arm,
 *      while never fully abandoning exploration.
 *   3. specOverrides actually moves the engine's chosen strikes.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildArmStats,
  pickShortDelta,
  variantId,
  DEFAULT_SHORT_DELTA,
  CONDOR_ARMS,
  legsForShortDelta
} from '../src/feedback/tuner.js'
import { normalizedReward } from '../src/feedback/calibration.js'
import { runEngineLive } from '../src/engine/index.js'
import { syntheticChain } from './fixtures.js'
import type { RecommendationSnapshot } from '../src/feedback/types.js'

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function snap(over: Partial<RecommendationSnapshot>, win: boolean): RecommendationSnapshot {
  return {
    id: 'x', etDay: '2026-06-01', capturedAt: '', source: 'dashboard',
    sym: 'TEST', strategyId: 'bull_put_spread', expiration: '2026-07-01',
    spot: 100, iv: 0.3, ivr: 50, rvAtScan: null, ivRvGap: null,
    regime: 'sell', score: 1, pop: 0.7, ev: 0.1, netPremium: 1,
    maxProfit: 1, maxLoss: -4, dte: 30, breakevens: [], legs: [],
    outcome: {
      computedAt: '', horizonDays: 5, tradingDaysUsed: 5,
      realizedVolAnnualized: null, spotMin: null, spotMax: null,
      pnlPathMin: null, pnlPathMax: null, pnlAtExpirationClose: null,
      stopHit: false, stopThresholdUsed: 0, nearBreakevenTouched: false,
      managedPnl: win ? 0.5 : -1, managedExitDay: null, managedExitReason: 'take_profit'
    },
    ...over
  }
}

test('tuner: legacy snapshots (no variant) seed the default arm with fractional mass', () => {
  // snap(): maxLoss=-4. win pnl +0.5 → r=0.5+0.5·0.5/4=0.5625; loss −1 → r=0.5−0.5·1/4=0.375
  const stats = buildArmStats([snap({}, true), snap({}, true), snap({}, false)])
  const k = `bull_put_spread|sell|${variantId(DEFAULT_SHORT_DELTA)}`
  const s = stats.get(k)!
  assert.equal(s.n, 3)
  assert.ok(Math.abs(s.rewardMass - (0.5625 + 0.5625 + 0.375)) < 1e-9, `rewardMass=${s.rewardMass}`)
  assert.ok(Math.abs(s.failMass - (0.4375 + 0.4375 + 0.625)) < 1e-9, `failMass=${s.failMass}`)
})

test('tuner: normalizedReward = return on capital-at-risk', () => {
  assert.equal(normalizedReward(4, -4), 1)        // made what you could lose
  assert.equal(normalizedReward(-4, -4), 0)       // full max loss
  assert.equal(normalizedReward(0, -4), 0.5)      // breakeven
  assert.equal(normalizedReward(2, -4), 0.75)     // +50% of risk
  assert.equal(normalizedReward(9, -4), 1)        // clamped above
  assert.equal(normalizedReward(0.5, null), 1)    // fallback: binary
  assert.equal(normalizedReward(-0.5, null), 0)
})

test('tuner: rejects the win-rate trap — picks the high-EV arm over the high-POP arm', () => {
  // Bounds ±1 → r = (pnl+1)/2.
  // sd0.25: 80% win rate but tiny wins / big losses → per-trade EV −0.10
  // sd0.35: 60% win rate but big wins / small losses → per-trade EV +0.34
  const w = (variant: string, pnl: number) =>
    snap({ variant, maxProfit: 1, maxLoss: -1,
      outcome: { ...snap({}, true).outcome!, managedPnl: pnl } }, pnl > 0)
  const snaps: RecommendationSnapshot[] = []
  for (let i = 0; i < 16; i++) snaps.push(w('sd0.25', +0.1))
  for (let i = 0; i < 4; i++) snaps.push(w('sd0.25', -0.9))
  for (let i = 0; i < 12; i++) snaps.push(w('sd0.35', +0.9))
  for (let i = 0; i < 8; i++) snaps.push(w('sd0.35', -0.5))

  const stats = buildArmStats(snaps)
  const rng = mulberry32(7)
  const picks: Record<string, number> = { 'sd0.25': 0, 'sd0.30': 0, 'sd0.35': 0 }
  for (let i = 0; i < 500; i++) picks[pickShortDelta('bull_put_spread', 'sell', stats, rng)!.variant]++

  // A win/loss-reward bandit would crown sd0.25 (80% > 60%). The PnL reward
  // must instead favor sd0.35, while still exploring the others.
  assert.ok(picks['sd0.35'] > picks['sd0.25'], `EV arm ${picks['sd0.35']} vs POP arm ${picks['sd0.25']}`)
  assert.ok(picks['sd0.35'] > 250, `EV arm should dominate: ${picks['sd0.35']}/500`)
  assert.ok(picks['sd0.25'] + picks['sd0.30'] > 0, 'other arms must still get explored')
})

test('tuner: untuned strategies return null; non-arm strategies have no legs', () => {
  assert.equal(pickShortDelta('long_straddle', 'sell', new Map()), null)
  assert.equal(pickShortDelta('bull_call_spread', 'sell', new Map()), null)
  assert.equal(legsForShortDelta('long_straddle', 0.25), null)
})

test('condor: arm 0.20 reproduces the shipped asymmetric spec exactly', () => {
  const legs = legsForShortDelta('iron_condor', 0.2)!
  const d = (type: 'put' | 'call', action: 'sell' | 'buy') =>
    legs.find((l) => l.type === type && l.action === action)!.targetDelta
  assert.equal(d('put', 'sell'), 0.2)
  assert.equal(d('put', 'buy'), 0.1)
  assert.ok(Math.abs(d('call', 'sell') - 0.13) < 1e-9, `call sell ${d('call', 'sell')}`)
  assert.ok(Math.abs(d('call', 'buy') - 0.07) < 1e-9, `call buy ${d('call', 'buy')}`)
  // Structure sanity: put strikes further OTM than their wing is wrong-way — the
  // short is closer to spot (higher delta) than the long wing.
  assert.ok(d('put', 'sell') > d('put', 'buy') && d('call', 'sell') > d('call', 'buy'))
})

test('condor: tuner picks only condor arms and learns from its own outcomes', () => {
  // sd0.24 wins big, sd0.16 loses. Bounds ±1 → r=(pnl+1)/2.
  const w = (variant: string, pnl: number) =>
    snap({ strategyId: 'iron_condor', variant, maxProfit: 1, maxLoss: -1,
      outcome: { ...snap({}, true).outcome!, managedPnl: pnl } }, pnl > 0)
  const snaps: RecommendationSnapshot[] = []
  for (let i = 0; i < 14; i++) snaps.push(w('sd0.24', +0.8))
  for (let i = 0; i < 4; i++) snaps.push(w('sd0.24', -0.6))
  for (let i = 0; i < 6; i++) snaps.push(w('sd0.16', -0.7))

  const stats = buildArmStats(snaps)
  const rng = mulberry32(3)
  const picks: Record<string, number> = {}
  for (let i = 0; i < 500; i++) {
    const v = pickShortDelta('iron_condor', 'sell', stats, rng)!.variant
    picks[v] = (picks[v] ?? 0) + 1
  }
  const condorVariants = CONDOR_ARMS.map(variantId)
  assert.ok(Object.keys(picks).every((v) => condorVariants.includes(v)),
    `picked a non-condor arm: ${Object.keys(picks)}`)
  assert.ok((picks['sd0.24'] ?? 0) > (picks['sd0.16'] ?? 0),
    `winner ${picks['sd0.24']} vs loser ${picks['sd0.16']}`)
})

test('condor: legacy snapshots (no variant, old structure) are skipped, not mis-attributed', () => {
  const stats = buildArmStats([snap({ strategyId: 'iron_condor' }, true)]) // no variant
  for (const a of CONDOR_ARMS) {
    assert.equal(stats.get(`iron_condor|sell|${variantId(a)}`), undefined)
  }
})

test('engine: specOverrides moves the credit-spread short strike', () => {
  const { chain, expiration, spot } = syntheticChain()
  const base = { symbol: 'TEST', spot, expiration, chain, ivRank: 60, seed: 42, simulations: 500 }

  const def = runEngineLive(base)
  const tuned = runEngineLive({
    ...base,
    specOverrides: { bull_put_spread: legsForShortDelta('bull_put_spread', 0.2)! }
  })

  const shortStrike = (r: typeof def) =>
    r.results.find((x) => x.strategy === 'bull_put_spread')!
      .legs.find((l) => l.action === 'sell')!.strike

  // 20-delta put sits further OTM (lower strike) than the default 30-delta.
  assert.ok(shortStrike(tuned) < shortStrike(def),
    `tuned short strike ${shortStrike(tuned)} should be below default ${shortStrike(def)}`)

  // Other strategies are untouched by the override.
  const condorLegs = (r: typeof def) =>
    JSON.stringify(r.results.find((x) => x.strategy === 'iron_condor')?.legs.map((l) => l.strike))
  assert.equal(condorLegs(tuned), condorLegs(def))
})

// ---- specOverridesFromVariants: detail page replays the scanner's frozen arm ----

test('specOverridesFromVariants rebuilds the exact legs the scanner chose', async () => {
  const { specOverridesFromVariants, armsFor } = await import('../src/feedback/tuner.js')
  for (const st of ['iron_condor', 'bull_put_spread', 'bear_call_spread'] as const) {
    for (const d of armsFor(st)) {
      const rebuilt = specOverridesFromVariants({ [st]: variantId(d) })[st]
      assert.deepEqual(rebuilt, legsForShortDelta(st, d),
        `${st} @ ${variantId(d)} must rebuild the scanner's leg spec`)
    }
  }
})

test('specOverridesFromVariants ignores unknown/empty variants (no crash, no key)', async () => {
  const { specOverridesFromVariants } = await import('../src/feedback/tuner.js')
  assert.deepEqual(specOverridesFromVariants({ iron_condor: 'sd9.99' }), {})
  assert.deepEqual(specOverridesFromVariants({ iron_condor: '' }), {})
  assert.deepEqual(specOverridesFromVariants({}), {})
})

test('scan path and detail-replay path produce identical POP/EV (deterministic)', async () => {
  const { specOverridesFromVariants } = await import('../src/feedback/tuner.js')
  const { pickExitPolicy, SCAN_SIMULATIONS } = await import('../src/engine/oppScanner.js')
  const { chain, expiration, spot } = syntheticChain()
  const d = 0.24
  const icPolicy = pickExitPolicy('TEST')
  const base = {
    symbol: 'TEST', spot, expiration, chain, ivRank: 65,
    seed: 42, simulations: SCAN_SIMULATIONS,
    exitPolicies: { iron_condor: icPolicy } as const
  }

  // Scanner: pins the arm's legs directly.
  const scan = runEngineLive({
    ...base,
    specOverrides: { iron_condor: legsForShortDelta('iron_condor', d)! }
  })
  // Detail page: rebuilds the same legs from only the frozen variant id.
  const detail = runEngineLive({
    ...base,
    specOverrides: specOverridesFromVariants({ iron_condor: variantId(d) })
  })

  const sc = scan.results.find((r) => r.strategy === 'iron_condor')!
  const dt = detail.results.find((r) => r.strategy === 'iron_condor')!
  assert.deepEqual(dt.legs, sc.legs, 'legs identical')
  assert.equal(dt.metrics.probabilityProfit, sc.metrics.probabilityProfit, 'POP identical')
  assert.equal(dt.metrics.ev, sc.metrics.ev, 'EV identical')
})

test('replay flag (no variant) matches scanner sim count for debit spreads', async () => {
  const { SCAN_SIMULATIONS } = await import('../src/engine/oppScanner.js')
  const { chain, expiration, spot } = syntheticChain()
  const atScanCount = runEngineLive({
    symbol: 'TEST', spot, expiration, chain, ivRank: 65, seed: 42, simulations: SCAN_SIMULATIONS
  })
  const atRecommendCount = runEngineLive({
    symbol: 'TEST', spot, expiration, chain, ivRank: 65, seed: 42, simulations: 5000
  })
  const scan = atScanCount.results.find((r) => r.strategy === 'bull_call_spread')!
  const replay = atScanCount.results.find((r) => r.strategy === 'bull_call_spread')!
  const manual = atRecommendCount.results.find((r) => r.strategy === 'bull_call_spread')!
  assert.equal(replay.metrics.probabilityProfit, scan.metrics.probabilityProfit)
  assert.notEqual(manual.metrics.probabilityProfit, scan.metrics.probabilityProfit)
})
