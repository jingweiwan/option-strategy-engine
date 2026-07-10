/**
 * Managed-exit simulation — THE single definition of "how a trade is closed",
 * shared by:
 *   - the live engine (walks Monte-Carlo price paths → displayed POP/EV)
 *   - the feedback backtester (walks real daily closes → learned outcomes)
 *
 * One function means the number shown to the user, the number the
 * calibration/tuner learn from, and the number realized are computed the SAME
 * way — no "display says hold-to-expiry, reality is managed" divergence.
 *
 * The position is MARKED with Black–Scholes at the remaining time to
 * expiration (not expiration intrinsic) — otherwise an OTM credit spread shows
 * full credit on day one (intrinsic = 0 on both legs) and "takes profit"
 * immediately, which is exactly the degenerate ~100% win rate the old backtest
 * produced. With a time-value mark, the 50%-credit target is only reached
 * through real theta decay / favorable moves.
 *
 * Rules (typical retail playbook):
 *   Credit (netPremium > 0): take profit at 50% of credit, stop at 2× credit
 *   Debit  (netPremium < 0): take profit at 1:1 (debit paid), stop at 50% debit
 *
 * LIMITATION: a single ATM `sigma` marks every leg — it ignores per-strike skew
 * (small entry residual). It is NOT constant through the window: `sigmaAt` lets
 * the caller drop the mark vol after an earnings step (IV crush). Per-leg IV
 * (full vega P&L across strikes) is still a follow-up.
 */
import { blackScholes } from './pricing.js'
import type { OptionLeg, StrategyType } from './types.js'

// Fraction of the beyond-stop overshoot realized as slippage when a stop is hit.
// 0 = fill exactly at −stop (optimistic; ignores real gaps). 1 = fill at the full
// observed mark (over-penalizes the forward sim, whose daily GBM steps overshoot
// the intraday trigger — they are discretization, not real gaps). ~0.35 keeps
// stops honestly worse-than-−stop without erasing the variance-risk-premium edge
// on rich-IV names. Real overnight/earnings gaps still bite via the marked value.
const STOP_GAP_SLIP = Number(process.env.STOP_GAP_SLIP ?? '0.35')

/**
 * Exit policy A/B (currently offered for iron_condor only, picked at scan time
 * and stamped on the snapshot so realized outcomes adjudicate):
 *   'managed' — the default playbook: TP at 50% credit, stop 2×, close at 21 DTE
 *   'runner'  — stop 2× only, NO take-profit, hold to expiration. A 3-way exit
 *               comparison on real bars showed ~8× higher avg P&L for condors
 *               (+1.97 vs +0.26/trade) but on a weak sample (n=51, one calm
 *               regime) — so it runs as a parallel experiment, not a switch.
 */
export type ExitPolicy = 'managed' | 'runner'

/** The DTE at which a structure is closed per its trading rule (0 = hold to
 *  expiration). Credit sellers close at 21 DTE to dodge late-cycle gamma;
 *  debit/long structures ride to expiry for the full directional/vol payoff.
 *  A 'runner' position ignores the early close-out and rides to expiry. */
function closeAtDte(strategy: StrategyType, policy: ExitPolicy): number {
  if (policy === 'runner') return 0
  if (strategy === 'bull_put_spread' || strategy === 'bear_call_spread' || strategy === 'iron_condor') {
    return 21
  }
  return 0 // long_straddle, bull_call_spread, bear_put_spread → hold to expiry
}

/**
 * Forward trading days the position is actively held — rule-based, not a fixed
 * window: hold until the strategy's close-at-DTE (so a 45-DTE credit spread
 * holds ~24 days to 21 DTE; a 30-DTE one holds ~9 days; debit/long hold to
 * expiry). Take-profit / stop still exit earlier within this span; only if
 * neither triggers is the position marked at the close-out point.
 */
export function managedHoldDays(strategy: StrategyType, dte: number, policy: ExitPolicy = 'managed'): number {
  const target = closeAtDte(strategy, policy)
  return dte > target ? dte - target : Math.max(1, dte)
}

export type ManagedExitReason = 'take_profit' | 'stop_loss' | 'end_of_window'

export type ManagedExit = {
  pnl: number
  exitIndex: number
  reason: ManagedExitReason
}

export type MarkContext = {
  /** Remaining time to expiration (years) at price-path index i. */
  tauAt: (i: number) => number
  r: number
  q: number
  /** Vol used to re-price (mark) the options — the implied vol, not the RV path sigma. */
  sigma: number
  /** Optional step-dependent mark vol (overrides `sigma` at index i) — used to
   *  drop IV after an earnings step (crush). Falls back to `sigma` when absent. */
  sigmaAt?: (i: number) => number
  /** Cap how far into the path to walk (the strategy-aware management window). */
  maxSteps?: number
}

export function managedThresholds(
  netPremium: number,
  policy: ExitPolicy = 'managed'
): { takeProfit: number; stop: number } {
  const credit = netPremium > 0
  if (credit && policy === 'runner') {
    // Runner: keep the 2× disaster stop, never take profit early — the position
    // rides to expiry to collect the full credit.
    return { takeProfit: Infinity, stop: netPremium * 2 }
  }
  return credit
    ? { takeProfit: netPremium * 0.5, stop: netPremium * 2 }
    : { takeProfit: Math.abs(netPremium), stop: Math.abs(netPremium) * 0.5 }
}

/** Mark-to-market P&L of the position at underlying S with `tau` years left. */
export function markPnL(
  legs: OptionLeg[],
  S: number,
  tau: number,
  r: number,
  q: number,
  sigma: number
): number {
  let pnl = 0
  for (const leg of legs) {
    const value =
      tau <= 0 || sigma <= 0
        ? leg.type === 'call'
          ? Math.max(0, S - leg.strike)
          : Math.max(0, leg.strike - S)
        : blackScholes({ type: leg.type, S, K: leg.strike, T: tau, r, q, sigma })
    const sign = leg.action === 'buy' ? 1 : -1
    const cost = leg.action === 'buy' ? leg.premium : -leg.premium
    pnl += (sign * value - cost) * leg.quantity
  }
  return pnl
}

/**
 * Walk a price path, exiting at the first take-profit/stop touch (on the marked
 * value), else marking at the last observation in the window.
 */
export function runManagedExit(
  legs: OptionLeg[],
  pricePath: number[],
  netPremium: number,
  ctx: MarkContext,
  policy: ExitPolicy = 'managed'
): ManagedExit {
  const { takeProfit, stop } = managedThresholds(netPremium, policy)
  const end = ctx.maxSteps != null ? Math.min(ctx.maxSteps, pricePath.length) : pricePath.length
  const sigmaOf = (i: number) => (ctx.sigmaAt ? ctx.sigmaAt(i) : ctx.sigma)

  for (let i = 0; i < end; i++) {
    const v = markPnL(legs, pricePath[i], ctx.tauAt(i), ctx.r, ctx.q, sigmaOf(i))
    // Take-profit is a limit order → fills at the target (a favorable gap is not
    // claimed). A stop is a market order that slips PAST −stop in a gap. But the
    // fill is NOT the full observed mark: on close-only paths a daily GBM step
    // overshoots the intraday stop-trigger, and in continuous time the price
    // passes THROUGH −stop. So realize −stop plus a FRACTION of the beyond-stop
    // overshoot (STOP_GAP_SLIP) — honest about gap slippage without the
    // discretization over-penalty that fills every daily breach at the close.
    if (v >= takeProfit) return { pnl: takeProfit, exitIndex: i, reason: 'take_profit' }
    if (v <= -stop) {
      const overshoot = -stop - v // ≥ 0
      return { pnl: -stop - STOP_GAP_SLIP * overshoot, exitIndex: i, reason: 'stop_loss' }
    }
  }
  const last = end - 1
  return {
    pnl: last >= 0 ? markPnL(legs, pricePath[last], ctx.tauAt(last), ctx.r, ctx.q, sigmaOf(last)) : 0,
    exitIndex: last,
    reason: 'end_of_window'
  }
}
