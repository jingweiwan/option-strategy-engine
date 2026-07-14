import { randomUUID } from 'node:crypto'
import { etCalendarDay } from '../ai/cache.js'
import type { ScannedOpp } from '../engine/oppScanner.js'
import type { RecommendationSnapshot } from './types.js'
import { loadSnapshots, saveSnapshots } from './store.js'

const OFF = process.env.FEEDBACK_RECORD === '0'

function toSnapshot(o: ScannedOpp, etDay: string, source: RecommendationSnapshot['source'] = 'dashboard'): RecommendationSnapshot {
  return {
    id: randomUUID(),
    etDay,
    capturedAt: new Date().toISOString(),
    source,
    sym: o.sym,
    strategyId: o.strategyId,
    expiration: o.expiration,
    spot: o.spot,
    iv: o.iv,
    ivr: o.ivr,
    rvAtScan: o.rvAtScan ?? null,
    ivRvGap:
      o.rvAtScan != null && o.rvAtScan > 0 && Number.isFinite(o.iv) ? o.iv - o.rvAtScan : null,
    regime: o.regime,
    score: o.score,
    pop: o.pop,
    ev: o.ev,
    netPremium: o.netPremium,
    maxProfit: o.maxProfit,
    maxLoss: o.maxLoss,
    dte: o.dte,
    breakevens: [...o.breakevens],
    legs: o.legs.map((l) => ({ ...l })),
    variant: o.variant ?? null,
    aiView: o.aiView ?? null,
    aiViewConfidence: o.aiViewConfidence ?? null,
    exitPolicy: o.exitPolicy ?? null,
    outcome: null
  }
}

/**
 * Replace today's `dashboard` batch with the latest scan (one row per symbol).
 * No-op when FEEDBACK_RECORD=0 or scan rows lack legs (stale cache).
 */
export async function recordDashboardScanSnapshots(scanned: ScannedOpp[]): Promise<void> {
  if (OFF) return

  const etDay = etCalendarDay()
  const rows = scanned.filter((o) => Array.isArray(o.legs) && o.legs.length > 0).map((o) => toSnapshot(o, etDay))
  if (rows.length === 0) return

  const all = await loadSnapshots()
  const kept = all.filter((s) => !(s.etDay === etDay && s.source === 'dashboard'))
  await saveSnapshots([...kept, ...rows])
}

/**
 * Replace today's `shadow` batch: every tuner arm evaluated by the scan (one
 * row per symbol × strategy × arm), recorded regardless of score so losing
 * arms accumulate settled evidence too (see the `source` doc in types.ts).
 * Settling a shadow row costs nothing extra — the outcome pass replays the
 * same daily bars it already fetches for the symbol.
 */
export async function recordShadowArmSnapshots(rows: ScannedOpp[]): Promise<void> {
  if (OFF) return

  const etDay = etCalendarDay()
  const snaps = rows.filter((o) => Array.isArray(o.legs) && o.legs.length > 0).map((o) => toSnapshot(o, etDay, 'shadow'))
  if (snaps.length === 0) return

  const all = await loadSnapshots()
  const kept = all.filter((s) => !(s.etDay === etDay && s.source === 'shadow'))
  await saveSnapshots([...kept, ...snaps])
}
