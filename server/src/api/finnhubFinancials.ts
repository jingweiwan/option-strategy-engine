/**
 * Finnhub financial-data endpoints for OCIFQ deep analysis.
 *
 * Endpoints:
 *   GET /api/v1/stock/metric?symbol=...&metric=all  — key financials (P/E, margins, growth)
 *   GET /api/v1/stock/peers?symbol=...              — peer tickers
 *   GET /api/v1/stock/earnings?symbol=...           — quarterly EPS history
 *   GET /api/v1/stock/profile2?symbol=...           — company profile (industry, cap)
 *
 * All free-tier endpoints.
 */

const base = process.env.FINNHUB_BASE ?? 'https://finnhub.io'
const apiKey = process.env.FINNHUB_API_KEY ?? ''

async function fhFetch<T = any>(path: string): Promise<T> {
  if (!apiKey) throw new Error('FINNHUB_API_KEY not configured')
  const sep = path.includes('?') ? '&' : '?'
  const url = `${base}${path}${sep}token=${encodeURIComponent(apiKey)}`
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Finnhub ${res.status}: ${text.slice(0, 200)}`)
  }
  return (await res.json()) as T
}

// ---------- Types ----------

export type CompanyProfile = {
  ticker: string
  name: string
  finnhubIndustry: string
  marketCapitalization: number  // millions
  exchange: string
  ipo: string
  country: string
  weburl: string
}

export type BasicFinancials = {
  metric: Record<string, number | string | null>
  series: {
    annual?: Record<string, { period: string; v: number }[]>
    quarterly?: Record<string, { period: string; v: number }[]>
  }
}

export type EarningsSurprise = {
  actual: number
  estimate: number
  surprise: number
  surprisePercent: number
  period: string  // 'YYYY-MM-DD'
  symbol: string
  year: number
  quarter: number
}

// ---------- API functions ----------

export async function fetchCompanyProfile(symbol: string): Promise<CompanyProfile | null> {
  const data = await fhFetch<any>(
    `/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}`
  )
  if (!data?.ticker) return null
  return {
    ticker: data.ticker,
    name: data.name ?? symbol,
    finnhubIndustry: data.finnhubIndustry ?? '',
    marketCapitalization: data.marketCapitalization ?? 0,
    exchange: data.exchange ?? '',
    ipo: data.ipo ?? '',
    country: data.country ?? '',
    weburl: data.weburl ?? ''
  }
}

export async function fetchBasicFinancials(symbol: string): Promise<BasicFinancials> {
  const data = await fhFetch<any>(
    `/api/v1/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all`
  )
  return {
    metric: data?.metric ?? {},
    series: data?.series ?? {}
  }
}

export async function fetchPeers(symbol: string): Promise<string[]> {
  const data = await fhFetch<any>(
    `/api/v1/stock/peers?symbol=${encodeURIComponent(symbol)}`
  )
  return Array.isArray(data) ? data.filter((s: any) => typeof s === 'string') : []
}

export async function fetchEarningsSurprises(symbol: string): Promise<EarningsSurprise[]> {
  const data = await fhFetch<any>(
    `/api/v1/stock/earnings?symbol=${encodeURIComponent(symbol)}`
  )
  if (!Array.isArray(data)) return []
  return data
    .filter((e: any) => e.period)
    .map((e: any) => ({
      actual: e.actual ?? 0,
      estimate: e.estimate ?? 0,
      surprise: e.surprise ?? 0,
      surprisePercent: e.surprisePercent ?? 0,
      period: e.period,
      symbol: e.symbol ?? symbol,
      year: e.year ?? 0,
      quarter: e.quarter ?? 0
    }))
}
