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

/**
 * Earliest upcoming earnings date per symbol over `horizonDays`, fetched in
 * ≤15-day slices. A single wide query hits Finnhub's 1500-row response cap,
 * which silently drops the NEAREST earnings (the ones that matter) — chunking
 * keeps every slice well under the cap.
 *
 * FORWARD-ONLY: never fold past dates into this map. A past earnings date would
 * make `spansEarningsDate` (earn ≤ expiration) true for every future expiry and
 * hard-ban the whole name. Recent-print detection is a separate map — see
 * `buildRecentlyReportedMap` / `EARNINGS_RECENCY_DAYS`.
 */
export async function getUpcomingEarningsMap(
  symbols: string[],
  horizonDays = 60
): Promise<Record<string, string>> {
  const now = Date.now()
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10)
  const ranges: Array<[string, string]> = []
  for (let s = 0; s < horizonDays; s += 15) {
    ranges.push([iso(now + s * 86400000), iso(now + Math.min(s + 15, horizonDays) * 86400000)])
  }
  const chunks = await Promise.all(ranges.map(([f, t]) => fetchEarningsCalendar(f, t).catch((): EarningsEntry[] => [])))
  const want = new Set(symbols.map((s) => s.toUpperCase()))
  const map: Record<string, string> = {}
  for (const e of chunks.flat()) {
    if (want.has(e.symbol) && (!(e.symbol in map) || e.date < map[e.symbol])) map[e.symbol] = e.date
  }
  return map
}

/**
 * Extra ET **calendar** days BEFORE today to treat as "just reported" → demote
 * a rich-IVR seller to `reference` (labeled near-miss, not auto-recommended).
 *
 * Default **1** = stop-bleed the day AFTER the print. The print day itself is
 * already hard-nulled by `buildNextEarnIsoMap` (today ∈ nextEarnIso → spans),
 * so recency owns the *post*-print window:
 *   - N=1 (default): printed yesterday → reference. This is 缺陷3 §1「止血次日」.
 *   - N=0: nothing after the print day → yesterday's AMC re-qualifies today
 *     (the gap Finding 2 flagged); the residual next-day IV spike is then only
 *     caught by 杠杆② IV/RV. Set 0 only if you deliberately want that.
 *   - N=3: multi-day cushion. Negative disables the recency gate entirely.
 *
 * A non-numeric env value falls back to the default (never NaN → the map
 * builders would throw on `new Date(NaN).toISOString()`).
 */
const RECENCY_DAYS_DEFAULT = 1
const rawRecencyDays = Number(process.env.EARNINGS_RECENCY_DAYS ?? RECENCY_DAYS_DEFAULT)
export const EARNINGS_RECENCY_DAYS = Number.isFinite(rawRecencyDays)
  ? rawRecencyDays
  : RECENCY_DAYS_DEFAULT

/**
 * Pure helper: symbols with an earnings date in [today−N, today] (ET calendar
 * YYYY-MM-DD, inclusive). N=0 → today only. Does NOT touch next-earn maps.
 */
export function buildRecentlyReportedMap(
  entries: EarningsEntry[],
  symbols: string[],
  today: string,
  recencyDays = EARNINGS_RECENCY_DAYS
): Record<string, boolean> {
  if (!Number.isFinite(recencyDays) || recencyDays < 0) return {}
  const todayMs = Date.parse(today)
  if (!Number.isFinite(todayMs)) return {}
  const from = new Date(todayMs - recencyDays * 86400000).toISOString().slice(0, 10)
  const want = new Set(symbols.map((s) => s.toUpperCase()))
  const out: Record<string, boolean> = {}
  for (const e of entries) {
    const sym = e.symbol.toUpperCase()
    if (!want.has(sym)) continue
    if (e.date >= from && e.date <= today) out[sym] = true
  }
  return out
}

/**
 * Earliest earnings date per symbol that is **today or later** (`date >= today`).
 *
 * Today IS included, deliberately. This map drives BOTH the forward display
 * (ticker `earn`, calendar, AI) AND the scanner's `spansEarnings` hard-drop, so:
 *   - Display: on the print day the UI shows "earnings today", not next quarter
 *     (excluding today was the 缺陷3 smoking gun — the event vanished from view).
 *   - Scan: a name reporting today (BMO already out, OR AMC still pending) →
 *     spansEarnings(today, futureExp)=true → hard null. Never auto-sell premium
 *     across an earnings print, not even as `reference`. Without a BMO/AMC
 *     time-of-day signal we cannot tell an already-reported BMO from a pending
 *     AMC, so we treat the whole print day as "upcoming" — the safe superset
 *     (missing one day of a BMO crush-sell ≪ shorting gamma into a pending AMC).
 *
 * PAST dates (`date < today`) stay excluded — a past print ≤ every future expiry
 * would `spansEarnings`-ban the name forever (the FORWARD-ONLY footgun). Names
 * that already printed on a PAST day are handled by `buildRecentlyReportedMap`
 * (→ reference), not here.
 */
export function buildNextEarnIsoMap(
  entries: EarningsEntry[],
  symbols: string[],
  today: string
): Record<string, string> {
  const want = new Set(symbols.map((s) => s.toUpperCase()))
  const map: Record<string, string> = {}
  for (const e of entries) {
    if (e.date < today) continue
    const sym = e.symbol.toUpperCase()
    if (!want.has(sym)) continue
    if (!(sym in map) || e.date < map[sym]) map[sym] = e.date
  }
  return map
}

/** Partition calendar rows into next-earn vs just-reported (single source). */
export function partitionEarningsForScan(
  entries: EarningsEntry[],
  symbols: string[],
  today: string,
  recencyDays = EARNINGS_RECENCY_DAYS
): {
  nextEarnIsoBySymbol: Record<string, string>
  recentlyReportedBySymbol: Record<string, boolean>
} {
  return {
    nextEarnIsoBySymbol: buildNextEarnIsoMap(entries, symbols, today),
    recentlyReportedBySymbol: buildRecentlyReportedMap(entries, symbols, today, recencyDays)
  }
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
