import type { RecommendationSnapshot } from './types.js'
import { computeOutcomeForSnapshot, SettlementNotReadyError, type OutcomeOptions } from './outcome.js'
import { SETTLEMENT_VERSION, isCurrentRegime, exitPolicyOf } from './settlementVersion.js'
import { assertLoadedHistoryMatchesFile, loadSnapshots, saveSnapshots } from './store.js'
import { managedHoldDays } from '../engine/managedExit.js'
import { addCalendarDays, currentTime, lastSettledEtDay } from '../api/marketSession.js'

/** Rule-based hold period (forward days) — matches the live engine, honoring
 *  the snapshot's exit-policy arm (runner condors need bars to expiry). */
function effectiveHorizon(s: RecommendationSnapshot): number {
  return managedHoldDays(s.strategyId, s.dte, exitPolicyOf(s))
}

/**
 * Outcome window ends `horizonDays` calendar days after snapshot ET day, and is
 * due once THAT day's session has settled — not once the UTC date reaches it,
 * which is 20:00 ET the evening before the final close (see marketSession.ts).
 */
export function snapshotPastHorizon(
  s: Pick<RecommendationSnapshot, 'etDay'>,
  horizonDays: number,
  now: Date = currentTime()
): boolean {
  return lastSettledEtDay(now) >= addCalendarDays(s.etDay, horizonDays)
}

/**
 * Attach outcomes to snapshots once past their (strategy-aware) horizon.
 * `force` recomputes existing outcomes too — used after the P&L marking method
 * changes, to migrate the whole book to the new definition.
 *
 * An outcome from a SUPERSEDED settlement regime counts as due even without
 * `force`. Otherwise a regime bump leaves the book permanently stale unless a
 * human remembers to run a one-off migration — and the learning layer, which
 * correctly ignores stale outcomes, would just quietly starve. Self-healing is
 * rate-limited by `maxUpdates` like any other backlog.
 */
export async function hydrateDueSnapshots(
  options: { stopLossFraction?: number; maxUpdates?: number; force?: boolean }
): Promise<{
  updated: number
  pendingWithinHorizon: number
}> {
  const maxUpdates = options.maxUpdates ?? 50
  const all = await loadSnapshots()
  await assertLoadedHistoryMatchesFile(all)
  let updated = 0
  let pendingWithinHorizon = 0

  const next: RecommendationSnapshot[] = []
  for (const s of all) {
    const horizonDays = effectiveHorizon(s)
    if (s.outcome != null && !options.force && isCurrentRegime(s.outcome)) {
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
      if (e instanceof SettlementNotReadyError) {
        // Data not complete yet — leave the row (and any superseded outcome)
        // as it is; a later run settles it.
        next.push(s)
        pendingWithinHorizon++
        continue
      }
      next.push({
        ...s,
        outcome: {
          computedAt: new Date().toISOString(),
          // Stamped even though settlement FAILED: it is a current-regime
          // result ("we tried and could not price it"). It carries no P&L, so
          // learning skips it on the null check, not on the regime check.
          settlementVersion: SETTLEMENT_VERSION,
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
  await assertLoadedHistoryMatchesFile(all)
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
