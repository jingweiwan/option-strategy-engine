import type { Regime, View } from '../engine/index.js'
import type { StrategyType } from '../engine/types.js'
import type { ExitPolicy } from '../engine/managedExit.js'

/** Serializable leg row (no greeks) — enough for expiry-style P&L. */
export type StoredLeg = {
  type: 'call' | 'put'
  action: 'buy' | 'sell'
  strike: number
  premium: number
  quantity: number
}

export type RecommendationSnapshot = {
  id: string
  /** ET calendar day when recorded (YYYY-MM-DD). */
  etDay: string
  capturedAt: string
  source: 'dashboard'
  sym: string
  strategyId: StrategyType
  expiration: string
  spot: number
  iv: number
  ivr: number
  /** 30d RV at scan time (same source as IVR), null if unavailable. */
  rvAtScan: number | null
  ivRvGap: number | null
  regime: Regime
  score: number
  pop: number
  ev: number
  netPremium: number
  maxProfit: number | null
  maxLoss: number | null
  dte: number
  breakevens: number[]
  legs: StoredLeg[]
  /** Tuner variant id (e.g. "sd0.25"); null/absent = static spec defaults. */
  variant?: string | null
  /** AI directional view at scan time + its confidence — persisted so the
   *  view-skill gate can be earned from realized outcomes over time. */
  aiView?: View | null
  aiViewConfidence?: number | null
  /** Condor exit A/B arm: 'managed' (default rules) / 'runner' (stop-only,
   *  hold to expiry). null/absent = pre-experiment snapshot ⇒ managed. */
  exitPolicy?: ExitPolicy | null
  outcome?: RecommendationOutcome | null
}

export type RecommendationOutcome = {
  computedAt: string
  horizonDays: number
  tradingDaysUsed: number
  /** Close-to-close annualized realized vol over the window (sqrt(252) * stdev of log returns). */
  realizedVolAnnualized: number | null
  spotMin: number | null
  spotMax: number | null
  /** Min / max of expiry-style P&L evaluated at each daily close in the window (per engine payoff). */
  pnlPathMin: number | null
  pnlPathMax: number | null
  /** P&L if expired at official expiration day close (when that date falls in fetched history). */
  pnlAtExpirationClose: number | null
  /**
   * Heuristic: path P&L went worse than -stopThreshold.
   * Threshold = maxLoss*stopLossFraction when maxLoss finite, else 2× credit when netPremium>0.
   */
  stopHit: boolean
  stopThresholdUsed: number
  /** Any daily close within 0.2% of spot of a breakeven level. */
  nearBreakevenTouched: boolean
  /** Managed exit simulation — applies take-profit / stop-loss rules per daily close. */
  managedPnl: number | null
  managedExitDay: string | null
  managedExitReason: 'take_profit' | 'stop_loss' | 'expiry' | 'end_of_window' | null
  note?: string
}
