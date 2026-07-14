import type { FastifyInstance } from 'fastify'
import { formatAsofEt, mergeLiveMacroIntoDashboardMarket } from '../ai/liveMacro.js'
import type { MarketSnapshot } from '../ai/marketNarrative.js'
import { buildOppsFromScan, type Opp, type OppTag } from '../ai/opportunities.js'
import { getAiTickerNotes } from '../ai/tickerNotes.js'
import { getScannedOpps } from '../engine/oppScanner.js'
import { summarizeBookRisk, enrichBookRiskWithCorrelation, type BookRisk } from '../engine/portfolioRisk.js'
import { computeRealBook, type RealBook } from '../engine/realBook.js'
import { fetchWatchlistQuotes, fetchLiveIvData, computeIvRank } from '../api/marketdata.js'
import { fetchCnnFearGreed } from '../api/cnnFearGreed.js'
import { archiveChains } from '../api/chainArchive.js'
import { fetchEarningsCalendar } from '../api/finnhub.js'
import { cached, etCalendarDay, DAY } from '../ai/cache.js'
import { recordDashboardScanSnapshots } from '../feedback/index.js'
import {
  DEFAULT_WATCHLIST,
  parseWatchlistSymbolsQuery,
  watchlistCacheSlug,
  type WatchlistEntry
} from '../watchlistDefaults.js'

/** One upcoming earnings date for a watchlist symbol. `spansEntry` = a new
 *  position opened today at the max scan DTE would straddle it (event risk). */
export type EarningsCalendarEntry = {
  sym: string
  date: string // ISO YYYY-MM-DD
  label: string // e.g. "Jul 22"
  daysUntil: number
  spansEntry: boolean
}

export type Market = {
  asof: string
  /** SPY (S&P 500 ETF) — price ≈ SPX / 10. Free tier has no SPX index access. */
  spy: { v: number; chg: number }
  /** VIXY (VIX futures ETF) — direction tracks VIX, absolute level is contango-distorted. */
  vixy: { v: number; chg: number }
  /** 0-100 fear-greed score. null when CNN feed is unavailable. */
  fearGreed: number | null
  ivRankAvg: number | null
  earningsToday: number
  /** Watchlist earnings within MAX_ENTRY_SPAN_DAYS, soonest first. */
  earningsCalendar: EarningsCalendarEntry[]
  fedDays: number
}

/** A new 30/45-DTE position opened today spans any earnings within this many
 *  days — the window that actually matters for the sell-vol board. */
const MAX_ENTRY_SPAN_DAYS = 45

export type Mood = {
  /** 0-100 fear-greed score. null when CNN feed is unavailable. */
  index: number | null
  label: string
  pulse: number[]
  factors: { tone: 'gain' | 'accent' | 'ink'; label: string; detail: string }[]
}

export type EngineView = {
  prose: string
  buckets: { label: string; value: number; hint: string }[]
}

export type { Opp, OppTag } from '../ai/opportunities.js'

export type Ticker = {
  sym: string
  name: string
  /** Live last price; null when MarketData quote was unavailable. */
  px: number | null
  /** Live percent change vs previous close; null when unavailable. */
  chg: number | null
  /** ATM implied volatility (annualized, 0-1 scale); null when chain unavailable. */
  iv: number | null
  /** IV Rank (0-100 percentile); null when computation unavailable. */
  ivr: number | null
  /** How the IVR was derived — 'rv-fallback' means no real IV history, so the
   *  rank is an unreliable RV proxy (don't treat as a vol-richness signal). */
  ivrSource?: 'iv-history' | 'dolt-iv' | 'rv-fallback' | null
  /** Expected move ±$ (ATM straddle mid); null when chain unavailable. */
  em: number | null
  /** Next earnings date ('May 28' format); '—' when unknown. */
  earn: string
  note: string
}

export type DashboardData = {
  market: Market
  mood: Mood
  engine: EngineView
  opps: Opp[]
  tickers: Ticker[]
  /** Book-level risk of the whole recommended board (net greeks + tail). */
  bookRisk?: BookRisk
  /** Net greeks of the user's REAL RH option book (bridge file; null when absent). */
  realBook?: RealBook | null
  /** ISO timestamp when this snapshot was built (server wall clock). */
  fetchedAt: string
}

export type { WatchlistEntry } from '../watchlistDefaults.js'

// ==================== FOMC 2026 calendar (Task 3) ====================

/**
 * 2026 FOMC announcement dates (second day of each 2-day meeting).
 * Source: Federal Reserve projected schedule.
 */
const FOMC_2026_DATES = [
  '2026-01-28',
  '2026-03-18',
  '2026-05-06',
  '2026-06-17',
  '2026-07-29',
  '2026-09-16',
  '2026-10-28',
  '2026-12-16'
]

/** Days until next FOMC announcement (0 = today is FOMC day). */
function computeFedDays(): number {
  const today = etCalendarDay() // 'YYYY-MM-DD' in ET
  const [ty, tm, td] = today.split('-').map(Number)
  const todayMs = new Date(ty, tm - 1, td).getTime()

  for (const dateStr of FOMC_2026_DATES) {
    const [y, m, d] = dateStr.split('-').map(Number)
    const diff = Math.round((new Date(y, m - 1, d).getTime() - todayMs) / 86400000)
    if (diff >= 0) return diff
  }
  return -1 // past all 2026 dates
}

// ==================== Earnings helpers (Task 2) ====================

function formatEarnDate(isoDate: string): string {
  const [, m, d] = isoDate.split('-').map(Number)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[m - 1]} ${String(d).padStart(2, '0')}`
}

/** Fetch earningsToday count + next earn dates for watchlist. Cached 24h. */
async function fetchEarningsData(symbols: string[]): Promise<{
  todayCount: number
  nextEarnBySymbol: Record<string, string>
  nextEarnIsoBySymbol: Record<string, string>
  calendar: EarningsCalendarEntry[]
}> {
  const etNow = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })
  )
  const today = etNow.toISOString().slice(0, 10)

  // Finnhub's free calendar caps each response at 1500 rows and truncates the
  // NEAR end first, so a wide window silently drops the SOONEST earnings — the
  // ones that matter most (e.g. UNH reporting in 3 days vanished behind 45 days
  // of small-caps). Chunk the horizon into ≤15-day slices, each well under the
  // cap, and merge. Cached daily, so the extra calls cost nothing.
  const CHUNK_DAYS = 15
  const HORIZON_DAYS = 90
  const ranges: Array<[string, string]> = []
  for (let start = 0; start < HORIZON_DAYS; start += CHUNK_DAYS) {
    const from = new Date(etNow.getTime() + start * 86400000).toISOString().slice(0, 10)
    const to = new Date(etNow.getTime() + Math.min(start + CHUNK_DAYS, HORIZON_DAYS) * 86400000).toISOString().slice(0, 10)
    ranges.push([from, to])
  }
  const chunks = await Promise.all(ranges.map(([f, t]) => fetchEarningsCalendar(f, t).catch(() => [])))
  const calendar = chunks.flat()

  let todayCount = 0
  const nextEarnBySymbol: Record<string, string> = {}
  const nextEarnIsoBySymbol: Record<string, string> = {}
  const symSet = new Set(symbols.map((s) => s.toUpperCase()))

  // Chunks may not be globally date-sorted (and can overlap on boundaries), so
  // keep the EARLIEST future date per symbol explicitly rather than first-seen.
  for (const entry of calendar) {
    if (entry.date === today) todayCount++
    const sym = entry.symbol.toUpperCase()
    if (symSet.has(sym) && (!(sym in nextEarnIsoBySymbol) || entry.date < nextEarnIsoBySymbol[sym])) {
      nextEarnBySymbol[sym] = formatEarnDate(entry.date)
      nextEarnIsoBySymbol[sym] = entry.date
    }
  }

  const todayMs = Date.parse(today)
  const entryCalendar: EarningsCalendarEntry[] = Object.entries(nextEarnIsoBySymbol)
    .map(([sym, date]) => {
      const daysUntil = Math.round((Date.parse(date) - todayMs) / 86400000)
      return { sym, date, label: formatEarnDate(date), daysUntil, spansEntry: daysUntil <= MAX_ENTRY_SPAN_DAYS }
    })
    .sort((a, b) => a.date.localeCompare(b.date))

  return { todayCount, nextEarnBySymbol, nextEarnIsoBySymbol, calendar: entryCalendar }
}

// ==================== Dashboard seed (minimal — only non-live parts) ====================

/**
 * Seed dashboard data. After Task 1+2+3, only these remain as seed:
 *   - mood label/pulse (overwritten by AI narrative)
 *   - engine buckets (roadmap: screening rules)
 *   - opps (task 4 will make these dynamic)
 *   - ticker notes (task 5 will make these AI-generated)
 *
 * ALL market/IV/IVR/EM/earningsToday/fedDays/earn fields are now live.
 */
export const DASHBOARD: DashboardData = {
  market: {
    asof: '',
    spy: { v: 0, chg: 0 },
    vixy: { v: 0, chg: 0 },
    fearGreed: null,
    ivRankAvg: null,
    earningsToday: 0,
    earningsCalendar: [],
    fedDays: 0
  },
  mood: {
    index: null,
    label: '',
    pulse: [],
    factors: []
  },
  engine: {
    prose: '',
    buckets: [
      { label: '看涨结构', value: 0, hint: '尚未接入' },
      { label: '卖方结构', value: 0, hint: '尚未接入' },
      { label: '事件交易', value: 0, hint: '尚未接入' },
      { label: '对冲建议', value: 0, hint: '尚未接入' }
    ]
  },
  opps: [], // built live by AI in buildLiveDashboard()
  tickers: [], // built live in buildLiveDashboard()
  fetchedAt: ''
}

/** 与 Dashboard 拉叙事时同一套口径（IVR 用 tickers 中位数，与 client 一致）。 */
export function dashboardSeedToMarketSnapshot(data: DashboardData): MarketSnapshot {
  const m = data.market
  const validIvrs = data.tickers.filter((t) => t.ivr != null).map((t) => t.ivr!)
  const ivRankMedian = (() => {
    if (validIvrs.length === 0) return 0
    const sorted = [...validIvrs].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return Math.round(
      sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid]
    )
  })()
  // Ground the narrative in what the gated scanner actually surfaced.
  const qualified = data.opps.filter((o) => (o.boardTier ?? 'qualified') === 'qualified')
  const withIvr = data.tickers.filter((t) => t.ivr != null)
  const lowIvrShare = withIvr.length
    ? withIvr.filter((t) => (t.ivr ?? 0) < 30).length / withIvr.length
    : 1
  const emptyReason =
    lowIvrShare >= 0.5
      ? 'IVR 普遍偏低,多数标的低于 30 达标线,卖波动溢价不足'
      : '无达标卖波动机会,或临近财报、或波动率不够贵'

  return {
    asof: formatAsofEt(),
    spy: { ...m.spy },
    vixy: { ...m.vixy },
    ivRankMedian,
    fearGreed: m.fearGreed,
    earningsUpcoming: m.earningsCalendar.map((e) => ({ sym: e.sym, label: e.label, daysUntil: e.daysUntil })),
    fedDays: m.fedDays,
    // Only include tickers with live chg — keeps the AI snapshot honest.
    watchlistTickers: data.tickers.flatMap((t) =>
      t.chg == null || t.iv == null || t.ivr == null || t.em == null
        ? []
        : [{ sym: t.sym, iv: t.iv, ivr: t.ivr, ivrReliable: t.ivrSource !== 'rv-fallback', em: t.em, chg: t.chg }]
    ),
    board: {
      qualifiedCount: qualified.length,
      emptyReason: qualified.length === 0 ? emptyReason : undefined,
      setups: qualified.slice(0, 4).map((o) => ({ sym: o.sym, strategy: o.strategy }))
    }
  }
}

// ==================== Live snapshot for warmer / AI ====================

// Underlying data barely moves faster than this (chains cache 15 min, quotes
// are ~15-min delayed anyway), so rebuilding every minute was pure churn.
const DASHBOARD_TTL_MS = (Number(process.env.DASHBOARD_TTL_MIN) || 5) * 60 * 1000

/** Shared entry point — routes pass custom watchlist; warmer uses default only. */
export function getCachedDashboard(entries: WatchlistEntry[]): Promise<DashboardData> {
  const slug = watchlistCacheSlug(entries)
  return cached(`dashboard-live-${slug}`, DASHBOARD_TTL_MS, () => buildLiveDashboard(entries))
}

/**
 * Build a fully-live MarketSnapshot for the AI narrative warmer.
 * Goes through getCachedDashboard() so warmer populates the route cache.
 */
export async function buildLiveMarketSnapshot(): Promise<MarketSnapshot> {
  const data = await getCachedDashboard(DEFAULT_WATCHLIST)
  return dashboardSeedToMarketSnapshot(data)
}

// ==================== Engine buckets ====================

/**
 * Classify opps into 4 strategy buckets for the dashboard gauge.
 *
 * - 看涨结构: bull_call_spread
 * - 卖方结构: iron_condor, short_strangle (credit strategies)
 * - 事件交易: long_straddle, bear_put_spread (vol/directional plays)
 * - 对冲建议: bearish opps on broad market (SPY) or high-IVR names
 */
function buildEngineBuckets(
  opps: Opp[],
  tickers: { sym: string; ivr: number | null }[]
): EngineView {
  const bullish = opps.filter((o) =>
    o.strategyId === 'bull_call_spread' || o.strategyId === 'bull_put_spread'
  )
  const seller = opps.filter((o) =>
    o.strategyId === 'iron_condor' || o.strategyId === 'short_strangle'
  )
  const event = opps.filter((o) =>
    o.strategyId === 'long_straddle' || o.strategyId === 'bear_put_spread' ||
    o.strategyId === 'bear_call_spread'
  )

  // Hedge bucket: count symbols with IVR ≥ 70 (elevated risk)
  const highIvrSyms = tickers.filter((t) => t.ivr != null && t.ivr >= 70)

  function topSyms(list: Opp[], n = 2): string {
    if (list.length === 0) return '—'
    return list
      .slice(0, n)
      .map((o) => o.sym)
      .join(', ')
  }

  const buckets = [
    {
      label: '看涨结构',
      value: bullish.length,
      hint: bullish.length > 0 ? topSyms(bullish) : '无信号'
    },
    {
      label: '卖方结构',
      value: seller.length,
      hint: seller.length > 0 ? topSyms(seller) : '无信号'
    },
    {
      label: '事件交易',
      value: event.length,
      hint: event.length > 0 ? topSyms(event) : '无信号'
    },
    {
      label: '对冲建议',
      value: highIvrSyms.length,
      hint:
        highIvrSyms.length > 0
          ? highIvrSyms
              .slice(0, 2)
              .map((t) => `${t.sym} IVR${Math.round(t.ivr!)}`)
              .join(', ')
          : '风险适中'
    }
  ]

  // One-line prose summary
  const totalSignals = bullish.length + seller.length + event.length
  let prose = ''
  if (totalSignals === 0) {
    prose = '今日引擎未发现明显机会，建议观望。'
  } else if (seller.length >= bullish.length && seller.length >= event.length) {
    prose = `卖方结构主导 — ${seller.length} 个标的 IV 溢价，适合收割 theta。`
  } else if (bullish.length > 0) {
    prose = `${bullish.length} 个看涨信号，市场偏多。`
  } else {
    prose = `${event.length} 个事件/波动交易机会。`
  }

  return { prose, buckets }
}

// ==================== Live dashboard builder ====================

/**
 * Build the live dashboard. All data fields are fetched from live APIs.
 *
 * Sources:
 *   - SPY/VIXY/asof   → Finnhub /quote ETFs (HARD; required)
 *   - F&G             → CNN graphdata feed (SOFT; null on failure)
 *   - Tickers px/chg  → MarketData stocks/quotes (SOFT; per-symbol null)
 *   - Tickers IV/EM   → MarketData options/chain delta-filtered (SOFT; 24h cache)
 *   - Tickers IVR     → MarketData stocks/candles RV percentile (SOFT; 24h cache)
 *   - earningsToday   → Finnhub /calendar/earnings (SOFT; 24h cache)
 *   - earn per ticker  → Finnhub /calendar/earnings (SOFT; 24h cache)
 *   - fedDays         → hardcoded 2026 FOMC calendar (computed)
 *   - Still seed: mood label/pulse, engine buckets, opps, ticker notes
 *
 * Cached at the route level for 60s to absorb refresh bursts.
 */
async function buildLiveDashboard(watchlist: WatchlistEntry[]): Promise<DashboardData> {
  const symbols = watchlist.map((t) => t.sym)
  const fedDays = computeFedDays()
  const wlSlug = watchlistCacheSlug(watchlist)

  // Data flywheel: snapshot today's full chains for offline strategy replay.
  // Idempotent per day, never throws, runs off the critical path.
  archiveChains(symbols).catch(() => {})

  // Phase 1: all independent fetches in parallel
  const [marketRes, fearGreedRes, watchlistQuotes, earningsData, ivDataResults, ivRankResults] =
    await Promise.all([
      mergeLiveMacroIntoDashboardMarket(DASHBOARD.market),
      fetchCnnFearGreed().catch((err): null => {
        console.warn('[dashboard] CNN F&G unavailable:', (err as Error).message)
        return null
      }),
      fetchWatchlistQuotes(symbols),
      cached(`earnings-calendar-${wlSlug}`, DAY, () => fetchEarningsData(symbols)).catch(
        (err): Awaited<ReturnType<typeof fetchEarningsData>> => {
          console.warn('[dashboard] earnings calendar unavailable:', (err as Error).message)
          return { todayCount: 0, nextEarnBySymbol: {}, nextEarnIsoBySymbol: {}, calendar: [] }
        }
      ),
      // IV data: 1 chain call per symbol, 24h self-cached in fetchLiveIvData
      Promise.allSettled(symbols.map((sym) => fetchLiveIvData(sym))),
      // IVR: prefers accumulated IV history, falls back to RV-percentile
      Promise.allSettled(symbols.map((sym) => computeIvRank(sym)))
    ])

  const fearGreed = fearGreedRes?.score ?? null

  // Phase 2: assemble tickers (without notes — notes need ticker data as input)
  const tickersNoNotes = watchlist.map((t, i) => {
    const q = watchlistQuotes[i]
    const ivRes = ivDataResults[i]
    const ivRankRes = ivRankResults[i]

    const ivData = ivRes.status === 'fulfilled' ? ivRes.value : null
    const ivRankData = ivRankRes.status === 'fulfilled' ? ivRankRes.value : null

    return {
      sym: t.sym,
      name: t.name,
      px: q.available ? q.last : null,
      chg: q.available ? q.changePct : null,
      iv: ivData?.iv ?? null,
      ivr: ivRankData?.rank != null ? Math.round(ivRankData.rank) : null,
      ivrSource: ivRankData?.source ?? null,
      em: ivData?.em ?? null,
      earn: earningsData.nextEarnBySymbol[t.sym] ?? '—'
    }
  })

  // Compute ivRankAvg from live IVR values
  const validIvrs = tickersNoNotes.filter((t) => t.ivr != null).map((t) => t.ivr!)
  const ivRankAvg =
    validIvrs.length > 0
      ? Math.round(validIvrs.reduce((s, v) => s + v, 0) / validIvrs.length)
      : null

  const market: Market = {
    ...marketRes,
    fearGreed,
    ivRankAvg,
    earningsToday: earningsData.todayCount,
    earningsCalendar: earningsData.calendar,
    fedDays
  }

  // Phase 3: engine scan + AI copywriting + ticker notes (all daily-cached)
  const tickerDataForAi = tickersNoNotes.map((t) => ({
    sym: t.sym, px: t.px, chg: t.chg,
    iv: t.iv, ivr: t.ivr, ivrReliable: t.ivrSource !== 'rv-fallback', em: t.em, earn: t.earn
  }))

  // Earnings lookup for AI tag inference
  const earnsBySymbol = earningsData.nextEarnBySymbol

  const [scanResult, notesResult] = await Promise.allSettled([
    getScannedOpps(watchlist, watchlist.length, earningsData.nextEarnIsoBySymbol),
    getAiTickerNotes({ tickers: tickerDataForAi })
  ])

  // Only 'qualified' opps are real recommendations. 'reference' near-misses ride
  // along for the UI's 参考位 tier but must NOT feed book risk or the feedback
  // loop (recording sub-threshold trades would poison calibration).
  const scannedQualified = (scanResult.status === 'fulfilled' ? scanResult.value : [])
    .filter((o) => o.boardTier === 'qualified')

  // Build opps: engine scan → AI copywriting
  let opps: Opp[] = []
  if (scanResult.status === 'fulfilled') {
    try {
      opps = await buildOppsFromScan(scanResult.value, earnsBySymbol)
      recordDashboardScanSnapshots(scannedQualified).catch((err) => {
        console.warn('[dashboard] feedback snapshots:', (err as Error).message)
      })
    } catch (err) {
      console.warn('[dashboard] opps copywriting failed:', (err as Error).message)
    }
  } else {
    console.warn('[dashboard] opp scan unavailable:', (scanResult.reason as Error).message)
  }

  const aiNotes: Record<string, string> =
    notesResult.status === 'fulfilled' ? notesResult.value : {}
  if (notesResult.status === 'rejected') {
    console.warn('[dashboard] AI notes unavailable:', (notesResult.reason as Error).message)
  }

  // Final tickers with AI notes (fallback when AI returns empty)
  const tickers: Ticker[] = tickersNoNotes.map((t) => {
    let note = aiNotes[t.sym] ?? ''
    if (!note.trim()) {
      // Generate a minimal fallback from available data
      const ivr = t.ivr != null ? Math.round(t.ivr) : null
      if (ivr != null) {
        if (ivr >= 60) note = `IVR ${ivr}，关注卖方`
        else if (ivr <= 25) note = `IVR ${ivr}，关注买方`
        else note = `IVR ${ivr}，观望`
      } else {
        note = '数据待更新'
      }
    }
    return { ...t, note }
  })

  // Phase 4: build engine buckets from qualified recommendations only
  const engine = buildEngineBuckets(
    opps.filter((o) => (o.boardTier ?? 'qualified') === 'qualified'),
    tickersNoNotes
  )

  // Phase 5: book-level risk of the whole recommended board (net greeks, tail),
  // enriched with measured pairwise correlation, plus the REAL account book
  // from the RH bridge file (both best-effort).
  const scannedForRisk = scannedQualified
  const [bookRisk, realBook] = await Promise.all([
    enrichBookRiskWithCorrelation(summarizeBookRisk(scannedForRisk), scannedForRisk),
    computeRealBook().catch(() => null)
  ])

  return {
    ...DASHBOARD,
    market,
    mood: { ...DASHBOARD.mood, index: fearGreed },
    engine,
    opps,
    tickers,
    bookRisk,
    realBook,
    fetchedAt: new Date().toISOString()
  }
}

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/api/dashboard', async (req, reply) => {
    try {
      const raw = req.query as { symbols?: string | string[] }
      const wl = parseWatchlistSymbolsQuery(raw.symbols)
      return await getCachedDashboard(wl)
    } catch (e) {
      const msg = (e as Error).message
      app.log.warn({ err: msg }, '[dashboard] live build failed')
      return reply.code(502).send({
        error: '实时市场数据不可用',
        detail: msg,
        hint: '检查 FINNHUB_API_KEY / MARKETDATA_TOKEN / 网络代理；不再回退到 mock'
      })
    }
  })
}
