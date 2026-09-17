/**
 * Performance page aggregation (feedback/performance.ts).
 *
 * The page read as "SPY: 444 recommendations, always wins" and "LLY: −$11,800"
 * on 2026-09-17. SPY had 57 cards; LLY had none — both tables were counting
 * shadow tuner arms, pooling long straddles with condors, and summing dollars
 * across a 21:1 win/max-loss ratio. These tests pin each correction.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeGroupStats,
  performanceScope,
  splitBook,
  symbolStrategyStats
} from '../src/feedback/performance.js'
import type { RecommendationSnapshot } from '../src/feedback/types.js'

let n = 0
function row(p: Partial<RecommendationSnapshot> & { pnl?: number | null }): RecommendationSnapshot {
  const { pnl, ...rest } = p
  return {
    id: `r${n++}`, etDay: '2026-06-01', capturedAt: '2026-06-01T14:00:00Z', source: 'dashboard', sym: 'SPY',
    strategyId: 'iron_condor', expiration: '2026-07-17', spot: 740, iv: 0.15, ivr: 40, rvAtScan: 0.12,
    ivRvGap: 0.03, regime: 'sell', score: 0.1, pop: 0.8, ev: 0.2, netPremium: 3.8, maxProfit: 3.8,
    maxLoss: -37.2, dte: 46, breakevens: [], legs: [],
    outcome: pnl === undefined ? null : {
      computedAt: '2026-06-20T22:00:00Z', settlementVersion: 's2', horizonDays: 25, tradingDaysUsed: 18,
      realizedVolAnnualized: 0.1, spotMin: 700, spotMax: 760, pnlPathMin: -1, pnlPathMax: 2,
      pnlAtExpirationClose: null, stopHit: false, stopThresholdUsed: 7.6, nearBreakevenTouched: false,
      managedPnl: pnl, managedExitDay: '2026-06-20', managedExitReason: 'take_profit'
    },
    ...rest
  } as RecommendationSnapshot
}

test('shadow arms are not recommendations: the book excludes them', () => {
  const rows = [row({ pnl: 1 }), row({ source: 'shadow', pnl: -5 }), row({ source: 'shadow', sym: 'LLY', pnl: -40 })]
  const { book, shadow } = splitBook(rows)
  assert.equal(book.length, 1)
  assert.equal(shadow.length, 2)
  assert.equal(symbolStrategyStats(book).some((g) => g.label === 'LLY'), false, 'never carded → not on the page')
})

test('symbol × strategy rows keep a straddle loss from reading as "META loses"', () => {
  const book = [
    row({ sym: 'META', strategyId: 'long_straddle', maxLoss: -25, pnl: -11.6 }),
    row({ sym: 'META', strategyId: 'short_strangle', maxLoss: null, pnl: 0.6 }),
    row({ sym: 'META', strategyId: 'short_strangle', maxLoss: null, pnl: 0.5, etDay: '2026-06-02' }),
    row({ sym: 'SPY', pnl: 1.86 })
  ]
  const g = symbolStrategyStats(book)
  assert.deepEqual(g.map((x) => `${x.label}/${x.strategy}`), ['META/short_strangle', 'META/long_straddle', 'SPY/iron_condor'])
  const straddle = g.find((x) => x.strategy === 'long_straddle')!
  assert.equal(Math.round(straddle.totalPnl), -1160)
})

test('returnOnRisk: a 92% condor book is measured against what it can lose', () => {
  // 12 wins of $186 and one max loss of $3,720 on the same $3,720 structure.
  const rows = [
    ...Array.from({ length: 12 }, (_, i) => row({ pnl: 1.86, etDay: `2026-06-${String(i + 1).padStart(2, '0')}` })),
    row({ pnl: -37.2, etDay: '2026-06-13' })
  ]
  const s = computeGroupStats('SPY', rows)
  assert.equal(s.winRate, 12 / 13)
  assert.ok(Math.abs(s.returnOnRisk! - (12 * 186 - 3720) / (13 * 3720)) < 1e-9)
  assert.ok(s.returnOnRisk! < 0, '92% winners, still negative per dollar at risk')
  assert.equal(s.days, 13)
})

test('days counts independent entry days, not rows', () => {
  const rows = [row({ pnl: 1 }), row({ pnl: 1 }), row({ pnl: 1, etDay: '2026-06-02' }), row({})]
  assert.equal(computeGroupStats('x', rows).days, 2, 'same-day rows share a price path; unsettled rows do not count')
})

test('unbounded structures are counted but kept out of returnOnRisk', () => {
  const s = computeGroupStats('x', [row({ strategyId: 'short_strangle', maxLoss: null, pnl: 4.2 })])
  assert.equal(s.unbounded, 1)
  assert.equal(s.returnOnRisk, null)
})

test('a debit structure recorded without maxLoss is bounded by what it paid', () => {
  // The 2026-05-17 AMD straddle: net −83.925, maxLoss null.
  const s = computeGroupStats('AMD', [row({ strategyId: 'long_straddle', netPremium: -83.925, maxLoss: null, pnl: -40 })])
  assert.equal(s.unbounded, 0)
  assert.ok(Math.abs(s.returnOnRisk! - -4000 / 8392.5) < 1e-9)
})

test('scope reports the ruler, the date range and the independent days of the priced book', () => {
  const book = [
    row({ pnl: 1, etDay: '2026-05-12' }),
    row({ pnl: -2, etDay: '2026-08-30' }),
    row({ pnl: 1, etDay: '2026-09-02' }),               // unstamped, after the cutoff → 'user'
    row({ pnl: 1, etDay: '2026-09-02', exitPolicy: 'runner' }),
    row({ etDay: '2026-09-10' })                         // not settled
  ]
  const sc = performanceScope(book, 99)
  assert.equal(sc.bookRows, 5)
  assert.equal(sc.shadowRows, 99)
  assert.equal(sc.settledFrom, '2026-05-12')
  assert.equal(sc.settledTo, '2026-09-02')
  assert.equal(sc.settledDays, 3)
  assert.deepEqual(sc.rulers, { managed: 2, user: 1, runner: 1 })
})
