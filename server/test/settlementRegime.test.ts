import test from 'node:test'
import assert from 'node:assert/strict'
import { SETTLEMENT_VERSION, isCurrentRegime } from '../src/feedback/settlementVersion.js'
import { buildArmStats, armKey, variantId } from '../src/feedback/tuner.js'
import { buildCalibrationTable, calibrationMultiplier } from '../src/feedback/calibration.js'
import type { RecommendationSnapshot } from '../src/feedback/types.js'
import { feedbackDegradations } from '../src/feedback/health.js'

const snap = (
  pnl: number, version?: string, strategyId = 'bull_put_spread'
): RecommendationSnapshot => ({
  id: `x${strategyId}${pnl}${version ?? 'none'}${Math.abs(pnl)}`,
  etDay: '2026-06-01',
  capturedAt: '2026-06-01T00:00:00Z',
  source: 'dashboard',
  sym: 'IWM',
  strategyId,
  expiration: '2026-07-17',
  spot: 200, iv: 0.2, ivr: 50, rvAtScan: 0.18, ivRvGap: 0.02,
  regime: 'sell', score: 0.1, pop: 0.8, ev: 0.5,
  netPremium: 1, maxProfit: 1, maxLoss: -4, dte: 46,
  legs: [], variant: variantId(0.25, strategyId as any),
  outcome: {
    computedAt: '2026-06-01T00:00:00Z',
    ...(version !== undefined ? { settlementVersion: version } : {}),
    horizonDays: 25, tradingDaysUsed: 18, realizedVolAnnualized: 0.17,
    spotMin: null, spotMax: null, pnlPathMin: null, pnlPathMax: null,
    pnlAtExpirationClose: null, stopHit: false, stopThresholdUsed: 2,
    nearBreakevenTouched: false,
    managedPnl: pnl, managedExitDay: null, managedExitReason: 'take_profit'
  }
} as any)

test('settlement regime: an un-stamped outcome is not current', () => {
  assert.equal(isCurrentRegime(undefined), false)
  assert.equal(isCurrentRegime({}), false)
  assert.equal(isCurrentRegime({ settlementVersion: 'nope' }), false)
  assert.equal(isCurrentRegime({ settlementVersion: SETTLEMENT_VERSION }), true)
})

// The whole point: 431 outcomes in the book were produced by marking code that
// has since been replaced five times. They look identical to fresh ones, so
// without this filter the tuner learns from rulers that no longer exist.
test('tuner: outcomes from a superseded regime contribute nothing', () => {
  const k = armKey('bull_put_spread', 'sell', variantId(0.25, 'bull_put_spread'))

  const stale = buildArmStats([snap(5), snap(5, 'OLD'), snap(5)])
  assert.equal(stale.get(k), undefined, 'no arm may be built from stale-regime outcomes')

  const fresh = buildArmStats([snap(5, SETTLEMENT_VERSION), snap(3, SETTLEMENT_VERSION)])
  assert.equal(fresh.get(k)?.n, 2)
  assert.equal(fresh.get(k)?.sum, 8)
})

test('calibration: a superseded regime leaves the multiplier neutral', () => {
  // The multiplier is RELATIVE to the book's own average, so a bucket that only
  // matches the baseline stays 1x however good it looks in absolute terms. Two
  // buckets are needed for any of these assertions to mean anything.
  const book = (v?: string) => [
    snap(9, v, 'bull_put_spread'), snap(9, v, 'bull_put_spread'),
    snap(9, v, 'bull_put_spread'), snap(8, v, 'bull_put_spread'),
    snap(-1, v, 'iron_condor'), snap(-1, v, 'iron_condor'),
    snap(-1, v, 'iron_condor'), snap(-2, v, 'iron_condor')
  ]

  const stale = buildCalibrationTable(book())
  assert.equal(stale.size, 0, 'a book of stale-regime outcomes yields no table at all')
  assert.equal(calibrationMultiplier(stale, 'bull_put_spread', 'sell'), 1)

  const fresh = buildCalibrationTable(book(SETTLEMENT_VERSION))
  const winner = calibrationMultiplier(fresh, 'bull_put_spread', 'sell')
  const loser = calibrationMultiplier(fresh, 'iron_condor', 'sell')
  assert.ok(winner > 1, `same outcomes, current regime — winner must lift: ${winner}`)
  assert.ok(loser < 1, `and the losing bucket must be damped: ${loser}`)
})

test('settlement regime: mixing regimes never silently averages them', () => {
  const k = armKey('bull_put_spread', 'sell', variantId(0.25, 'bull_put_spread'))
  const mixed = buildArmStats([
    snap(10, SETTLEMENT_VERSION),
    snap(-10, 'OLD'),          // would halve the mean if it leaked in
    snap(10, SETTLEMENT_VERSION)
  ])
  assert.equal(mixed.get(k)?.n, 2)
  assert.equal(mixed.get(k)?.sum, 20, 'the superseded loss must not dilute the current mean')
})


// The loudest case was the silent one: `buildCalibrationTable` returned early
// on an empty table BEFORE reporting, and an empty table is exactly what "the
// entire book predates the current regime" produces. Reporting only on the
// success path meant the one condition an operator must be told about was the
// one condition that said nothing.
test('calibration: an all-stale book still reports, even though the table is empty', () => {
  const stale = [snap(5, 'ancient'), snap(-3, 'ancient'), snap(2, undefined)]
  const table = buildCalibrationTable(stale)

  assert.equal(table.size, 0, 'nothing is learnable from a fully superseded book')
  // Degradation state is process-global and other tests populate the tuner
  // entry, so select this source explicitly rather than taking the first.
  const d = feedbackDegradations().find(
    (x) => x.what === 'settlement' && x.message.startsWith('calibration:')
  )
  assert.ok(d, 'an all-stale book MUST surface a settlement degradation')
  assert.match(d!.message, /calibration: 3\/3/)
  assert.match(d!.message, new RegExp(SETTLEMENT_VERSION))
})

// calibration and the tuner scan different subsets, so they legitimately reach
// different skipped/total denominators. Keying both onto a bare 'settlement'
// made the displayed count depend on whichever table built last — a number
// that flaps between refreshes reads as a broken counter, not a real boundary.
test('health: calibration and tuner report stale settlements independently', () => {
  const stale = [snap(5, 'ancient'), snap(-3, 'ancient'), snap(2, undefined)]
  buildCalibrationTable(stale)
  buildArmStats(stale)

  const all = feedbackDegradations().filter((x) => x.what === 'settlement')
  assert.equal(all.length, 2, 'both sources must survive; neither overwrites the other')
  assert.ok(all.some((d) => d.message.startsWith('calibration:')))
  assert.ok(all.some((d) => d.message.startsWith('tuner:')))
})

// …and it must clear itself once the book is re-settled, or the banner becomes
// permanent furniture that everyone learns to ignore.
test('health: a fully current book clears the settlement degradation', () => {
  buildCalibrationTable([snap(5, 'ancient')])
  assert.ok(feedbackDegradations().some((x) => x.what === 'settlement'))

  buildCalibrationTable([snap(5, SETTLEMENT_VERSION), snap(-3, SETTLEMENT_VERSION)])
  buildArmStats([snap(5, SETTLEMENT_VERSION)])
  assert.equal(feedbackDegradations().filter((x) => x.what === 'settlement').length, 0)
})
