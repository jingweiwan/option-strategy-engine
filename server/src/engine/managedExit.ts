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
 * Rules:
 *   'user'    (DEFAULT) — what this account actually does: take profit at 75%
 *                         of credit, no stop, ride to expiry. See ExitPolicy.
 *   'managed' (legacy)  — TP 50% of credit, stop 2× credit, close at 21 DTE
 *   Debit  (netPremium < 0): take profit at 1:1 (debit paid), stop at 50% debit
 *
 * MARK VOL: each leg is marked at ITS OWN implied vol when the chain supplied
 * one (`leg.iv`), falling back to the context's ATM `sigma`. This matters most
 * for multi-leg index structures, where put skew is large: an IWM condor priced
 * from the real chain (276P @ 23.9%, 321C @ 15.2%) but MARKED at one ATM vol
 * (18.2%) starts the simulation already at −0.105 P&L — 23% of its own
 * take-profit target — purely from the vol mismatch between entry premiums and
 * the marking model. Per-leg marking removes that residual (−0.105 → −0.012).
 *
 * The vol is NOT constant through the window: `sigmaAt` lets the caller drop
 * mark vol after an earnings step (IV crush), and `convergeTo` decays the whole
 * surface toward the realized/diffusion vol across the window so the variance
 * risk premium the seller collected actually shows up in the P&L. The crush is applied to per-leg
 * vols as a RATIO (sigmaAt(i)/sigma), so a 30% ATM crush crushes every strike
 * by 30% and the skew shape survives the event.
 */
import { blackScholes } from './pricing.js'
import { theoreticalExtremes } from './payoff.js'
import type { OptionLeg, StrategyType } from './types.js'

// Fraction of the beyond-stop overshoot realized as slippage when a stop is hit.
// 0 = fill exactly at −stop (optimistic; ignores real gaps). 1 = fill at the full
// observed mark (over-penalizes the forward sim, whose daily GBM steps overshoot
// the intraday trigger — they are discretization, not real gaps). ~0.35 keeps
// stops honestly worse-than-−stop without erasing the variance-risk-premium edge
// on rich-IV names. Real overnight/earnings gaps still bite via the marked value.
const STOP_GAP_SLIP = Number(process.env.STOP_GAP_SLIP ?? '0.35')

/**
 * How a position is closed. Stamped on every snapshot so a realized outcome is
 * always settled by the rule its own card claimed.
 *
 *   'user'    — WHAT THIS ACCOUNT ACTUALLY DOES, and the default for new scans:
 *               take profit at 75% of the credit, NO stop, ride to expiry.
 *   'managed' — the textbook retail playbook: TP 50% credit, stop 2× credit,
 *               close at 21 DTE. Was the default through 2026-08-31; kept so
 *               older snapshots re-settle under the rule they were shown with.
 *   'runner'  — stop 2× only, NO take-profit, hold to expiration. A 3-way exit
 *               comparison on real bars showed ~8× higher avg P&L for condors
 *               (+1.97 vs +0.26/trade) but on a weak sample (n=51, one calm
 *               regime) — so it runs as a parallel experiment, not a switch.
 *
 * WHY 'user' HAD TO EXIST. Under 'managed' the mechanical breakeven win rate is
 * stop/(stop+TP) = 2/(2+0.5) = 80% for EVERY credit structure, regardless of how
 * much credit it collects — the 2× stop truncates the loss, and that truncation
 * was doing all the work. Measured on the 2026-08-31 board, the three qualified
 * cards showed POP 82-84% against that 80% bar and scored +EV. Under the rule
 * this account actually follows the loss is NOT truncated, so the bar is
 * maxLoss/(maxLoss + 0.75·credit) — 90.6% (IWM), 84.2% (XLE), 90.1% (XOM). Two
 * of the three do not clear it even at the engine's own optimistic vol. The +EV
 * verdict was an artifact of a stop the user does not place.
 */
export type ExitPolicy = 'user' | 'managed' | 'runner'

/**
 * Fraction of the collected credit taken as profit under 'user'. The account's
 * written rule is a 70-85% band; 0.75 is its midpoint. Raising it holds for more
 * of the credit and loses more often — the trade-off this policy exists to make
 * visible rather than assume.
 */
export const USER_TAKE_PROFIT_FRACTION = Number(process.env.USER_TAKE_PROFIT_FRACTION ?? '0.75')

/**
 * 'user' places no stop, which is exactly representable for a defined-risk
 * structure: the position cannot lose more than its own max loss, so `Infinity`
 * IS the rule, not an approximation.
 *
 * An UNBOUNDED-loss structure (naked short_strangle) has no max loss for the
 * rule to lean on, so "no stop" is undefined there and an unstopped sim would
 * report a mean driven by however far the worst path happened to run. This
 * multiple is a MODELING FLOOR, not something the account promised to do — and
 * short_strangle is in DISABLED_STRATEGIES by default, so it should not arise.
 */
export const USER_UNBOUNDED_STOP_MULTIPLE = Number(process.env.USER_UNBOUNDED_STOP_MULTIPLE ?? '3')

/** The DTE at which a structure is closed per its trading rule (0 = hold to
 *  expiration). Credit sellers close at 21 DTE to dodge late-cycle gamma;
 *  debit/long structures ride to expiry for the full directional/vol payoff.
 *  A 'runner' position ignores the early close-out and rides to expiry. */
function closeAtDte(strategy: StrategyType, policy: ExitPolicy): number {
  // 'user' has no DTE rule — the written rule is take-profit-or-expiry — so it
  // rides the whole cycle, same as a runner.
  if (policy === 'runner' || policy === 'user') return 0
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
export function managedHoldDays(strategy: StrategyType, dte: number, policy: ExitPolicy = 'user'): number {
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
  /**
   * Vol level the whole surface decays TOWARD across the holding window — the
   * diffusion (realized) vol. Without it every leg stays marked at its ENTRY IV
   * for the entire path, so a seller who collected 28.9% on a name realizing
   * 22.8% never books that spread: at the 21-DTE close-out the remaining time
   * value is still priced at 28.9%. The variance risk premium — the entire
   * reason to sell — is invisible to the sim, and the richer the IV the larger
   * the understatement (measured on the 2026-08-24 chain: XOM +6.1pp of edge
   * scored the WORST EV of the watchlist, TLT +1.2pp the only positive one).
   *
   * Applied as a RATIO on `sigma`, linearly over the window, so per-leg IVs
   * scale proportionally and the skew shape survives (same reason `sigmaAt` is
   * a ratio). DOWNWARD ONLY: when convergeTo ≥ sigma this is a no-op. Modeling
   * upward convergence would hand long-vol structures a gain the seller-focused
   * evidence base has never validated — that stays out until a backtest earns it.
   */
  convergeTo?: number
  /** Cap how far into the path to walk (the strategy-aware management window). */
  maxSteps?: number
}

export function managedThresholds(
  netPremium: number,
  policy: ExitPolicy = 'user',
  /** Theoretical max loss as a POSITIVE magnitude; Infinity when unbounded.
   *  Only 'user' reads it — that policy's "no stop" is only well-defined for a
   *  structure whose loss is bounded. Omitted → treated as unbounded. */
  maxLoss?: number
): { takeProfit: number; stop: number } {
  const credit = netPremium > 0
  if (credit && policy === 'user') {
    const bounded = maxLoss != null && Number.isFinite(maxLoss)
    return {
      takeProfit: netPremium * USER_TAKE_PROFIT_FRACTION,
      stop: bounded ? Infinity : netPremium * USER_UNBOUNDED_STOP_MULTIPLE
    }
  }
  if (credit && policy === 'runner') {
    // Runner: keep the 2× disaster stop, never take profit early — the position
    // rides to expiry to collect the full credit.
    return { takeProfit: Infinity, stop: netPremium * 2 }
  }
  return credit
    ? { takeProfit: netPremium * 0.5, stop: netPremium * 2 }
    : { takeProfit: Math.abs(netPremium), stop: Math.abs(netPremium) * 0.5 }
}

/** A leg's own implied vol is usable only when the chain gave a sane one. */
function legIvSane(iv: number | undefined): iv is number {
  return typeof iv === 'number' && Number.isFinite(iv) && iv > 0.01 && iv < 5
}

/**
 * Mark-to-market P&L of the position at underlying S with `tau` years left.
 *
 * `sigma` is the ATM mark vol. Each leg uses its OWN `leg.iv` when present,
 * scaled by `volRatio` — the caller passes sigmaAt(i)/sigma so an earnings
 * crush applies proportionally across strikes instead of flattening the skew.
 * Legs without an iv fall back to `sigma * volRatio`.
 */
export function markPnL(
  legs: OptionLeg[],
  S: number,
  tau: number,
  r: number,
  q: number,
  sigma: number,
  volRatio = 1
): number {
  let pnl = 0
  for (const leg of legs) {
    const base = legIvSane(leg.iv) ? leg.iv : sigma
    const vol = base * volRatio
    const value =
      tau <= 0 || vol <= 0
        ? leg.type === 'call'
          ? Math.max(0, S - leg.strike)
          : Math.max(0, leg.strike - S)
        : blackScholes({ type: leg.type, S, K: leg.strike, T: tau, r, q, sigma: vol })
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
  policy: ExitPolicy = 'user'
): ManagedExit {
  // 'user' needs to know whether the loss is bounded before it can say "no stop".
  const { takeProfit, stop } = managedThresholds(
    netPremium,
    policy,
    policy === 'user' ? Math.abs(theoreticalExtremes(legs).theoMaxLoss) : undefined
  )
  const end = ctx.maxSteps != null ? Math.min(ctx.maxSteps, pricePath.length) : pricePath.length
  // sigmaAt drops the ATM mark vol after an earnings step. Convert it to a
  // RATIO so the same crush scales each leg's own IV and the skew shape
  // survives the event (a flat override would erase it exactly when the
  // structure's wings matter most).
  //
  // Two independent effects scale the mark vol, both as ratios on ctx.sigma:
  //   crush      — the earnings step (sigmaAt), a discrete drop
  //   convergence— IV decaying toward realized vol across the window (VRP harvest)
  // They compose multiplicatively but are FLOORED at the convergence target:
  // an earnings crush already collapses the surface, so stacking a full
  // convergence on top would mark below the diffusion vol and pay the seller
  // twice for the same collapse.
  const convTarget = ctx.convergeTo
  const convFloor =
    convTarget != null && ctx.sigma > 0 && convTarget > 0 && convTarget < ctx.sigma
      ? convTarget / ctx.sigma
      : 1
  // Convergence denominator is the MANAGEMENT WINDOW, not however many price
  // points happened to be supplied.
  //
  // `end` is the walk bound and must stay min(maxSteps, path.length) — you
  // cannot walk bars you do not have. But using it as the denominator made
  // `maxSteps` a dead parameter on the settlement side: outcome slices bars from
  // a window of `managedHoldDays` CALENDAR days, so it always holds ~5/7 as many
  // trading bars as that number, `min` never binds, and the schedule silently
  // re-based onto the bar count — compressing the whole VRP decay into a shorter
  // span than the card used.
  //
  // Live indexes trading steps (tauAt uses /252) and divides by maxSteps;
  // settlement indexes real trading bars and now divides by maxSteps too, so the
  // two schedules line up. A short bar series simply ends mid-schedule, still
  // partly converged — which is the honest reading of a window that ended early.
  //
  // KNOWN, PRE-EXISTING: maxSteps itself is a calendar-day count
  // (`dte - closeAtDte`) used as a trading-step count. That unit slip is
  // identical on both sides, so the display/learning invariant holds; fixing it
  // means moving live and settlement together, and is not this change.
  const steps = Math.max(1, ctx.maxSteps ?? end)
  const ratioOf = (i: number) => {
    const crush = ctx.sigmaAt && ctx.sigma > 0 ? ctx.sigmaAt(i) / ctx.sigma : 1
    if (convFloor >= 1) return crush
    const progress = Math.min(1, (i + 1) / steps)
    const converge = 1 + (convFloor - 1) * progress
    return Math.max(crush * converge, convFloor)
  }

  for (let i = 0; i < end; i++) {
    const v = markPnL(legs, pricePath[i], ctx.tauAt(i), ctx.r, ctx.q, ctx.sigma, ratioOf(i))
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
    pnl:
      last >= 0
        ? markPnL(legs, pricePath[last], ctx.tauAt(last), ctx.r, ctx.q, ctx.sigma, ratioOf(last))
        : 0,
    exitIndex: last,
    reason: 'end_of_window'
  }
}
