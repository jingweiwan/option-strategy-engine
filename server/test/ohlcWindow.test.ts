/**
 * Regression tests for the daily-candle window cache.
 *
 * These exist because of a real, silent production failure: Nasdaq's historical
 * endpoint returns ZERO rows for a narrow window whose end date is in the past
 * (SPY 2026-05-12→2026-06-05 → 0 rows) while the SAME start anchored at today
 * returns the full window (73 rows, earliest 05/12). MarketData — the fallback —
 * was 429'd, so 289 of 450 settlements quietly produced `tradingDaysUsed: 0`
 * and null P&L, and the learning layer was told the history did not exist.
 *
 * So every assertion here is about the SHAPE OF THE REQUEST and about refusing
 * to remember coverage we did not actually receive.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getDailyBars, __setOhlcFetcherForTest, type OhlcBar } from '../src/api/marketdata.js'
import { etCalendarDay } from '../src/ai/cache.js'

const DAY = 86_400_000
const today = etCalendarDay()
const iso = (d: number) => new Date(Date.parse(today) + d * DAY).toISOString().slice(0, 10)

/** One bar per calendar day in [from, to] — the code never assumes trading days. */
function bars(from: string, to: string): OhlcBar[] {
  const out: OhlcBar[] = []
  for (let t = Date.parse(from); t <= Date.parse(to); t += DAY) {
    const date = new Date(t).toISOString().slice(0, 10)
    out.push({ date, open: 1, high: 1, low: 1, close: 1, volume: 0 })
  }
  return out
}

type Call = { sym: string; from: string; to: string }

function fakeProvider(reply: (c: Call) => OhlcBar[]): { calls: Call[] } {
  const calls: Call[] = []
  __setOhlcFetcherForTest(async (sym, from, to) => {
    calls.push({ sym, from, to })
    return reply({ sym, from, to })
  })
  return { calls }
}

test('narrow historical window is fetched anchored at today, not at the requested end', async () => {
  // The exact production shape: ask for a window that ended months ago.
  const { calls } = fakeProvider((c) => bars(c.from, c.to))
  const got = await getDailyBars('SPY', iso(-100), iso(-80))

  assert.equal(calls.length, 1)
  assert.equal(calls[0].from, iso(-100))
  assert.equal(calls[0].to, today, 'must anchor at today — a past end date returns 0 rows upstream')
  // …and the caller still gets exactly the window it asked for.
  assert.equal(got[0].date, iso(-100))
  assert.equal(got[got.length - 1].date, iso(-80))
  __setOhlcFetcherForTest(null)
})

test('a wider cached series serves a narrower request without refetching', async () => {
  const { calls } = fakeProvider((c) => bars(c.from, c.to))
  await getDailyBars('SPY', iso(-100), iso(-80))
  const got = await getDailyBars('SPY', iso(-90), iso(-85))

  assert.equal(calls.length, 1, 'second window must be sliced from the cached series')
  assert.equal(got.length, 6)
  assert.equal(got[0].date, iso(-90))
  assert.equal(got[got.length - 1].date, iso(-85))
  __setOhlcFetcherForTest(null)
})

test('an empty result is NOT cached as "this symbol has no history"', async () => {
  // The production failure mode: caching the empty answer would keep the
  // symbol dark for the whole TTL and make settlement silently unrecoverable.
  const { calls } = fakeProvider(() => [])
  assert.equal((await getDailyBars('SPY', iso(-100), iso(-80))).length, 0)
  assert.equal((await getDailyBars('SPY', iso(-100), iso(-80))).length, 0)
  assert.equal(calls.length, 2, 'an empty answer must be retried, not remembered')
  __setOhlcFetcherForTest(null)
})

test('a provider that truncates the TAIL does not get recorded as full coverage', async () => {
  // Provider ignores the anchor and stops 40 days ago. If we cached
  // `through: today`, the next request for the recent window would slice to
  // zero bars and never refetch — the original bug wearing a new costume.
  const { calls } = fakeProvider((c) => bars(c.from, iso(-40)))
  await getDailyBars('SPY', iso(-100), iso(-80))
  const recent = await getDailyBars('SPY', iso(-30), iso(-10))

  assert.equal(calls.length, 2, 'coverage past the last bar must trigger a refetch')
  assert.equal(recent.length, 0, 'and must report honestly that the provider has nothing there')
  __setOhlcFetcherForTest(null)
})

test('a provider that clamps the START does not get recorded as full coverage', async () => {
  // Nasdaq demonstrably does this: fromdate 05-12 came back starting 05-26.
  const { calls } = fakeProvider((c) => bars(iso(-60), c.to))
  await getDailyBars('SPY', iso(-100), iso(-80))
  await getDailyBars('SPY', iso(-100), iso(-70))

  assert.equal(calls.length, 2, 'a clamped start must not be remembered as the requested start')
  __setOhlcFetcherForTest(null)
})

test('a normal tail lag (weekend / unprinted bar) still counts as full coverage', async () => {
  // Today's bar does not exist before the close; that must not defeat the cache.
  const { calls } = fakeProvider((c) => bars(c.from, iso(-3)))
  await getDailyBars('SPY', iso(-100), iso(-80))
  await getDailyBars('SPY', iso(-20), iso(-5))

  assert.equal(calls.length, 1, 'a few days of lag is normal, not truncation')
  __setOhlcFetcherForTest(null)
})
