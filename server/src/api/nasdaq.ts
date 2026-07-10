/**
 * Nasdaq historical daily OHLC.
 *
 * The public JSON the nasdaq.com site uses for its historical-price tables.
 * No auth, no per-day cap — a free, stable source for the daily candles the
 * engine needs for realized-vol and technicals, so they no longer burn
 * MarketData's tiny options budget.
 *
 *   GET https://api.nasdaq.com/api/quote/{SYM}/historical
 *         ?assetclass=stocks|etf&fromdate=YYYY-MM-DD&todate=YYYY-MM-DD&limit=N
 *
 * Rows come newest-first with $-prefixed prices and comma-grouped volumes.
 * Use for personal research only.
 */
import type { OhlcBar } from './marketdata.js'

// Stocks and ETFs live under different assetclasses; try stock first, then ETF.
const ASSET_CLASSES = ['stocks', 'etf'] as const
const UA = 'Mozilla/5.0'

function num(s: unknown): number {
  const n = Number(String(s ?? '').replace(/[$,]/g, ''))
  return Number.isFinite(n) ? n : 0
}

/** "06/09/2026" → "2026-06-09" */
function toIso(mdy: string): string {
  const [m, d, y] = mdy.split('/')
  if (!y || !m || !d) return ''
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
}

async function fetchHistorical(
  sym: string,
  assetclass: string,
  from: string,
  to: string
): Promise<OhlcBar[]> {
  const url =
    `https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/historical` +
    `?assetclass=${assetclass}&fromdate=${from}&todate=${to}&limit=9999`
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' }
  })
  if (!res.ok) throw new Error(`Nasdaq ${res.status} for ${sym}`)
  const json = (await res.json()) as {
    data?: { tradesTable?: { rows?: Record<string, string>[] } }
  }
  const rows = json?.data?.tradesTable?.rows
  if (!Array.isArray(rows)) return []

  const bars: OhlcBar[] = []
  for (const r of rows) {
    const date = toIso(r.date)
    const close = num(r.close)
    if (!date || close <= 0) continue
    bars.push({
      date,
      open: num(r.open) || close,
      high: num(r.high) || close,
      low: num(r.low) || close,
      close,
      volume: num(r.volume)
    })
  }
  bars.reverse() // newest-first → chronological ascending (engine expects this)
  return bars
}

export async function getDailyOhlc(
  symbol: string,
  from: string,
  to: string
): Promise<OhlcBar[]> {
  const sym = symbol.toUpperCase()
  for (const ac of ASSET_CLASSES) {
    try {
      const bars = await fetchHistorical(sym, ac, from, to)
      if (bars.length > 0) return bars
    } catch {
      // try next assetclass / let caller fall back to another provider
    }
  }
  return []
}
