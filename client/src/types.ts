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

export type Greeks = {
  delta: number
  gamma: number
  theta: number
  vega: number
}

export type OptionLeg = {
  type: 'call' | 'put'
  action: 'buy' | 'sell'
  strike: number
  premium: number
  quantity: number
  greeks: Greeks
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

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'na'
export type ChecklistItem = {
  id: string
  label: string
  status: CheckStatus
  detail: string
}
export type PreTradeChecklist = {
  sellerSide: boolean
  profitSource: string
  items: ChecklistItem[]
  passCount: number
  warnCount: number
  failCount: number
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
  /** Track-record multiplier on the score (>1 boosted, <1 damped, 1 = neutral). */
  calibration?: number
  /** 10-point pre-trade checklist. */
  checklist?: PreTradeChecklist
}

// ============ Live ============

export type View = 'bullish' | 'bearish' | 'neutral' | 'neutral-vol'
export type VolExpect = 'low' | 'mid' | 'high'
export type RiskPref = 'defined' | 'any'

export type LiveEngineInput = {
  symbol: string
  expiration: string
  ivRank?: number
  riskFreeRate?: number
  dividendYield?: number
  simulations?: number
  seed?: number
  view?: View
  volExpect?: VolExpect
  riskPref?: RiskPref
}

export type Regime = 'sell' | 'buy' | 'mid'

export type LiveMarketState = MarketState & {
  spot: number
  iv: number
  ivRank: number
  dte: number
  symbol: string
  expiration: string
  regime?: Regime
  /** Next earnings date (YYYY-MM-DD) falling before expiration, if any. */
  earningsDate?: string | null
  /** True when an earnings report lands before expiration (jump risk priced in). */
  earningsInWindow?: boolean
  ivRankSamples?: number | null
  ivRankSource?: 'manual' | 'computed' | 'fallback'
  currentRv?: number | null
  rvLow?: number | null
  rvHigh?: number | null
}

export type LiveEngineResponse = {
  state: LiveMarketState
  results: StrategyResult[]
  skipped: { strategy: StrategyType; reason: string }[]
}

export type Quote = {
  symbol: string
  last: number
  bid: number
  ask: number
}

// ============ Dashboard ============

export type Market = {
  asof: string
  /** SPY (S&P 500 ETF) — proxy for SPX. Price ≈ SPX/10. */
  spy: { v: number; chg: number }
  /** VIXY (VIX futures ETF) — proxy for VIX. Direction reliable, level distorted. */
  vixy: { v: number; chg: number }
  /** CNN Fear & Greed (0-100). null when feed unavailable. */
  fearGreed: number | null
  ivRankAvg: number | null
  earningsToday: number
  /** Watchlist earnings within the entry-span window (≤45d), soonest first. */
  earningsCalendar: EarningsCalendarEntry[]
  fedDays: number
}

/** One upcoming earnings date for a watchlist symbol. `spansEntry` = a position
 *  opened today at the max scan DTE would straddle it (event risk). */
export type EarningsCalendarEntry = {
  sym: string
  date: string
  label: string
  daysUntil: number
  spansEntry: boolean
}

export type MoodFactor = {
  tone: 'gain' | 'accent' | 'ink'
  label: string
  detail: string
}

export type Mood = {
  /** 0-100 score. null when CNN feed unavailable. */
  index: number | null
  label: string
  pulse: number[]
  factors: MoodFactor[]
}

export type EngineView = {
  prose: string
  buckets: { label: string; value: number; hint: string }[]
}

export type OppTag = '财报' | '高 IV' | '事件'

export type OppLeg = {
  type: 'call' | 'put'
  action: 'buy' | 'sell'
  strike: number
  premium: number
}

export type OppManagement = {
  /** null = runner arm (no take-profit, ride to expiry). */
  profitTarget: number | null
  stopLoss: number
  /** null = runner arm (no early roll). */
  rollDte: number | null
  note: string
}

export type Opp = {
  sym: string
  thesis: string
  strategy: string
  strategyId: StrategyType
  expiration: string
  edge: string
  pop: number
  ev: number
  ivr: number
  dte: number
  spot: number
  netPremium: number
  maxProfit: number | null
  maxLoss: number | null
  breakevens: number[]
  legs: OppLeg[]
  why: string
  /** AI analyst deep-dive reasoning */
  analysis: string
  tag: OppTag
  /** Suggested profit-target / stop-loss / roll rules. */
  management: OppManagement
  /** 买方 regime:引擎无卖方 edge,低信心 */
  lowConviction?: boolean
  /** AI directional view that guided strategy selection */
  aiView?: View | null
  aiViewReason?: string | null
  /** 自动板分级:'qualified' 达标推荐,'reference' 未达标参考位(不建议开仓) */
  boardTier?: 'qualified' | 'reference'
  /** 每条短腿离最近关键位的距离(定行权位用) */
  shortLevels?: ShortLevel[]
  /** 标的处于强单边趋势 — 铁鹰易被碾(警示) */
  strongTrend?: boolean
}

export type ShortLevel = {
  strike: number
  type: 'call' | 'put'
  level: number
  /** 短腿到关键位的带符号 %:+在上方 / −在下方 */
  distPct: number
  touches: number
  /** 短腿正压在一个被反复测试的关键位上(争夺/被钉风险) */
  tested: boolean
}

export type Ticker = {
  sym: string
  name: string
  /** Live last price; null if MarketData quote was unavailable for this ticker. */
  px: number | null
  /** Live percent change vs previous close; null if unavailable. */
  chg: number | null
  /** ATM implied volatility (annualized, 0-1); null when chain unavailable. */
  iv: number | null
  /** IV Rank (0-100 percentile); null when unavailable. */
  ivr: number | null
  /** IVR data source: 'iv-history' (true IVR) or 'rv-fallback'. */
  ivrSource: 'iv-history' | 'rv-fallback' | null
  /** Expected move ±$ (ATM straddle mid); null when unavailable. */
  em: number | null
  earn: string
  note: string
}

export type BookRisk = {
  positions: number
  netDelta: number
  netGamma: number
  netVega: number
  netTheta: number
  aggMaxLossUsd: number
  netThetaUsd: number
  undefinedRiskCount: number
  shortVolCount: number
  /** 账户规模(RH 桥文件优先,env 兜底);未配置为 null */
  accountSize?: number | null
  accountSource?: 'rh' | 'env' | null
  /** RH 持仓数据年龄(小时);无桥文件为 null */
  rhAgeHours?: number | null
  /** 同时打满占账户 %;未配置为 null */
  maxLossPctOfAccount?: number | null
  /** 板上标的 60 天平均两两相关;数据不足为 null */
  avgPairwiseCorrelation?: number | null
  flags: string[]
}

export type RealBook = {
  fetchedAt: string
  ageHours: number | null
  accountSize: number | null
  optionLegCount: number
  equityCount: number
  symbols: string[]
  netDelta: number
  netGamma: number
  netVega: number
  netTheta: number
  matchedLegs: number
  unmatchedLegs: number
}

export type RhLegView = {
  sym: string
  side: 'long' | 'short'
  qty: number
  avgCost: number
  expiration: string
  strike: number
  optionType: 'call' | 'put'
  openedAt?: string
  mark: number | null
  unrealized: number | null
}

export type RhEquityView = {
  sym: string
  qty: number
  avgCost: number
  last: number | null
  unrealized: number | null
}

export type RhStructureAlert = { level: 'warn' | 'good' | 'info'; text: string }

export type RhStructure = {
  sym: string
  expiration: string
  dte: number
  kind: 'iron_condor' | 'put_spread' | 'call_spread' | 'short_put' | 'short_call' | 'long_combo' | 'other'
  label: string
  legs: RhLegView[]
  netCost: number
  credit: boolean
  unrealized: number | null
  alerts: RhStructureAlert[]
}

export type RhPositionsView = {
  fetchedAt: string
  ageHours: number | null
  account: { totalValue: number; equityValue?: number; optionsValue?: number; cryptoValue?: number; cash?: number }
  optionLegs: RhLegView[]
  structures: RhStructure[]
  optionsUnrealized: number
  optionsMarked: number
  equities: RhEquityView[]
  equityUnrealized: number
  equityQuoted: number
  realized: { totalAll: number; rateAll: number; last3m: number; asOf: string } | null
}

export type RhStrategyClass = {
  id: string
  name: string
  monthly: Record<string, number>
  total: number
  orders: number
}

export type RhStrategyPnl = {
  schema: string
  generatedAt: string
  windowFrom: string
  windowTo: string
  months: string[]
  classes: RhStrategyClass[]
  wheelStockLegs: { sym: string; pnl: number; closedAt: string }[]
  wheelStockTotal: number
  wheelTrueTotal: number
  concentration: { topSym: string; topPnl: number; shareOfWheelTrue: number }
  notes: string[]
}

export type DashboardData = {
  market: Market
  mood: Mood
  engine: EngineView
  opps: Opp[]
  tickers: Ticker[]
  bookRisk?: BookRisk
  realBook?: RealBook | null
  /** ISO timestamp when this snapshot was built (server wall clock). */
  fetchedAt: string
}

// ============ AI narrative ============

export type AiFactor = {
  tone: 'gain' | 'accent' | 'ink'
  label: string
  detail: string
}

export type DashboardNarrative = {
  heroLine1: string // may include <em>...</em>
  heroLine2: string
  deck: string
  enginePose: string
  factors: AiFactor[]
}

// ============ Sell Put Scanner ============

export type SellPutScoreBreakdown = {
  ivRankScore: number
  ivRvScore: number
  popScore: number
  rocScore: number
  liquidityScore: number
  dteScore: number
}

export type SellPutCandidate = {
  sym: string
  name: string
  spot: number
  strike: number
  optionSymbol: string
  expiration: string
  dte: number
  premium: number
  delta: number
  iv: number
  atmIv: number
  ivr: number
  rv: number | null
  ivRvGap: number | null
  regime: string
  greeks: Greeks
  buyingPower: number
  roc: number
  rocAnnualized: number
  breakeven: number
  otmPct: number
  pop: number
  ev: number
  simMaxLoss: number
  bidAskSpread: number
  openInterest: number
  score: number
  scoreBreakdown: SellPutScoreBreakdown
}

// ============ Wheel (轮子) ============

export type FundamentalVerdict = {
  pass: boolean
  score: number
  notes: string[]
  kind: 'company' | 'etf'
}

export type WheelCspCandidate = SellPutCandidate & {
  fundamentals: FundamentalVerdict
  assignmentCost: number
  cashOk: boolean | null
  discountPct: number
  heldQty: number
  concentrated: boolean
  nextEarnings: string | null
  wheelScore: number
}

export type CoveredCallSuggestion = {
  sym: string
  heldQty: number
  contractsAvailable: number
  costBasis: number
  spot: number
  expiration: string
  dte: number
  strike: number
  premium: number
  delta: number | null
  yieldAnnualized: number
  ifCalledReturnPct: number
  underwater: boolean
  nextEarnings: string | null
  spansEarnings: boolean
  note: string
}

export type WheelScanResult = {
  asof: string
  csp: WheelCspCandidate[]
  coveredCalls: CoveredCallSuggestion[]
  skipped: { sym: string; reason: string }[]
  cash: number | null
}

// ============ Intel / AI Scan ============

export type IntelItem = {
  sym: string
  category: 'news' | 'filing' | 'rating' | 'earnings'
  headline: string
  source: string
  time: string
  tldr: string
  thesisImpact: 'positive' | 'negative' | 'neutral' | 'monitor'
  relevance: string
  unread: boolean
}

export type CrossLink = {
  from: string
  to: string
  title: string
  strength: 'High' | 'Medium' | 'Low'
  body: string
}

export type DailyIntelBrief = {
  date: string
  scannedDocs: number
  scannedFilings: number
  topItems: IntelItem[]
  crossLinks: CrossLink[]
  generatedAt: string
}

// ============ OCIFQ Deep Analysis ============

export type OcifqScore = {
  O: number
  C: number
  I: number
  F: number
  Q: number
  total: number
}

export type OcifqDimension = {
  key: 'O' | 'C' | 'I' | 'F' | 'Q'
  label: string
  score: number
  maxScore: number
  reasoning: string
  evidence: string[]
  signal: 'bullish' | 'bearish' | 'neutral'
}

export type ThesisItem = {
  id: number
  text: string
  status: 'validated' | 'challenged' | 'no_change'
  delta: string
  date: string
  /** Concrete, measurable condition that would falsify this thesis. */
  invalidation?: string
}

export type ToneWord = {
  word: string
  count: number
}

export type CallTone = {
  available: boolean
  quarter?: string
  confidenceScore?: number
  hedgeWordCount?: number
  confidenceWordCount?: number
  confidenceWords?: ToneWord[]
  hedgeWords?: ToneWord[]
  guidanceTone?: 'raise' | 'maintain' | 'lower' | 'none'
  toneShift?: 'improving' | 'stable' | 'deteriorating' | 'unknown'
  keyQuotes?: string[]
  confidenceQuotes?: string[]
  hedgeQuotes?: string[]
  summary?: string
}

export type DeepAnalysis = {
  symbol: string
  name: string
  industry: string
  marketCap: number
  peers: string[]
  scores: OcifqScore
  dimensions: OcifqDimension[]
  thesisItems: ThesisItem[]
  callTone?: CallTone
  summary: string
  optionImplication: string
  view: 'bullish' | 'bearish' | 'neutral'
  viewConfidence: number
  dataStats: {
    newsCount: number
    earningsQuarters: number
    peersCount: number
    hasFinancials: boolean
    fmpIncomeQuarters?: number
    fmpCashFlowQuarters?: number
    transcriptQuarters?: number
  }
  generatedAt: string
}

// ============ Ticker page ============

export type ContractGreeks = {
  delta: number
  gamma: number
  theta: number
  vega: number
}

export type OptionContract = {
  symbol: string
  strike: number
  optionType: 'call' | 'put'
  bid: number
  ask: number
  mid: number
  last: number
  openInterest: number
  volume: number
  expiration: string
  iv?: number
  greeks?: ContractGreeks
}

export type TickerResponse = {
  quote: { symbol: string; last: number; bid: number; ask: number }
  expirations: string[]
  expiration: string
  chain: OptionContract[]
}

// ============ Performance / Feedback ============

export type GroupStats = {
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

export type DailyCurvePoint = {
  date: string
  count: number
  pnl: number
  wins: number
  losses: number
}

export type RecentSnapshot = {
  id: string
  etDay: string
  sym: string
  strategyId: StrategyType
  expiration: string
  regime: string
  score: number
  pop: number
  ev: number
  netPremium: number
  dte: number
  spot: number
  ivr: number
  /** Tuner variant id (e.g. "sd0.25"); null = static spec defaults. */
  variant?: string | null
  hasOutcome: boolean
  pnl: number | null
  pnlPathMin: number | null
  pnlPathMax: number | null
  stopHit: boolean
  exitReason: 'take_profit' | 'stop_loss' | 'expiry' | 'end_of_window' | null
  exitDay: string | null
}

export type TunerArm = {
  strategy: string
  regime: string
  variant: string
  n: number
  /** Posterior mean of risk-normalized reward — for ranking arms within a bucket. */
  score: number
}

export type PerformanceData = {
  totalSnapshots: number
  withOutcome: number
  pendingOutcome: number
  overall: GroupStats
  strategies: GroupStats[]
  regimes: GroupStats[]
  symbols: GroupStats[]
  dailyCurve: DailyCurvePoint[]
  recent: RecentSnapshot[]
  tunerArms?: TunerArm[]
}
