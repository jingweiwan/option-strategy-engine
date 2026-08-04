/**
 * fix/condor-reward-formula — realign the tuner reward with realized $/trade.
 *
 * The offline replay (2,388 trades) showed that even with equal-$ wings the
 * condor tuner still ranked arms INVERSELY to money made: the arm with the
 * higher mean realized $ scored the LOWER reward. Root cause: the reward was
 * per-trade return-on-capital-at-risk (0.5 + 0.5·pnl/|maxLoss|), which favors
 * the bigger-credit/tighter-maxLoss arm regardless of win-rate-weighted $. The
 * account trades a FIXED number of contracts, so $/trade — not return per dollar
 * risked — is the objective.
 *
 * Fix (direction 2): score arms by a mean-variance posterior over per-trade RAW
 * $/share P&L (NOT pnl/spot — dividing by spot re-inverts it, over-crediting
 * wins on cheap underlyings; the OOS replay confirmed that). The arm with the
 * higher mean $/trade must be picked more often; variance only governs
 * exploration.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildArmStats, pickShortDelta, variantId } from '../src/feedback/tuner.js'
import { shortDeltaFromVariant } from '../src/backtest/replay.js'
import type { RecommendationSnapshot } from '../src/feedback/types.js'

test('shortDeltaFromVariant strips the structure epoch (condor @w2 → number, not NaN)', () => {
  assert.equal(shortDeltaFromVariant(variantId(0.16, 'iron_condor')), 0.16) // 'sd0.16@w2'
  assert.equal(shortDeltaFromVariant('sd0.16@w2'), 0.16)
  assert.equal(shortDeltaFromVariant('sd0.30'), 0.3)
})

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function condorTrade(variant: string, pnl: number, maxLoss: number, spot = 100): RecommendationSnapshot {
  return {
    id: `${variant}-${pnl}-${Math.random()}`,
    etDay: '2026-07-01',
    capturedAt: '2026-07-01',
    source: 'dashboard',
    sym: 'TEST',
    strategyId: 'iron_condor',
    expiration: '2026-08-21',
    spot,
    iv: 0.3,
    ivr: 50,
    rvAtScan: null,
    ivRvGap: null,
    regime: 'mid',
    score: 0,
    pop: 0,
    ev: 0,
    netPremium: 0,
    maxProfit: Math.abs(pnl),
    maxLoss,
    dte: 30,
    breakevens: [],
    legs: [],
    variant,
    aiView: null,
    aiViewConfidence: null,
    exitPolicy: null,
    outcome: {
      computedAt: '2026-07-20',
      horizonDays: 5,
      tradingDaysUsed: 5,
      realizedVolAnnualized: null,
      spotMin: spot,
      spotMax: spot,
      pnlPathMin: pnl,
      pnlPathMax: pnl,
      pnlAtExpirationClose: pnl,
      stopHit: false,
      stopThresholdUsed: null,
      nearBreakevenTouched: false,
      managedPnl: pnl,
      managedExitDay: null,
      managedExitReason: null,
      note: null
    }
  } as unknown as RecommendationSnapshot
}

test('condor tuner picks the higher-$/trade arm, not the higher return-on-risk arm', () => {
  const HIGH$ = variantId(0.16, 'iron_condor') // more money/trade, big maxLoss (low return-on-risk)
  const LOW$ = variantId(0.24, 'iron_condor') // less money/trade, small maxLoss (high return-on-risk)

  const snaps: RecommendationSnapshot[] = []
  // sd0.16: mean pnl +1.0, but wide maxLoss -12 → OLD reward = 0.5+0.5·1/12 = 0.542
  for (let i = 0; i < 20; i++) snaps.push(condorTrade(HIGH$, +1.0, -12))
  // sd0.24: mean pnl +0.5, tight maxLoss -4 → OLD reward = 0.5+0.5·0.5/4 = 0.5625 (higher!)
  for (let i = 0; i < 20; i++) snaps.push(condorTrade(LOW$, +0.5, -4))

  const stats = buildArmStats(snaps)
  const rng = mulberry32(7)
  const picks: Record<string, number> = {}
  for (let i = 0; i < 800; i++) {
    const v = pickShortDelta('iron_condor', 'mid', stats, rng)!.variant
    picks[v] = (picks[v] ?? 0) + 1
  }
  assert.ok(
    (picks[HIGH$] ?? 0) > (picks[LOW$] ?? 0),
    `must favor the higher-$/trade arm: sd0.16=${picks[HIGH$]} vs sd0.24=${picks[LOW$]}`
  )
})
