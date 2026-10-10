/**
 * Settlement must wait for the window's final CLOSE.
 *
 * The production failure (found on the 2026-09-17 re-settle): `snapshotPastHorizon`
 * compared the UTC date with the window's last day, so a window ending 2026-09-04
 * was "due" at 2026-09-04T00:00Z — 20:00 ET on 09-03. The auto-hydrate ran at
 * 01Z/04Z/07Z, settled without the final bar, and stamped the result current-
 * regime so nothing ever recomputed it. 642 outcomes moved once the bar was
 * restored; every one had been computed on its window-end day before the close.
 * Under the 'user' policy that day is the expiration itself.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lastSettledEtDay, lastWeekdayOnOrBefore, addCalendarDays, __setNowForTest } from '../src/api/marketSession.js'
import { snapshotPastHorizon } from '../src/feedback/hydrate.js'
import { tailPublished, computeOutcomeForSnapshot, SettlementNotReadyError } from '../src/feedback/outcome.js'
import { getDailyBars, __setOhlcFetcherForTest, type OhlcBar } from '../src/api/marketdata.js'
import { etCalendarDay } from '../src/ai/cache.js'
import type { RecommendationSnapshot } from '../src/feedback/types.js'

const at = (iso: string) => new Date(iso)

test('lastSettledEtDay: a session settles at 17:00 ET, in both EDT and EST', () => {
  assert.equal(lastSettledEtDay(at('2026-09-17T07:00:00Z')), '2026-09-16') // 03:00 EDT
  assert.equal(lastSettledEtDay(at('2026-09-17T20:30:00Z')), '2026-09-16') // 16:30 EDT — closed, not yet printed
  assert.equal(lastSettledEtDay(at('2026-09-17T21:05:00Z')), '2026-09-17') // 17:05 EDT
  assert.equal(lastSettledEtDay(at('2026-12-01T21:30:00Z')), '2026-11-30') // 16:30 EST
  assert.equal(lastSettledEtDay(at('2026-12-01T22:05:00Z')), '2026-12-01') // 17:05 EST
  // 00:30Z is still the previous ET evening — the exact instant the UTC rule got wrong.
  assert.equal(lastSettledEtDay(at('2026-09-18T00:30:00Z')), '2026-09-17')
})

test('snapshotPastHorizon: the 2026-08-23 TSLA row was settled 16 hours early', () => {
  const s = { etDay: '2026-08-23' } // + 12 days → window ends 2026-09-04
  assert.equal(snapshotPastHorizon(s, 12, at('2026-09-04T04:05:00Z')), false, 'the real computedAt — before the 09-04 close')
  assert.equal(snapshotPastHorizon(s, 12, at('2026-09-04T19:59:00Z')), false, '15:59 ET — session still open')
  assert.equal(snapshotPastHorizon(s, 12, at('2026-09-04T21:30:00Z')), true)
})

test("snapshotPastHorizon: a 'user' window that ends on expiration waits for the expiry print", () => {
  const s = { etDay: '2026-09-01' } // + 31 → 2026-10-02 expiration
  assert.equal(addCalendarDays(s.etDay, 31), '2026-10-02')
  assert.equal(snapshotPastHorizon(s, 31, at('2026-10-02T13:00:00Z')), false)
  assert.equal(snapshotPastHorizon(s, 31, at('2026-10-02T21:30:00Z')), true)
})

test('lastWeekdayOnOrBefore: weekends fall back to Friday', () => {
  assert.equal(lastWeekdayOnOrBefore('2026-09-19'), '2026-09-18') // Sat
  assert.equal(lastWeekdayOnOrBefore('2026-09-20'), '2026-09-18') // Sun
  assert.equal(lastWeekdayOnOrBefore('2026-09-17'), '2026-09-17') // Thu
})

test('tailPublished: missing final bar is "not yet", until the grace period says holiday', () => {
  const eve = (d: string) => at(`${d}T21:30:00Z`)
  assert.equal(tailPublished('2026-09-17', '2026-09-17', eve('2026-09-17')), true)
  assert.equal(tailPublished('2026-09-16', '2026-09-17', eve('2026-09-17')), false, 'provider has not printed 09-17')
  assert.equal(tailPublished(null, '2026-09-17', eve('2026-09-18')), false, 'empty recent window is not an answer')
  assert.equal(tailPublished('2026-09-18', '2026-09-19', eve('2026-09-19')), true, 'Saturday window: Friday is the last bar')
  // Good Friday 2027-03-26: last bar is Thursday; accepted once the grace period passes.
  assert.equal(tailPublished('2027-03-25', '2027-03-26', eve('2027-03-27')), false)
  assert.equal(tailPublished('2027-03-25', '2027-03-26', eve('2027-03-30')), true)
})

// ---- end to end through the bar cache ----

const today = etCalendarDay()
const DAY = 86_400_000
const iso = (d: number) => new Date(Date.parse(today) + d * DAY).toISOString().slice(0, 10)
// 14:00Z is 10:00 EDT / 09:00 EST; 23:30Z is 19:30 EDT / 18:30 EST — same ET day either way.
const morning = at(`${today}T14:00:00Z`)
const evening = at(`${today}T23:30:00Z`)

function barsThrough(from: string, to: string): OhlcBar[] {
  const out: OhlcBar[] = []
  for (let t = Date.parse(from); t <= Date.parse(to); t += DAY) {
    out.push({ date: new Date(t).toISOString().slice(0, 10), open: 100, high: 100, low: 100, close: 100, volume: 0 })
  }
  return out
}

function provider(reply: (from: string, to: string) => OhlcBar[] | Promise<OhlcBar[]>): { calls: number } {
  const box = { calls: 0 }
  __setOhlcFetcherForTest(async (_sym, from, to) => {
    box.calls++
    return reply(from, to)
  })
  return box
}

test('bar cache: a series fetched before the close is refetched once the session settles', async () => {
  const p = provider((from) => barsThrough(from, iso(-1)))
  __setNowForTest(() => morning)
  await getDailyBars('SPY', iso(-10), today)
  await getDailyBars('SPY', iso(-10), today)
  assert.equal(p.calls, 1, 'intraday callers keep hitting the cache — nothing new can exist')
  __setNowForTest(() => evening)
  await getDailyBars('SPY', iso(-10), today)
  assert.equal(p.calls, 2, 'after the close the morning series cannot contain today')
  await getDailyBars('SPY', iso(-10), today)
  assert.equal(p.calls, 2)
  __setNowForTest(null)
  __setOhlcFetcherForTest(null)
})

test('bar cache: a window that ended before the fetch is still served from cache after the close', async () => {
  const p = provider((from, to) => barsThrough(from, to))
  __setNowForTest(() => morning)
  await getDailyBars('SPY', iso(-20), today)
  __setNowForTest(() => evening)
  await getDailyBars('SPY', iso(-20), iso(-5))
  assert.equal(p.calls, 1)
  __setNowForTest(null)
  __setOhlcFetcherForTest(null)
})

function snap(etDay: string, dte: number): RecommendationSnapshot {
  return {
    id: 'tail-test', etDay, capturedAt: `${etDay}T14:00:00Z`, source: 'dashboard', sym: 'SPY',
    strategyId: 'bull_put_spread', expiration: addCalendarDays(etDay, dte), spot: 100, iv: 0.2, ivr: 50,
    rvAtScan: 0.18, ivRvGap: 0.02, regime: 'sell', score: 0.1, pop: 0.8, ev: 0.1, netPremium: 1,
    maxProfit: 1, maxLoss: -4, dte, breakevens: [99], exitPolicy: 'user',
    legs: [
      { type: 'put', action: 'sell', strike: 100, premium: 2, quantity: 1 },
      { type: 'put', action: 'buy', strike: 95, premium: 1, quantity: 1 }
    ],
    outcome: null
  } as RecommendationSnapshot
}

test('computeOutcomeForSnapshot: refuses to settle a window whose final close is missing', async () => {
  const end = lastWeekdayOnOrBefore(today)
  const s = snap(addCalendarDays(end, -10), 10)
  __setNowForTest(() => evening)
  provider((from) => barsThrough(from, addCalendarDays(end, -1)))
  await assert.rejects(computeOutcomeForSnapshot(s, { horizonDays: 10 }), SettlementNotReadyError)
  __setOhlcFetcherForTest(null)
  __setNowForTest(null)
})

test('computeOutcomeForSnapshot: a fetch failure is retried later, never persisted as "no history"', async () => {
  const end = lastWeekdayOnOrBefore(today)
  const s = snap(addCalendarDays(end, -10), 10)
  __setNowForTest(() => evening)
  // Both providers fail: the real fetcher swallows Nasdaq errors, so a throw here
  // stands in for MarketData's 429.
  provider(() => { throw new Error('429 Too Many Requests') })
  await assert.rejects(computeOutcomeForSnapshot(s, { horizonDays: 10 }), SettlementNotReadyError)
  __setOhlcFetcherForTest(null)
  __setNowForTest(null)
})

test('computeOutcomeForSnapshot: settles once the final close is in', async () => {
  const end = lastWeekdayOnOrBefore(today)
  const s = snap(addCalendarDays(end, -10), 10)
  __setNowForTest(() => evening)
  provider((from, to) => barsThrough(from, to))
  const o = await computeOutcomeForSnapshot(s, { horizonDays: 10 })
  assert.equal(o.tradingDaysUsed, 11, 'etDay through window end inclusive, final day included')
  assert.notEqual(o.managedPnl, null)
  __setOhlcFetcherForTest(null)
  __setNowForTest(null)
})
