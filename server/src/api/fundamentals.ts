/**
 * Company fundamentals via Finnhub /stock/metric (free tier).
 *
 * Used by the wheel scanner: the wheel's premise is "only sell puts on stocks
 * you'd be HAPPY to own", which is a fundamentals question, not a premium
 * question. Metrics change quarterly, so a 7-day cache is plenty.
 *
 * Field names on Finnhub's metric blob vary (TTM/annual variants); read
 * defensively and return null for anything missing — the gate treats missing
 * data honestly (ETFs pass neutral, companies with holes get flagged).
 */
import { cached, DAY } from '../ai/cache.js'

const base = process.env.FINNHUB_BASE ?? 'https://finnhub.io'
const apiKey = process.env.FINNHUB_API_KEY ?? ''

export type Fundamentals = {
  sym: string
  /** Trailing P/E; null when unprofitable or unavailable. */
  pe: number | null
  /** Net profit margin TTM, percent. */
  netMargin: number | null
  /** Return on equity TTM, percent. */
  roe: number | null
  /** Total debt / equity (x). */
  debtToEquity: number | null
  /** Revenue growth TTM YoY, percent. */
  revenueGrowth: number | null
  /** EPS growth TTM YoY, percent. */
  epsGrowth: number | null
  beta: number | null
  week52High: number | null
  week52Low: number | null
  dividendYield: number | null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function firstNum(m: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = num(m[k])
    if (v != null) return v
  }
  return null
}

export async function getFundamentals(symbol: string): Promise<Fundamentals | null> {
  const sym = symbol.toUpperCase()
  return cached(`fundamentals-v1-${sym}`, 7 * DAY, async () => {
    if (!apiKey) throw new Error('FINNHUB_API_KEY not configured')
    const url = `${base}/api/v1/stock/metric?symbol=${encodeURIComponent(sym)}&metric=all&token=${encodeURIComponent(apiKey)}`
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(`Finnhub metric ${res.status}`)
    const body = (await res.json()) as { metric?: Record<string, unknown> }
    const m = body.metric ?? {}
    return {
      sym,
      pe: firstNum(m, ['peBasicExclExtraTTM', 'peTTM', 'peNormalizedAnnual', 'peAnnual']),
      netMargin: firstNum(m, ['netProfitMarginTTM', 'netProfitMarginAnnual']),
      roe: firstNum(m, ['roeTTM', 'roeRfy', 'roeAnnual']),
      debtToEquity: firstNum(m, ['totalDebt/totalEquityQuarterly', 'totalDebt/totalEquityAnnual', 'longTermDebt/equityQuarterly']),
      revenueGrowth: firstNum(m, ['revenueGrowthTTMYoy', 'revenueGrowthQuarterlyYoy']),
      epsGrowth: firstNum(m, ['epsGrowthTTMYoy', 'epsGrowthQuarterlyYoy']),
      beta: firstNum(m, ['beta']),
      week52High: firstNum(m, ['52WeekHigh']),
      week52Low: firstNum(m, ['52WeekLow']),
      dividendYield: firstNum(m, ['dividendYieldIndicatedAnnual', 'currentDividendYieldTTM'])
    }
  }).catch(() => null)
}
