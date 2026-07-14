/**
 * MarketData.app REST client.
 *
 * Free tier: 100 options requests/day, includes full chain with IV + greeks.
 * https://www.marketdata.app/docs/api
 *
 * Endpoints used:
 *   GET /v1/stocks/quotes/{symbol}/
 *   GET /v1/options/expirations/{symbol}/
 *   GET /v1/options/chain/{symbol}/?expiration=YYYY-MM-DD
 *
 * NOTE: MarketData.app responses are column-oriented (parallel arrays).
 * We transpose to row-oriented OptionContract[] to match our internal shape.
 *
 * FALLBACK: the free tier's 100 req/day cap is easily exhausted by a full
 * watchlist scan. When MarketData returns 429 (or empty), getQuote /
 * getExpirations / getOptionChain transparently fall back to Yahoo then
 * Finnhub so the dashboard keeps working instead of collapsing to one symbol.
 */

import type { Quote, OptionContract } from './types.js'
import * as yahoo from './yahoo.js'
import * as finnhub from './finnhub.js'
import * as polygon from './polygon.js'
import * as tradier from './tradier.js'
import * as cboe from './cboe.js'
import * as nasdaq from './nasdaq.js'
import { cached, MIN, HOUR } from '../ai/cache.js'
import { impliedVolFromChain, dteFromExpiration } from '../engine/liveStrategies.js'

export type { Quote, OptionContract } from './types.js'

// Which fallback providers have credentials configured. Yahoo needs no token
// (but is often geo-blocked, so it's always tried last).
const hasFinnhub = !!(process.env.FINNHUB_API_KEY || process.env.FINNHUB_TOKEN)
const hasPolygon = !!process.env.POLYGON_API_KEY
const hasTradier = !!process.env.TRADIER_TOKEN

// Interface-layer cache TTLs. Chains move intraday so keep them short-ish;
// expirations change only when new series list, so cache them for hours.
// Both tunable via env. The cache is the existing two-tier (mem + disk) store,
// with in-flight dedup so a parallel scan fetches each chain at most once.
const CHAIN_TTL_MS = (Number(process.env.CHAIN_CACHE_TTL_MIN) || 15) * MIN
const EXPS_TTL_MS = (Number(process.env.EXPS_CACHE_TTL_HR) || 6) * HOUR

const base = process.env.MARKETDATA_BASE ?? 'https://api.marketdata.app'
const token = process.env.MARKETDATA_TOKEN ?? ''

const DEBUG = process.env.MARKETDATA_DEBUG === '1'

// MarketData keeps serving cached (HTTP 203) quotes/chains for FREE even after
// the daily cap is hit — and those are often the only chains we can get. So we
// always try MarketData first and just fall through on a 429. (Repetition is
// handled by the interface-layer cache below, not by skipping the provider.)
const hasMarketData = !!token

/** Try providers in order; return the first result that passes `ok`. */
async function withFallback<T>(
  attempts: { name: string; fn: () => Promise<T> }[],
  ok: (v: T) => boolean,
  label: string
): Promise<T> {
  let lastErr: unknown
  for (const a of attempts) {
    try {
      const v = await a.fn()
      if (ok(v)) {
        if (DEBUG) console.log(`[marketdata] ${label} served by ${a.name}`)
        return v
      }
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr ?? new Error(`all providers failed: ${label}`)
}

async function mdFetch<T = any>(path: string): Promise<T> {
  if (!token) throw new Error('MARKETDATA_TOKEN not configured')
  const res = await fetch(`${base}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json'
    }
  })
  // MarketData.app returns 203 for "stale" cached data — treat as success
  if (res.status === 200 || res.status === 203) {
    const data = (await res.json()) as T
    if (DEBUG) {
      console.log(
        `[marketdata] ${path} status=${res.status} keys=`,
        Object.keys(data as any).slice(0, 12)
      )
    }
    return data
  }
  if (res.status === 429 && DEBUG) {
    console.warn('[marketdata] 429 daily cap — falling back to other providers for this call')
  }
  const text = await res.text().catch(() => '')
  throw new Error(`MarketData ${res.status} on ${path}: ${text.slice(0, 200)}`)
}

function pickNum(arr: any[] | undefined, i: number): number | undefined {
  if (!arr) return undefined
  const v = arr[i]
  return Number.isFinite(v) ? v : undefined
}

function unixToDate(t: number): string {
  return new Date(t * 1000).toISOString().slice(0, 10)
}

// ------- Public API -------

async function mdGetQuote(symbol: string): Promise<Quote> {
  const sym = symbol.toUpperCase()
  const data = await mdFetch<any>(`/v1/stocks/quotes/${encodeURIComponent(sym)}/`)
  if (data?.s !== 'ok' && data?.s !== 'no_data') {
    throw new Error(`MarketData stocks/quotes ${sym}: ${data?.errmsg ?? 'failed'}`)
  }
  const last = pickNum(data?.last, 0) ?? pickNum(data?.mid, 0) ?? 0
  if (!Number.isFinite(last) || last <= 0) {
    throw new Error(`No price for ${sym}`)
  }
  const change = pickNum(data?.change, 0)
  const changePct = pickNum(data?.changepct, 0)
  return {
    symbol: sym,
    last,
    bid: pickNum(data?.bid, 0) ?? 0,
    ask: pickNum(data?.ask, 0) ?? 0,
    change,
    changePct
  }
}

/** Spot quote with provider fallback. Quotes are cheap/ubiquitous, so this
 *  keeps the watchlist priced even when MarketData's daily cap is hit — and
 *  frees MarketData's budget for the chains only it can serve. */
export async function getQuote(symbol: string): Promise<Quote> {
  return withFallback(
    [
      // MarketData leads for QUOTES so the load spreads: MarketData's daily quota
      // absorbs the first batch (429 → cascade), leaving Finnhub (60/min) for the
      // overflow. Leading with Finnhub instead concentrated every quote on it and
      // 429'd it (it's also used for earnings / SPY-VIXY macro / symbol search).
      // NOTE: this is quotes only — IV/IVR & chains still lead CBOE, not MarketData.
      ...(hasMarketData ? [{ name: 'marketdata', fn: () => mdGetQuote(symbol) }] : []),
      ...(hasFinnhub ? [{ name: 'finnhub', fn: () => finnhub.getQuote(symbol) }] : []),
      ...(hasPolygon ? [{ name: 'polygon', fn: () => polygon.getQuote(symbol) }] : []),
      ...(hasTradier ? [{ name: 'tradier', fn: () => tradier.getQuote(symbol) }] : []),
      { name: 'yahoo', fn: () => yahoo.getQuote(symbol) }
    ],
    (q) => Number.isFinite(q.last) && q.last > 0,
    `quote ${symbol}`
  )
}

/**
 * Batch quotes for a list of symbols. Per-symbol failures are tolerated:
 * they show up in the result with `available: false` and null fields.
 * The whole call only throws if MARKETDATA_TOKEN is missing.
 */
export type WatchlistQuote =
  | { symbol: string; available: true; last: number; changePct: number }
  | { symbol: string; available: false; reason: string }

export async function fetchWatchlistQuotes(symbols: string[]): Promise<WatchlistQuote[]> {
  const settled = await Promise.allSettled(symbols.map((s) => getQuote(s)))
  return settled.map((r, i) => {
    const symbol = symbols[i].toUpperCase()
    if (r.status === 'fulfilled') {
      return {
        symbol,
        available: true,
        last: r.value.last,
        changePct: r.value.changePct ?? 0
      }
    }
    return {
      symbol,
      available: false,
      reason: (r.reason as Error)?.message ?? 'unknown'
    }
  })
}

async function mdGetExpirations(symbol: string): Promise<string[]> {
  const sym = symbol.toUpperCase()
  const data = await mdFetch<any>(
    `/v1/options/expirations/${encodeURIComponent(sym)}/`
  )
  if (data?.s !== 'ok') return []
  const exps: string[] = data.expirations ?? []
  return exps.slice().sort()
}

/** Option expirations with provider fallback, cached (they rarely change).
 *  Chain-grade providers (Tradier/Polygon) preferred; Finnhub/Yahoo chains
 *  are premium/blocked here. */
export async function getExpirations(symbol: string): Promise<string[]> {
  const sym = symbol.toUpperCase()
  return cached(`exps-${sym}`, EXPS_TTL_MS, () =>
    withFallback(
      [
        // CBOE first: free, no cap, one fetch covers all expirations.
        { name: 'cboe', fn: () => cboe.getExpirations(sym) },
        ...(hasMarketData ? [{ name: 'marketdata', fn: () => mdGetExpirations(sym) }] : []),
        ...(hasTradier ? [{ name: 'tradier', fn: () => tradier.getExpirations(sym) }] : []),
        ...(hasPolygon ? [{ name: 'polygon', fn: () => polygon.getExpirations(sym) }] : []),
        ...(hasFinnhub ? [{ name: 'finnhub', fn: () => finnhub.getExpirations(sym) }] : []),
        { name: 'yahoo', fn: () => yahoo.getExpirations(sym) }
      ],
      (xs) => xs.length > 0,
      `expirations ${sym}`
    )
  )
}

/**
 * Fetch ATM implied volatility on a HISTORICAL date.
 * Uses MarketData.app filters: delta≈.5 + dte≈30 → 1-2 contracts/side.
 * Returns the average of nearest call+put IV, or null if unavailable.
 */
export async function getHistoricalAtmIv(
  symbol: string,
  date: string,
  dte = 30
): Promise<number | null> {
  const sym = symbol.toUpperCase()
  // ?delta=.5 means |delta| ~ 0.5 (ATM). MarketData's range filter accepts a
  // single value; we widen via from/to to tolerate any chain spacing.
  const params = new URLSearchParams({
    date,
    dte: String(dte),
    'delta.gte': '0.35',
    'delta.lte': '0.65'
  })
  let data: any
  try {
    data = await mdFetch<any>(`/v1/options/chain/${encodeURIComponent(sym)}/?${params}`)
  } catch (e) {
    if (DEBUG) console.warn(`[marketdata] historical ${sym}@${date} failed:`, (e as Error).message)
    return null
  }
  if (data?.s !== 'ok') return null

  const n: number = data?.optionSymbol?.length ?? 0
  if (n === 0) return null

  // Within the filtered set, pick call+put closest to |delta|=0.5
  let bestCallIv: number | null = null
  let bestPutIv: number | null = null
  let bestCallDist = Infinity
  let bestPutDist = Infinity

  for (let i = 0; i < n; i++) {
    const side: string = (data.side?.[i] ?? '').toLowerCase()
    const delta = pickNum(data.delta, i)
    const iv = pickNum(data.iv, i)
    if (delta == null || iv == null || iv <= 0) continue
    if (side === 'call') {
      const dist = Math.abs(delta - 0.5)
      if (dist < bestCallDist) {
        bestCallDist = dist
        bestCallIv = iv
      }
    } else if (side === 'put') {
      const dist = Math.abs(delta + 0.5)
      if (dist < bestPutDist) {
        bestPutDist = dist
        bestPutIv = iv
      }
    }
  }

  const ivs = [bestCallIv, bestPutIv].filter(
    (x): x is number => x != null && Number.isFinite(x)
  )
  if (ivs.length === 0) return null
  return ivs.reduce((a, b) => a + b, 0) / ivs.length
}

/** Daily bars with calendar dates (MarketData column `t` unix → YYYY-MM-DD). */
export type DailyBar = { date: string; close: number }

/** Full OHLCV daily candle. */
export type OhlcBar = {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

// --- Inflight dedup + short-lived cache for daily candles ---
// Prevents duplicate API calls when fetchTechnicals() and computeRvRank()
// both request the same symbol's candles in the same Promise.all().
const ohlcCache = new Map<string, { ts: number; bars: OhlcBar[] }>()
const ohlcInflight = new Map<string, Promise<OhlcBar[]>>()
// Daily bars only change once per day (after close), so cache for hours. The
// from/to keys are date-stable, so a day's worth of scans reuse one fetch.
const OHLC_CACHE_TTL = (Number(process.env.OHLC_CACHE_TTL_HR) || 6) * 60 * 60 * 1000

/**
 * Fetch full OHLCV daily candles from MarketData.
 * Uses /v1/stocks/candles/D which is free-tier.
 * Includes inflight dedup: concurrent calls for the same key share one HTTP request.
 */
export async function getDailyOhlc(
  symbol: string,
  from: string,
  to: string
): Promise<OhlcBar[]> {
  const sym = symbol.toUpperCase()
  const cacheKey = `${sym}:${from}:${to}`

  const cached = ohlcCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < OHLC_CACHE_TTL) return cached.bars

  // Dedup in-flight requests (e.g. technicals + RV calling in parallel)
  const inflight = ohlcInflight.get(cacheKey)
  if (inflight) return inflight

  const promise = fetchOhlcRaw(sym, from, to)
  ohlcInflight.set(cacheKey, promise)
  try {
    const bars = await promise
    ohlcCache.set(cacheKey, { ts: Date.now(), bars })
    return bars
  } finally {
    ohlcInflight.delete(cacheKey)
  }
}

async function fetchOhlcRaw(sym: string, from: string, to: string): Promise<OhlcBar[]> {
  // Nasdaq first: free, no cap. Falls back to MarketData only if it returns
  // nothing — so daily candles stop consuming the options budget.
  try {
    const bars = await nasdaq.getDailyOhlc(sym, from, to)
    if (bars.length > 0) return bars
  } catch {
    /* fall through to MarketData */
  }
  if (!hasMarketData) return []

  const params = new URLSearchParams({ from, to })
  const data = await mdFetch<any>(
    `/v1/stocks/candles/D/${encodeURIComponent(sym)}/?${params}`
  )
  if (data?.s !== 'ok') return []
  const opens: any[] = data.o ?? []
  const highs: any[] = data.h ?? []
  const lows: any[] = data.l ?? []
  const closes: any[] = data.c ?? []
  const volumes: any[] = data.v ?? []
  const times: any[] = data.t ?? []
  if (!Array.isArray(times) || times.length === 0) return []

  const out: OhlcBar[] = []
  for (let i = 0; i < times.length; i++) {
    const close = closes[i]
    if (!Number.isFinite(close)) continue
    const ts = times[i]
    const date = typeof ts === 'number' ? unixToDate(ts) : ''
    if (!date) continue
    out.push({
      date,
      open: Number.isFinite(opens[i]) ? opens[i] : close,
      high: Number.isFinite(highs[i]) ? highs[i] : close,
      low: Number.isFinite(lows[i]) ? lows[i] : close,
      close,
      volume: Number.isFinite(volumes[i]) ? volumes[i] : 0
    })
  }
  return out
}

/**
 * Daily stock candles — close prices only.
 * Delegates to getDailyOhlc (shared cache) to avoid duplicate API calls.
 */
export async function getDailyCloses(
  symbol: string,
  from: string,
  to: string
): Promise<number[]> {
  const bars = await getDailyOhlc(symbol, from, to)
  return bars.map((b) => b.close)
}

export async function getDailyBars(
  symbol: string,
  from: string,
  to: string
): Promise<DailyBar[]> {
  const bars = await getDailyOhlc(symbol, from, to)
  return bars.map((b) => ({ date: b.date, close: b.close }))
}

/**
 * Compute rolling 30-day annualized realized volatility.
 * Returns one RV value per window (closes.length - 30 - 1 windows).
 */
// Cap each daily return at this multiple of the window's MEDIAN |return| (a
// jump-robust scale). A single earnings gap inflates close-to-close RV for a
// whole month — e.g. AAPL's ~16% normal vol reads as 30% off one −6.3% day —
// which then flips the engine's sell/buy decision on a move that won't repeat.
// Median-based capping keeps genuinely volatile names (many big days → big
// median → little capping) while trimming one-off jumps in calm names.
const RV_WINSOR_K = Number(process.env.RV_WINSOR_K) || 4

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function rolling30dRealizedVol(closes: number[]): number[] {
  const N = closes.length
  if (N < 32) return []
  // log returns
  const ret: number[] = new Array(N - 1)
  for (let i = 0; i < N - 1; i++) {
    ret[i] = Math.log(closes[i + 1] / closes[i])
  }
  // 30-period rolling stdev * sqrt(252), with per-window jump winsorization
  const window = 30
  const out: number[] = []
  for (let end = window; end <= ret.length; end++) {
    const win = ret.slice(end - window, end)
    const cap = RV_WINSOR_K * median(win.map(Math.abs))
    const w = cap > 0 ? win.map((r) => Math.max(-cap, Math.min(cap, r))) : win
    const mean = w.reduce((a, b) => a + b, 0) / window
    let varSum = 0
    for (const r of w) varSum += (r - mean) ** 2
    const rv = Math.sqrt(varSum / (window - 1)) * Math.sqrt(252)
    if (Number.isFinite(rv)) out.push(rv)
  }
  return out
}

/**
 * RV Rank: 30-day realized volatility percentile over the past 12 months.
 * Uses ONE call to /v1/stocks/candles/D, which is free and doesn't count
 * toward the options quota.
 *
 * This is now an internal helper — the public API is computeIvRank() which
 * prefers true IV history and falls back to this when <30 IV data points.
 */
type RvRankCacheEntry = {
  value: number
  samples: number
  ts: number
  currentRv: number
  rvLow: number
  rvHigh: number
}
const rvRankCache = new Map<string, RvRankCacheEntry>()
const RV_RANK_TTL_MS = 24 * 60 * 60 * 1000

async function computeRvRank(
  symbol: string
): Promise<{ rank: number; samples: number; currentRv: number; rvLow: number; rvHigh: number } | null> {
  const sym = symbol.toUpperCase()
  const hit = rvRankCache.get(sym)
  if (hit && Date.now() - hit.ts < RV_RANK_TTL_MS) {
    return {
      rank: hit.value,
      samples: hit.samples,
      currentRv: hit.currentRv,
      rvLow: hit.rvLow,
      rvHigh: hit.rvHigh
    }
  }

  const today = new Date()
  const to = today.toISOString().slice(0, 10)
  const fromDate = new Date(today)
  fromDate.setUTCDate(fromDate.getUTCDate() - 400) // ~13 months for buffer
  const from = fromDate.toISOString().slice(0, 10)

  let closes: number[]
  try {
    closes = await getDailyCloses(sym, from, to)
  } catch (e) {
    console.warn(`[rvRank] ${sym}: candles fetch failed: ${(e as Error).message}`)
    return null
  }

  if (closes.length < 60) {
    console.warn(`[rvRank] ${sym}: only ${closes.length} candles — need ≥60`)
    return null
  }

  const rvSeries = rolling30dRealizedVol(closes)
  if (rvSeries.length < 30) {
    console.warn(`[rvRank] ${sym}: only ${rvSeries.length} RV windows`)
    return null
  }

  const currentRv = rvSeries[rvSeries.length - 1]
  const sorted = [...rvSeries].sort((a, b) => a - b)
  let count = 0
  for (const v of sorted) {
    if (v <= currentRv) count++
  }
  const rank = (count / sorted.length) * 100

  const rvLow = sorted[0]
  const rvHigh = sorted[sorted.length - 1]
  rvRankCache.set(sym, {
    value: rank,
    samples: rvSeries.length,
    ts: Date.now(),
    currentRv,
    rvLow,
    rvHigh
  })
  return { rank, samples: rvSeries.length, currentRv, rvLow, rvHigh }
}

// Re-export IV history types for consumers
import { computeIvRankFromHistory, recordIv, type IvRankResult } from './ivHistory.js'
import { getDoltIvRange } from './doltIv.js'
export type { IvRankResult }

/**
 * Compute IV Rank using a layered approach:
 *
 * 1. Fetch current live ATM IV (from option chain, already cached 24h)
 * 2. Record it in the self-accumulating IV history store
 * 3. If ≥30 days of IV history exist → true IVR (source: 'iv-history')
 * 4. Otherwise → fall back to RV-percentile rank (source: 'rv-fallback')
 *
 * Returns IvRankResult with rank (0-100), source label, and relevant metadata.
 * Returns null only if both IV and RV data are unavailable.
 */
export async function computeIvRank(
  symbol: string,
  _currentAtmIvHint?: number // optional hint; live fetch preferred
): Promise<IvRankResult | null> {
  const sym = symbol.toUpperCase()

  // Step 1: Get current ATM IV from live chain
  let currentIv: number | null = null
  const liveData = await fetchLiveIvData(sym)
  if (liveData) {
    currentIv = liveData.iv
  }

  // Fall back to hint if live fetch fails
  if ((currentIv == null || currentIv <= 0) && _currentAtmIvHint != null && _currentAtmIvHint > 0) {
    currentIv = _currentAtmIvHint
  }

  // Step 2: RV fallback + DoltHub 52-week IV range (both network; fetch parallel).
  // DoltHub is the primary IVR source until our own history matures to a year.
  const [rvData, doltRange] = await Promise.all([computeRvRank(sym), getDoltIvRange(sym)])

  // Step 3: If we have a current IV, use the IV history store
  if (currentIv != null && currentIv > 0) {
    return computeIvRankFromHistory(sym, currentIv, rvData, doltRange)
  }

  // Step 4: No current IV available — pure RV fallback
  if (rvData) {
    console.log(
      `[ivRank] ${sym}: no live IV, using pure RV fallback. ` +
        `RV-rank=${rvData.rank.toFixed(1)} (${rvData.samples} samples)`
    )
    return {
      rank: rvData.rank,
      source: 'rv-fallback',
      samples: rvData.samples,
      currentIv: 0,
      ivLow: 0,
      ivHigh: 0,
      currentRv: rvData.currentRv,
      rvLow: rvData.rvLow,
      rvHigh: rvData.rvHigh
    }
  }

  return null
}

// ---------- Live ATM IV + Expected Move (1 call per symbol, self-cached 24h) ----------

export type LiveIvData = {
  /** ATM implied volatility (annualized, 0-1 scale). */
  iv: number
  /** Expected move in dollars (ATM straddle mid). */
  em: number
  /** DTE of the chain used. */
  dte: number
}

const liveIvCache = new Map<string, { ts: number; data: LiveIvData }>()
const LIVE_IV_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Fetch ATM IV + straddle-based expected move for `symbol`.
 * Uses MarketData `/v1/options/chain` with delta filter → 1 API call.
 * Self-cached 24h per symbol.
 */
/**
 * CBOE-chain fallback for ATM IV/EM. The MarketData chain endpoint has a 100
 * req/day cap that a full watchlist scan exhausts; when it 429s, live IV would
 * be null and computeIvRank would silently degrade to an RV-RANK (which is high
 * exactly when the tape is choppy — the OPPOSITE of a sell signal), mislabeled
 * as "IVR" on the dashboard. This derives ATM IV from the free CBOE chain the
 * scanner already uses, so IVR stays a real IVR instead of an RV-rank artifact.
 */
async function liveIvFromCboeChain(sym: string): Promise<LiveIvData | null> {
  try {
    const q = await getQuote(sym)
    if (!q.last || !Number.isFinite(q.last)) return null
    const exps = await getExpirations(sym)
    const today = Date.now()
    let exp = ''
    let best = Infinity
    for (const e of exps) {
      const dte = (new Date(e).getTime() - today) / 86_400_000
      if (dte < 7) continue
      const d = Math.abs(dte - 30)
      if (d < best) { best = d; exp = e }
    }
    if (!exp) return null
    const chain = await getOptionChain(sym, exp)
    const atmIv = impliedVolFromChain(chain, q.last)
    if (atmIv == null || atmIv <= 0) return null
    const dte = dteFromExpiration(exp)
    const em = q.last * atmIv * Math.sqrt(dte / 365)
    const result: LiveIvData = { iv: atmIv, em, dte }
    liveIvCache.set(sym, { ts: Date.now(), data: result })
    recordIv(sym, atmIv)
    console.log(`[liveIv] ${sym}: CBOE IV=${(atmIv * 100).toFixed(1)}% DTE=${dte}`)
    return result
  } catch (e) {
    console.warn(`[liveIv] ${sym}: CBOE fallback failed:`, (e as Error).message)
    return null
  }
}

export async function fetchLiveIvData(symbol: string): Promise<LiveIvData | null> {
  const sym = symbol.toUpperCase()
  const hit = liveIvCache.get(sym)
  if (hit && Date.now() - hit.ts < LIVE_IV_TTL_MS) return hit.data

  // CBOE is the DEFAULT IV source — free, unlimited, and the same chain the
  // scanner already uses. MarketData's 100/day cap silently degraded IVR to an
  // RV-rank once exhausted, so it is now ONLY a fallback when CBOE yields nothing
  // (rare). Set LIVE_IV_MARKETDATA_FALLBACK=0 to disable the MarketData path.
  const cboe = await liveIvFromCboeChain(sym)
  if (cboe) return cboe
  if (process.env.LIVE_IV_MARKETDATA_FALLBACK === '0') return null

  const params = new URLSearchParams({
    dte: '30',
    'delta.gte': '0.35',
    'delta.lte': '0.65'
  })

  let data: any
  try {
    data = await mdFetch<any>(`/v1/options/chain/${encodeURIComponent(sym)}/?${params}`)
  } catch (e) {
    console.warn(`[liveIv] ${sym}: CBOE empty + MarketData failed (${(e as Error).message})`)
    return null
  }
  if (data?.s !== 'ok') return null

  const n: number = data?.optionSymbol?.length ?? 0
  if (n === 0) return null

  let bestCallIv: number | null = null
  let bestPutIv: number | null = null
  let bestCallMid = 0
  let bestPutMid = 0
  let bestCallDist = Infinity
  let bestPutDist = Infinity
  let dte = 30

  for (let i = 0; i < n; i++) {
    const side: string = (data.side?.[i] ?? '').toLowerCase()
    const delta = pickNum(data.delta, i)
    const iv = pickNum(data.iv, i)
    const mid = pickNum(data.mid, i) ?? 0
    if (delta == null || iv == null || iv <= 0) continue

    const expUnix = data.expiration?.[i]
    if (expUnix && Number.isFinite(expUnix)) {
      dte = Math.max(1, Math.round((expUnix * 1000 - Date.now()) / 86400000))
    }

    if (side === 'call') {
      const dist = Math.abs(delta - 0.5)
      if (dist < bestCallDist) {
        bestCallDist = dist
        bestCallIv = iv
        bestCallMid = mid
      }
    } else if (side === 'put') {
      const dist = Math.abs(delta + 0.5)
      if (dist < bestPutDist) {
        bestPutDist = dist
        bestPutIv = iv
        bestPutMid = mid
      }
    }
  }

  const ivs = [bestCallIv, bestPutIv].filter(
    (x): x is number => x != null && Number.isFinite(x)
  )
  if (ivs.length === 0) return null

  const atmIv = ivs.reduce((a, b) => a + b, 0) / ivs.length
  // EM = ATM straddle mid price (market-implied expected move)
  const em = bestCallMid + bestPutMid

  const result: LiveIvData = { iv: atmIv, em: em > 0 ? em : 0, dte }
  liveIvCache.set(sym, { ts: Date.now(), data: result })

  // Record ATM IV for self-accumulating history (enables true IVR over time)
  recordIv(sym, atmIv)

  console.log(
    `[liveIv] ${sym}: IV=${(atmIv * 100).toFixed(1)}% EM=±$${em.toFixed(1)} ` +
      `DTE=${dte} (callIV=${bestCallIv?.toFixed(3)} putIV=${bestPutIv?.toFixed(3)})`
  )

  return result
}

async function mdGetOptionChain(
  symbol: string,
  expiration: string
): Promise<OptionContract[]> {
  const sym = symbol.toUpperCase()
  const data = await mdFetch<any>(
    `/v1/options/chain/${encodeURIComponent(sym)}/?expiration=${encodeURIComponent(expiration)}`
  )
  if (data?.s !== 'ok') return []

  const n: number = data?.optionSymbol?.length ?? 0
  const out: OptionContract[] = []

  for (let i = 0; i < n; i++) {
    const sideRaw: string = data.side?.[i] ?? ''
    const optionType = sideRaw.toLowerCase() === 'put' ? 'put' : 'call'
    const bid = pickNum(data.bid, i) ?? 0
    const ask = pickNum(data.ask, i) ?? 0
    const last = pickNum(data.last, i) ?? 0
    const mid =
      bid > 0 && ask > 0 && ask >= bid
        ? (bid + ask) / 2
        : (pickNum(data.mid, i) ?? last)
    const iv = pickNum(data.iv, i)

    const delta = pickNum(data.delta, i)
    const gamma = pickNum(data.gamma, i)
    const theta = pickNum(data.theta, i)
    const vega = pickNum(data.vega, i)
    const hasGreeks =
      delta != null && gamma != null && theta != null && vega != null

    const expRaw: number | undefined = data.expiration?.[i]
    const expDate = expRaw ? unixToDate(expRaw) : expiration

    out.push({
      symbol: data.optionSymbol?.[i] ?? '',
      strike: data.strike?.[i] ?? 0,
      optionType,
      bid,
      ask,
      mid,
      last,
      openInterest: pickNum(data.openInterest, i) ?? 0,
      volume: pickNum(data.volume, i) ?? 0,
      expiration: expDate,
      iv,
      greeks: hasGreeks ? { delta, gamma, theta, vega } : undefined
    })
  }

  return out
}

/** Option chain with provider fallback + interface-layer cache. The cache is
 *  what lets MarketData's daily budget cover the whole watchlist: a scan, a
 *  dashboard refresh, and the Ticker/Recommend pages all reuse one fetch per
 *  (symbol, expiration) within CHAIN_TTL_MS. Order favors providers that serve
 *  full chains with IV/greeks (Tradier/Polygon) once a token is set; Finnhub
 *  chains are premium and Yahoo is geo-blocked in some networks. */
export async function getOptionChain(
  symbol: string,
  expiration: string
): Promise<OptionContract[]> {
  const sym = symbol.toUpperCase()
  return cached(`chain-${sym}-${expiration}`, CHAIN_TTL_MS, () =>
    withFallback(
      [
        // CBOE first: free, uncapped, full chain with IV + greeks.
        { name: 'cboe', fn: () => cboe.getOptionChain(sym, expiration) },
        ...(hasMarketData ? [{ name: 'marketdata', fn: () => mdGetOptionChain(sym, expiration) }] : []),
        ...(hasTradier ? [{ name: 'tradier', fn: () => tradier.getOptionChain(sym, expiration) }] : []),
        ...(hasPolygon ? [{ name: 'polygon', fn: () => polygon.getOptionChain(sym, expiration) }] : []),
        ...(hasFinnhub ? [{ name: 'finnhub', fn: () => finnhub.getOptionChain(sym, expiration) }] : []),
        { name: 'yahoo', fn: () => yahoo.getOptionChain(sym, expiration) }
      ],
      (c) => c.length > 0,
      `chain ${sym} ${expiration}`
    )
  )
}
