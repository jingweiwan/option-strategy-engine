/**
 * Shadow arm learning — invariants:
 *   1. Settled shadow rows update the tuner's arm posteriors (losing arms
 *      finally accumulate evidence — the selection-bias fix).
 *   2. A shadow row duplicating a surfaced (dashboard) row on the same
 *      (etDay × sym × strategy × variant) is counted once.
 *   3. Calibration ignores shadow rows (it measures the recommended book).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildArmStats } from '../src/feedback/tuner.js'
import { buildCalibrationTable, normalizedReward } from '../src/feedback/calibration.js'
import type { RecommendationSnapshot } from '../src/feedback/types.js'

function snap(over: Partial<RecommendationSnapshot>, win: boolean): RecommendationSnapshot {
  return {
    id: 'x', etDay: '2026-06-01', capturedAt: '', source: 'dashboard',
    sym: 'TEST', strategyId: 'iron_condor', expiration: '2026-07-01',
    spot: 100, iv: 0.3, ivr: 50, rvAtScan: null, ivRvGap: null,
    regime: 'sell', score: 1, pop: 0.7, ev: 0.1, netPremium: 1,
    maxProfit: 1, maxLoss: -4, dte: 30, breakevens: [], legs: [],
    variant: 'sd0.16',
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

test('shadow rows feed arm posteriors — losing arms accumulate evidence', () => {
  // The 0.20 arm was never surfaced (score ≤ 0) but its shadow rows settled.
  const stats = buildArmStats([
    snap({ source: 'shadow', variant: 'sd0.20' }, false),
    snap({ source: 'shadow', variant: 'sd0.20', etDay: '2026-06-02' }, false)
  ])
  const s = stats.get('iron_condor|sell|sd0.20')
  assert.ok(s, 'shadow-only arm has a posterior')
  assert.equal(s!.n, 2)
  assert.ok(s!.failMass > s!.rewardMass, 'losses actually registered')
})

test('shadow row duplicating a surfaced row is counted once (surfaced wins)', () => {
  const stats = buildArmStats([
    snap({}, true), // surfaced sd0.16
    snap({ source: 'shadow' }, true), // same day/sym/strategy/variant → skipped
    snap({ source: 'shadow', variant: 'sd0.24' }, false) // different arm → kept
  ])
  assert.equal(stats.get('iron_condor|sell|sd0.16')!.n, 1, 'no double count')
  assert.equal(stats.get('iron_condor|sell|sd0.24')!.n, 1)
})

test('calibration skips shadow rows entirely', () => {
  // 6 dashboard wins (≥ MIN_SAMPLES) + a pile of shadow losses that must not
  // drag the multiplier down.
  const rows: RecommendationSnapshot[] = []
  for (let i = 0; i < 6; i++) rows.push(snap({ etDay: `2026-06-0${i + 1}` }, true))
  for (let i = 0; i < 12; i++) rows.push(snap({ source: 'shadow', variant: 'sd0.24', etDay: `2026-06-${10 + i}` }, false))
  const withShadow = buildCalibrationTable(rows)
  const withoutShadow = buildCalibrationTable(rows.filter((r) => r.source !== 'shadow'))
  assert.deepEqual([...withShadow.entries()], [...withoutShadow.entries()], 'shadow rows changed calibration')
})

test('normalizedReward sanity: loss maps below 0.5, win above', () => {
  assert.ok(normalizedReward(-1, -4) < 0.5)
  assert.ok(normalizedReward(0.5, -4) > 0.5)
})
