/**
 * Aggregation for the Performance page.
 *
 * Three ways the page used to mislead, all fixed here rather than in the view:
 *
 *   1. It counted SHADOW arm rows as 推荐. Shadow rows are tuner experiments
 *      recorded on the same chain — never shown to the user. On 2026-09-17 they
 *      were 8,147 of 8,715 rows: SPY's "444 推荐" was 57 cards, and LLY showed
 *      −$11,800 without ever having been recommended. Calibration and the exit
 *      A/B already read only the surfaced book; this page now agrees with them.
 *      (The tuner still reads shadow rows — that is what they are for.)
 *   2. It pooled structures. META's −$25k was mostly long straddles and bull
 *      call spreads from before the buy-vol gate, reported as "META loses".
 *   3. It summed dollars across risk sizes. A $186 condor win and a $4,019 max
 *      loss are one row each; return on max loss puts them on one scale.
 */
import type { RecommendationOutcome, RecommendationSnapshot } from './types.js'
import { exitPolicyOf } from './settlementVersion.js'
import type { ExitPolicy } from '../engine/managedExit.js'

const MULTIPLIER = 100 // standard equity option contract

export type GroupStats = {
  label: string
  /** Set on symbol × strategy rows. */
  strategy?: string
  total: number
  withOutcome: number
  wins: number
  losses: number
  winRate: number | null
  avgPnl: number | null
  totalPnl: number
  avgPop: number | null
  avgEv: number | null
  stopHits: number
  /** Distinct entry days among priced rows — the independent-sample count.
   *  Same-day rows share one price path. */
  days: number
  /** Σ P&L ÷ Σ max loss over priced rows whose loss is bounded. */
  returnOnRisk: number | null
  /** Priced rows with no finite max loss (short strangles, naked shorts):
   *  excluded from returnOnRisk, counted so the UI can say so. */
  unbounded: number
}

/** Realized P&L per contract in dollars. */
export function bestPnl(o: RecommendationOutcome): number | null {
  if (o.managedPnl != null) return o.managedPnl * MULTIPLIER
  if (o.pnlAtExpirationClose != null) return o.pnlAtExpirationClose * MULTIPLIER
  if (o.pnlPathMin != null && o.pnlPathMax != null) {
    return ((o.pnlPathMin + o.pnlPathMax) / 2) * MULTIPLIER
  }
  return null
}

function maxLossDollars(s: RecommendationSnapshot): number | null {
  if (s.maxLoss != null && Number.isFinite(s.maxLoss) && s.maxLoss < 0) {
    return Math.abs(s.maxLoss) * MULTIPLIER
  }
  // A long-premium structure cannot lose more than it paid. Mid-May 2026 long
  // straddles were recorded with maxLoss null (the unbounded max PROFIT nulled
  // both fields); without this they read as "unbounded loss".
  if (s.netPremium < 0) return Math.abs(s.netPremium) * MULTIPLIER
  return null
}

export function computeGroupStats(label: string, rows: RecommendationSnapshot[], strategy?: string): GroupStats {
  const withOutcome = rows.filter(
    (r) => r.outcome != null && (r.outcome.pnlPathMax != null || r.outcome.pnlAtExpirationClose != null)
  )
  const priced = withOutcome
    .map((r) => ({ r, pnl: bestPnl(r.outcome!) }))
    .filter((x): x is { r: RecommendationSnapshot; pnl: number } => x.pnl != null)
  const pnls = priced.map((x) => x.pnl)
  const wins = pnls.filter((p) => p > 0).length

  let riskPnl = 0
  let risk = 0
  let unbounded = 0
  for (const { r, pnl } of priced) {
    const ml = maxLossDollars(r)
    if (ml == null) {
      unbounded++
      continue
    }
    riskPnl += pnl
    risk += ml
  }

  return {
    label,
    ...(strategy ? { strategy } : {}),
    total: rows.length,
    withOutcome: withOutcome.length,
    wins,
    losses: pnls.length - wins,
    winRate: pnls.length > 0 ? wins / pnls.length : null,
    avgPnl: pnls.length > 0 ? pnls.reduce((a, b) => a + b, 0) / pnls.length : null,
    totalPnl: pnls.reduce((a, b) => a + b, 0),
    avgPop: rows.length > 0 ? rows.reduce((a, r) => a + r.pop, 0) / rows.length : null,
    avgEv: rows.length > 0 ? rows.reduce((a, r) => a + r.ev, 0) / rows.length : null,
    stopHits: withOutcome.filter((r) => r.outcome!.stopHit).length,
    days: new Set(priced.map((x) => x.r.etDay)).size,
    returnOnRisk: risk > 0 ? riskPnl / risk : null,
    unbounded
  }
}

/** What the page's numbers are actually measuring. */
export type PerformanceScope = {
  bookRows: number
  shadowRows: number
  /** Entry-day range and distinct entry days of the priced book. */
  settledFrom: string | null
  settledTo: string | null
  settledDays: number
  /** Priced book rows by the exit rule they were settled under. */
  rulers: Partial<Record<ExitPolicy, number>>
}

export function splitBook(rows: RecommendationSnapshot[]): {
  book: RecommendationSnapshot[]
  shadow: RecommendationSnapshot[]
} {
  const book: RecommendationSnapshot[] = []
  const shadow: RecommendationSnapshot[] = []
  for (const s of rows) (s.source === 'shadow' ? shadow : book).push(s)
  return { book, shadow }
}

export function performanceScope(book: RecommendationSnapshot[], shadowRows: number): PerformanceScope {
  const priced = book.filter((s) => s.outcome != null && bestPnl(s.outcome) != null)
  const days = [...new Set(priced.map((s) => s.etDay))].sort()
  const rulers: Partial<Record<ExitPolicy, number>> = {}
  for (const s of priced) {
    const p = exitPolicyOf(s)
    rulers[p] = (rulers[p] ?? 0) + 1
  }
  return {
    bookRows: book.length,
    shadowRows,
    settledFrom: days[0] ?? null,
    settledTo: days[days.length - 1] ?? null,
    settledDays: days.length,
    rulers
  }
}

/** Symbol × strategy breakdown, grouped by symbol (busiest first), strategies
 *  within a symbol by row count. Pooling structures under a symbol is exactly
 *  the reading this replaces. */
export function symbolStrategyStats(book: RecommendationSnapshot[]): GroupStats[] {
  const bySym = new Map<string, Map<string, RecommendationSnapshot[]>>()
  for (const s of book) {
    const m = bySym.get(s.sym) ?? new Map<string, RecommendationSnapshot[]>()
    const list = m.get(s.strategyId) ?? []
    list.push(s)
    m.set(s.strategyId, list)
    bySym.set(s.sym, m)
  }
  const symTotal = (m: Map<string, RecommendationSnapshot[]>) =>
    [...m.values()].reduce((a, l) => a + l.length, 0)
  return [...bySym.entries()]
    .sort(([a, ma], [b, mb]) => symTotal(mb) - symTotal(ma) || a.localeCompare(b))
    .flatMap(([sym, m]) =>
      [...m.entries()]
        .map(([strategy, rows]) => computeGroupStats(sym, rows, strategy))
        .sort((a, b) => b.total - a.total || a.strategy!.localeCompare(b.strategy!))
    )
}
