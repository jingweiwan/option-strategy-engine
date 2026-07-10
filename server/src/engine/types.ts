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
  /** 10-point pre-trade checklist (attached by the route, not the core engine). */
  checklist?: import('./preTradeChecklist.js').PreTradeChecklist
}
