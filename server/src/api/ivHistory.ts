/**
 * Self-accumulating IV history store.
 *
 * MarketData.app does NOT provide historical implied volatility data.
 * Instead, we record each day's live ATM IV (from fetchLiveIvData) and
 * persist the series to disk. Over time this builds a true IV history
 * that enables accurate IV Rank calculation.
 *
 * Storage: server/data/iv-history.json
 * Shape:   { [symbol]: { date: string, iv: number }[] }
 *
 * IV Rank = percentile of current IV within its trailing 1-year IV range:
 *   (current − low) / (high − low) × 100
 *
 * Source priority (each degrades to the next):
 *   1. Our own self-accumulated history, ONCE it spans a full year (≥252 pts) —
 *      self-sufficient, our own IV definition. This is the end state.
 *   2. DoltHub's true 52-week IV high/low (api/doltIv) while our own history is
 *      still immature — makes IVR trustworthy immediately instead of waiting
 *      ~6 months. Primary source today.
 *   3. Our own history but shallow (30–251 pts): the rank is SHRUNK toward 50 by
 *      how much of a year we've seen (confidence = pts/252), so a fresh extreme
 *      over a short window can't read as a hard 100/0.
 *   4. <30 pts and no DoltHub → RV-percentile fallback.
 * We keep recording CBOE IV daily throughout, so #1 arrives on its own and we
 * never depend permanently on the community DoltHub dataset.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DoltIvRange } from './doltIv.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Overridable so tests can point at an isolated file instead of the real store.
const DATA_FILE = process.env.IV_HISTORY_FILE ?? join(__dirname, '..', '..', 'data', 'iv-history.json')
const MAX_DAYS_PER_SYMBOL = 260 // ~1 trading year + buffer
const MAX_SYMBOLS = 200
const FULL_HISTORY_DAYS = 252 // a full trading year → confidence 1, graduate to own history
const MIN_SAMPLES = 30        // below this, too little even to shrink → RV fallback

type IvSnapshot = { date: string; iv: number }
type IvStore = Record<string, IvSnapshot[]>

let store: IvStore | null = null

function load(): IvStore {
  if (store) return store
  if (!existsSync(DATA_FILE)) {
    store = {}
    return store
  }
  try {
    const raw = readFileSync(DATA_FILE, 'utf-8')
    store = JSON.parse(raw) as IvStore
    // Sanity — if file is corrupt, start fresh
    if (typeof store !== 'object' || store === null || Array.isArray(store)) {
      store = {}
    }
  } catch {
    store = {}
  }
  return store
}

function persist(): void {
  const s = load()
  try {
    mkdirSync(dirname(DATA_FILE), { recursive: true })
    writeFileSync(DATA_FILE, JSON.stringify(s), 'utf-8')
  } catch (e) {
    console.warn('[ivHistory] persist failed:', (e as Error).message)
  }
}

/** Today's date string in ET (US Eastern), format YYYY-MM-DD. */
function todayET(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

/**
 * Record a live ATM IV reading for `symbol`.
 * Deduplicates by date — only one reading per trading day.
 */
export function recordIv(symbol: string, iv: number): void {
  if (!Number.isFinite(iv) || iv <= 0) return
  const sym = symbol.toUpperCase()
  const date = todayET()
  const s = load()

  if (!s[sym]) s[sym] = []
  const series = s[sym]

  // Already recorded today?
  if (series.length > 0 && series[series.length - 1].date === date) {
    // Update today's reading (may have fetched a fresher quote)
    series[series.length - 1].iv = iv
  } else {
    series.push({ date, iv })
  }

  // Trim to max
  if (series.length > MAX_DAYS_PER_SYMBOL) {
    s[sym] = series.slice(-MAX_DAYS_PER_SYMBOL)
  }

  // Cap total symbols
  const syms = Object.keys(s)
  if (syms.length > MAX_SYMBOLS) {
    // Evict symbols with fewest data points
    const sorted = syms
      .map((k) => ({ k, len: s[k].length }))
      .sort((a, b) => a.len - b.len)
    const toEvict = sorted.slice(0, syms.length - MAX_SYMBOLS)
    for (const { k } of toEvict) delete s[k]
  }

  persist()
}

export type IvRankResult = {
  rank: number        // 0-100
  source: 'iv-history' | 'dolt-iv' | 'rv-fallback'
  samples: number     // number of historical data points used
  confidence?: number // 0-1: how much of a year the rank is based on (<1 = shrunk)
  currentIv: number   // current ATM IV (annualized, 0-1)
  ivLow: number       // 52-week low IV
  ivHigh: number      // 52-week high IV
  currentRv?: number  // realized vol — always populated when RV data exists
  rvLow?: number
  rvHigh?: number
}

/**
 * Compute IV Rank from accumulated history.
 * Returns null if we have no history AND no RV fallback data.
 *
 * @param symbol  Ticker
 * @param currentIv  Current ATM IV (annualized, 0-1 scale). Will be recorded.
 * @param rvFallback  Optional RV-based fallback data (from computeRvRank)
 */
type RvFallback = {
  rank: number
  samples: number
  currentRv: number
  rvLow: number
  rvHigh: number
} | null | undefined

/** IV Rank from our own accumulated series, shrunk toward 50 by `confidence`
 *  (1 = full year, no shrink). RV is threaded through for the engine's IV-RV
 *  edge (sim sigma blends toward RV; dropping it here once biased selection). */
function ivRankFromSeries(
  symbol: string,
  series: IvSnapshot[],
  currentIv: number,
  confidence: number,
  rv: RvFallback
): IvRankResult {
  const window = series.slice(-FULL_HISTORY_DAYS)
  const ivValues = window.map((d) => d.iv)
  const min = Math.min(...ivValues)
  const max = Math.max(...ivValues)

  let rank: number
  if (max - min < 0.001) {
    rank = 50 // flat IV → middle
  } else {
    const raw = Math.max(0, Math.min(100, ((currentIv - min) / (max - min)) * 100))
    rank = 50 + (raw - 50) * confidence
  }

  console.log(
    `[ivRank] ${symbol}: rank=${rank.toFixed(1)} (IV=${(currentIv * 100).toFixed(1)}%, ` +
      `range=${(min * 100).toFixed(1)}%–${(max * 100).toFixed(1)}%, ` +
      `samples=${window.length}, conf=${confidence.toFixed(2)}, source=iv-history)`
  )
  return {
    rank, source: 'iv-history', samples: window.length, confidence, currentIv,
    ivLow: min, ivHigh: max, currentRv: rv?.currentRv, rvLow: rv?.rvLow, rvHigh: rv?.rvHigh
  }
}

export function computeIvRankFromHistory(
  symbol: string,
  currentIv: number,
  rvFallback?: RvFallback,
  doltRange?: DoltIvRange | null
): IvRankResult | null {
  const sym = symbol.toUpperCase()

  // Record this reading (self-accumulation continues regardless of source used)
  if (Number.isFinite(currentIv) && currentIv > 0) {
    recordIv(sym, currentIv)
  }

  const s = load()
  const series = s[sym]
  const points = series?.length ?? 0

  // 1. Own history, matured to a full year → self-sufficient, graduate to it.
  if (series && points >= FULL_HISTORY_DAYS) {
    return ivRankFromSeries(sym, series, currentIv, 1, rvFallback)
  }

  // 2. Primary while our own history is immature: DoltHub's true 52-week range.
  if (doltRange && doltRange.yearHigh - doltRange.yearLow > 0.001) {
    const raw = ((currentIv - doltRange.yearLow) / (doltRange.yearHigh - doltRange.yearLow)) * 100
    const rank = Math.max(0, Math.min(100, raw))
    console.log(
      `[ivRank] ${sym}: rank=${rank.toFixed(1)} (IV=${(currentIv * 100).toFixed(1)}%, ` +
        `dolt range=${(doltRange.yearLow * 100).toFixed(1)}%–${(doltRange.yearHigh * 100).toFixed(1)}%, source=dolt-iv)`
    )
    return {
      rank, source: 'dolt-iv', samples: points, confidence: 1, currentIv,
      ivLow: doltRange.yearLow, ivHigh: doltRange.yearHigh,
      currentRv: rvFallback?.currentRv, rvLow: rvFallback?.rvLow, rvHigh: rvFallback?.rvHigh
    }
  }

  // 3. Own history but shallow → shrink toward 50 by depth (confidence = pts/year).
  if (series && points >= MIN_SAMPLES) {
    return ivRankFromSeries(sym, series, currentIv, Math.min(1, points / FULL_HISTORY_DAYS), rvFallback)
  }

  // 4. Fall back to RV-based rank
  if (rvFallback) {
    const historyPoints = series?.length ?? 0
    console.log(
      `[ivRank] ${sym}: using RV fallback (only ${historyPoints} IV points, need 30). ` +
        `RV-rank=${rvFallback.rank.toFixed(1)}`
    )
    return {
      rank: rvFallback.rank,
      source: 'rv-fallback',
      samples: rvFallback.samples,
      currentIv,
      ivLow: 0,
      ivHigh: 0,
      currentRv: rvFallback.currentRv,
      rvLow: rvFallback.rvLow,
      rvHigh: rvFallback.rvHigh
    }
  }

  return null
}

/**
 * Get raw IV history for a symbol (for API exposure / charting).
 */
export function getIvHistory(symbol: string): IvSnapshot[] {
  const s = load()
  return s[symbol.toUpperCase()] ?? []
}
