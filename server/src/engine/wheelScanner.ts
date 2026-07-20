/**
 * Wheel-strategy recommender (轮子): cash-secured puts on stocks worth OWNING,
 * plus covered-call suggestions on shares already held.
 *
 * The wheel differs from the pure sell-vol board in one fundamental way:
 * assignment is a FEATURE, not a failure — so candidates must pass a
 * fundamentals gate ("would I be happy owning this at this price?") before
 * any premium math matters. It also doesn't need a high-IVR regime: a fair
 * price on a good business plus a decent annualized yield is enough, which
 * makes it the low-vol-desert counterpart to the condor board.
 *
 * Gates, in order:
 *   1. fundamentals  — profitable, sane leverage, not collapsing (hard) +
 *                      quality/valuation score (soft tilt)
 *   2. earnings      — expiry must NOT span the symbol's next earnings
 *   3. account fit   — assignment cost vs real cash (rh-positions bridge)
 *   4. concentration — flag names the book is already heavy in
 * Leveraged ETFs are excluded outright (daily-rebalance decay makes them
 * unfit for buy-and-hold assignment).
 */
import { runSellPutScan, type SellPutCandidate } from './sellPutScanner.js'
import { getFundamentals, type Fundamentals } from '../api/fundamentals.js'
import { getOptionChain, getExpirations, getQuote } from '../api/marketdata.js'
import { getUpcomingEarningsMap } from '../api/finnhub.js'
import { loadRhPositions, type RhPositions } from '../api/rhPositions.js'
import { mapSettledLimit } from './concurrency.js'
import { cached, etCalendarDay, HOUR } from '../ai/cache.js'
import { watchlistCacheSlug, type WatchlistEntry } from '../watchlistDefaults.js'

// Daily-rebalanced leveraged/inverse ETFs — never wheel these.
const LEVERAGED_ETFS = new Set(['SOXL', 'SOXS', 'TQQQ', 'SQQQ', 'UPRO', 'SPXU', 'TNA', 'TZA', 'LABU', 'LABD', 'FNGU', 'UVXY', 'VIXY', 'SVXY'])

export type FundamentalVerdict = {
  /** false → hard-failed the ownership gate. */
  pass: boolean
  /** 0..1 quality/valuation tilt (0.6 neutral for ETFs / missing data). */
  score: number
  /** Short human-readable reasons (Chinese), worst first. */
  notes: string[]
  /** 'company' | 'etf' — ETFs have no fundamentals and pass neutrally. */
  kind: 'company' | 'etf'
}

/**
 * Ownership gate. Heuristic and deliberately coarse — it exists to keep
 * broken businesses out of the wheel, not to rank blue chips precisely.
 */
export function fundamentalGate(f: Fundamentals | null): FundamentalVerdict {
  // No data at all → almost certainly an ETF (Finnhub metric returns empties).
  if (!f || (f.netMargin == null && f.roe == null && f.pe == null)) {
    return { pass: true, score: 0.6, notes: ['ETF/无个股基本面,按中性处理'], kind: 'etf' }
  }
  const notes: string[] = []
  let pass = true
  if (f.netMargin != null && f.netMargin <= 0) { pass = false; notes.push(`TTM 亏损(净利率 ${f.netMargin.toFixed(1)}%)`) }
  if (f.roe != null && f.roe < 5) { pass = false; notes.push(`ROE 过低(${f.roe.toFixed(1)}%)`) }
  // High leverage is a SOFT penalty, not a hard fail: banks/financials
  // structurally run D/E 3-12 and we can't tell sector from the metric blob.
  // The leverage component of the score already discounts it; profitability
  // and growth hard gates still protect against genuinely broken balance sheets.
  if (f.debtToEquity != null && f.debtToEquity > 3) notes.push(`D/E ${f.debtToEquity.toFixed(1)} 高杠杆(金融股常态,已降分)`)
  if (f.revenueGrowth != null && f.revenueGrowth < -10) { pass = false; notes.push(`营收收缩(${f.revenueGrowth.toFixed(1)}%)`) }

  // Soft score: profitability 35% + growth 20% + valuation 30% + leverage 15%.
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
  const profit = (f.roe != null ? clamp01(f.roe / 25) : 0.5) * 0.2 + (f.netMargin != null ? clamp01(f.netMargin / 25) : 0.5) * 0.15
  const growth = (f.revenueGrowth != null ? clamp01(f.revenueGrowth / 20) : 0.5) * 0.2
  const peScore = f.pe != null && f.pe > 0 ? clamp01((40 - f.pe) / 25) : 0.3 // <=15x → 1, >=40x → 0
  const valuation = peScore * 0.3
  const leverage = (f.debtToEquity != null ? clamp01((3 - f.debtToEquity) / 3) : 0.5) * 0.15
  const score = clamp01(profit + growth + valuation + leverage)

  if (pass) {
    if (f.pe != null) notes.push(`PE ${f.pe.toFixed(0)}`)
    if (f.roe != null) notes.push(`ROE ${f.roe.toFixed(0)}%`)
    if (f.revenueGrowth != null) notes.push(`营收 ${f.revenueGrowth > 0 ? '+' : ''}${f.revenueGrowth.toFixed(0)}%`)
    if (f.debtToEquity != null && f.debtToEquity > 1.5) notes.push(`D/E ${f.debtToEquity.toFixed(1)} 偏高`)
  }
  return { pass, score, notes, kind: 'company' }
}

export type WheelCspCandidate = SellPutCandidate & {
  fundamentals: FundamentalVerdict
  /** strike × 100 — cash needed if assigned. */
  assignmentCost: number
  /** Does the bridge account's cash cover assignment? null when bridge missing. */
  cashOk: boolean | null
  /** Effective cost if assigned (= breakeven) as % below spot. */
  discountPct: number
  /** Shares of this symbol already held (bridge). */
  heldQty: number
  /** True when the book is already meaningfully exposed to this name. */
  concentrated: boolean
  /** Next earnings date if within horizon (informational — spanning ones are dropped). */
  nextEarnings: string | null
  /** tasty score × fundamentals tilt. */
  wheelScore: number
}

export type CoveredCallSuggestion = {
  sym: string
  heldQty: number
  contractsAvailable: number
  costBasis: number
  spot: number
  expiration: string
  dte: number
  strike: number
  premium: number
  delta: number | null
  /** Annualized premium yield on spot. */
  yieldAnnualized: number
  /** Total return if called away: (strike − cost + premium) / cost. */
  ifCalledReturnPct: number
  /** Cost basis is above spot by >25% — CC income will be thin. */
  underwater: boolean
  /** Next confirmed earnings date, if one is known within the horizon. */
  nextEarnings: string | null
  /**
   * The chosen expiration lands on/after earnings. Unlike a CSP — which would be
   * taking on brand-new jump risk — a covered call written on shares already held
   * carries exposure the holder has anyway, and the inflated event IV is real
   * money. So this is surfaced as a labelled trade-off (you cap the upside gap),
   * not filtered out. An earlier, pre-earnings expiration is preferred when the
   * 21-50 DTE window offers one.
   */
  spansEarnings: boolean
  note: string
}

export type WheelScanResult = {
  asof: string
  csp: WheelCspCandidate[]
  coveredCalls: CoveredCallSuggestion[]
  skipped: { sym: string; reason: string }[]
  cash: number | null
}

/** Pick the covered-call strike: OTM, delta ≤ maxDelta, and NEVER below cost basis. */
export function pickCoveredCallStrike(
  calls: Array<{ strike: number; bid: number; ask: number; mid: number; greeks?: { delta?: number } | null }>,
  spot: number,
  costBasis: number,
  maxDelta = 0.35
): { strike: number; premium: number; delta: number | null } | null {
  const floor = Math.max(spot, costBasis) // the hard rule: assignment must not lock a loss
  const eligible = calls
    .filter((c) => c.strike >= floor && (c.bid ?? 0) > 0)
    .filter((c) => {
      const d = c.greeks?.delta
      return d == null || Math.abs(d) <= maxDelta
    })
    .sort((a, b) => a.strike - b.strike)
  if (eligible.length === 0) return null
  // Prefer delta nearest 0.25 when greeks exist; else nearest strike above floor.
  const withDelta = eligible.filter((c) => c.greeks?.delta != null)
  const pick = withDelta.length
    ? withDelta.reduce((best, c) => Math.abs(Math.abs(c.greeks!.delta!) - 0.25) < Math.abs(Math.abs(best.greeks!.delta!) - 0.25) ? c : best)
    : eligible[0]
  const premium = pick.mid > 0 ? pick.mid : (pick.bid + pick.ask) / 2
  return { strike: pick.strike, premium, delta: pick.greeks?.delta ?? null }
}

/** One retry after a short pause — the CC fetch fires right after the heavy
 *  CSP scan, and a momentary provider burst-limit shouldn't kill a holding. */
/**
 * Choose the covered-call expiration: 21-50 DTE, nearest 35, but preferring one
 * that settles BEFORE the next report when the window offers such a date — same
 * premium harvest, none of the gap risk. Falls back to a spanning expiration
 * (the caller flags it) rather than dropping the suggestion, because the holder
 * carries the earnings exposure either way.
 */
export function pickCcExpiration(
  exps: string[],
  now: number,
  earnings: string | null
): { e: string; d: number } | null {
  const window = exps
    .map((e) => ({ e, d: Math.round((Date.parse(e) - now) / 86400000) }))
    .filter((x) => x.d >= 21 && x.d <= 50)
    .sort((a, b) => Math.abs(a.d - 35) - Math.abs(b.d - 35))
  const clean = earnings ? window.filter((x) => x.e < earnings) : window
  return clean[0] ?? window[0] ?? null
}

async function withRetry<T>(fn: () => Promise<T>, delayMs = 1500): Promise<T> {
  try { return await fn() } catch {
    await new Promise((r) => setTimeout(r, delayMs))
    return fn()
  }
}

/** Provider errors can be whole HTML pages — reduce to something readable. */
function cleanErr(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e)
  const cut = msg.indexOf('<')
  const short = (cut > 0 ? msg.slice(0, cut) : msg).trim().slice(0, 60)
  return short || '数据源暂时不可用(已重试)'
}

async function buildCoveredCalls(rh: RhPositions | null, skipped: { sym: string; reason: string }[]): Promise<CoveredCallSuggestion[]> {
  if (!rh) return []
  const holdings = rh.equities.filter((e) => e.qty >= 100)
  const existingShortCalls = new Set(
    rh.optionLegs.filter((l) => l.side === 'short' && l.optionType === 'call').map((l) => l.sym)
  )
  // Earnings for HELD names, which need not overlap the scanned watchlist.
  const earnMap = await getUpcomingEarningsMap(holdings.map((h) => h.sym), 60).catch(
    (): Record<string, string> => ({})
  )
  const results = await mapSettledLimit(holdings, 4, async (h): Promise<CoveredCallSuggestion | null> => {
    if (LEVERAGED_ETFS.has(h.sym)) return null
    if (existingShortCalls.has(h.sym)) {
      skipped.push({ sym: h.sym, reason: '已有短 call 在挂,避免重复覆盖' })
      return null
    }
    const [quote, exps] = await withRetry(() => Promise.all([getQuote(h.sym), getExpirations(h.sym)]))
    if (!quote.last) throw new Error('无报价')
    const earn = earnMap[h.sym] ?? null
    const target = pickCcExpiration(exps, Date.now(), earn)
    if (!target) throw new Error('无 21-50 DTE 到期')
    const spansEarnings = !!earn && earn <= target.e
    const chain = await withRetry(() => getOptionChain(h.sym, target.e))
    const calls = chain.filter((c) => c.optionType === 'call')
    const underwater = h.avgCost > quote.last * 1.25
    const pick = pickCoveredCallStrike(calls, quote.last, h.avgCost)
    if (!pick) throw new Error(underwater ? '成本远高于现价,链上无≥成本的合理 call' : '无合规 call(≥成本且 Δ≤0.35)')
    const yieldAnnualized = (pick.premium / quote.last) * (365 / target.d)
    return {
      sym: h.sym,
      heldQty: h.qty,
      contractsAvailable: Math.floor(h.qty / 100),
      costBasis: h.avgCost,
      spot: quote.last,
      expiration: target.e,
      dte: target.d,
      strike: pick.strike,
      premium: pick.premium,
      delta: pick.delta,
      yieldAnnualized,
      ifCalledReturnPct: ((pick.strike - h.avgCost + pick.premium) / h.avgCost) * 100,
      underwater,
      nextEarnings: earn,
      spansEarnings,
      note: underwater
        ? '⚠ 深度浮亏持仓,call 收入薄——先想清楚去留'
        : spansEarnings
          ? `⚠ 跨财报(${earn})——权利金里含事件溢价,代价是封住跳空上行`
          : ''
    }
  })
  const out: CoveredCallSuggestion[] = []
  for (let i = 0; i < holdings.length; i++) {
    const r = results[i]
    if (r.status === 'fulfilled' && r.value) out.push(r.value)
    else if (r.status === 'rejected') skipped.push({ sym: holdings[i].sym, reason: cleanErr(r.reason) })
  }
  return out.sort((a, b) => b.yieldAnnualized - a.yieldAnnualized)
}

async function runWheelScanUncached(watchlist: WatchlistEntry[]): Promise<WheelScanResult> {
  const skipped: { sym: string; reason: string }[] = []
  const rh = loadRhPositions()
  const cash = rh?.account.cash ?? null
  const accountTotal = rh?.account.totalValue ?? null

  const eligible = watchlist.filter((w) => {
    if (LEVERAGED_ETFS.has(w.sym)) { skipped.push({ sym: w.sym, reason: '杠杆 ETF,不适合接股持有' }); return false }
    return true
  })

  const [scan, earnMap, fundResults] = await Promise.all([
    runSellPutScan(eligible),
    getUpcomingEarningsMap(eligible.map((e) => e.sym), 60).catch((): Record<string, string> => ({})),
    mapSettledLimit(eligible, 6, (e) => getFundamentals(e.sym))
  ])
  const fundBySym = new Map<string, Fundamentals | null>()
  eligible.forEach((e, i) => {
    const r = fundResults[i]
    fundBySym.set(e.sym, r.status === 'fulfilled' ? r.value : null)
  })
  // Symbols the sell-put scan itself failed on (rate limits etc.) — surface,
  // don't silently vanish.
  for (const s of scan.skipped) skipped.push({ sym: s.sym, reason: `期权数据失败:${(s.reason.split('<')[0].trim() || '数据源暂时不可用').slice(0, 60)}` })

  const heldBySym = new Map<string, number>((rh?.equities ?? []).map((e) => [e.sym, e.qty]))
  const seen = new Set<string>()
  const csp: WheelCspCandidate[] = []
  for (const c of scan.candidates.sort((a, b) => b.score - a.score)) {
    if (seen.has(`${c.sym}`)) continue // best row per symbol
    const earn = earnMap[c.sym] ?? null
    if (earn && earn <= c.expiration) { if (!seen.has(c.sym)) { skipped.push({ sym: c.sym, reason: `跨财报(${earn})` }); seen.add(c.sym) } continue }
    const verdict = fundamentalGate(fundBySym.get(c.sym) ?? null)
    if (!verdict.pass) { skipped.push({ sym: c.sym, reason: `基本面不过关:${verdict.notes.join('、')}` }); seen.add(c.sym); continue }
    seen.add(c.sym)
    const heldQty = heldBySym.get(c.sym) ?? 0
    const heldValue = heldQty * c.spot
    csp.push({
      ...c,
      fundamentals: verdict,
      assignmentCost: c.strike * 100,
      cashOk: cash != null ? c.strike * 100 <= cash : null,
      discountPct: ((c.spot - c.breakeven) / c.spot) * 100,
      heldQty,
      concentrated: heldQty >= 100 || (accountTotal != null && heldValue > accountTotal * 0.05),
      nextEarnings: earn,
      wheelScore: c.score * (0.5 + 0.5 * verdict.score)
    })
  }
  csp.sort((a, b) => b.wheelScore - a.wheelScore)

  const coveredCalls = await buildCoveredCalls(rh, skipped)
  return { asof: new Date().toISOString(), csp, coveredCalls, skipped, cash }
}

/** Wheel scan, cached per ET day (6h TTL). */
export async function runWheelScan(watchlist: WatchlistEntry[]): Promise<WheelScanResult> {
  const key = `wheel-scan-v1-${etCalendarDay()}-${watchlistCacheSlug(watchlist)}`
  return cached(key, 6 * HOUR, () => runWheelScanUncached(watchlist))
}
