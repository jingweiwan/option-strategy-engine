import { simulatePaths } from './simulator.js'
import { evaluateStrategyManaged } from './scorer.js'
import { managedHoldDays, type ExitPolicy } from './managedExit.js'
import { scaleByViewSkill, viewWeight } from '../feedback/viewSkill.js'
import { netPremium, netGreeks, totalPnL } from './payoff.js'
import {
  STRATEGY_SPECS,
  legsFromSpec,
  impliedVolFromChain,
  dteFromExpiration,
  enrichWithGreeks,
  skewFromChain,
  type LegSpec
} from './liveStrategies.js'
import type { OptionContract } from '../api/types.js'
import type {
  StrategyResult,
  MarketState,
  OptionLeg,
  PayoffCurve,
  StrategyType
} from './types.js'

function buildPayoffCurve(
  legs: OptionLeg[],
  spot: number,
  expectedMove: number,
  steps = 200
): PayoffCurve {
  const strikes = legs.map((l) => l.strike)
  const em = Math.max(expectedMove, spot * 0.05)
  const minStrike = Math.min(...strikes)
  const maxStrike = Math.max(...strikes)
  const xMin = Math.min(minStrike, spot - em * 1.5) - em * 0.5
  const xMax = Math.max(maxStrike, spot + em * 1.5) + em * 0.5
  const dx = (xMax - xMin) / steps
  const points: [number, number][] = []
  for (let i = 0; i <= steps; i++) {
    const price = xMin + dx * i
    points.push([price, totalPnL(legs, price)])
  }
  return { xMin, xMax, points }
}

const RATIONALES: Record<string, (s: MarketState) => string> = {
  bull_call_spread: () => '看涨债务价差: 限定下行风险, 适合温和上涨与中低 IV',
  bear_call_spread: () => '看跌信用价差: 收 credit, 高 IV 卖 call 方向性看跌, 风险限定',
  bull_put_spread: () => '看涨信用价差: 收 credit, 高 IV 卖 put 方向性看涨, 风险限定',
  bear_put_spread: () => '看跌债务价差: 限定下行风险, 适合温和下跌',
  iron_condor: () => '铁鹰: 高 IV 卖波动率, 横盘获利, 两侧风险有保护',
  short_strangle: () => '裸卖宽跨: 高 IV 收 premium, 但尾部裸露, 需保证金',
  long_straddle: () => '买跨: 低 IV 买波动率, 等待大波动 (财报/事件)'
}

export function scoreStrategy(r: StrategyResult, spot?: number): number {
  const m = r.metrics
  const tailPenalty = m.unboundedLoss ? 0.5 : 1

  if (spot != null && spot > 0) {
    // Normalize to percentage returns so scores are comparable across
    // $20 and $500 stocks. EV% / CVaR% is dimensionless.
    const evPct = m.ev / spot
    const cvarPct = Math.abs(m.cvar95) / spot
    const floor = 0.005 // 0.5% minimum CVaR to avoid division instability
    return (evPct / Math.max(cvarPct, floor)) * tailPenalty
  }

  // Fallback when spot unknown (e.g. static analysis) — original formula
  const cvarFloor = Math.max(Math.abs(m.cvar95), 0.5)
  return (m.ev / cvarFloor) * tailPenalty
}

export type View = 'bullish' | 'bearish' | 'neutral' | 'neutral-vol'
export type VolExpect = 'low' | 'mid' | 'high'
export type RiskPref = 'defined' | 'any'

export type LiveEngineInput = {
  symbol: string
  spot: number
  expiration: string // YYYY-MM-DD
  chain: OptionContract[]
  ivRank?: number
  currentRv?: number
  riskFreeRate?: number
  dividendYield?: number
  simulations?: number
  seed?: number
  /** Next earnings date (YYYY-MM-DD) — triggers a discrete vol jump when it falls within DTE. */
  earningsDate?: string
  // user view inputs (Recommend page)
  view?: View
  volExpect?: VolExpect
  riskPref?: RiskPref
  /**
   * Historical-track-record multiplier per (strategy × regime). Injected by the
   * route from the feedback calibration table so manual recommendations respect
   * what has actually paid off — not just the hardcoded regime/view constants.
   */
  calibrate?: (strategy: StrategyType, regime: Regime) => number
  /**
   * Per-strategy leg-spec overrides (the online tuner's chosen variant).
   * Strategies without an override build from the static STRATEGY_SPECS.
   */
  specOverrides?: Partial<Record<StrategyType, LegSpec[]>>
  /**
   * Per-strategy exit-policy overrides (the condor exit A/B). Displayed POP/EV
   * are computed under the SAME policy the snapshot records — display =
   * learning = realized holds across the experiment.
   */
  exitPolicies?: Partial<Record<StrategyType, ExitPolicy>>
}

export type Regime = 'sell' | 'buy' | 'mid'

// Debit spreads whose realized P&L is a pure directional bet (audited corr ≈
// ±0.8 with the underlying's move — bear_put +5.8/trade when the stock fell,
// −3.3 when it rose). Two consequences: the auto-scanner only surfaces these
// when an aligned view has earned skill weight (the engine has no standalone
// directional edge), and calibration ignores them (their track record measures
// the sample's market direction, not strategy skill, and is anti-persistent).
export const DIRECTIONAL_DEBIT_SPREADS: ReadonlySet<StrategyType> = new Set<StrategyType>([
  'bull_call_spread',
  'bear_put_spread'
])

// Which views each strategy aligns with
const STRATEGY_VIEW: Record<StrategyType, View[]> = {
  bull_call_spread: ['bullish'],
  bear_call_spread: ['bearish'],
  bull_put_spread: ['bullish'],
  bear_put_spread: ['bearish'],
  iron_condor: ['neutral'],
  short_strangle: ['neutral'],
  long_straddle: ['neutral-vol']
}

// Which IV regimes each strategy prefers
const STRATEGY_IV_PREF: Record<StrategyType, VolExpect[]> = {
  bull_call_spread: ['low', 'mid'],
  bear_call_spread: ['high', 'mid'],
  bull_put_spread: ['high', 'mid'],
  bear_put_spread: ['low', 'mid'],
  iron_condor: ['high'],
  short_strangle: ['high'],
  long_straddle: ['low']
}

// The view's tilt is gated by its EARNED skill weight (see feedback/viewSkill):
// currently 0 for both directional views (bullish anti-predictive, bearish
// regime-confounded), so `scaleByViewSkill` collapses their multiplier to 1
// (no effect). neutral / neutral-vol keep full weight. The dial turns back up
// on its own once the P1 scorecard proves cross-regime skill.
function viewBonus(s: StrategyType, view?: View): number {
  if (!view) return 1
  const designed = STRATEGY_VIEW[s]?.includes(view) ? 1.6 : 0.5
  return scaleByViewSkill(designed, view)
}

function volBonus(s: StrategyType, vol?: VolExpect): number {
  if (!vol) return 1
  return STRATEGY_IV_PREF[s]?.includes(vol) ? 1.2 : 0.85
}

function riskFilter(s: StrategyResult, pref?: RiskPref): number {
  if (pref !== 'defined') return 1
  return s.metrics.unboundedLoss ? 0.2 : 1
}

export type LiveEngineResult = {
  state: MarketState & {
    spot: number
    iv: number
    ivRank: number
    dte: number
    symbol: string
    expiration: string
    regime: Regime
    /** Return skewness fed to the simulator (negative = fat left tail). */
    returnSkew: number
  }
  results: StrategyResult[]
  skipped: { strategy: StrategyType; reason: string }[]
}

/**
 * Decide regime from IV-RV gap (primary) + IV Rank (fallback).
 *
 * The IV-RV gap is the most direct measure of premium mispricing:
 *   IV > RV → options overpriced → sell premium
 *   IV < RV → options underpriced → buy premium
 *
 * IVR (rank/percentile) tells us if vol is historically elevated but
 * does NOT say whether options are cheap or rich vs actual movement.
 * We only fall back to IVR when RV data is unavailable.
 */
export function deriveRegime(ivRank: number, currentIv: number, currentRv?: number): Regime {
  if (currentRv != null && currentRv > 0) {
    const gap = currentIv - currentRv // positive = IV rich = sell-edge
    // Use relative threshold (15% of RV) so the detector is equally sensitive
    // for low-vol stocks (IV 10%, RV 7% → 43% gap) and high-vol stocks
    // (IV 60%, RV 57% → 5% gap). Minimum 2pp absolute to avoid noise.
    const threshold = Math.max(currentRv * 0.15, 0.02)

    if (gap > threshold) {
      // IV > RV → sell-edge, BUT if IVR is historically low (<30),
      // the "richness" may be structural (e.g. meme stock always has IV > RV).
      // Downgrade to 'mid' to avoid selling cheap premium.
      if (ivRank < 30) return 'mid'
      return 'sell'
    }
    if (gap < -threshold) {
      // RV > IV → buy-edge, BUT if IVR is historically high (>70),
      // vol is already expensive by rank — buying more is risky.
      // Downgrade to 'mid'.
      if (ivRank > 70) return 'mid'
      return 'buy'
    }
    return 'mid'
  }
  // Fallback: no RV data, use IVR percentile
  if (ivRank >= 70) return 'sell'
  if (ivRank <= 30) return 'buy'
  return 'mid'
}

const SELLER_STRATEGIES: StrategyType[] = ['iron_condor', 'short_strangle', 'bear_call_spread', 'bull_put_spread']
const BUYER_STRATEGIES: StrategyType[] = [
  'long_straddle',
  'bull_call_spread',
  'bear_put_spread'
]

function tierFor(
  regime: Regime,
  strategy: StrategyType,
  rankByScore: number
): 'primary' | 'reference' {
  if (regime === 'sell') {
    return SELLER_STRATEGIES.includes(strategy) ? 'primary' : 'reference'
  }
  if (regime === 'buy') {
    return BUYER_STRATEGIES.includes(strategy) ? 'primary' : 'reference'
  }
  // mid: top 3 by score are primary
  return rankByScore < 3 ? 'primary' : 'reference'
}

/**
 * Derive simulation sigma from IV and realized vol.
 *
 * When RV is available, blend toward RV so simulated paths reflect actual
 * expected movement rather than the inflated IV. This lets sell strategies
 * benefit from the IV-RV gap (the whole premise of "sell high IV").
 *
 * Blend: 70% RV + 30% IV — keeps paths grounded in realized movement
 * while retaining some IV-driven tail risk.
 * Floor at 60% of IV to avoid unrealistically tight paths.
 */
export function deriveSimSigma(iv: number, currentRv?: number): number {
  if (currentRv == null || currentRv <= 0) return iv
  const blended = 0.7 * currentRv + 0.3 * iv
  // Floor: never simulate tighter than 60% of IV
  return Math.max(blended, iv * 0.6)
}

/**
 * Market-implied one-time earnings jump (log-return std), read straight from the
 * option prices instead of an arbitrary multiplier.
 *
 * The chain's IV prices total variance to expiry (iv²·T); the RV-based diffusion
 * (simSigma) explains the calm-day part; the EXCESS is what the market
 * attributes to the event:  j = sqrt(max(0, iv² − simSigma²) · T).
 * A sleepy name (iv≈rv) gets ~0; a rich event premium (iv≫rv) gets a big jump.
 * By construction diffusion + jump variance = iv²·T, so the sim's total variance
 * equals the market's — no double-count, no hardcoded 2.5×.
 */
export function marketImpliedJump(iv: number, simSigma: number, T: number): number {
  return Math.sqrt(Math.max(0, iv * iv - simSigma * simSigma) * Math.max(0, T))
}

/**
 * Earnings jump size when an earnings date falls on/before expiration, else 0.
 * (The live engine gates on the shorter MANAGED window and computes the step;
 * this wider [today, expiration] gate is the standalone helper.)
 */
export function earningsJumpSigma(
  iv: number,
  simSigma: number,
  expiration: string,
  earningsDate?: string,
  today = new Date()
): number {
  if (!earningsDate) return 0
  const earn = new Date(earningsDate + 'T16:00:00-04:00').getTime()
  const exp = new Date(expiration + 'T16:00:00-04:00').getTime()
  const now = today.getTime()
  if (!Number.isFinite(earn)) return 0
  // Event must be in the future and on/before expiration to affect the position.
  if (earn < now || earn > exp) return 0
  const T = Math.max(0, (exp - now) / (365 * 86_400_000))
  return marketImpliedJump(iv, simSigma, T)
}

export function runEngineLive(input: LiveEngineInput): LiveEngineResult {
  const iv = impliedVolFromChain(input.chain, input.spot)
  if (iv == null || iv <= 0) {
    throw new Error('Cannot derive IV from chain — chain may be illiquid or missing IV')
  }
  if (iv > 5.0) {
    throw new Error(`IV ${(iv * 100).toFixed(0)}% is unreasonably high — data may be garbage`)
  }
  const dte = dteFromExpiration(input.expiration)
  const ivRank = input.ivRank ?? 50

  const r = input.riskFreeRate ?? 0.045
  const q = input.dividendYield ?? 0
  const T = dte / 365
  const sims = input.simulations ?? 5000

  const expectedMoveVal = input.spot * iv * Math.sqrt(T)
  const volatility: MarketState['volatility'] =
    ivRank > 70 ? 'high' : ivRank < 30 ? 'low' : 'mid'
  const baseState: MarketState = { volatility, expectedMove: expectedMoveVal }

  const enrichedChain = enrichWithGreeks(input.chain, { spot: input.spot, T, r, q })

  // Simulation sigma: use realized vol when available to capture IV-RV gap.
  // Options are priced at IV (embedded in leg premiums), but actual price
  // paths should reflect expected realized movement. When IV >> RV (sell
  // regime), using RV-based sigma means sold options get breached less often
  // → sell strategies show positive EV from the premium edge.
  const simSigma = deriveSimSigma(iv, input.currentRv)
  // Surfaced for transparency. (Terminal-tail skew + earnings jump are modeled
  // in simulatePrices but not yet folded into the managed-exit path sim below —
  // managed exit usually triggers before the terminal tail matters.)
  const returnSkew = skewFromChain(enrichedChain, input.spot, iv)

  // Strategy-aware management window: how many trading days forward each
  // structure is actively managed before marking. Premium sellers resolve on
  // theta within days; long-vol needs room for the move/event.
  const policyFor = (strategy: StrategyType): ExitPolicy => input.exitPolicies?.[strategy] ?? 'managed'
  const managedHorizon = (strategy: StrategyType): number =>
    managedHoldDays(strategy, dte, policyFor(strategy))
  const maxHorizon = Math.max(...STRATEGY_SPECS.map((s) => managedHorizon(s.type)))

  // Earnings jump: if an earnings date lands inside the hold window, shock that
  // day. Each strategy walks only its own prefix, so a credit spread that closes
  // at 21 DTE naturally dodges late-cycle earnings while a straddle held to
  // expiry wears it — no per-strategy plumbing needed. The jump is market-
  // implied (iv vs the ex-event diffusion simSigma), not a hardcoded multiple.
  let earningsStep = -1
  let earningsJump = 0
  if (input.earningsDate) {
    const dE = Math.round(
      (new Date(input.earningsDate + 'T16:00:00-04:00').getTime() - Date.now()) / 86_400_000
    )
    if (dE >= 1 && dE <= maxHorizon) {
      earningsStep = dE - 1
      earningsJump = marketImpliedJump(iv, simSigma, T)
    }
  }

  // IV crush: after the report the event premium evaporates, so options past the
  // earnings step are MARKED at the crushed vol (the ex-event diffusion vol) not
  // the elevated pre-earnings IV. This is the sell-side reward the sim was
  // missing — a short that survived the gap collects the collapse; a long
  // straddle held through earnings eats it. crushIv = min(simSigma, iv) so a
  // no-gap name (iv≤simSigma) is a no-op. Only wire it up when there's a real
  // jump to crush.
  const crushIv = Math.min(simSigma, iv)
  const sigmaAtFor = (): ((i: number) => number) | undefined =>
    earningsStep >= 0 && earningsJump > 0 && crushIv < iv
      ? (i: number) => (i >= earningsStep ? crushIv : iv)
      : undefined

  // One set of daily paths (longest window); each strategy walks its own prefix.
  const pricePaths = simulatePaths({
    S0: input.spot,
    sigma: simSigma,
    dtYears: 1 / 252,
    steps: maxHorizon,
    r,
    q,
    simulations: sims,
    seed: input.seed,
    earningsStep,
    earningsJump
  })

  const results: StrategyResult[] = []
  const skipped: { strategy: StrategyType; reason: string }[] = []

  for (const spec of STRATEGY_SPECS) {
    const legs = legsFromSpec(input.specOverrides?.[spec.type] ?? spec.legs, enrichedChain)
    if (!legs) {
      skipped.push({
        strategy: spec.type,
        reason: 'missing liquid contracts at target deltas'
      })
      continue
    }
    const metrics = evaluateStrategyManaged(pricePaths, legs, {
      // paths move at simSigma (RV-blend); options are MARKED at IV, dropping to
      // the crushed vol after the earnings step (sigmaAt) when one is in window.
      tauAt: (i) => Math.max(0, T - (i + 1) / 252),
      r,
      q,
      sigma: iv,
      sigmaAt: sigmaAtFor(),
      maxSteps: managedHorizon(spec.type)
    }, policyFor(spec.type))
    results.push({
      strategy: spec.type,
      legs,
      netPremium: netPremium(legs),
      netGreeks: netGreeks(legs),
      metrics,
      rationale: RATIONALES[spec.type]?.(baseState) ?? '',
      payoffCurve: buildPayoffCurve(legs, input.spot, expectedMoveVal)
    })
  }

  const regime = deriveRegime(ivRank, iv, input.currentRv)

  // Combine engine score with user-view bonuses + the historical-track-record
  // calibration (down-weights strategy×regime combos that have actually lost).
  function userScore(r: StrategyResult): number {
    const calib = input.calibrate?.(r.strategy, regime) ?? 1
    return (
      scoreStrategy(r, input.spot) *
      viewBonus(r.strategy, input.view) *
      volBonus(r.strategy, input.volExpect) *
      riskFilter(r, input.riskPref) *
      calib
    )
  }
  results.sort((a, b) => userScore(b) - userScore(a))

  results.forEach((r, idx) => {
    r.calibration = input.calibrate?.(r.strategy, regime) ?? 1
    // Hard-disabled by track record (calibration 0): never primary, even when
    // it aligns with the user's view — the badge in the UI explains why.
    if (r.calibration === 0) {
      r.tier = 'reference'
      return
    }
    // Primary = strategies aligned with a view that carries earned skill weight.
    // A view gated to weight 0 (both directional views today) contributes no
    // signal, so tiering falls back to regime-based instead of surfacing it.
    const av = viewWeight(input.view) > 0 ? input.view : undefined
    if (av) {
      r.tier = STRATEGY_VIEW[r.strategy]?.includes(av) ? 'primary' : 'reference'
    } else {
      r.tier = tierFor(regime, r.strategy, idx)
    }
  })

  return {
    state: {
      ...baseState,
      spot: input.spot,
      iv,
      ivRank,
      dte,
      symbol: input.symbol,
      expiration: input.expiration,
      regime,
      returnSkew
    },
    results,
    skipped
  }
}

export type {
  MarketInput,
  StrategyResult,
  MarketState,
  RiskMetrics,
  Greeks,
  OptionLeg,
  PayoffCurve
} from './types.js'
