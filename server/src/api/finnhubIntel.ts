/**
 * Finnhub intelligence endpoints — news, SEC filings, analyst recommendations.
 *
 * Separate from finnhub.ts so the main option-chain module stays untouched.
 * Uses the same FINNHUB_BASE / FINNHUB_API_KEY env vars.
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

export type FinnhubNewsItem = {
  category: string
  datetime: number       // unix timestamp
  headline: string
  id: number
  image: string
  related: string        // ticker
  source: string
  summary: string
  url: string
}

export type FinnhubFiling = {
  accessNumber: string
  symbol: string
  cik: string
  form: string           // '8-K', '10-Q', '10-K', etc
  filedDate: string      // 'YYYY-MM-DD'
  acceptedDate: string
  reportUrl: string
  filingUrl: string
}

export type FinnhubRecommendation = {
  buy: number
  hold: number
  period: string         // 'YYYY-MM-01'
  sell: number
  strongBuy: number
  strongSell: number
  symbol: string
}

// ---------- API functions ----------

/**
 * Finnhub company news.
 * GET /api/v1/company-news?symbol=AAPL&from=2026-05-17&to=2026-05-18
 */
export async function fetchCompanyNews(
  symbol: string,
  from: string,
  to: string
): Promise<FinnhubNewsItem[]> {
  const data = await fhFetch<any>(
    `/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
  )
  return Array.isArray(data) ? data : []
}

/**
 * Finnhub SEC filings.
 * GET /api/v1/stock/filings?symbol=AAPL&from=2026-05-01&to=2026-05-18
 */
export async function fetchSecFilings(
  symbol: string,
  from: string,
  to: string
): Promise<FinnhubFiling[]> {
  const data = await fhFetch<any>(
    `/api/v1/stock/filings?symbol=${encodeURIComponent(symbol)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
  )
  return Array.isArray(data) ? data : []
}

/**
 * Finnhub analyst recommendations (trend).
 * GET /api/v1/stock/recommendation?symbol=AAPL
 */
export async function fetchRecommendations(
  symbol: string
): Promise<FinnhubRecommendation[]> {
  const data = await fhFetch<any>(
    `/api/v1/stock/recommendation?symbol=${encodeURIComponent(symbol)}`
  )
  return Array.isArray(data) ? data : []
}
