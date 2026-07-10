/**
 * Directional debit spreads (bull_call / bear_put) are pure directional bets
 * with no standalone edge, so:
 *   1. the auto-scanner only surfaces them when an aligned view has earned skill
 *      weight (autoScanEligible),
 *   2. calibration ignores them entirely (their P&L is market direction, not
 *      skill) — they stay at 1×.
 * See DIRECTIONAL_DEBIT_SPREADS in engine/index.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoScanEligible } from '../src/engine/oppScanner.js'
import { buildCalibrationTable } from '../src/feedback/calibration.js'
import type { RecommendationSnapshot } from '../src/feedback/types.js'
import type { StrategyType } from '../src/engine/types.js'

test('autoScanEligible: non-directional structures always eligible', () => {
  for (const s of ['iron_condor', 'bull_put_spread', 'bear_call_spread'] as StrategyType[]) {
    assert.equal(autoScanEligible(s, undefined), true, `${s} with no view`)
    assert.equal(autoScanEligible(s, 'bullish'), true, `${s} with bullish`)
  }
})

test('autoScanEligible: directional debit spreads gated without an earned aligned view', () => {
  // No view, or a view at DEFAULT weight 0 → not eligible.
  assert.equal(autoScanEligible('bull_call_spread', undefined), false)
  assert.equal(autoScanEligible('bull_call_spread', 'bullish'), false) // bullish weight 0
  assert.equal(autoScanEligible('bear_put_spread', 'bearish'), false)  // bearish weight 0
  // With an earned + aligned view (override table), the aligned one becomes eligible.
  const skill = new Map([['bullish' as const, 0.6]])
  assert.equal(autoScanEligible('bull_call_spread', 'bullish', skill), true)
  assert.equal(autoScanEligible('bear_put_spread', 'bullish', skill), false) // wrong direction
})

test('calibration: directional debit spreads never enter the table (stay 1×)', () => {
  const mk = (strategyId: StrategyType, regime: 'sell' | 'buy' | 'mid', pnl: number): RecommendationSnapshot => ({
    id: Math.random().toString(), etDay: '2026-06-01', capturedAt: '', source: 'dashboard',
    sym: 'X', strategyId, expiration: '2026-07-01', spot: 100, iv: 0.3, ivr: 50,
    rvAtScan: null, ivRvGap: null, regime, score: 1, pop: 0.6, ev: 0.1, netPremium: -1,
    maxProfit: 3, maxLoss: -2, dte: 30, breakevens: [], legs: [],
    outcome: {
      computedAt: '', horizonDays: 5, tradingDaysUsed: 5, realizedVolAnnualized: null,
      spotMin: null, spotMax: null, pnlPathMin: null, pnlPathMax: null,
      pnlAtExpirationClose: null, stopHit: false, stopThresholdUsed: 0,
      nearBreakevenTouched: false, managedPnl: pnl, managedExitDay: null, managedExitReason: 'expiry'
    }
  })
  const snaps: RecommendationSnapshot[] = []
  // bear_put: many big winners (would earn a high multiplier if calibrated)
  for (let i = 0; i < 12; i++) snaps.push(mk('bear_put_spread', 'buy', 5))
  // iron_condor: a normal calibrated bucket (control)
  for (let i = 0; i < 12; i++) snaps.push(mk('iron_condor', 'sell', 1))

  const table = buildCalibrationTable(snaps)
  assert.equal(table.has('bear_put_spread|buy'), false, 'bear_put must be excluded from calibration')
  assert.equal(table.has('bull_call_spread|buy'), false, 'bull_call must be excluded from calibration')
  assert.ok(table.has('iron_condor|sell'), 'non-directional buckets are still calibrated')
})
