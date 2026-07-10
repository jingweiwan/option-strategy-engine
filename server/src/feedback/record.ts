import { randomUUID } from 'node:crypto'
import { etCalendarDay } from '../ai/cache.js'
import type { ScannedOpp } from '../engine/oppScanner.js'
import type { RecommendationSnapshot } from './types.js'
import { loadSnapshots, saveSnapshots } from './store.js'

const OFF = process.env.FEEDBACK_RECORD === '0'

function toSnapshot(o: ScannedOpp, etDay: string): RecommendationSnapshot {
  return {
    id: randomUUID(),
    etDay,
    capturedAt: new Date().toISOString(),
    source: 'dashboard',
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
