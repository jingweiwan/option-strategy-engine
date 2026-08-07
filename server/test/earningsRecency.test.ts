/**
 * Post-print earnings recency gate (缺陷 3 · 杠杆①):
 *   - today IS in nextEarnIso → the print day is hard-nulled via spansEarnings
 *     (never boards, not even reference); the display also shows today's event.
 *   - recency owns the days AFTER the print: default N=1 → yesterday → reference
 *     (止血次日). N<0 disables; non-numeric N falls back (never NaN → throw).
 *   - sellVolDecision: spans null wins over recency; recency caps qualified → reference
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

test('buildRecentlyReportedMap: N=0 → today only (AMC yesterday not flagged)', () => {
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
  // Pass rich iv/rv so 'qualified' is a genuine pass, not the RV-absent skip.
  assert.equal(sellVolTier('iron_condor', 90, false, false, 0.4, 0.3), 'qualified')
  assert.equal(sellVolTier('iron_condor', 90, false, false, 0.4, 0.3), 'qualified')
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
    sellVolDecision('iron_condor', 90, false, false, 0.4, 0.3),
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

test('partition: today print INCLUDED in nextEarnIso (drives display + spans hard-null)', () => {
  const entries = [
    entry('MSFT', TODAY),           // print today
    entry('MSFT', '2026-10-22'),    // next quarter
    entry('AAPL', '2026-08-01')     // future only
  ]
  const next = buildNextEarnIsoMap(entries, ['MSFT', 'AAPL'], TODAY)
  assert.equal(next.MSFT, TODAY) // today, NOT next quarter (Finding 1a: event stays visible)
  assert.equal(next.AAPL, '2026-08-01')
})

test('COUPLED (Finding 1): print today → in nextEarnIso → spans=true → hard null (never reference)', () => {
  const entries = [
    entry('MSFT', TODAY),
    entry('MSFT', '2026-10-22')
  ]
  const { nextEarnIsoBySymbol, recentlyReportedBySymbol } = partitionEarningsForScan(
    entries, ['MSFT'], TODAY, 1
  )
  const expiration = '2026-09-18' // after today, before next quarter print
  const next = nextEarnIsoBySymbol.MSFT
  const spans = spansEarningsDate(next, expiration)
  const recent = recentlyReportedBySymbol.MSFT === true

  assert.equal(next, TODAY)
  assert.equal(spans, true) // today ≤ Sept expiration → spans → hard null
  assert.equal(recent, true) // flagged, but spans wins first
  // Hard null, NOT reference: never auto-board across a print (Finding 1b).
  assert.deepEqual(sellVolDecision('iron_condor', 90, spans, recent), { tier: null })
})

test('COUPLED (Finding 1b): AMC-today, only-today print → hard null, not reference', () => {
  // A name whose sole near earnings is today's (pending AMC) must be hard-blocked,
  // not surfaced as a reference near-miss.
  const entries = [entry('AMD', TODAY)]
  const { nextEarnIsoBySymbol, recentlyReportedBySymbol } = partitionEarningsForScan(
    entries, ['AMD'], TODAY, 1
  )
  const spans = spansEarningsDate(nextEarnIsoBySymbol.AMD, '2026-09-18')
  const recent = recentlyReportedBySymbol.AMD === true
  assert.equal(spans, true)
  assert.deepEqual(sellVolDecision('iron_condor', 90, spans, recent), { tier: null })
})

test('COUPLED (Finding 2): default N=1 demotes yesterday-AMC → reference (止血次日)', () => {
  const entries = [
    entry('META', '2026-07-29'), // printed yesterday (AMC)
    entry('META', '2026-10-22')  // next quarter
  ]
  const { nextEarnIsoBySymbol, recentlyReportedBySymbol } = partitionEarningsForScan(
    entries, ['META'], TODAY, 1 // the new default
  )
  const spans = spansEarningsDate(nextEarnIsoBySymbol.META, '2026-09-18')
  const recent = recentlyReportedBySymbol.META === true
  assert.equal(spans, false) // next earnings is Oct, after the Sept expiry → no span
  assert.equal(recent, true)  // yesterday within N=1 → demote
  assert.deepEqual(
    sellVolDecision('iron_condor', 90, spans, recent),
    { tier: 'reference', reason: 'earnings_recency' }
  )
})

test('buildRecentlyReportedMap: non-numeric N (NaN) → empty, does not throw', () => {
  assert.doesNotThrow(() =>
    buildRecentlyReportedMap([entry('MSFT', TODAY)], ['MSFT'], TODAY, NaN)
  )
  assert.deepEqual(buildRecentlyReportedMap([entry('MSFT', TODAY)], ['MSFT'], TODAY, NaN), {})
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

test('COUPLED: N=0 (recency off) → AMC yesterday not recent, no span → qualified', () => {
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
  // rich iv/rv so the qualification is genuine, not the RV-absent skip.
  assert.deepEqual(sellVolDecision('bull_put_spread', 90, spans, recent, 0.4, 0.3), { tier: 'qualified' })
})
