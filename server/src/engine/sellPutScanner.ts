/**
 * Sell Put Scanner — TastyTrade-style screening.
 *
 * Finds optimal short put candidates across the watchlist based on:
 *   1. IV / RV / IVR (premium richness)
 *   2. Delta targeting (probability of profit)
 *   3. DTE sweet spot (30-45d theta decay)
 *   4. Return on capital (premium / buying power)
 *   5. Monte Carlo EV / POP validation
 *
 * TastyTrade sell-put criteria:
 *   - IVR ≥ 30 (ideally ≥ 50): options are rich relative to history
 *   - IV > RV: implied overpricing realized → edge for sellers
 *   - 30-45 DTE: theta decay accelerates after this window
 *   - 16-30 delta: ~70-84% POP at expiration
 *   - Bid-ask spread reasonable (liquidity)
 *   - ROC (annualized) worth the risk
 */

import { simulatePrices } from './simulator.js'
import { evaluateStrategy } from './scorer.js'
import { netPremium, netGreeks } from './payoff.js'
import {
  impliedVolFromChain,
  dteFromExpiration,
  enrichWithGreeks,
  liquidContracts
} from './liveStrategies.js'
import { deriveRegime, deriveSimSigma, type Regime } from './index.js'
import { mapSettledLimit } from './concurrency.js'
import type { OptionContract } from '../api/types.js'
import type { OptionLeg, Greeks, RiskMetrics } from './types.js'
import { getQuote, getExpirations, getOptionChain, computeIvRank } from '../api/marketdata.js'
import { cached, etCalendarDay, HOUR } from '../ai/cache.js'
import { watchlistCacheSlug, type WatchlistEntry } from '../watchlistDefaults.js'

// ---------- Types ----------

export type SellPutCandidate = {
  sym: string
  name: string
  spot: number
  /** Selected strike */
  strike: number
  /** Option symbol (e.g. AAPL260606P00200000) */
  optionSymbol: string
  expiration: string
  dte: number
  /** Premium received (mid price) */
  premium: number
  /** Absolute delta of the put */
  delta: number
  /** Put IV */
  iv: number
  /** Symbol-level ATM IV */
  atmIv: number
  /** IV Rank 0-100 */
  ivr: number
  /** Realized vol (annualized) */
  rv: number | null
  /** IV minus RV in percentage points */
  ivRvGap: number | null
  /** Regime (sell/buy/mid) */
  regime: Regime
  /** Greeks of the sold put */
  greeks: Greeks
  /** Cash-secured buying power = strike * 100 */
  buyingPower: number
  /** Premium / buying power */
  roc: number
  /** Annualized ROC */
  rocAnnualized: number
  /** Breakeven = strike - premium */
  breakeven: number
  /** Distance from spot to strike (% OTM) */
  otmPct: number
  /** Monte Carlo probability of profit */
  pop: number
  /** Monte Carlo expected value */
  ev: number
  /** Monte Carlo max loss in simulation */
  simMaxLoss: number
  /** Bid-ask spread of the contract */
  bidAskSpread: number
  /** Open interest */
  openInterest: number
  /** Composite TastyTrade score (higher = better) */
  score: number
  /** Score breakdown for transparency */
  scoreBreakdown: {
    ivRankScore: number
    ivRvScore: number
    popScore: number
    rocScore: number
    liquidityScore: number
    dteScore: number
  }
}

// ---------- Scoring ----------

/**
 * TastyTrade-inspired composite score.
 * Each factor contributes 0-1, weighted by importance.
 */
function scoreSellPut(c: {
  ivr: number
  ivRvGap: number | null
  pop: number
  ev: number
  rocAnnualized: number
  dte: number
  bidAskSpread: number
  premium: number
  openInterest: number
}): { score: number; breakdown: SellPutCandidate['scoreBreakdown'] } {
  // IVR score: higher IVR = better for selling premium
  // 0 at IVR=0, 1.0 at IVR=100, sweet spot > 50
  const ivRankScore = Math.min(c.ivr / 80, 1)

  // IV-RV gap: positive = options overpriced = seller edge
  // 0 at gap=0, 1.0 at gap=10pp+
  const gap = c.ivRvGap ?? 0
  const ivRvScore = gap > 0 ? Math.min(gap / 10, 1) : Math.max(0, 0.3 + gap / 10)

  // POP: probability of profit from Monte Carlo
  // Normalize: 0 at POP=50%, 1 at POP=90%
  const popScore = Math.max(0, Math.min((c.pop - 0.5) / 0.4, 1))

  // ROC annualized: higher = more premium collected
  // 0 at 0%, 1 at 30%+
  const rocScore = Math.min(c.rocAnnualized / 0.3, 1)

  // Liquidity: tight bid-ask relative to premium
  const spreadRatio = c.premium > 0 ? c.bidAskSpread / c.premium : 1
  const oiScore = Math.min(c.openInterest / 500, 1)
  const liquidityScore = Math.max(0, 1 - spreadRatio * 0.5) * 0.5 + oiScore * 0.5

  // DTE sweet spot: 30-45 is ideal for theta decay
  let dteScore: number
  if (c.dte >= 25 && c.dte <= 50) dteScore = 1
  else if (c.dte >= 14 && c.dte < 25) dteScore = 0.6
  else if (c.dte > 50 && c.dte <= 70) dteScore = 0.7
  else dteScore = 0.3

  // EV penalty: if Monte Carlo EV is negative, penalize heavily
  const evPenalty = c.ev < 0 ? 0.5 : 1

  // Weighted composite
  const score =
    (ivRankScore * 0.20 +
      ivRvScore * 0.25 +
      popScore * 0.20 +
      rocScore * 0.15 +
      liquidityScore * 0.10 +
      dteScore * 0.10) *
    evPenalty

  return {
    score,
    breakdown: {
      ivRankScore: +ivRankScore.toFixed(2),
      ivRvScore: +ivRvScore.toFixed(2),
      popScore: +popScore.toFixed(2),
      rocScore: +rocScore.toFixed(2),
      liquidityScore: +liquidityScore.toFixed(2),
      dteScore: +dteScore.toFixed(2)
    }
  }
}

// ---------- Delta targets ----------

/** Target deltas for sell-put scan (absolute values). */
const TARGET_DELTAS = [0.16, 0.20, 0.25, 0.30]

// ---------- Single-symbol scanner ----------

async function scanSellPuts(entry: WatchlistEntry): Promise<SellPutCandidate[]> {
  const { sym, name } = entry

  const [quote, exps, ivRankInfo] = await Promise.all([
    getQuote(sym),
    getExpirations(sym),
    computeIvRank(sym, 0).catch(() => null)
  ])

  if (!quote.last || !Number.isFinite(quote.last)) {
    console.warn(`[sellPut] no quote for ${sym}`)
    return []
  }
  const spot = quote.last

  // Pick expirations: target 30-45 DTE window, plus one short and one long
  const today = Date.now()
  const validExps = exps.filter((e) => {
    const dte = (new Date(e).getTime() - today) / 86400000
    return dte >= 14 && dte <= 70
  })
  if (validExps.length === 0) return []

  // Pick up to 3 best expirations
  const targets = [21, 35, 50]
  const pickedExps: string[] = []
  for (const target of targets) {
    let best = ''
    let bestDiff = Infinity
    for (const e of validExps) {
      const dte = (new Date(e).getTime() - today) / 86400000
      const diff = Math.abs(dte - target)
      if (diff < bestDiff) { bestDiff = diff; best = e }
    }
    if (best && !pickedExps.includes(best)) pickedExps.push(best)
  }

  const chainResults = await Promise.allSettled(
    pickedExps.map((exp) => getOptionChain(sym, exp))
  )

  const candidates: SellPutCandidate[] = []
  const ivr = ivRankInfo?.rank ?? 50
  const rv = ivRankInfo?.currentRv ?? null

  for (let i = 0; i < pickedExps.length; i++) {
    const exp = pickedExps[i]
    const chainResult = chainResults[i]
    if (chainResult.status !== 'fulfilled' || chainResult.value.length === 0) continue

    const chain = chainResult.value
    const dte = dteFromExpiration(exp)
    const T = dte / 365
    const r = 0.045
    const q = 0

    const enriched = enrichWithGreeks(chain, { spot, T, r, q })
    const liquid = liquidContracts(enriched)
    const puts = liquid.filter(
      (c) => c.optionType === 'put' && c.greeks != null && c.greeks.delta < 0
    )

    if (puts.length === 0) continue

    const atmIv = impliedVolFromChain(enriched, spot) ?? 0.3
    const regime = deriveRegime(ivr, atmIv, rv ?? undefined)
    const simSigma = deriveSimSigma(atmIv, rv ?? undefined)

    // Monte Carlo simulation for POP/EV
    const pricePaths = simulatePrices({
      S0: spot,
      sigma: simSigma,
      T,
      r,
      q,
      simulations: 3000,
      seed: 42
    })
    const discount = Math.exp(-r * T)

    for (const targetDelta of TARGET_DELTAS) {
      // Find put closest to target delta (puts have negative delta)
      const target = -targetDelta
      const putContract = puts.reduce((a, b) => {
        const da = Math.abs((a.greeks?.delta ?? 0) - target)
        const db = Math.abs((b.greeks?.delta ?? 0) - target)
        return db < da ? b : a
      })

      if (!putContract.greeks || putContract.mid <= 0) continue

      // Skip if bid-ask is too wide (illiquid)
      if (putContract.ask > 0 && putContract.bid > 0) {
        const spreadPct = (putContract.ask - putContract.bid) / putContract.mid
        if (spreadPct > 1.0) continue // skip if spread > 100% of mid
      }

      // Build the single-leg "strategy"
      const leg: OptionLeg = {
        type: 'put',
        action: 'sell',
        strike: putContract.strike,
        premium: putContract.mid,
        quantity: 1,
        greeks: {
          delta: putContract.greeks.delta,
          gamma: putContract.greeks.gamma,
          theta: putContract.greeks.theta,
          vega: putContract.greeks.vega
        }
      }

      // Monte Carlo evaluation
      const metrics = evaluateStrategy(pricePaths, [leg], discount)

      const buyingPower = putContract.strike * 100
      const premiumPer100 = putContract.mid * 100
      const roc = buyingPower > 0 ? premiumPer100 / buyingPower : 0
      const rocAnnualized = dte > 0 ? roc * (365 / dte) : 0
      const breakeven = putContract.strike - putContract.mid
      const otmPct = spot > 0 ? ((spot - putContract.strike) / spot) * 100 : 0
      const putDelta = Math.abs(putContract.greeks.delta)
      const putIv = putContract.iv ?? atmIv
      const ivRvGap = rv != null ? ((putIv - rv) * 100) : null

      const { score, breakdown } = scoreSellPut({
        ivr,
        ivRvGap,
        pop: metrics.probabilityProfit,
        ev: metrics.ev,
        rocAnnualized,
        dte,
        bidAskSpread: putContract.ask - putContract.bid,
        premium: putContract.mid,
        openInterest: putContract.openInterest
      })

      candidates.push({
        sym,
        name,
        spot,
        strike: putContract.strike,
        optionSymbol: putContract.symbol,
        expiration: exp,
        dte,
        premium: putContract.mid,
        delta: putDelta,
        iv: putIv,
        atmIv,
        ivr,
        rv,
        ivRvGap,
        regime,
        greeks: leg.greeks,
        buyingPower,
        roc,
        rocAnnualized,
        breakeven,
        otmPct,
        pop: metrics.probabilityProfit,
        ev: metrics.ev,
        simMaxLoss: metrics.simMaxLoss,
        bidAskSpread: putContract.ask - putContract.bid,
        openInterest: putContract.openInterest,
        score,
        scoreBreakdown: breakdown
      })
    }
  }

  // For each symbol, keep only the top candidate per expiration
  // (best delta/score combo)
  const byExp = new Map<string, SellPutCandidate>()
  for (const c of candidates) {
    const key = c.expiration
    if (!byExp.has(key) || c.score > byExp.get(key)!.score) {
      byExp.set(key, c)
    }
  }

  return [...byExp.values()]
}

// ---------- Public API ----------

export type SellPutScanResult = {
  asof: string
  candidates: SellPutCandidate[]
  /** Symbols that failed to scan */
  skipped: { sym: string; reason: string }[]
  /** Filter criteria used */
  criteria: {
    minIvr: number
    targetDeltas: number[]
    dteRange: [number, number]
  }
}

/**
 * Scan all watchlist symbols for sell-put opportunities.
 * Returns candidates ranked by composite score.
 * Cached per ET day (4h TTL — shorter than opp scan since this is a focused tool).
 */
export async function runSellPutScan(
  watchlist: WatchlistEntry[]
): Promise<SellPutScanResult> {
  const slug = watchlistCacheSlug(watchlist)
  const key = `sellput-scan-v1-${etCalendarDay()}-${slug}`

  return cached<SellPutScanResult>(key, 4 * HOUR, async () => {
    console.log(`[sellPut] scanning ${watchlist.length} symbols...`)
    const t0 = Date.now()

    // Throttle the fan-out — an unbounded parallel map over a large watchlist
    // bursts the quote provider's rate limit and every 429'd symbol lands in
    // `skipped` (that's the "跳过" list swallowing the whole board). See
    // mapSettledLimit; SELL_PUT_CONCURRENCY is env-tunable.
    const results = await mapSettledLimit(
      watchlist,
      Number(process.env.SELL_PUT_CONCURRENCY) || 6,
      (entry) => scanSellPuts(entry)
    )

    const allCandidates: SellPutCandidate[] = []
    const skipped: { sym: string; reason: string }[] = []

    for (let i = 0; i < watchlist.length; i++) {
      const r = results[i]
      if (r.status === 'fulfilled') {
        allCandidates.push(...r.value)
      } else {
        skipped.push({ sym: watchlist[i].sym, reason: (r.reason as Error).message })
      }
    }

    // Sort by score descending
    allCandidates.sort((a, b) => b.score - a.score)

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    console.log(`[sellPut] done in ${elapsed}s — ${allCandidates.length} candidates from ${watchlist.length - skipped.length} symbols`)

    return {
      asof: new Date().toISOString(),
      candidates: allCandidates,
      skipped,
      criteria: {
        minIvr: 0,
        targetDeltas: TARGET_DELTAS,
        dteRange: [14, 70]
      }
    }
  })
}
