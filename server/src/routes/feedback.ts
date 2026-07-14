import type { FastifyInstance } from 'fastify'
import {
  feedbackStorePath,
  hydrateDueSnapshots,
  hydrateSnapshotById,
  loadSnapshots
} from '../feedback/index.js'
import type { RecommendationSnapshot, RecommendationOutcome } from '../feedback/types.js'
import { buildArmStats } from '../feedback/tuner.js'
import { outcomePnl } from '../feedback/calibration.js'

// ---------- Performance aggregation ----------

type GroupStats = {
  label: string
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
}

/**
 * Get P&L for a snapshot using managed exit simulation.
 * Managed exit applies realistic trade management rules:
 *   Credit: take profit at 50% credit, stop at 2× credit
 *   Debit:  take profit at 1:1 (profit = debit paid), stop at 50% debit
 * Falls back to path midpoint for legacy outcomes without managedPnl.
 */
function bestPnl(o: RecommendationOutcome): number | null {
  const MULTIPLIER = 100 // standard equity option contract multiplier
  if (o.managedPnl != null) return o.managedPnl * MULTIPLIER
  if (o.pnlAtExpirationClose != null) return o.pnlAtExpirationClose * MULTIPLIER
  if (o.pnlPathMin != null && o.pnlPathMax != null) {
    return ((o.pnlPathMin + o.pnlPathMax) / 2) * MULTIPLIER
  }
  return null
}

function computeGroupStats(label: string, rows: RecommendationSnapshot[]): GroupStats {
  const withOutcome = rows.filter(r => r.outcome != null && (r.outcome.pnlPathMax != null || r.outcome.pnlAtExpirationClose != null))
  const pnls = withOutcome
    .map(r => bestPnl(r.outcome!))
    .filter((v): v is number => v != null)

  const wins = pnls.filter(p => p > 0).length
  const losses = pnls.filter(p => p <= 0).length

  return {
    label,
    total: rows.length,
    withOutcome: withOutcome.length,
    wins,
    losses,
    winRate: pnls.length > 0 ? wins / pnls.length : null,
    avgPnl: pnls.length > 0 ? pnls.reduce((a, b) => a + b, 0) / pnls.length : null,
    totalPnl: pnls.reduce((a, b) => a + b, 0),
    avgPop: rows.length > 0 ? rows.reduce((a, r) => a + r.pop, 0) / rows.length : null,
    avgEv: rows.length > 0 ? rows.reduce((a, r) => a + r.ev, 0) / rows.length : null,
    stopHits: withOutcome.filter(r => r.outcome!.stopHit).length
  }
}

export async function feedbackRoutes(app: FastifyInstance) {
  app.get('/api/feedback/recommendations', async (req, reply) => {
    const q = req.query as { limit?: string }
    const limit = Math.min(500, Math.max(1, Number(q.limit ?? 100) || 100))
    const all = await loadSnapshots()
    const slice = all.slice(-limit).reverse()
    return {
      path: feedbackStorePath(),
      count: all.length,
      items: slice
    }
  })

  /** Aggregate performance stats for the Performance page. */
  app.get('/api/feedback/performance', async () => {
    const all = await loadSnapshots()

    const overall = computeGroupStats('总计', all)

    // Group by strategy
    const byStrategy = new Map<string, RecommendationSnapshot[]>()
    for (const s of all) {
      const list = byStrategy.get(s.strategyId) ?? []
      list.push(s)
      byStrategy.set(s.strategyId, list)
    }
    const strategies = [...byStrategy.entries()]
      .map(([k, v]) => computeGroupStats(k, v))
      .sort((a, b) => b.total - a.total)

    // Group by regime
    const byRegime = new Map<string, RecommendationSnapshot[]>()
    for (const s of all) {
      const list = byRegime.get(s.regime) ?? []
      list.push(s)
      byRegime.set(s.regime, list)
    }
    const regimes = [...byRegime.entries()]
      .map(([k, v]) => computeGroupStats(k, v))
      .sort((a, b) => b.total - a.total)

    // Group by symbol
    const bySym = new Map<string, RecommendationSnapshot[]>()
    for (const s of all) {
      const list = bySym.get(s.sym) ?? []
      list.push(s)
      bySym.set(s.sym, list)
    }
    const symbols = [...bySym.entries()]
      .map(([k, v]) => computeGroupStats(k, v))
      .sort((a, b) => b.total - a.total)

    // Daily P&L curve
    const byDay = new Map<string, RecommendationSnapshot[]>()
    for (const s of all) {
      const list = byDay.get(s.etDay) ?? []
      list.push(s)
      byDay.set(s.etDay, list)
    }
    const dailyCurve = [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, rows]) => {
        const pnls = rows
          .filter(r => r.outcome != null)
          .map(r => bestPnl(r.outcome!))
          .filter((v): v is number => v != null)
        return {
          date: day,
          count: rows.length,
          pnl: pnls.reduce((a, b) => a + b, 0),
          wins: pnls.filter(p => p > 0).length,
          losses: pnls.filter(p => p <= 0).length
        }
      })

    // Recent individual snapshots for history table
    const recent = all
      .slice(-50)
      .reverse()
      .map(s => ({
        id: s.id,
        etDay: s.etDay,
        sym: s.sym,
        strategyId: s.strategyId,
        expiration: s.expiration,
        regime: s.regime,
        score: s.score,
        pop: s.pop,
        ev: s.ev,
        netPremium: s.netPremium,
        dte: s.dte,
        spot: s.spot,
        ivr: s.ivr,
        variant: s.variant ?? null,
        hasOutcome: s.outcome != null,
        pnl: s.outcome ? bestPnl(s.outcome) : null,
        pnlPathMin: s.outcome?.pnlPathMin != null ? s.outcome.pnlPathMin * 100 : null,
        pnlPathMax: s.outcome?.pnlPathMax != null ? s.outcome.pnlPathMax * 100 : null,
        stopHit: s.outcome?.stopHit ?? false,
        exitReason: s.outcome?.managedExitReason ?? null,
        exitDay: s.outcome?.managedExitDay ?? null
      }))

    // Tuner arm posteriors — risk-normalized reward score per
    // (strategy × regime × variant). score = posterior mean of Beta(1+α, 1+β);
    // only meaningful for RANKING arms within the same strategy×regime bucket.
    const tunerArms = [...buildArmStats(all).entries()]
      .map(([k, v]) => {
        const [strategy, regime, variant] = k.split('|')
        return {
          strategy,
          regime,
          variant,
          n: v.n,
          score: (1 + v.rewardMass) / (2 + v.rewardMass + v.failMass)
        }
      })
      .sort((a, b) =>
        a.strategy.localeCompare(b.strategy) ||
        a.regime.localeCompare(b.regime) ||
        a.variant.localeCompare(b.variant)
      )

    // Condor exit A/B scoreboard: realized P&L per exit-policy arm. Pre-
    // experiment snapshots (exitPolicy absent) count as 'managed'.
    const exitPolicyStats = (() => {
      const acc: Record<string, { n: number; totalPnl: number; wins: number }> = {}
      for (const s of all) {
        if (s.strategyId !== 'iron_condor' || !s.outcome) continue
        // Shadow arm rows share the day's exit policy across 3 arms — near-
        // duplicates that would triple-count; the A/B reads the surfaced book.
        if (s.source === 'shadow') continue
        const pnl = outcomePnl(s.outcome)
        if (pnl == null) continue
        const k = s.exitPolicy ?? 'managed'
        const a = acc[k] ?? (acc[k] = { n: 0, totalPnl: 0, wins: 0 })
        a.n++
        a.totalPnl += pnl
        if (pnl > 0) a.wins++
      }
      return Object.entries(acc).map(([policy, a]) => ({
        policy,
        n: a.n,
        avgPnl: a.totalPnl / a.n,
        winRate: a.wins / a.n
      }))
    })()

    return {
      totalSnapshots: all.length,
      withOutcome: all.filter(s => s.outcome != null).length,
      pendingOutcome: all.filter(s => s.outcome == null).length,
      overall,
      strategies,
      regimes,
      symbols,
      dailyCurve,
      recent,
      tunerArms,
      exitPolicyStats
    }
  })

  app.post('/api/feedback/recommendations/hydrate', async (req, reply) => {
    const body = (req.body ?? {}) as {
      stopLossFraction?: number
      maxUpdates?: number
      force?: boolean
    }
    const stopLossFraction = Math.min(1, Math.max(0.05, Number(body.stopLossFraction ?? 0.5) || 0.5))
    // Horizon is now strategy-aware; force recomputes existing outcomes (e.g. after a marking change).
    const maxUpdates = Math.min(2000, Math.max(1, Number(body.maxUpdates ?? 50) || 50))
    try {
      const r = await hydrateDueSnapshots({ stopLossFraction, maxUpdates, force: body.force === true })
      return { ok: true, updated: r.updated, pendingWithinHorizon: r.pendingWithinHorizon }
    } catch (e) {
      app.log.error(e)
      return reply.code(502).send({ error: (e as Error).message })
    }
  })

  app.post<{ Params: { id: string } }>('/api/feedback/recommendations/:id/hydrate', async (req, reply) => {
    const body = (req.body ?? {}) as { stopLossFraction?: number }
    const stopLossFraction = Math.min(1, Math.max(0.05, Number(body.stopLossFraction ?? 0.5) || 0.5))
    try {
      const row = await hydrateSnapshotById(req.params.id, { stopLossFraction })
      if (!row) return reply.code(404).send({ error: 'snapshot not found' })
      return { ok: true, item: row }
    } catch (e) {
      app.log.error(e)
      return reply.code(502).send({ error: (e as Error).message })
    }
  })
}
