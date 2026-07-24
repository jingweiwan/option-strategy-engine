/**
 * Opportunity scanner — finds the best (symbol, expiration, strategy)
 * combinations across the watchlist by running the real engine.
 *
 * Flow:
 *   1. For each symbol: fetch quote, expirations, IVR
 *   2. Pick 3 representative expirations (~14d, ~30d, ~45d)
 *   3. Fetch chain + run engine for each (symbol × expiration)
 *   4. Score every strategy result, rank globally, return top N
 *
 * The result carries the real expiration, strategyId, legs, metrics —
 * so clicking through to /strategy can show the exact same data.
 *
 * Cached per ET calendar day, 12h TTL.
 */

import { runEngineLive, scoreStrategy, deriveRegime, DIRECTIONAL_DEBIT_SPREADS, type Regime, type View } from './index.js'
import type { ExitPolicy } from './managedExit.js'
import { viewWeight, scaleByViewSkill, loadViewSkill, type ViewSkillTable } from '../feedback/viewSkill.js'
import type { StrategyResult } from './types.js'
import type { StrategyType } from './types.js'
import { impliedVolFromChain } from './liveStrategies.js'
import { mapSettledLimit } from './concurrency.js'
import { getQuote, getExpirations, getOptionChain, computeIvRank, getDailyOhlc } from '../api/marketdata.js'
import { cached, getCachedIfValid, etCalendarDay, HOUR } from '../ai/cache.js'
import { watchlistCacheSlug } from '../watchlistDefaults.js'
import { getDirectionalViews, type SymbolContext } from '../ai/directionalView.js'
import { computeTechnicals, type TechnicalSnapshot, type KeyLevel } from './technicals.js'
import { pairwiseCorrelation } from './portfolioRisk.js'
import { loadCalibrationTable, calibrationMultiplier, type CalibrationTable } from '../feedback/calibration.js'
import {
  TUNER_ENABLED,
  TUNED_STRATEGIES,
  buildArmStats,
  legsForShortDelta,
  armsFor,
  variantId,
  type ArmStats
} from '../feedback/tuner.js'
import { loadSnapshots } from '../feedback/store.js'
import { recordShadowArmSnapshots } from '../feedback/record.js'
import type { LegSpec } from './liveStrategies.js'

// ---------- Types ----------

export type ScannedLeg = {
  type: 'call' | 'put'
  action: 'buy' | 'sell'
  strike: number
  premium: number
  quantity: number
}

export type ScannedOpp = {
  sym: string
  name: string
  expiration: string
  strategyId: StrategyType
  /** Chinese display name */
  strategy: string
  score: number
  spot: number
  iv: number
  ivr: number
  dte: number
  pop: number        // probabilityProfit (0-1 → will be converted to % in AI)
  ev: number
  maxProfit: number | null
  maxLoss: number | null
  netPremium: number
  delta: number
  gamma: number
  vega: number
  theta: number
  regime: Regime
  rvAtScan: number | null
  breakevens: number[]
  legs: ScannedLeg[]
  /** AI directional view that guided strategy selection */
  aiView?: View
  aiViewConfidence?: number
  aiViewReason?: string
  /** Tuner variant id (e.g. "sd0.25") when the online tuner chose the legs. */
  variant?: string | null
  /** Exit-policy arm for the condor A/B ('managed' default / 'runner' experiment). */
  exitPolicy?: ExitPolicy | null
  /** Whether this expiration spans the underlying's next earnings date. */
  spansEarnings?: boolean
  /** Auto-board tier: 'qualified' recommends, 'reference' is a labeled near-miss. */
  boardTier?: OppTier
  /** Nearest support/resistance level to each SHORT strike (for strike placement). */
  shortLevels?: ShortLevel[]
  /** Underlying is in a strong aligned trend — a condor is easily run over. */
  strongTrend?: boolean
}

/** A short strike's proximity to the nearest key level — informational, for
 *  strike placement / management. Not a filter. */
export type ShortLevel = {
  strike: number
  type: 'call' | 'put'
  /** Nearest key level to the short strike. */
  level: number
  /** Signed % from strike to level: +above / −below the strike. */
  distPct: number
  /** How many swing pivots formed the level (significance). */
  touches: number
  /** Short strike sits ON a well-tested level (contested/pin risk). */
  tested: boolean
}

const LEVEL_NEAR_PCT = 3 // within this % of a level counts as "at" it
const LEVEL_TESTED_TOUCHES = 3 // a level this well-tested near a short strike → flag

/** Nearest key level to each short leg; flags shorts pinned on a tested level. */
export function shortLegLevels(legs: ScannedLeg[], keyLevels: KeyLevel[]): ShortLevel[] {
  if (keyLevels.length === 0) return []
  const out: ShortLevel[] = []
  for (const l of legs) {
    if (l.action !== 'sell') continue
    let best = keyLevels[0]
    for (const kl of keyLevels) {
      if (Math.abs(kl.price - l.strike) < Math.abs(best.price - l.strike)) best = kl
    }
    const distPct = ((best.price - l.strike) / l.strike) * 100
    out.push({
      strike: l.strike,
      type: l.type,
      level: best.price,
      distPct: Math.round(distPct * 10) / 10,
      touches: best.touches,
      tested: Math.abs(distPct) <= LEVEL_NEAR_PCT && best.touches >= LEVEL_TESTED_TOUCHES
    })
  }
  return out
}

// ---------- Sell-vol auto-board qualification ----------

export type OppTier = 'qualified' | 'reference'

/** IVR at/above this is "rich enough" to auto-recommend selling premium. */
/** Monte-Carlo path count for the surfaced scan result. The detail page must
 *  replay a card with this exact count (+ seed 42 + same legs) for its POP/EV to
 *  reproduce deterministically — a different count is the last source of drift. */
export const SCAN_SIMULATIONS = 2000

export const IVR_QUALIFY_FLOOR = Number(process.env.IVR_QUALIFY_FLOOR) || 30
/** IVR in [reference, qualify) surfaces as a labeled near-miss, not a rec. */
export const IVR_REFERENCE_FLOOR = Number(process.env.IVR_REFERENCE_FLOOR) || 20

// Credit/condor structures that live or die by selling a RICH, event-free
// variance premium. short_strangle is disabled elsewhere; directional debit
// spreads are gated by autoScanEligible and aren't subject to a vol floor.
const SELL_VOL_STRATEGIES: Set<StrategyType> = new Set(['iron_condor', 'bull_put_spread', 'bear_call_spread'])

/**
 * Auto-board tier for one opportunity. The engine's only proven edge is
 * harvesting a rich, event-free variance risk premium, so a sell-vol structure
 * must clear an IVR floor AND not span earnings before it's recommended:
 *   - 'qualified'  IVR ≥ floor, no earnings before expiry → a real rec
 *   - 'reference'  IVR in [ref, floor), no earnings        → labeled near-miss
 *   - null         IVR < ref, OR earnings-spanning         → dropped entirely
 * Non-sell-vol structures are always 'qualified' (this gate is about vol
 * richness, not direction — direction is gated by autoScanEligible).
 *
 * The IVR floor is only a coarse screen; the real edge test is the downstream
 * score>0 (EV) filter. An rv-fallback IVR is an unreliable *rank* but the EV
 * is computed from real IV, so a positive-EV setup on an rv-fallback name is
 * still a real opportunity — we DON'T demote here (that discarded genuine edge,
 * e.g. QQQ +0.81 EV). The rv-fallback caveat lives in the display layer only
 * (narrative/notes must not headline a fake rank as "seller's paradise").
 */
export function sellVolTier(strategy: StrategyType, ivr: number, spansEarnings: boolean): OppTier | null {
  if (!SELL_VOL_STRATEGIES.has(strategy)) return 'qualified'
  if (spansEarnings) return null // never auto-sell premium through earnings — not even as reference
  if (ivr >= IVR_QUALIFY_FLOOR) return 'qualified'
  if (ivr >= IVR_REFERENCE_FLOOR) return 'reference'
  return null
}

/** Whether an expiration (YYYY-MM-DD) falls on/after the next earnings date. */
function spansEarningsDate(earningsDate: string | undefined, expiration: string): boolean {
  return !!earningsDate && earningsDate !== '—' && earningsDate <= expiration
}

/** How many labeled near-miss candidates ride along below the qualified board. */
const REFERENCE_LIMIT = 3

// ---------- Correlation-aware board diversification ----------

// A candidate whose price is highly correlated with names already on the board
// is down-weighted: five 0.7-correlated tech condors are one bet levered 5×, and
// they blow up together. Below CORR_THRESHOLD → no penalty; at ρ=1 → knocked to
// CORR_PENALTY_FLOOR of its score (so a much stronger candidate can still win).
const CORR_THRESHOLD = 0.5
const CORR_PENALTY_FLOOR = 0.5

/** Score multiplier for `sym` given the already-chosen board. Only POSITIVE
 *  correlation is penalized — a negatively-correlated name is a diversifier. */
function correlationPenalty(
  sym: string,
  chosen: readonly ScannedOpp[],
  returnsBySym: Map<string, Map<string, number>>
): number {
  const rs = returnsBySym.get(sym)
  if (!rs) return 1
  let maxRho = 0
  for (const c of chosen) {
    if (c.sym === sym) continue
    const other = returnsBySym.get(c.sym)
    if (!other) continue
    const rho = pairwiseCorrelation(rs, other)
    if (rho != null && rho > maxRho) maxRho = rho
  }
  if (maxRho <= CORR_THRESHOLD) return 1
  const t = (maxRho - CORR_THRESHOLD) / (1 - CORR_THRESHOLD)
  return 1 - (1 - CORR_PENALTY_FLOOR) * t
}

/** Greedily fill up to `limit` slots; each pick maximizes
 *  score × correlationPenalty(vs already-chosen). Falls back to plain score
 *  order when no returns are available (correlationPenalty → 1). */
export function selectDiverse(
  cands: ScannedOpp[],
  limit: number,
  returnsBySym: Map<string, Map<string, number>>
): ScannedOpp[] {
  const pool = [...cands]
  const chosen: ScannedOpp[] = []
  while (chosen.length < limit && pool.length > 0) {
    let bestIdx = 0
    let bestAdj = -Infinity
    for (let i = 0; i < pool.length; i++) {
      const adj = pool[i].score * correlationPenalty(pool[i].sym, chosen, returnsBySym)
      if (adj > bestAdj) { bestAdj = adj; bestIdx = i }
    }
    chosen.push(pool.splice(bestIdx, 1)[0])
  }
  return chosen
}

const STRAT_CN: Record<StrategyType, string> = {
  bull_call_spread: '看涨债务价差',
  bear_call_spread: '看跌信用价差',
  bull_put_spread: '看涨信用价差',
  bear_put_spread: '熊市看跌价差',
  iron_condor: '铁鹰',
  short_strangle: '裸卖宽跨',
  long_straddle: '跨式买入'
}

// ---------- Regime-aware scoring ----------

/**
 * Boost strategies that match the IV regime.
 * sell regime (high IVR) → SELL_STRATEGIES get 1.5×, misaligned get 0.6×
 * buy regime  (low IVR)  → BUY_STRATEGIES get 1.5×, misaligned get 0.6×
 * mid regime             → no adjustment (1.0×)
 * (An earned AI view softens the 0.6 penalty to 0.85 for its aligned strategy.)
 */
const SELL_STRATEGIES: Set<StrategyType> = new Set(['iron_condor', 'short_strangle', 'bear_call_spread', 'bull_put_spread'])
const BUY_STRATEGIES: Set<StrategyType> = new Set(['long_straddle', 'bull_call_spread', 'bear_put_spread'])

// Regime-level conviction — how much standalone edge the engine has in a regime,
// applied on top of the per-strategy regime fit (regimeBonus). Orthogonal:
// regimeBonus picks *which* strategy fits; this weights *whether the whole
// regime is worth surfacing*. Sell regime is where the variance risk premium
// pays; mid is neutral; buy (RV>IV) is where the engine has NO proven edge —
// long vol systematically bleeds (long_straddle lost even here) and selling
// cheap premium is the wrong side — so buy-regime candidates are down-weighted
// to stand aside unless nothing better exists. Only ~7% of scans are buy regime.
const REGIME_CONVICTION: Record<Regime, number> = { sell: 1, mid: 1, buy: 0.5 }

function regimeBonus(strategy: StrategyType, regime: Regime, ivr?: number, view?: View, skill?: ViewSkillTable): number {
  // Only a view with earned skill weight softens the regime penalty for its
  // aligned buy strategies; a gated-to-0 view (both directional views today)
  // counts as no view.
  const av = viewWeight(view, skill) > 0 ? view : undefined
  if (regime === 'sell') {
    // When AI view conflicts with sell regime (e.g. view=neutral-vol wants buy),
    // soften the regime penalty so the view bonus can have more influence.
    if (av && !SELL_STRATEGIES.has(strategy)) {
      const viewAligned = STRATEGY_VIEW_MAP[strategy]?.includes(av)
      if (viewAligned) return 0.85 // softer penalty (was 0.6) — let view bonus decide
    }
    return SELL_STRATEGIES.has(strategy) ? 1.5 : 0.6
  }
  if (regime === 'buy') {
    if (av && !BUY_STRATEGIES.has(strategy)) {
      const viewAligned = STRATEGY_VIEW_MAP[strategy]?.includes(av)
      if (viewAligned) return 0.85
    }
    return BUY_STRATEGIES.has(strategy) ? 1.5 : 0.6
  }
  // mid regime but IVR is extreme → mild tilt to avoid contradicting the narrative
  // IVR < 25 → slightly favor buy strategies (vol is cheap historically)
  // IVR > 75 → slightly favor sell strategies (vol is rich historically)
  if (ivr != null) {
    if (ivr < 25) return BUY_STRATEGIES.has(strategy) ? 1.2 : 0.85
    if (ivr > 75) return SELL_STRATEGIES.has(strategy) ? 1.2 : 0.85
  }
  return 1
}

// View→strategy alignment (mirrors STRATEGY_VIEW in index.ts)
const STRATEGY_VIEW_MAP: Record<StrategyType, View[]> = {
  bull_call_spread: ['bullish'],
  bear_call_spread: ['bearish'],
  bull_put_spread: ['bullish'],
  bear_put_spread: ['bearish'],
  iron_condor: ['neutral'],
  short_strangle: ['neutral'],
  long_straddle: ['neutral-vol']
}

/**
 * View-aware bonus for scanner scoring.
 * Scales with AI confidence: higher confidence → stronger alignment effect.
 * This ensures the AI directional view actually drives strategy selection
 * rather than being overridden by raw EV/CVaR differences.
 *
 * At confidence 0.55 (minimum): aligned 1.6×, misaligned 0.5×
 * At confidence 0.80 (strong):  aligned 2.2×, misaligned 0.3×
 */
function scannerViewBonus(strategy: StrategyType, view?: View, confidence = 0.6, skill?: ViewSkillTable): number {
  if (!view || viewWeight(view, skill) === 0) return 1
  const aligned = STRATEGY_VIEW_MAP[strategy]?.includes(view)
  // Scale bonus strength with confidence (0.55 → 1.0 mapped to intensity)
  const t = Math.min(1, Math.max(0, (confidence - 0.5) / 0.4)) // 0 at conf=0.5, 1 at conf=0.9
  const designed = aligned ? 1.5 + t * 0.8 : 0.5 - t * 0.2 // aligned 1.5→2.3, misaligned 0.5→0.3
  // Then gate the whole tilt by the view's earned skill weight (0 → no effect).
  return scaleByViewSkill(designed, view, skill)
}

/**
 * Whether a strategy belongs on the auto-scanner for this view. The engine has
 * no standalone directional edge, so a directional debit spread (bull_call /
 * bear_put) is only eligible when an *aligned* view has earned skill weight —
 * i.e. direction has to be justified, not guessed. Non-directional and
 * risk-defined-credit structures are always eligible. The Recommend page is
 * unaffected: a user who supplies their own view still gets debit spreads.
 */
export function autoScanEligible(strategy: StrategyType, view: View | undefined, skill?: ViewSkillTable): boolean {
  if (!DIRECTIONAL_DEBIT_SPREADS.has(strategy)) return true
  return !!view && viewWeight(view, skill) > 0 && (STRATEGY_VIEW_MAP[strategy]?.includes(view) ?? false)
}

// Per-symbol fan-out is capped so a large watchlist doesn't burst past the
// quote provider's rate limit (Finnhub 60/min) — 29 simultaneous quote calls
// 429'd almost every one. See mapSettledLimit.
const PREFETCH_CONCURRENCY = Number(process.env.SCAN_PREFETCH_CONCURRENCY) || 6
const SCAN_CONCURRENCY = Number(process.env.SCAN_SYMBOL_CONCURRENCY) || 4

/**
 * Condor exit-policy A/B assignment. EXIT_POLICY_EXPERIMENT=0 turns the
 * experiment off (everything runs 'managed'). Deterministic hash of
 * (symbol × ET day): same-day rescans agree, arms alternate across days.
 */
const EXIT_EXPERIMENT_ON = process.env.EXIT_POLICY_EXPERIMENT !== '0'

export function pickExitPolicy(sym: string, etDay: string = etCalendarDay()): ExitPolicy {
  if (!EXIT_EXPERIMENT_ON) return 'managed'
  let h = 0
  const s = `${sym}|${etDay}`
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h % 2 === 0 ? 'managed' : 'runner'
}

/** Primary strategy for a given view direction. */
function viewAlignedStrategy(view: View): StrategyType {
  switch (view) {
    case 'bullish': return 'bull_call_spread'
    case 'bearish': return 'bear_put_spread'
    case 'neutral-vol': return 'long_straddle'
    default: return 'iron_condor'
  }
}

// ---------- Technical snapshot ----------

/** date → daily log return, from a close series (for cross-symbol correlation). */
function logReturns(bars: { date: string; close: number }[]): Map<string, number> {
  const m = new Map<string, number>()
  for (let i = 1; i < bars.length; i++) {
    const p0 = bars[i - 1].close
    const p1 = bars[i].close
    if (p0 > 0 && p1 > 0) m.set(bars[i].date, Math.log(p1 / p0))
  }
  return m
}

type TechData = { tech: TechnicalSnapshot; returns: Map<string, number> }

/**
 * Fetch ~1 year of OHLCV data → technical indicators AND a daily-return series.
 * Uses the free daily candles endpoint (doesn't count toward options quota); the
 * returns reuse the SAME bars, so correlation-aware selection costs no extra call.
 */
async function fetchTechnicals(sym: string): Promise<TechData> {
  const to = new Date().toISOString().slice(0, 10)
  // Fetch ~400 calendar days to get ~252 trading days (1 year)
  const from = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10)
  const bars = await getDailyOhlc(sym, from, to)
  return { tech: computeTechnicals(bars), returns: logReturns(bars) }
}

// ---------- Expiration picker ----------

// Chains come from CBOE, whose one-shot payload covers every expiration —
// extra targets cost no extra network. (If chains ever fall back to a
// per-expiration provider like MarketData, trim via SCAN_EXP_TARGETS="30".)
// Entry DTE floor: never open on the auto-board inside the high-gamma endgame.
// 30–45 DTE is the theta/gamma sweet spot; short-dated (7/14 DTE) condors are
// max-gamma, min-defense and were dropped. ≥28 keeps standard monthlies.
const MIN_ENTRY_DTE = Number(process.env.MIN_ENTRY_DTE) || 28

const SCAN_EXP_TARGETS: number[] = (process.env.SCAN_EXP_TARGETS ?? '30,45')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0)

/** Pick expirations nearest each DTE target, never inside the entry floor. */
function pickExpirations(exps: string[], targets = SCAN_EXP_TARGETS): string[] {
  if (exps.length === 0) return []
  const today = Date.now()
  const picked: string[] = []

  for (const target of targets) {
    let best = ''
    let bestDiff = Infinity
    for (const e of exps) {
      const dte = (new Date(e).getTime() - today) / 86400000
      if (dte < MIN_ENTRY_DTE) continue // no high-gamma short-dated entries
      const diff = Math.abs(dte - target)
      if (diff < bestDiff) { bestDiff = diff; best = e }
    }
    if (best && !picked.includes(best)) picked.push(best)
  }

  return picked
}

// ---------- Scanner ----------

type WatchlistEntry = { sym: string; name: string }

/**
 * Scan all watchlist symbols across multiple expirations.
 * Returns top `limit` opportunities ranked by engine score.
 */
async function runScan(
  watchlist: WatchlistEntry[],
  limit = 5,
  earningsIso: Record<string, string> = {}
): Promise<ScannedOpp[]> {
  const allOpps: ScannedOpp[] = []

  // Calibration table from realized feedback — nudges scoring toward
  // (strategy × regime) combos that have historically won. Empty until
  // enough outcomes accumulate (multiplier defaults to 1×).
  const calibration = await loadCalibrationTable().catch((): CalibrationTable => new Map())
  if (calibration.size > 0) {
    const summary = [...calibration.entries()].map(([k, m]) => `${k}=${m.toFixed(2)}`).join(', ')
    console.log(`[oppScanner] calibration: ${summary}`)
  }

  // Per-view skill weights: how much the AI directional view is allowed to tilt
  // selection, earned from its track record (both directional views 0 today).
  const viewSkill = loadViewSkill()

  // Online tuner: Beta posteriors per (strategy × regime × variant), built from
  // the same recorded outcomes that feed calibration.
  const armStats: ArmStats = TUNER_ENABLED
    ? await loadSnapshots().then(buildArmStats).catch((): ArmStats => new Map())
    : new Map()

  // Phase 0: fetch AI directional views for all symbols.
  // Pre-fetch quotes + IVR + technicals (OHLCV-based) in parallel per symbol.
  // Results are reused in scanSymbol to avoid redundant API calls.
  type PreFetchResult = {
    ctx: SymbolContext
    quote: Awaited<ReturnType<typeof getQuote>>
    ivRankInfo: Awaited<ReturnType<typeof computeIvRank>> | null
    returns: Map<string, number>
    keyLevels: KeyLevel[]
    strongTrend: boolean
  }
  const preData = await mapSettledLimit(
    watchlist, PREFETCH_CONCURRENCY,
    async (entry): Promise<PreFetchResult> => {
      const [q, ivr, td] = await Promise.all([
        getQuote(entry.sym).catch(() => ({ symbol: entry.sym, last: 0, bid: 0, ask: 0 } as const)),
        computeIvRank(entry.sym, 0).catch(() => null),
        fetchTechnicals(entry.sym).catch((): TechData => ({ tech: computeTechnicals([]), returns: new Map() }))
      ])
      const tech = td.tech
      // Strong aligned trend (both SMAs same side + a big 20d move) → a condor is
      // likely to be run over on that side. A warning, not a hard filter.
      const strongTrend = tech.chg20d != null && Math.abs(tech.chg20d) >= 15 &&
        tech.aboveSma20 != null && tech.aboveSma20 === tech.aboveSma50
      const ivrVal = ivr?.rank ?? 50
      const rvVal = ivr?.currentRv ?? null
      const ivEstimate = rvVal != null && rvVal > 0 ? rvVal : null
      const emEstimate = (q.last && ivEstimate)
        ? q.last * ivEstimate * Math.sqrt(30 / 365)
        : null
      const ctx: SymbolContext = {
        sym: entry.sym,
        px: q.last || null,
        chg: ('changePct' in q && q.changePct != null) ? q.changePct : null,
        chg5d: tech.chg5d,
        chg20d: tech.chg20d,
        week52Pct: tech.week52Pct,
        iv: ivEstimate,
        ivr: ivr?.rank ?? null,
        rv: rvVal,
        em: emEstimate,
        earn: earningsIso[entry.sym] ?? '—',
        regime: deriveRegime(ivrVal, 0, undefined),
        rsi14: tech.rsi14,
        macdHist: tech.macdHist,
        aboveSma20: tech.aboveSma20,
        aboveSma50: tech.aboveSma50,
        volumeRatio: tech.volumeRatio
      }
      return {
        ctx, quote: q as Awaited<ReturnType<typeof getQuote>>, ivRankInfo: ivr,
        returns: td.returns, keyLevels: tech.keyLevels, strongTrend
      }
    }
  )

  // Build lookup maps from pre-fetched data
  const preDataMap = new Map<string, PreFetchResult>()
  const symbolContexts: SymbolContext[] = []
  for (let i = 0; i < watchlist.length; i++) {
    const pd = preData[i]
    if (pd.status === 'fulfilled') {
      symbolContexts.push(pd.value.ctx)
      preDataMap.set(watchlist[i].sym, pd.value)
    }
  }

  // Returns matrix (reuses the daily bars already fetched above) → drives
  // correlation-aware board diversification at final selection. Best-effort:
  // symbols with too little history are simply absent → no penalty for them.
  const returnsBySym = new Map<string, Map<string, number>>()
  for (const [sym, pd] of preDataMap) {
    if (pd.returns.size >= 30) returnsBySym.set(sym, pd.returns)
  }

  let viewMap = new Map<string, { view: View; confidence: number; reason: string }>()
  try {
    viewMap = await getDirectionalViews(symbolContexts)
    const viewSummary = [...viewMap.entries()].map(([s, v]) => `${s}=${v.view}(${v.confidence.toFixed(1)})`).join(', ')
    console.log(`[oppScanner] AI views: ${viewSummary}`)
  } catch (err) {
    console.warn('[oppScanner] AI directional view failed, proceeding without:', (err as Error).message)
  }

  // Process symbols with a bounded fan-out (each symbol is independent but does
  // several chain fetches + engine runs; unbounded across a large watchlist
  // bursts the data providers and thrashes CPU).
  const symbolResults = await mapSettledLimit(
    watchlist, SCAN_CONCURRENCY,
    (entry) => {
      const dv = viewMap.get(entry.sym)
      // Only use view if confidence is above threshold
      const view = dv && dv.confidence >= 0.55 ? dv.view : undefined
      const reason = dv?.reason
      const confidence = dv?.confidence
      const pd = preDataMap.get(entry.sym)
      return scanSymbol(entry, view, reason, confidence, pd?.quote, pd?.ivRankInfo, earningsIso[entry.sym], calibration, armStats, viewSkill, pd?.keyLevels ?? [], pd?.strongTrend ?? false)
    }
  )

  const shadowRows: ScannedOpp[] = []
  for (const result of symbolResults) {
    if (result.status === 'fulfilled') {
      allOpps.push(...result.value.opps)
      shadowRows.push(...result.value.shadow)
    } else {
      console.warn('[oppScanner] symbol scan failed:', (result.reason as Error).message)
    }
  }

  // Record every evaluated arm for learning (fire-and-forget; same-day batches
  // replace, so rescans stay idempotent). See recordShadowArmSnapshots.
  if (shadowRows.length > 0) {
    console.log(`[oppScanner] shadow-recording ${shadowRows.length} arm rows for learning`)
    recordShadowArmSnapshots(shadowRows).catch((err) =>
      console.warn('[oppScanner] shadow record failed:', (err as Error).message)
    )
  }

  // Drop opps that fail the sell-vol auto-board gate (IVR too low, or earnings-
  // spanning). Filter BEFORE dedup so a rejected high-score expiration can't
  // crowd a qualified one of the same symbol out of the max-2 budget.
  const eligible = allOpps.filter((o) => o.boardTier != null)
  eligible.sort((a, b) => b.score - a.score)

  // Dedupe: max 2 per symbol, but only if different strategy types.
  // This allows e.g. AAPL iron_condor (sell) + AAPL bull_call_spread (direction)
  // but not two iron_condors at different expirations.
  const symStratCount = new Map<string, Set<StrategyType>>()
  const deduped: ScannedOpp[] = []
  for (const opp of eligible) {
    const seen = symStratCount.get(opp.sym)
    if (seen) {
      if (seen.size >= 2) continue                  // already 2 from this symbol
      if (seen.has(opp.strategyId)) continue         // same strategy type
    }
    const set = seen ?? new Set<StrategyType>()
    set.add(opp.strategyId)
    symStratCount.set(opp.sym, set)
    deduped.push(opp)
  }

  // Qualified fill the board (up to limit) via correlation-aware selection so a
  // pile of the same bet (correlated tech condors) doesn't crowd it out; a few
  // reference near-misses ride along, clearly sub-threshold, for the "参考位"
  // tier. When nothing qualifies the board is honestly empty (callers surface a
  // stand-aside message).
  const qualified = selectDiverse(deduped.filter((o) => o.boardTier === 'qualified'), limit, returnsBySym)
  const reference = deduped.filter((o) => o.boardTier === 'reference').slice(0, REFERENCE_LIMIT)
  return [...qualified, ...reference]
}

async function scanSymbol(
  entry: WatchlistEntry,
  view?: View,
  viewReason?: string,
  viewConfidence?: number,
  prefetchedQuote?: Awaited<ReturnType<typeof getQuote>>,
  prefetchedIvr?: Awaited<ReturnType<typeof computeIvRank>> | null,
  earningsDate?: string,
  calibration?: CalibrationTable,
  armStats?: ArmStats,
  viewSkill?: ViewSkillTable,
  keyLevels: KeyLevel[] = [],
  strongTrend = false
): Promise<{ opps: ScannedOpp[]; shadow: ScannedOpp[] }> {
  const { sym, name } = entry

  // Use pre-fetched data when available; only fetch what's missing
  const [quote, exps, ivRankInfo] = await Promise.all([
    prefetchedQuote ?? getQuote(sym),
    getExpirations(sym),
    prefetchedIvr !== undefined ? prefetchedIvr : computeIvRank(sym, 0).catch(() => null)
  ])

  if (!quote.last || !Number.isFinite(quote.last)) {
    console.warn(`[oppScanner] no quote for ${sym}`)
    return { opps: [], shadow: [] }
  }

  const targetExps = pickExpirations(exps)
  if (targetExps.length === 0) {
    console.warn(`[oppScanner] no valid expirations for ${sym}`)
    return { opps: [], shadow: [] }
  }

  // Fetch chains for each expiration in parallel
  const chainResults = await Promise.allSettled(
    targetExps.map((exp) => getOptionChain(sym, exp))
  )

  const opps: ScannedOpp[] = []
  const shadow: ScannedOpp[] = []
  let shadowDone = false

  for (let i = 0; i < targetExps.length; i++) {
    const exp = targetExps[i]
    const chainResult = chainResults[i]
    if (chainResult.status !== 'fulfilled' || chainResult.value.length === 0) continue

    const chain = chainResult.value

    // Derive ATM IV for IVR computation
    let ivRank = ivRankInfo?.rank ?? undefined
    if (ivRank == null) {
      const atmIv = impliedVolFromChain(chain, quote.last)
      if (atmIv != null && atmIv > 0) {
        const ivr = await computeIvRank(sym, atmIv).catch(() => null)
        ivRank = ivr?.rank
      }
    }

    try {
      // Online tuner: Thompson-sample the credit-spread short delta for this
      // regime. Regime is pre-derived from the same inputs the engine uses, so
      // the arm matches the bucket the outcome will later be attributed to.
      // Condor exit A/B: deterministic 50/50 by (symbol × ET day) — stable
      // across same-day rescans (snapshot replacement stays consistent), flips
      // across days so both arms accumulate on every name. The engine then
      // scores the condor UNDER the chosen policy (display = learning).
      const icPolicy = pickExitPolicy(sym)
      const exitPolicyBy: Partial<Record<StrategyType, ExitPolicy>> = { iron_condor: icPolicy }

      // Tuner arm selection for the BOARD: evaluate every arm on this chain and
      // keep the BEST-scoring one per tuned strategy. A random Thompson sample
      // hides real edge when only the conservative arm is positive (AAPL/NVDA
      // condors clear at 0.16 but not 0.20/0.24 — the sampled arm would drop
      // them). Exploration/learning still covers ALL arms via the shadow
      // snapshots below; this only decides what to SHOW. Ranking by raw
      // scoreStrategy is exact here — the regime/view/calib multipliers are
      // constant across a strategy's arms, so they don't change the ordering.
      let specOverrides: Partial<Record<StrategyType, LegSpec[]>> | undefined
      const variantBy: Partial<Record<StrategyType, string>> = {}
      if (armStats && TUNER_ENABLED) {
        const bestArmScore: Partial<Record<StrategyType, number>> = {}
        const armCount = Math.max(...TUNED_STRATEGIES.map((st) => armsFor(st).length))
        for (let k = 0; k < armCount; k++) {
          const pinned: Partial<Record<StrategyType, LegSpec[]>> = {}
          const pinnedVariant: Partial<Record<StrategyType, string>> = {}
          for (const st of TUNED_STRATEGIES) {
            const d = armsFor(st)[k]
            const legs = d != null ? legsForShortDelta(st, d) : null
            if (d != null && legs) {
              pinned[st] = legs
              pinnedVariant[st] = variantId(d)
            }
          }
          const probe = runEngineLive({
            symbol: sym, spot: quote.last, expiration: exp, chain, ivRank,
            currentRv: ivRankInfo?.currentRv ?? undefined,
            simulations: 800, seed: 42, view, earningsDate,
            specOverrides: pinned, exitPolicies: exitPolicyBy
          })
          for (const st of TUNED_STRATEGIES) {
            const specLegs = pinned[st]
            if (!specLegs) continue
            const r = probe.results.find((x) => x.strategy === st)
            if (!r || r.legs.length === 0) continue
            const sc = scoreStrategy(r, quote.last)
            if (bestArmScore[st] == null || sc > (bestArmScore[st] as number)) {
              bestArmScore[st] = sc
              specOverrides = { ...(specOverrides ?? {}), [st]: specLegs }
              variantBy[st] = pinnedVariant[st]
            }
          }
        }
        const picked = Object.entries(variantBy).map(([s, v]) => `${s}=${v}`).join(' ')
        if (picked) console.log(`[tuner] ${sym} ${exp} best-arm: ${picked}`)
      }

      const result = runEngineLive({
        symbol: sym,
        spot: quote.last,
        expiration: exp,
        chain,
        ivRank,
        currentRv: ivRankInfo?.currentRv ?? undefined,
        simulations: SCAN_SIMULATIONS, // lighter for scanning; detail page replays this exact count
        seed: 42,
        view, // AI directional view → drives viewBonus() in engine scoring
        earningsDate, // triggers earnings-jump modeling when within DTE
        specOverrides,
        exitPolicies: exitPolicyBy
      })

      // Score strategies with BOTH regime bonus AND AI view bonus.
      // This ensures directional signals from the AI actually influence
      // which strategy is selected — previously only regimeBonus was used,
      // making AI views completely ineffective.
      const regime = result.state.regime
      const calib = (r: StrategyResult) =>
        calibration ? calibrationMultiplier(calibration, r.strategy, regime) : 1
      const candidates = result.results
        .filter((r) => scoreStrategy(r, quote.last) > 0 && autoScanEligible(r.strategy, view, viewSkill))
        .map((r) => ({
          r,
          score: scoreStrategy(r, quote.last) * regimeBonus(r.strategy, regime, result.state.ivRank, view, viewSkill) * scannerViewBonus(r.strategy, view, viewConfidence, viewSkill) * calib(r) * REGIME_CONVICTION[regime]
        }))
        // calib=0 marks a hard-disabled combo (≥10 outcomes, <20% win rate)
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score)

      // Log top-3 scoring breakdown for debugging strategy selection
      if (candidates.length > 0) {
        const top3 = candidates.slice(0, 3).map((c) => {
          const raw = scoreStrategy(c.r, quote.last)
          const rb = regimeBonus(c.r.strategy, regime, result.state.ivRank, view, viewSkill)
          const vb = scannerViewBonus(c.r.strategy, view, viewConfidence, viewSkill)
          const cb = calib(c.r)
          const cv = REGIME_CONVICTION[regime]
          return `${c.r.strategy}(raw=${raw.toFixed(2)} ×reg=${rb.toFixed(2)} ×view=${vb.toFixed(2)} ×cal=${cb.toFixed(2)} ×conv=${cv.toFixed(2)} =>${c.score.toFixed(2)})`
        })
        console.log(`[oppScanner] ${sym} ${exp} regime=${regime} view=${view ?? 'none'}(conf=${viewConfidence?.toFixed(2) ?? '?'}): ${top3.join(' | ')}`)
      }

      function makeOpp(sr: { r: StrategyResult; score: number }): ScannedOpp {
        const r = sr.r
        const spansEarnings = spansEarningsDate(earningsDate, exp)
        const legs = r.legs.map((l) => ({ type: l.type, action: l.action, strike: l.strike, premium: l.premium, quantity: l.quantity }))
        return {
          sym,
          name,
          expiration: exp,
          strategyId: r.strategy,
          strategy: STRAT_CN[r.strategy] ?? r.strategy,
          score: sr.score,
          spot: quote.last,
          iv: result.state.iv,
          ivr: result.state.ivRank,
          dte: result.state.dte,
          pop: r.metrics.probabilityProfit,
          ev: r.metrics.ev,
          maxProfit: r.metrics.unboundedProfit ? null : r.metrics.theoMaxProfit,
          maxLoss: r.metrics.unboundedLoss ? null : r.metrics.theoMaxLoss,
          netPremium: r.netPremium,
          delta: r.netGreeks.delta,
          gamma: r.netGreeks.gamma,
          vega: r.netGreeks.vega,
          theta: r.netGreeks.theta,
          regime: result.state.regime,
          rvAtScan: ivRankInfo?.currentRv ?? null,
          breakevens: [...r.metrics.breakevens],
          legs,
          aiView: view,
          aiViewConfidence: viewConfidence,
          aiViewReason: viewReason,
          variant: variantBy[r.strategy] ?? null,
          exitPolicy: exitPolicyBy[r.strategy] ?? null,
          spansEarnings,
          boardTier: sellVolTier(r.strategy, result.state.ivRank, spansEarnings) ?? undefined,
          shortLevels: shortLegLevels(legs, keyLevels),
          strongTrend
        }
      }

      // Emit top strategy per expiration.
      // Also emit the view-aligned best if it differs — this allows the
      // global dedup to surface directional plays even when regime prefers
      // neutral strategies.
      const best = candidates[0]
      if (best) {
        opps.push(makeOpp(best))

        // Only a view with earned skill weight force-emits its aligned strategy;
        // a gated-to-0 view (both directional views today) does not push a
        // directional debit spread onto the board.
        const emitView = viewWeight(view, viewSkill) > 0 ? view : undefined
        if (emitView && best.r.strategy !== viewAlignedStrategy(emitView)) {
          const viewBest = candidates.find(
            (c) => c.r.strategy !== best.r.strategy &&
                   STRATEGY_VIEW_MAP[c.r.strategy]?.includes(emitView)
          )
          if (viewBest && scoreStrategy(viewBest.r, quote.last) > 0) {
            opps.push(makeOpp(viewBest))
          }
        }
      }

      // Shadow arm evaluation (learning only, never displayed): rerun the
      // engine pinned to EVERY tuner arm and record all of them, including
      // the ones the score filter would reject. Without this, losing arms
      // are never recorded, their posteriors never update, and the tuner
      // can't learn they lose — the score filter would otherwise act as an
      // unfalsifiable gate (selection bias). One expiration per symbol per
      // day (the first valid one) keeps rows per (sym × strategy × arm)
      // unique; earnings-spanning expirations are skipped because the board
      // never trades them, so learning them would poison the posteriors.
      if (!shadowDone && armStats && TUNER_ENABLED && !spansEarningsDate(earningsDate, exp)) {
        shadowDone = true
        const armCount = Math.max(...TUNED_STRATEGIES.map((st) => armsFor(st).length))
        for (let k = 0; k < armCount; k++) {
          const pinned: Partial<Record<StrategyType, LegSpec[]>> = {}
          const pinnedVariant: Partial<Record<StrategyType, string>> = {}
          for (const st of TUNED_STRATEGIES) {
            const d = armsFor(st)[k]
            const legSpecs = d != null ? legsForShortDelta(st, d) : null
            if (d != null && legSpecs) {
              pinned[st] = legSpecs
              pinnedVariant[st] = variantId(d)
            }
          }
          try {
            const res = runEngineLive({
              symbol: sym,
              spot: quote.last,
              expiration: exp,
              chain,
              ivRank,
              currentRv: ivRankInfo?.currentRv ?? undefined,
              simulations: 1000, // structure + rough metrics; reward comes from the realized outcome
              seed: 42,
              specOverrides: pinned,
              exitPolicies: exitPolicyBy
            })
            for (const st of TUNED_STRATEGIES) {
              if (!pinnedVariant[st]) continue
              const r = res.results.find((x) => x.strategy === st)
              if (!r || r.legs.length === 0) {
                // Usually the liquid chain doesn't reach the arm's far wing
                // (common on stale/weekend snapshots) — untradable that day,
                // so not recording it is honest, but say so.
                console.log(`[oppScanner] shadow ${sym} ${exp} ${st} ${pinnedVariant[st]}: not buildable on this chain, skipped`)
                continue
              }
              shadow.push({
                sym,
                name,
                expiration: exp,
                strategyId: st,
                strategy: STRAT_CN[st] ?? st,
                score: scoreStrategy(r, quote.last), // raw; may be ≤0 — that's the point
                spot: quote.last,
                iv: res.state.iv,
                ivr: res.state.ivRank,
                dte: res.state.dte,
                pop: r.metrics.probabilityProfit,
                ev: r.metrics.ev,
                maxProfit: r.metrics.unboundedProfit ? null : r.metrics.theoMaxProfit,
                maxLoss: r.metrics.unboundedLoss ? null : r.metrics.theoMaxLoss,
                netPremium: r.netPremium,
                delta: r.netGreeks.delta,
                gamma: r.netGreeks.gamma,
                vega: r.netGreeks.vega,
                theta: r.netGreeks.theta,
                regime: res.state.regime,
                rvAtScan: ivRankInfo?.currentRv ?? null,
                breakevens: [...r.metrics.breakevens],
                legs: r.legs.map((l) => ({ type: l.type, action: l.action, strike: l.strike, premium: l.premium, quantity: l.quantity })),
                variant: pinnedVariant[st],
                exitPolicy: exitPolicyBy[st] ?? null
              })
            }
          } catch (err) {
            console.warn(`[oppScanner] shadow run failed for ${sym} ${exp} arm#${k}:`, (err as Error).message)
          }
        }
      }
    } catch (err) {
      console.warn(`[oppScanner] engine failed for ${sym} ${exp}:`, (err as Error).message)
    }
  }

  return { opps, shadow }
}

// ---------- Cached public API ----------

/**
 * Scan opportunities for the given watchlist. Cached per ET day (12h TTL).
 */
export async function getScannedOpps(
  watchlist: WatchlistEntry[],
  limit = 5,
  earningsIso: Record<string, string> = {}
): Promise<ScannedOpp[]> {
  const wlSlug = watchlistCacheSlug(watchlist)
  const key = `opp-scan-v10-${etCalendarDay()}-${wlSlug}`

  const hit = await getCachedIfValid<ScannedOpp[]>(key, 12 * HOUR)
  if (hit != null) return hit

  return cached<ScannedOpp[]>(key, 12 * HOUR, async () => {
    console.log(`[oppScanner] scanning ${watchlist.length} symbols...`)
    const t0 = Date.now()
    const opps = await runScan(watchlist, limit, earningsIso)
    console.log(`[oppScanner] done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${opps.length} opportunities`)
    return opps
  })
}
