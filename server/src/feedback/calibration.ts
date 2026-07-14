/**
 * Feedback-loop calibration.
 *
 * Reads realized outcomes from recorded snapshots and derives a per-(strategy ×
 * regime) score multiplier from the historical RISK-ADJUSTED RETURN — not the
 * win rate. Win rate is structurally misleading for options (a 52%-win long
 * straddle that loses −3.48/trade would sneak back into recommendations under a
 * win-rate rule); reward = return on capital-at-risk instead, so a combo is
 * boosted only if it actually made money per dollar risked.
 *
 * Shrinkage by sample size keeps small-n buckets near 1× until enough evidence
 * accumulates, so a couple of lucky/unlucky trades don't swing selection.
 */

import { loadSnapshots } from './store.js'
import type { RecommendationOutcome, RecommendationSnapshot } from './types.js'
import type { StrategyType } from '../engine/types.js'
import { DIRECTIONAL_DEBIT_SPREADS, type Regime } from '../engine/index.js'

/** Managed P&L preferred; fall back to expiry close, then path midpoint. */
export function outcomePnl(o: RecommendationOutcome): number | null {
  if (o.managedPnl != null) return o.managedPnl
  if (o.pnlAtExpirationClose != null) return o.pnlAtExpirationClose
  if (o.pnlPathMin != null && o.pnlPathMax != null) return (o.pnlPathMin + o.pnlPathMax) / 2
  return null
}

/**
 * Realized P&L → return on capital-at-risk on [0,1]. 0.5 = breakeven,
 * 0 = lost the max, 1 = made as much as could be lost. Self-normalizing across
 * $20 and $500 underlyings. Shared by the online tuner. Falls back to binary
 * win/loss only when maxLoss is unavailable (undefined-risk structures).
 */
export function normalizedReward(pnl: number, maxLoss: number | null): number {
  if (maxLoss != null && maxLoss < 0) {
    return Math.max(0, Math.min(1, 0.5 + 0.5 * (pnl / Math.abs(maxLoss))))
  }
  return pnl > 0 ? 1 : 0
}

/** key `${strategy}|${regime}` → score multiplier (clamped). */
export type CalibrationTable = Map<string, number>

const MIN_SAMPLES = 3   // need at least this many resolved outcomes per bucket
const SHRINK_N = 8      // half-confidence at n=8 (n/(n+SHRINK_N))
const PNL_K = 0.1       // how hard a $/trade edge moves the multiplier
const CLAMP_LO = 0.4
const CLAMP_HI = 1.4

// Hard gate: reserved for CATASTROPHIC combos (avg loss worse than this
// $/share). A hard 0 is self-perpetuating — a disabled combo is never
// recommended, so it never records fresh outcomes to earn its way back — so
// keep the bar high; moderate losers get soft-damped (still occasionally
// recommended → self-correcting) instead of killed.
const DISABLE_MIN_N = 10
const DISABLE_PNL = -2.5

// The signal is the bucket's MEAN P&L ($/share). Every normalized alternative
// (÷maxLoss, ÷spot, ÷premium) gets pulled positive by a right-skewed long
// straddle's few big-percent winners on low-priced names, hiding that it loses
// money — mean $ P&L is the metric that matches "did this actually pay". The
// watchlist is bounded large-caps ($70–700), so cross-symbol $ scale is fine;
// the multiplier is a gentle, clamped nudge relative to the book's own baseline.

function calibKey(strategy: StrategyType, regime: Regime): string {
  return `${strategy}|${regime}`
}

export function buildCalibrationTable(snaps: RecommendationSnapshot[]): CalibrationTable {
  const groups = new Map<string, number[]>() // per-bucket P&Ls ($/share)
  let allPnl = 0
  let allN = 0

  for (const s of snaps) {
    if (!s.outcome) continue
    // Calibration measures the RECOMMENDED book (was the surfaced edge real?).
    // Shadow arm rows include never-recommended combos and would triple-weight
    // tuned strategies — they are tuner-only evidence (see types.ts `source`).
    if (s.source === 'shadow') continue
    // Directional debit spreads aren't calibrated — their realized P&L is the
    // sample's market direction, not skill (see DIRECTIONAL_DEBIT_SPREADS), so
    // they stay at 1× and never sway selection by which way the tape happened
    // to go in the training window.
    if (DIRECTIONAL_DEBIT_SPREADS.has(s.strategyId)) continue
    const pnl = outcomePnl(s.outcome)
    if (pnl == null) continue
    const k = calibKey(s.strategyId, s.regime)
    const arr = groups.get(k) ?? []
    arr.push(pnl)
    groups.set(k, arr)
    allPnl += pnl
    allN++
  }

  const table: CalibrationTable = new Map()
  if (allN === 0) return table

  // Baseline = the book's own average P&L, so the multiplier rewards *relative*
  // edge (a combo that beats the book) rather than an absolute bar.
  const baseline = allPnl / allN

  for (const [k, pnls] of groups) {
    if (pnls.length < MIN_SAMPLES) continue
    const avg = pnls.reduce((a, b) => a + b, 0) / pnls.length
    if (pnls.length >= DISABLE_MIN_N && avg < DISABLE_PNL) {
      table.set(k, 0)
      continue
    }
    const confidence = pnls.length / (pnls.length + SHRINK_N)
    const raw = 1 + PNL_K * (avg - baseline) * confidence
    table.set(k, Math.min(CLAMP_HI, Math.max(CLAMP_LO, raw)))
  }

  return table
}

export async function loadCalibrationTable(): Promise<CalibrationTable> {
  const snaps = await loadSnapshots()
  return buildCalibrationTable(snaps)
}

export function calibrationMultiplier(
  table: CalibrationTable,
  strategy: StrategyType,
  regime: Regime
): number {
  return table.get(calibKey(strategy, regime)) ?? 1
}
