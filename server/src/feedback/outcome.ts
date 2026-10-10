import { getDailyBars, type DailyBar } from '../api/marketdata.js'
import { totalPnL } from '../engine/payoff.js'
import { runManagedExit, managedHoldDays } from '../engine/managedExit.js'
import { deriveSimSigma } from '../engine/index.js'
import type { RecommendationOutcome, RecommendationSnapshot } from './types.js'
import { storedLegsToOptionLegs } from './legAdapter.js'
import { SETTLEMENT_VERSION, exitPolicyOf } from './settlementVersion.js'
import {
  addCalendarDays,
  calendarDaysBetween,
  currentTime,
  lastSettledEtDay,
  lastWeekdayOnOrBefore
} from '../api/marketSession.js'

/**
 * The price data for this window is not complete YET — retry on a later run.
 * Distinct from a settlement that ran and could not price anything: that one
 * is persisted; this one must not be, because a current-regime outcome is never
 * recomputed, so persisting a window without its final close freezes the wrong
 * number into the learning record until the next SETTLEMENT_VERSION bump.
 */
export class SettlementNotReadyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SettlementNotReadyError'
  }
}

/**
 * Days a missing tail bar is attributed to "not printed yet" before it is
 * accepted as a market holiday (or a genuinely empty history). Long enough to
 * outlast a provider lag plus a weekend; short enough that a window ending on
 * Good Friday settles the following week.
 */
export const TAIL_PUBLISH_GRACE_DAYS = 4

/** Does the window's newest bar reach its last weekday — or has the grace
 *  period for it to appear run out? */
export function tailPublished(lastBarDate: string | null, capEnd: string, now: Date = currentTime()): boolean {
  if (lastBarDate != null && lastBarDate >= lastWeekdayOnOrBefore(capEnd)) return true
  return calendarDaysBetween(capEnd, lastSettledEtDay(now)) >= TAIL_PUBLISH_GRACE_DAYS
}

/** Calendar days from isoA to isoB (B − A). */
function daysBetween(isoA: string, isoB: string): number {
  return (Date.parse(isoB) - Date.parse(isoA)) / 86_400_000
}

function annualizedRvFromCloses(closes: number[]): number | null {
  if (closes.length < 2) return null
  const ret: number[] = []
  for (let i = 1; i < closes.length; i++) {
    ret.push(Math.log(closes[i] / closes[i - 1]))
  }
  const n = ret.length
  if (n < 2) return null
  const mean = ret.reduce((a, b) => a + b, 0) / n
  let v = 0
  for (const r of ret) v += (r - mean) ** 2
  const sd = Math.sqrt(v / (n - 1))
  return sd * Math.sqrt(252)
}

function defaultStopThreshold(s: RecommendationSnapshot): number {
  if (s.maxLoss != null && Number.isFinite(s.maxLoss) && s.maxLoss < 0) {
    return Math.abs(s.maxLoss) * 0.5
  }
  if (s.netPremium > 0) return s.netPremium * 2
  return Math.max(s.spot * 0.02, 1)
}

function barsInWindow(bars: DailyBar[], start: string, end: string): DailyBar[] {
  return bars.filter((b) => b.date >= start && b.date <= end)
}

function nearBreakeven(
  bars: DailyBar[],
  bes: number[],
  epsRatio = 0.002
): boolean {
  if (bes.length === 0) return false
  for (const { close } of bars) {
    for (const be of bes) {
      if (Math.abs(close - be) / Math.max(close, 1e-6) < epsRatio) return true
    }
  }
  return false
}

export type OutcomeOptions = {
  horizonDays: number
  /** When maxLoss is finite, threshold = abs(maxLoss) * fraction; else credit heuristic still applies. */
  stopLossFraction?: number
}

/**
 * Fills outcome fields from daily bars after the snapshot's ET day.
 * Uses MARKETDATA_TOKEN (same as IVR path).
 */
export async function computeOutcomeForSnapshot(
  s: RecommendationSnapshot,
  opts: OutcomeOptions
): Promise<RecommendationOutcome> {
  const { horizonDays } = opts
  const stopFrac = opts.stopLossFraction ?? 0.5
  const windowEnd = addCalendarDays(s.etDay, horizonDays)
  // Only sessions that have CLOSED — never "today by UTC" (see marketSession.ts).
  const settled = lastSettledEtDay()
  const capEnd = settled < windowEnd ? settled : windowEnd
  const legs = storedLegsToOptionLegs(s.legs)

  let bars: DailyBar[] = []
  try {
    bars = await getDailyBars(s.sym, s.etDay, capEnd)
  } catch (e) {
    // A fetch failure is transient (429s, proxy). Persisting it stamped 876
    // outcomes "bars fetch failed" with null P&L that nothing ever retried.
    throw new SettlementNotReadyError(`bars fetch failed: ${(e as Error).message}`)
  }

  const win = barsInWindow(bars, s.etDay, capEnd)
  const lastBarDate = win.length > 0 ? win[win.length - 1].date : null
  if (!tailPublished(lastBarDate, capEnd)) {
    throw new SettlementNotReadyError(
      `${s.sym}: newest bar ${lastBarDate ?? 'none'} stops short of ${lastWeekdayOnOrBefore(capEnd)}`
    )
  }
  const closes = win.map((b) => b.close)
  const rv = annualizedRvFromCloses(closes)

  let pnlPathMin: number | null = null
  let pnlPathMax: number | null = null
  let spotMin: number | null = null
  let spotMax: number | null = null
  if (closes.length > 0) {
    spotMin = Math.min(...closes)
    spotMax = Math.max(...closes)
    const pnls = closes.map((c) => totalPnL(legs, c))
    pnlPathMin = Math.min(...pnls)
    pnlPathMax = Math.max(...pnls)
  }

  let pnlAtExpirationClose: number | null = null
  const expBar = win.find((b) => b.date === s.expiration)
  if (expBar) pnlAtExpirationClose = totalPnL(legs, expBar.close)
  else if (win.length > 0) {
    const last = win[win.length - 1]
    if (last.date >= s.expiration) {
      const hit = win.filter((b) => b.date <= s.expiration)
      const b = hit[hit.length - 1]
      if (b && b.date === s.expiration) pnlAtExpirationClose = totalPnL(legs, b.close)
    }
  }

  let stopThresholdUsed = defaultStopThreshold(s)
  if (s.maxLoss != null && Number.isFinite(s.maxLoss) && s.maxLoss < 0) {
    stopThresholdUsed = Math.abs(s.maxLoss) * stopFrac
  }

  const stopHit =
    pnlPathMin != null && Number.isFinite(stopThresholdUsed)
      ? pnlPathMin <= -stopThresholdUsed
      : false

  // ---- Managed exit simulation (shared with the live engine) ----
  let managedPnl: number | null = null
  let managedExitDay: string | null = null
  let managedExitReason: 'take_profit' | 'stop_loss' | 'expiry' | 'end_of_window' | null = null

  if (win.length > 0) {
    const me = runManagedExit(legs, closes, s.netPremium, {
      tauAt: (i) => Math.max(0, daysBetween(win[i].date, s.expiration) / 365),
      r: 0.045,
      q: 0,
      // ATM FALLBACK, not the mark vol: legs carrying their own scan-time `iv`
      // (storedLegsToOptionLegs brings it back) are marked at that IV inside
      // markPnL. This keeps the learning loop on the same vol surface as the
      // displayed card — otherwise calibration/tuner would train on take-profit
      // and stop touches that the card's own sim never produced.
      sigma: s.iv,
      // Same VRP-harvest decay, aimed at the SAME target the live card aimed at:
      // deriveSimSigma(iv, rvAtScan) — strictly the scan-time information set.
      //
      // It must NOT be the window's realized vol. `rv` is annualized over the
      // whole holding window, so a mark on day 5 would already carry day 30's
      // move; take-profit and stop TIMING is exactly what the tuner learns from,
      // so peeking there teaches the bandit a game easier than the one it plays.
      // (An earlier revision did this and rationalized it as "the better
      // target" — for a settlement engine that reasoning is backwards.)
      // rvAtScan missing → deriveSimSigma returns iv → no-op.
      convergeTo: deriveSimSigma(s.iv, s.rvAtScan ?? undefined),
      // Same management horizon the card used. Without it `end` defaults to the
      // bar count, and a calendar-day window holds ~5/7 as many trading bars —
      // so the settlement engine ran a SHORTER window than the card AND, since
      // `steps` drives the convergence schedule, decayed vol faster, shifting
      // take-profit/stop timing away from what was displayed. Two halves of
      // "display and learning share one managed exit" must share this too.
      maxSteps: managedHoldDays(s.strategyId, s.dte, exitPolicyOf(s))
    }, exitPolicyOf(s))
    if (me.reason !== 'end_of_window') {
      managedPnl = me.pnl
      managedExitDay = win[me.exitIndex].date
      managedExitReason = me.reason
    } else if (pnlAtExpirationClose != null) {
      // No TP/stop hit but the position expired within the window.
      managedPnl = pnlAtExpirationClose
      managedExitDay = s.expiration
      managedExitReason = 'expiry'
    } else {
      managedPnl = me.pnl
      managedExitDay = win[win.length - 1].date
      managedExitReason = 'end_of_window'
    }
  }

  return {
    computedAt: new Date().toISOString(),
    settlementVersion: SETTLEMENT_VERSION,
    horizonDays,
    tradingDaysUsed: win.length,
    realizedVolAnnualized: rv,
    spotMin,
    spotMax,
    pnlPathMin,
    pnlPathMax,
    pnlAtExpirationClose,
    stopHit,
    stopThresholdUsed,
    nearBreakevenTouched: nearBreakeven(win, s.breakevens),
    managedPnl,
    managedExitDay,
    managedExitReason,
  }
}
