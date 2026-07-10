/**
 * Walk-forward replay backtester — the offline engine behind Stage 3 of the
 * self-optimization plan.
 *
 * For each archived day × symbol × strategy × candidate parameter (short delta),
 * it rebuilds the position FROM THE REAL HISTORICAL CHAIN (actual bid/ask, IV,
 * greeks) and scores it through the exact same managed-exit simulator the live
 * feedback loop uses — so a parameter that wins here wins for the same reason
 * it would in production. Aggregated per (strategy × regime × variant), the
 * output is directly comparable to the online tuner's arms.
 *
 * This is the accelerator: one archived day yields a full watchlist of virtual
 * trades, versus a handful of real recommendations per day.
 */
import {
  enrichWithGreeks,
  legsFromSpec,
  dteFromExpiration,
  impliedVolFromChain
} from '../engine/liveStrategies.js'
import { netPremium } from '../engine/payoff.js'
import { theoreticalExtremes } from '../engine/payoff.js'
import { deriveRegime, type Regime } from '../engine/index.js'
import type { StrategyType, OptionLeg } from '../engine/types.js'
import { computeOutcomeForSnapshot } from '../feedback/outcome.js'
import { outcomePnl, normalizedReward } from '../feedback/calibration.js'
import {
  TUNED_STRATEGIES,
  armsFor,
  legsForShortDelta,
  variantId
} from '../feedback/tuner.js'
import type { RecommendationSnapshot, StoredLeg } from '../feedback/types.js'
import { getDailyBars } from '../api/marketdata.js'
import { rawExpirations, mapRawChain, rawSpot } from '../api/cboe.js'
import { listArchiveDays, listArchivedSymbols, loadArchivedChain } from './archiveReader.js'

export type ReplayConfig = {
  strategies?: readonly StrategyType[]
  shortDeltas?: readonly number[]
  dteTarget?: number
  horizonDays?: number
  riskFreeRate?: number
  /** Restrict to these days (default: all archived days). */
  days?: string[]
}

export type ArmResult = {
  strategy: StrategyType
  regime: Regime
  variant: string
  shortDelta: number
  n: number
  wins: number
  winRate: number
  avgPnl: number
  totalPnl: number
  avgReward: number
}

export type ReplayReport = {
  daysCovered: string[]
  trades: number
  skipped: number
  arms: ArmResult[]
}

const RV_LOOKBACK_DAYS = 40

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

function annualizedRv(closes: number[]): number | null {
  if (closes.length < 3) return null
  const r: number[] = []
  for (let i = 1; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]))
  const mean = r.reduce((a, b) => a + b, 0) / r.length
  const v = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1)
  return Math.sqrt(v) * Math.sqrt(252)
}

/** Nearest expiration to `dteTarget` with at least 7 DTE. */
function pickExpiration(exps: string[], asOf: string, dteTarget: number): string | null {
  let best: string | null = null
  let bestDiff = Infinity
  for (const e of exps) {
    const dte = dteFromExpiration(e, new Date(asOf + 'T16:00:00-04:00'))
    if (dte < 7) continue
    const diff = Math.abs(dte - dteTarget)
    if (diff < bestDiff) {
      bestDiff = diff
      best = e
    }
  }
  return best
}

function toStoredLegs(legs: OptionLeg[]): StoredLeg[] {
  return legs.map((l) => ({
    type: l.type,
    action: l.action,
    strike: l.strike,
    premium: l.premium,
    quantity: l.quantity
  }))
}

function armKey(strategy: StrategyType, regime: Regime, variant: string): string {
  return `${strategy}|${regime}|${variant}`
}

export async function runReplay(cfg: ReplayConfig = {}): Promise<ReplayReport> {
  const strategies = cfg.strategies ?? TUNED_STRATEGIES
  const dteTarget = cfg.dteTarget ?? 30
  const horizonDays = cfg.horizonDays ?? 5
  const r = cfg.riskFreeRate ?? 0.045
  const days = cfg.days ?? listArchiveDays()

  type Acc = { rewards: number[]; pnls: number[] }
  const buckets = new Map<string, Acc>()
  let trades = 0
  let skipped = 0

  for (const day of days) {
    for (const sym of listArchivedSymbols(day)) {
      const arch = loadArchivedChain(day, sym)
      const spot = arch ? rawSpot(arch.payload) : null
      if (!arch || spot == null) { skipped++; continue }

      const exp = pickExpiration(rawExpirations(arch.payload), day, dteTarget)
      if (!exp) { skipped++; continue }
      const chain = mapRawChain(arch.payload, exp)
      if (chain.length === 0) { skipped++; continue }

      const dte = dteFromExpiration(exp, new Date(day + 'T16:00:00-04:00'))
      const T = dte / 365
      const enriched = enrichWithGreeks(chain, { spot, T, r, q: 0 })

      // Regime from the chain's ATM IV vs realized vol leading up to `day`
      // (matches deriveRegime's IV-RV-gap path; ivRank arg is the fallback only).
      const atmIv = impliedVolFromChain(chain, spot) ?? 0
      let rv: number | null = null
      try {
        const bars = await getDailyBars(sym, addDays(day, -RV_LOOKBACK_DAYS), day)
        rv = annualizedRv(bars.map((b) => b.close))
      } catch { /* RV optional */ }
      const regime = deriveRegime(50, atmIv, rv ?? undefined)

      for (const strategy of strategies) {
        // Each strategy tunes its own arm set (condors sell further OTM than
        // credit spreads), unless the caller pins an explicit sweep.
        for (const shortDelta of cfg.shortDeltas ?? armsFor(strategy)) {
          const specs = legsForShortDelta(strategy, shortDelta)
          const legs = specs && legsFromSpec(specs, enriched)
          if (!legs) { skipped++; continue }

          const np = netPremium(legs)
          const ext = theoreticalExtremes(legs)
          const maxProfit = ext.unboundedProfit ? null : ext.theoMaxProfit
          const maxLoss = ext.unboundedLoss ? null : ext.theoMaxLoss

          const snap: RecommendationSnapshot = {
            id: `replay-${day}-${sym}-${strategy}-${variantId(shortDelta)}`,
            etDay: day, capturedAt: day, source: 'dashboard', sym,
            strategyId: strategy, expiration: exp, spot, iv: atmIv, ivr: 50,
            rvAtScan: rv, ivRvGap: rv != null ? atmIv - rv : null, regime,
            score: 0, pop: 0, ev: 0, netPremium: np, maxProfit, maxLoss, dte,
            breakevens: [], legs: toStoredLegs(legs), variant: variantId(shortDelta),
            outcome: null
          }

          let pnl: number | null = null
          try {
            const outcome = await computeOutcomeForSnapshot(snap, { horizonDays })
            pnl = outcomePnl(outcome)
          } catch { /* skip on outcome failure */ }
          if (pnl == null) { skipped++; continue }

          const reward = normalizedReward(pnl, maxLoss)
          const k = armKey(strategy, regime, variantId(shortDelta))
          const acc = buckets.get(k) ?? { rewards: [], pnls: [] }
          acc.rewards.push(reward)
          acc.pnls.push(pnl)
          buckets.set(k, acc)
          trades++
        }
      }
    }
  }

  const arms: ArmResult[] = [...buckets.entries()].map(([k, acc]) => {
    const [strategy, regime, variant] = k.split('|') as [StrategyType, Regime, string]
    const n = acc.pnls.length
    const wins = acc.pnls.filter((p) => p > 0).length
    const totalPnl = acc.pnls.reduce((a, b) => a + b, 0)
    return {
      strategy, regime, variant,
      shortDelta: Number(variant.replace('sd', '')),
      n, wins,
      winRate: n ? wins / n : 0,
      avgPnl: n ? totalPnl / n : 0,
      totalPnl,
      avgReward: n ? acc.rewards.reduce((a, b) => a + b, 0) / n : 0
    }
  }).sort((a, b) =>
    a.strategy.localeCompare(b.strategy) ||
    a.regime.localeCompare(b.regime) ||
    a.shortDelta - b.shortDelta
  )

  return { daysCovered: days, trades, skipped, arms }
}
