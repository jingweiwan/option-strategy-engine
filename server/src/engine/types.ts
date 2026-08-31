export type MarketInput = {
  price: number
  iv: number
  ivRank: number
  daysToExpiration: number
  riskFreeRate?: number
  dividendYield?: number
  simulations?: number
  seed?: number
}

export type MarketState = {
  volatility: 'low' | 'mid' | 'high'
  expectedMove: number
}

export type StrategyType =
  | 'bull_call_spread'
  | 'bear_call_spread'
  | 'bull_put_spread'
  | 'bear_put_spread'
  | 'iron_condor'
  | 'short_strangle'
  | 'long_straddle'

export type OptionLeg = {
  type: 'call' | 'put'
  action: 'buy' | 'sell'
  strike: number
  premium: number
  quantity: number
  greeks: Greeks
  /** This strike's own implied vol from the chain. Used to MARK the leg during
   *  the managed-exit sim, so entry premiums (real, skewed) and marks come from
   *  the same vol surface. Absent → the caller's ATM sigma marks it. */
  iv?: number
}

export type Greeks = {
  delta: number
  gamma: number
  theta: number
  vega: number
}

export type RiskMetrics = {
  ev: number
  stdDev: number
  sharpe: number
  var95: number
  cvar95: number
  simMaxProfit: number
  simMaxLoss: number
  theoMaxProfit: number
  theoMaxLoss: number
  unboundedProfit: boolean
  unboundedLoss: boolean
  probabilityProfit: number
  breakevens: number[]
}

export type PayoffCurve = {
  xMin: number
  xMax: number
  points: [number, number][]
}

export type StrategyTier = 'primary' | 'reference'

/**
 * The same structure re-scored in the world where THE MARKET'S PRICE OF VOL IS
 * THE TRUTH, instead of the engine's RV-blended `simSigma`.
 *
 * `pop`/`ev` are directly comparable to `metrics.probabilityProfit` /
 * `metrics.ev`: same legs, same exit policy, same random draws (common random
 * numbers). What differs is the whole variance-risk-premium wager, on BOTH the
 * sides it enters — the paths diffuse at `marketSigma` instead of `simSigma`,
 * and the marks decay toward `marketSigma` instead of `simSigma`.
 *
 * So the published-vs-check gap is NOT "the same model with a wider diffusion",
 * and it is NOT attributable to RV-vs-IV alone. Two things move:
 *   • sigma level — `marketSigma` is `soldLegIv`, the vol at the SHORT strikes,
 *     so the gap against ATM-derived `simSigma` mixes skew with the RV blend;
 *   • mark decay — the published run harvests it; the check does not, and when
 *     the sold legs are richer than ATM `convergeTo` is a documented no-op so
 *     the legs simply hold entry IV across the window.
 *
 * Present only on CREDIT structures whose sold-leg IV is known and differs from
 * `simSigma` by at least MARKET_VOL_CHECK_MIN_GAP.
 *
 * This does not adjudicate which world is right — settled outcomes do that. It
 * exists so a card cannot show one POP as if it were free of that choice.
 */
export type MarketVolCheck = {
  /** Sigma the published POP/EV used, for both diffusion and mark decay:
   *  max(0.7·RV + 0.3·IV, 0.6·IV) — see deriveSimSigma. */
  simSigma: number
  /** Premium-weighted IV of the SOLD legs (soldLegIv) — the vol the market
   *  actually charges for what this structure shorts. At the short strikes, so
   *  it carries the chain's skew; not ATM iv. */
  marketSigma: number
  pop: number
  ev: number
}

export type StrategyResult = {
  strategy: StrategyType
  legs: OptionLeg[]
  netPremium: number
  netGreeks: Greeks
  metrics: RiskMetrics
  rationale: string
  payoffCurve: PayoffCurve
  tier?: StrategyTier
  /**
   * Historical-track-record multiplier applied to this strategy's score
   * (>1 boosted, <1 damped, 1 = neutral/insufficient data). Surfaced so the UI
   * can show when a pick was nudged by past outcomes.
   */
  calibration?: number
  /** POP/EV re-run at the market's sold-leg vol. See MarketVolCheck. */
  marketVolCheck?: MarketVolCheck | null
  /** 10-point pre-trade checklist (attached by the route, not the core engine). */
  checklist?: import('./preTradeChecklist.js').PreTradeChecklist
}
