/**
 * Finnhub /calendar/earnings returns at most 1500 rows and drops the NEAREST
 * dates first. Production observation (2026-10-26): the 10-26..11-10 slice came
 * back as exactly 1500 rows, all dated ≥ 11-04, so AMZN (10-29) and GOOGL
 * (10-28) were missing and an AMZN 11-27 bear call spread qualified with
 * spansEarnings=false. A capped response must be split until each piece fits.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.FINNHUB_API_KEY ??= 'test-key'
const { fetchEarningsCalendar } = await import('../src/api/finnhub.js')

/** Fake Finnhub: `perDay` rows per date; any window over the cap keeps only its LAST 1500 rows. */
function fakeFinnhub(perDay: Record<string, number>, special: Record<string, string>) {
  const calls: string[] = []
  const fetchImpl = (async (url: string) => {
    const u = new URL(url)
    const from = u.searchParams.get('from')!
    const to = u.searchParams.get('to')!
    calls.push(`${from}..${to}`)
    const rows: { symbol: string; date: string }[] = []
    for (const [date, n] of Object.entries(perDay).sort()) {
      if (date < from || date > to) continue
      for (let i = 0; i < n; i++) rows.push({ symbol: `X${date}${i}`, date })
      for (const [sym, d] of Object.entries(special)) if (d === date) rows.push({ symbol: sym, date })
    }
    const capped = rows.slice(-1500)
    return new Response(JSON.stringify({ earningsCalendar: capped }), { status: 200 })
  }) as typeof fetch
  return { fetchImpl, calls }
}

test('a capped window is bisected so the near-end earnings come back', async () => {
  const perDay: Record<string, number> = {
    '2026-10-26': 100, '2026-10-27': 184, '2026-10-28': 261, '2026-10-29': 339, '2026-10-30': 54,
    '2026-11-02': 200, '2026-11-03': 250, '2026-11-04': 419, '2026-11-05': 522, '2026-11-06': 52,
    '2026-11-09': 234, '2026-11-10': 272
  }
  const { fetchImpl, calls } = fakeFinnhub(perDay, { AMZN: '2026-10-29', GOOGL: '2026-10-28' })
  const real = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    const out = await fetchEarningsCalendar('2026-10-26', '2026-11-10')
    const amzn = out.find((e) => e.symbol === 'AMZN')
    const googl = out.find((e) => e.symbol === 'GOOGL')
    assert.equal(amzn?.date, '2026-10-29')
    assert.equal(googl?.date, '2026-10-28')
    const total = Object.values(perDay).reduce((a, b) => a + b, 0) + 3 // AMZN, GOOGL + its GOOG twin
    assert.equal(out.length, total, 'every row recovered, none duplicated')
    assert.ok(calls.length > 1, 'split happened')
  } finally {
    globalThis.fetch = real
  }
})

test('an uncapped window is a single call', async () => {
  const { fetchImpl, calls } = fakeFinnhub({ '2026-10-26': 100, '2026-10-30': 54 }, { AMZN: '2026-10-29' })
  const real = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    const out = await fetchEarningsCalendar('2026-10-26', '2026-10-30')
    assert.equal(calls.length, 1)
    assert.equal(out.length, 154)
  } finally {
    globalThis.fetch = real
  }
})

test('GOOG inherits the GOOGL print (Finnhub lists only one share class)', async () => {
  const { fetchImpl } = fakeFinnhub({ '2026-10-28': 10 }, { GOOGL: '2026-10-28' })
  const real = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    const out = await fetchEarningsCalendar('2026-10-26', '2026-10-30')
    assert.equal(out.find((e) => e.symbol === 'GOOG')?.date, '2026-10-28')
    assert.equal(out.find((e) => e.symbol === 'GOOGL')?.date, '2026-10-28')
  } finally {
    globalThis.fetch = real
  }
})
