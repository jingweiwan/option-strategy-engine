import type { FastifyInstance } from 'fastify'
import type { StrategyType } from '../engine/types.js'
import type { ExitPolicy } from '../engine/managedExit.js'
import { runEngineLive } from '../engine/index.js'
import { specOverridesFromVariants } from '../feedback/tuner.js'
import { getQuote, getOptionChain, computeIvRank } from '../api/marketdata.js'
import { fetchEarningsCalendar } from '../api/finnhub.js'
import { impliedVolFromChain } from '../engine/liveStrategies.js'
import { getAiStrategyRationales, type RationaleInput } from '../ai/strategyRationale.js'
import { loadCalibrationTable, calibrationMultiplier } from '../feedback/calibration.js'
import { buildPreTradeChecklist } from '../engine/preTradeChecklist.js'

/** Next earnings date for `symbol` within (today, expiration], or null. */
async function nextEarningsBeforeExpiry(
  symbol: string,
  expiration: string
): Promise<string | null> {
  const today = new Date().toISOString().slice(0, 10)
  const calendar = await fetchEarningsCalendar(today, expiration)
  const dates = calendar
    .filter((e) => e.symbol === symbol && e.date > today && e.date <= expiration)
    .map((e) => e.date)
    .sort()
  return dates[0] ?? null
}

type Body = {
  symbol: string
  expiration: string
  ivRank?: number
  riskFreeRate?: number
  dividendYield?: number
  simulations?: number
  seed?: number
  view?: 'bullish' | 'bearish' | 'neutral' | 'neutral-vol'
  volExpect?: 'low' | 'mid' | 'high'
  riskPref?: 'defined' | 'any'
  /** Tuner variants the scanner froze onto the card, so the detail re-run
   *  reproduces the SAME structure the card showed (e.g. { iron_condor: 'sd0.24' }). */
  variants?: Partial<Record<StrategyType, string>>
  exitPolicies?: Partial<Record<StrategyType, ExitPolicy>>
}

export async function strategiesLiveRoutes(app: FastifyInstance) {
  app.post<{ Body: Body }>('/api/strategies/live', async (req, reply) => {
    const b = req.body
    if (!b?.symbol || !b?.expiration) {
      return reply.code(400).send({ error: 'symbol and expiration are required' })
    }

    const symbol = b.symbol.toUpperCase()

    // Validate expiration format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.expiration)) {
      return reply.code(400).send({ error: 'expiration must be YYYY-MM-DD' })
    }

    // Cap simulations to prevent CPU exhaustion
    const simulations = b.simulations != null ? Math.min(Math.max(b.simulations, 100), 50_000) : undefined

    try {
      const [quote, chain, earningsDate, calibration] = await Promise.all([
        getQuote(symbol),
        getOptionChain(symbol, b.expiration),
        nextEarningsBeforeExpiry(symbol, b.expiration).catch((err) => {
          app.log.warn(`earnings lookup failed for ${symbol}: ${err?.message}`)
          return null
        }),
        loadCalibrationTable().catch((err) => {
          app.log.warn(`calibration load failed: ${err?.message}`)
          return null
        })
      ])

      if (!quote.last || !Number.isFinite(quote.last)) {
        return reply.code(502).send({ error: `No spot price for ${symbol}` })
      }
      if (chain.length === 0) {
        return reply.code(502).send({ error: `Empty chain for ${symbol} ${b.expiration}` })
      }

      // Compute IV Rank: prefers accumulated IV history (true IVR), falls
      // back to RV-percentile when <30 days of IV data are available.
      // If client passed an explicit ivRank, that overrides.
      let ivRankInfo: Awaited<ReturnType<typeof computeIvRank>> = null
      if (b.ivRank == null) {
        const currentAtmIv = impliedVolFromChain(chain, quote.last)
        ivRankInfo = await computeIvRank(symbol, currentAtmIv ?? undefined).catch((err) => {
          app.log.warn(`computeIvRank failed for ${symbol}: ${err?.message}`)
          return null
        })
      }

      const result = runEngineLive({
        symbol,
        spot: quote.last,
        expiration: b.expiration,
        chain,
        ivRank: b.ivRank ?? ivRankInfo?.rank,
        currentRv: ivRankInfo?.currentRv ?? undefined,
        riskFreeRate: b.riskFreeRate,
        dividendYield: b.dividendYield,
        simulations,
        seed: b.seed,
        view: b.view,
        volExpect: b.volExpect,
        riskPref: b.riskPref,
        // Replay the scanner's frozen tuner variant + exit policy so the detail
        // page's legs/POP/EV match the card instead of the static default spec.
        specOverrides: b.variants ? specOverridesFromVariants(b.variants) : undefined,
        exitPolicies: b.exitPolicies,
        earningsDate: earningsDate ?? undefined,
        calibrate: calibration
          ? (s, regime) => calibrationMultiplier(calibration, s, regime)
          : undefined
      })

      // Phase B: AI-generated rationales (non-blocking — falls back to engine defaults)
      try {
        const rationaleInput: RationaleInput = {
          symbol,
          spot: quote.last,
          iv: result.state.iv,
          ivRank: result.state.ivRank,
          dte: result.state.dte,
          regime: result.state.regime,
          expectedMove: result.state.expectedMove,
          currentRv: ivRankInfo?.currentRv ?? null,
          aiView: b.view ?? null,
          strategies: result.results.map((r) => ({
            strategy: r.strategy,
            netPremium: r.netPremium,
            pop: r.metrics.probabilityProfit,
            ev: r.metrics.ev,
            maxProfit: r.metrics.unboundedProfit ? null : r.metrics.theoMaxProfit,
            maxLoss: r.metrics.unboundedLoss ? null : r.metrics.theoMaxLoss,
            delta: r.netGreeks.delta,
            theta: r.netGreeks.theta,
            legs: r.legs.map((l) => ({
              type: l.type, action: l.action,
              strike: l.strike, premium: l.premium
            }))
          }))
        }
        const aiRationales = await getAiStrategyRationales(rationaleInput, b.expiration)
        for (const r of result.results) {
          if (aiRationales[r.strategy]) {
            r.rationale = aiRationales[r.strategy]
          }
        }
      } catch (err) {
        app.log.warn(`[strategy] AI rationale unavailable: ${(err as Error).message}`)
        // Keep engine's default rationales
      }

      // Pre-trade checklist per strategy (10-point "filter bad trades" review)
      for (const r of result.results) {
        r.checklist = buildPreTradeChecklist({
          strategy: r.strategy,
          legs: r.legs,
          netPremium: r.netPremium,
          metrics: r.metrics,
          iv: result.state.iv,
          ivRank: result.state.ivRank,
          currentRv: ivRankInfo?.currentRv ?? null,
          dte: result.state.dte,
          regime: result.state.regime,
          earningsDate: earningsDate ?? null,
          earningsInWindow: earningsDate != null
        })
      }

      // Surface IV Rank source/quality + RV stats back to client
      return {
        ...result,
        state: {
          ...result.state,
          ivRank: result.state.ivRank ?? null,
          earningsDate: earningsDate ?? null,
          earningsInWindow: earningsDate != null,
          ivRankSamples: ivRankInfo?.samples ?? null,
          ivRankSource: b.ivRank != null ? 'manual' : ivRankInfo?.source ?? 'fallback',
          currentIv: ivRankInfo?.currentIv ?? null,
          ivLow: ivRankInfo?.ivLow ?? null,
          ivHigh: ivRankInfo?.ivHigh ?? null,
          currentRv: ivRankInfo?.currentRv ?? null,
          rvLow: ivRankInfo?.rvLow ?? null,
          rvHigh: ivRankInfo?.rvHigh ?? null
        }
      }
    } catch (e: any) {
      app.log.error(e)
      return reply.code(502).send({ error: e?.message ?? 'request failed' })
    }
  })
}
