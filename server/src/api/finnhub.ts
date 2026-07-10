/**
 * Finnhub.io REST client.
 *
 * Endpoints used:
 *   GET /api/v1/search?q=... — symbol / name lookup (watchlist picker)
 *   GET /api/v1/quote?symbol=AAPL&token=...
 *   GET /api/v1/stock/option-chain?symbol=AAPL&token=...
 *
 * The option-chain endpoint returns ALL expirations + their full chains in
 * one response, so getExpirations() and getOptionChain() can share a short
 * in-memory cache to save API calls (free tier = 60 calls/min).
 *
 * Free tier MAY return greeks fields populated; if missing, the engine fills
 * via BSM in liveStrategies.enrichWithGreeks().
 */

import type { Quote, OptionContract } from './types.js'

export type { Quote, OptionContract } from './types.js'

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

// ---------- Chain cache ----------
// 60-second cache so /api/expirations and /api/strategies/live can share the
// same response without hitting the rate limit.
type ChainCacheEntry = {
  ts: number
  data: any
}
const chainCache = new Map<string, ChainCacheEntry>()
const CHAIN_TTL_MS = 60_000

async function getRawChain(symbol: string): Promise<any> {
  const key = symbol.toUpperCase()
  const hit = chainCache.get(key)
  if (hit && Date.now() - hit.ts < CHAIN_TTL_MS) return hit.data
  const data = await fhFetch<any>(
    `/api/v1/stock/option-chain?symbol=${encodeURIComponent(key)}`
  )
  chainCache.set(key, { ts: Date.now(), data })
  return data
}

// ---------- Symbol search (Finnhub) ----------

export type StockSymbolSearchHit = {
  symbol: string
  description: string
  type: string
}

/** Finnhub `type` values we treat as dashboard-eligible US-style equities / ETFs. */
const SEARCH_INCLUDE_TYPES = new Set([
  'Common Stock',
  'American Depositary Receipt',
  'Depositary Receipt',
  'ETP',
  'ETF',
  'REIT',
  'MLP',
  'Closed-End Fund'
])

/**
 * Finnhub GET /api/v1/search?q=… — for picking valid tickers.
 * Returns [] when API key missing or query empty (no throw).
 */
export async function searchStockSymbols(query: string): Promise<StockSymbolSearchHit[]> {
  const q = query.trim()
  if (!apiKey.trim() || q.length < 1 || q.length > 64) return []

  const data = await fhFetch<any>(`/api/v1/search?q=${encodeURIComponent(q)}`)
  const raw: any[] = Array.isArray(data?.result) ? data.result : []
  const out: StockSymbolSearchHit[] = []
  const seen = new Set<string>()

  for (const row of raw) {
    const sym = String(row?.symbol ?? '')
      .toUpperCase()
      .trim()
    if (!sym || seen.has(sym)) continue
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(sym)) continue

    const type = String(row?.type ?? '').trim()
    if (!type || !SEARCH_INCLUDE_TYPES.has(type)) continue

    seen.add(sym)
    out.push({
      symbol: sym,
      description: String(row?.description ?? sym).slice(0, 120),
      type
    })
    if (out.length >= 20) break
  }

  return out
}

// ---------- Public API ----------

export async function getQuote(symbol: string): Promise<Quote> {
  const data = await fhFetch<any>(`/api/v1/quote?symbol=${encodeURIComponent(symbol)}`)
  const last = data?.c ?? 0
  if (!Number.isFinite(last) || last <= 0) {
    throw new Error(`No price for ${symbol}`)
  }
  // /quote also carries daily change (d) + change pct (dp) — surface them so
  // the watchlist 涨跌 column stays populated when this is the fallback source.
  const change = Number.isFinite(data?.d) ? Number(data.d) : undefined
  const changePct = Number.isFinite(data?.dp) ? Number(data.dp) : undefined
  return { symbol: symbol.toUpperCase(), last, bid: 0, ask: 0, change, changePct }
}

/**
 * Finnhub /quote: prefer `c` (last trade); if 0 (halted/closed/some indices), fall back to `pc`.
 * `chg` is daily % change: `dp` when present, else `d` / `pc` * 100.
 */
export async function getQuotePctChange(symbol: string): Promise<{ v: number; chg: number }> {
  const data = await fhFetch<any>(`/api/v1/quote?symbol=${encodeURIComponent(symbol)}`)
  const c = data?.c
  const pc = data?.pc
  const d = data?.d
  const dp = data?.dp
  let v = Number.isFinite(c) && c > 0 ? Number(c) : Number.isFinite(pc) && pc > 0 ? Number(pc) : 0
  let chg = Number.isFinite(dp) ? Number(dp) : 0
  if (chg === 0 && Number.isFinite(d) && Number.isFinite(pc) && pc !== 0) {
    chg = (Number(d) / Number(pc)) * 100
  }
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error(`No quote for ${symbol} (c=${c} pc=${pc})`)
  }
  return { v, chg }
}

export async function getExpirations(symbol: string): Promise<string[]> {
  const data = await getRawChain(symbol)
  const list: any[] = data?.data ?? []
  const set = new Set<string>()
  for (const day of list) {
    if (day.expirationDate) set.add(day.expirationDate)
  }
  return Array.from(set).sort()
}

function mapContract(c: any, type: 'call' | 'put', expiration: string): OptionContract {
  const bid = Number.isFinite(c.bid) ? c.bid : 0
  const ask = Number.isFinite(c.ask) ? c.ask : 0
  const last = Number.isFinite(c.lastPrice) ? c.lastPrice : 0
  const mid = bid > 0 && ask > 0 && ask >= bid ? (bid + ask) / 2 : last
  const iv =
    Number.isFinite(c.impliedVolatility) && c.impliedVolatility > 0
      ? c.impliedVolatility
      : undefined

  const hasGreeks =
    Number.isFinite(c.delta) &&
    Number.isFinite(c.gamma) &&
    Number.isFinite(c.theta) &&
    Number.isFinite(c.vega)

  return {
    symbol: c.contractName ?? '',
    strike: c.strike,
    optionType: type,
    bid,
    ask,
    mid,
    last,
    openInterest: Number.isFinite(c.openInterest) ? c.openInterest : 0,
    volume: Number.isFinite(c.volume) ? c.volume : 0,
    expiration,
    iv,
    greeks: hasGreeks
      ? { delta: c.delta, gamma: c.gamma, theta: c.theta, vega: c.vega }
      : undefined
  }
}

// ---------- Earnings Calendar ----------

export type EarningsEntry = {
  date: string        // 'YYYY-MM-DD'
  symbol: string
}

/**
 * Finnhub /calendar/earnings — returns upcoming earnings in [from, to].
 * Free tier: works, but large ranges may be truncated.
 */
export async function fetchEarningsCalendar(
  from: string,
  to: string
): Promise<EarningsEntry[]> {
  const data = await fhFetch<any>(
    `/api/v1/calendar/earnings?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
  )
  const list: any[] = data?.earningsCalendar ?? []
  return list
    .filter((e: any) => e.symbol && e.date)
    .map((e: any) => ({ date: e.date, symbol: String(e.symbol).toUpperCase() }))
}

export async function getOptionChain(
  symbol: string,
  expiration: string
): Promise<OptionContract[]> {
  const data = await getRawChain(symbol)
  const list: any[] = data?.data ?? []
  const day = list.find((d) => d.expirationDate === expiration)
  if (!day) return []
  const calls: any[] = day.options?.CALL ?? []
  const puts: any[] = day.options?.PUT ?? []
  return [
    ...calls.map((c) => mapContract(c, 'call', expiration)),
    ...puts.map((c) => mapContract(c, 'put', expiration))
  ]
}
