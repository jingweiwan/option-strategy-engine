import type { RecommendationSnapshot } from './types.js'
import { computeOutcomeForSnapshot, type OutcomeOptions } from './outcome.js'
import { loadSnapshots, saveSnapshots } from './store.js'
import { managedHoldDays } from '../engine/managedExit.js'

/** Rule-based hold period (forward days) — matches the live engine, honoring
 *  the snapshot's exit-policy arm (runner condors need bars to expiry). */
function effectiveHorizon(s: RecommendationSnapshot): number {
  return managedHoldDays(s.strategyId, s.dte, s.exitPolicy ?? 'managed')
}

function addCalendarDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Outcome window ends `horizonDays` calendar days after snapshot ET day. */
function snapshotPastHorizon(s: RecommendationSnapshot, horizonDays: number): boolean {
  return todayUtcDate() >= addCalendarDays(s.etDay, horizonDays)
}

/**
 * Attach outcomes to snapshots once past their (strategy-aware) horizon.
 * `force` recomputes existing outcomes too — used after the P&L marking method
 * changes, to migrate the whole book to the new definition.
 */
export async function hydrateDueSnapshots(
  options: { stopLossFraction?: number; maxUpdates?: number; force?: boolean }
): Promise<{
  updated: number
  pendingWithinHorizon: number
}> {
  const maxUpdates = options.maxUpdates ?? 50
  const all = await loadSnapshots()
  let updated = 0
  let pendingWithinHorizon = 0

  const next: RecommendationSnapshot[] = []
  for (const s of all) {
    const horizonDays = effectiveHorizon(s)
    if (s.outcome != null && !options.force) {
      next.push(s)
      continue
    }
    if (!snapshotPastHorizon(s, horizonDays)) {
      next.push(s)
      pendingWithinHorizon++
      continue
    }
    if (updated >= maxUpdates) {
      next.push(s)
      continue
    }
    try {
      const outcome = await computeOutcomeForSnapshot(s, { horizonDays, stopLossFraction: options.stopLossFraction })
      next.push({ ...s, outcome })
      updated++
    } catch (e) {
      next.push({
        ...s,
        outcome: {
          computedAt: new Date().toISOString(),
          horizonDays,
          tradingDaysUsed: 0,
          realizedVolAnnualized: null,
          spotMin: null,
          spotMax: null,
          pnlPathMin: null,
          pnlPathMax: null,
          pnlAtExpirationClose: null,
          stopHit: false,
          stopThresholdUsed: 0,
          nearBreakevenTouched: false,
          managedPnl: null,
          managedExitDay: null,
          managedExitReason: null,
          note: `hydrate error: ${(e as Error).message}`
        }
      })
      updated++
    }
  }

  await saveSnapshots(next)
  return { updated, pendingWithinHorizon }
}

export async function hydrateSnapshotById(
  id: string,
  options: Pick<OutcomeOptions, 'stopLossFraction'> = {}
): Promise<RecommendationSnapshot | null> {
  const all = await loadSnapshots()
  const idx = all.findIndex((s) => s.id === id)
  if (idx < 0) return null
  const s = all[idx]
  const outcome = await computeOutcomeForSnapshot(s, {
    horizonDays: effectiveHorizon(s),
    stopLossFraction: options.stopLossFraction
  })
  const row: RecommendationSnapshot = { ...s, outcome }
  const next = [...all]
  next[idx] = row
  await saveSnapshots(next)
  return row
}
