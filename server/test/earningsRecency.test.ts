/**
 * Post-print earnings recency gate (缺陷 3 · 杠杆①):
 *   - default N=0: only today's ET calendar date (AMC yesterday → today OK)
 *   - today must NOT enter nextEarnIso (else spansEarnings kills recency — dead code)
 *   - N>0 lookback optional; N<0 disables
 *   - sellVolDecision: recentlyReported caps qualified → reference
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRecentlyReportedMap,
  buildNextEarnIsoMap,
  partitionEarningsForScan,
  type EarningsEntry
} from '../src/api/finnhub.js'
import {
  sellVolTier,
  sellVolDecision,
  boardTierFor,
  boardTierDecision,
  IVR_QUALIFY_FLOOR,
  IVR_REFERENCE_FLOOR
} from '../src/engine/oppScanner.js'

/** Mirror of oppScanner.spansEarningsDate (private) — earn ≤ expiration. */
const spansEarningsDate = (earn: string | undefined, expiration: string) =>
  !!earn && earn !== '—' && earn <= expiration

const TODAY = '2026-07-30'

function entry(symbol: string, date: string): EarningsEntry {
  return { symbol, date }
}

test('buildRecentlyReportedMap: default N=0 → today only (AMC yesterday not flagged)', () => {
  const entries = [
    entry('MSFT', '2026-07-30'), // today
    entry('META', '2026-07-29'), // yesterday — must NOT block today's open
    entry('QQQ', '2026-08-15')   // future
  ]
  const map = buildRecentlyReportedMap(entries, ['MSFT', 'META', 'QQQ'], TODAY, 0)
  assert.equal(map.MSFT, true)
  assert.equal(map.META, undefined)
  assert.equal(map.QQQ, undefined)
})

test('buildRecentlyReportedMap: N=1 includes yesterday; N+1 day does not', () => {
  const entries = [
    entry('MSFT', '2026-07-30'),
    entry('META', '2026-07-29'),
    entry('AAPL', '2026-07-28')
  ]
  const map = buildRecentlyReportedMap(entries, ['MSFT', 'META', 'AAPL'], TODAY, 1)
  assert.equal(map.MSFT, true)
  assert.equal(map.META, true)
  assert.equal(map.AAPL, undefined)
})

test('buildRecentlyReportedMap: negative N disables the gate', () => {
  const map = buildRecentlyReportedMap([entry('MSFT', TODAY)], ['MSFT'], TODAY, -1)
  assert.deepEqual(map, {})
})

test('buildRecentlyReportedMap: ignores symbols not in the watchlist', () => {
  const map = buildRecentlyReportedMap([entry('NVDA', TODAY)], ['MSFT'], TODAY, 0)
  assert.deepEqual(map, {})
})

test('sellVolTier: recentlyReported demotes rich-IVR seller to reference', () => {
  assert.equal(sellVolTier('iron_condor', 90, false, true), 'reference')
  assert.equal(sellVolTier('bull_put_spread', IVR_QUALIFY_FLOOR, false, true), 'reference')
  assert.equal(sellVolTier('bear_call_spread', 81, false, true), 'reference')
})

test('sellVolTier: recentlyReported=false leaves rich-IVR seller qualified', () => {
  assert.equal(sellVolTier('iron_condor', 90, false, false), 'qualified')
  assert.equal(sellVolTier('iron_condor', 90, false), 'qualified')
})

test('sellVolTier: recentlyReported does not upgrade or change reference/null', () => {
  assert.equal(
    sellVolTier('iron_condor', IVR_REFERENCE_FLOOR, false, true),
    'reference'
  )
  assert.equal(sellVolTier('iron_condor', 10, false, true), null)
})

test('sellVolTier: forward spansEarnings still hard-drops (null), even if recent', () => {
  assert.equal(sellVolTier('iron_condor', 90, true, true), null)
})

test('sellVolTier: debit / buy-vol unaffected by recentlyReported', () => {
  assert.equal(sellVolTier('bull_call_spread', 5, false, true), 'qualified')
  assert.equal(sellVolTier('long_straddle', 90, false, true), null)
})

test('boardTierFor: wires recentlyReported into sell-vol path', () => {
  const rich = { ivr: 90, iv: 0.4, rv: 0.3, spansEarnings: false, recentlyReported: true }
  assert.equal(boardTierFor('bull_put_spread', rich), 'reference')
  assert.equal(boardTierFor('bull_put_spread', { ...rich, recentlyReported: false }), 'qualified')
})

test('sellVolDecision / boardTierDecision: tier+reason from one source (no re-derive)', () => {
  assert.deepEqual(
    sellVolDecision('iron_condor', 90, false, true),
    { tier: 'reference', reason: 'earnings_recency' }
  )
  assert.deepEqual(
    sellVolDecision('iron_condor', IVR_REFERENCE_FLOOR, false, false),
    { tier: 'reference', reason: 'ivr_below_floor' }
  )
  assert.deepEqual(
    sellVolDecision('iron_condor', 90, false, false),
    { tier: 'qualified' }
  )
  // recentlyReported + already-below-floor → ivr reason (not recency); still reference
  assert.deepEqual(
    sellVolDecision('iron_condor', IVR_REFERENCE_FLOOR, false, true),
    { tier: 'reference', reason: 'ivr_below_floor' }
  )
  const d = boardTierDecision('bull_put_spread', {
    ivr: 90, iv: 0.4, rv: 0.3, spansEarnings: false, recentlyReported: true
  })
  assert.equal(d.tier, 'reference')
  assert.equal(d.reason, 'earnings_recency')
})

test('partition: today print excluded from nextEarnIso (recency path stays reachable)', () => {
  const entries = [
    entry('MSFT', TODAY),           // print today
    entry('MSFT', '2026-10-22'),    // next quarter
    entry('AAPL', '2026-08-01')     // future only
  ]
  const next = buildNextEarnIsoMap(entries, ['MSFT', 'AAPL'], TODAY)
  assert.equal(next.MSFT, '2026-10-22') // NOT today
  assert.equal(next.AAPL, '2026-08-01')
  const recent = buildRecentlyReportedMap(entries, ['MSFT', 'AAPL'], TODAY, 0)
  assert.equal(recent.MSFT, true)
  assert.equal(recent.AAPL, undefined)
})

test('COUPLED production path: print today → spans=false + recent=true → reference/earnings_recency', () => {
  // This is the reachable combo after excluding today from nextEarnIso.
  // Feeding (spans=false, recent=true) is NOT synthetic when maps are partitioned correctly.
  const entries = [
    entry('MSFT', TODAY),
    entry('MSFT', '2026-10-22')
  ]
  const { nextEarnIsoBySymbol, recentlyReportedBySymbol } = partitionEarningsForScan(
    entries, ['MSFT'], TODAY, 0
  )
  const expiration = '2026-09-18' // after today, before next quarter print
  const next = nextEarnIsoBySymbol.MSFT
  const spans = spansEarningsDate(next, expiration)
  const recent = recentlyReportedBySymbol.MSFT === true

  assert.equal(next, '2026-10-22')
  assert.equal(spans, false) // Oct > Sept expiration → does not span
  assert.equal(recent, true)

  const d = sellVolDecision('iron_condor', 90, spans, recent)
  assert.deepEqual(d, { tier: 'reference', reason: 'earnings_recency' })
})

test('COUPLED: future earnings still hard-dropped via spansEarnings (null)', () => {
  const entries = [entry('NVDA', '2026-08-20')]
  const { nextEarnIsoBySymbol, recentlyReportedBySymbol } = partitionEarningsForScan(
    entries, ['NVDA'], TODAY, 0
  )
  const expiration = '2026-09-18'
  const spans = spansEarningsDate(nextEarnIsoBySymbol.NVDA, expiration)
  const recent = recentlyReportedBySymbol.NVDA === true
  assert.equal(spans, true)
  assert.equal(recent, false)
  assert.deepEqual(sellVolDecision('iron_condor', 90, spans, recent), { tier: null })
})

test('COUPLED: AMC yesterday → not recent, no span on clean exp → qualified', () => {
  const entries = [
    entry('META', '2026-07-29'), // yesterday
    entry('META', '2026-10-22')
  ]
  const { nextEarnIsoBySymbol, recentlyReportedBySymbol } = partitionEarningsForScan(
    entries, ['META'], TODAY, 0
  )
  const expiration = '2026-09-18'
  const spans = spansEarningsDate(nextEarnIsoBySymbol.META, expiration)
  const recent = recentlyReportedBySymbol.META === true
  assert.equal(recent, false)
  assert.equal(spans, false)
  assert.deepEqual(sellVolDecision('bull_put_spread', 90, spans, recent), { tier: 'qualified' })
})
