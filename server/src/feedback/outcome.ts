import { getDailyBars, type DailyBar } from '../api/marketdata.js'
import { totalPnL } from '../engine/payoff.js'
import { runManagedExit } from '../engine/managedExit.js'
import type { RecommendationOutcome, RecommendationSnapshot } from './types.js'
import { storedLegsToOptionLegs } from './legAdapter.js'

function addCalendarDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10)
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
  const capEnd = todayUtcDate() < windowEnd ? todayUtcDate() : windowEnd
  const legs = storedLegsToOptionLegs(s.legs)

  let note = ''
  let bars: DailyBar[] = []
  try {
    bars = await getDailyBars(s.sym, s.etDay, capEnd)
  } catch (e) {
    note = `bars fetch failed: ${(e as Error).message}`
  }

  const win = barsInWindow(bars, s.etDay, capEnd)
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
      sigma: s.iv
    }, s.exitPolicy ?? 'managed')
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
    note: note || undefined
  }
}
