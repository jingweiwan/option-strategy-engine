import type { OptionLeg, StrategyType, Greeks } from './types.js'
import type { OptionContract } from '../api/types.js'
import { greeks as bsmGreeks } from './pricing.js'

// ---------- Data-quality guards ----------

/** IV must be between 1% and 500% annualized to be considered sane. */
const IV_MIN = 0.01
const IV_MAX = 5.0

export function ivSane(iv: number | undefined | null): iv is number {
  return iv != null && Number.isFinite(iv) && iv >= IV_MIN && iv <= IV_MAX
}

/**
 * Maximum bid-ask spread as a fraction of mid price.
 * Contracts wider than this are treated as illiquid.
 */
const MAX_SPREAD_PCT = 0.40 // 40%

/** Minimum open interest to consider a contract liquid. */
const MIN_OPEN_INTEREST = 5

/**
 * Maximum absolute delta deviation from target.
 * If the closest match is further than this, the leg is skipped.
 */
const MAX_DELTA_DEVIATION = 0.15

/**
 * Slippage assumption: fraction of the half bid-ask spread paid on entry.
 * Mid price is optimistic — real fills land toward the touch. Buying fills
 * above mid, selling fills below mid. 0.5 ≈ halfway to the touch, a realistic
 * retail assumption for liquid options. This makes net premium (and therefore
 * EV) more honest, especially for wide-spread credit strategies.
 */
const SLIPPAGE_FRACTION = 0.5

/**
 * Executable premium after a slippage haircut.
 * buy  → pay above mid (cost up)
 * sell → receive below mid (credit down)
 */
function executionPremium(c: OptionContract, action: 'buy' | 'sell'): number {
  const halfSpread = Math.max(0, (c.ask - c.bid) / 2)
  const slip = halfSpread * SLIPPAGE_FRACTION
  const adjusted = action === 'buy' ? c.mid + slip : c.mid - slip
  return Math.max(0.01, adjusted)
}

export type LegSpec = {
  type: 'call' | 'put'
  action: 'buy' | 'sell'
  /** Pick by delta (short legs, and delta-based wings). Absolute, e.g. 0.16 = 16-delta. */
  targetDelta?: number
  /**
   * Long-wing placement by EQUAL DOLLAR width instead of delta: the wing lands
   * |k × same-side short strike| from its short (put wing below, call wing
   * above). Keeps put/call wings ~equal-$ despite skew, so maxLoss is
   * arm-comparable. Exactly one of targetDelta / widthPctFromShort is set.
   */
  widthPctFromShort?: number
}

export type StrategySpec = {
  type: StrategyType
  legs: LegSpec[]
}

/**
 * Long-wing width for the two-leg credit spreads, as a fraction of the short
 * strike. Same value and same rationale as the iron condor's CONDOR_WING_PCT:
 * a delta-placed wing is NOT a stable geometry — under put skew the 10Δ strike
 * drifts far OTM, ballooning maxLoss while adding almost no protection, and it
 * makes the wing width a function of the name's skew rather than a choice.
 *
 * Measured on the real 2026-10-02 chains (2026-08-17 close):
 *   IWM 304.06  10Δ wing → 290/270 ($20 wide): credit/width 10.8%, maxLoss $1,785
 *               2%  wing → 290/285 ($5  wide): credit/width 16.1%, maxLoss $420
 *   TLT  81.45  10Δ wing → 79/76   ($3  wide): credit/width 13.3%, maxLoss $260
 *               2%  wing → 79/77   ($2  wide): credit/width 15.5%, maxLoss $169
 *
 * The narrow wing is NOT strictly better — loss saturates sooner, and the same
 * capital buys more contracts (more short gamma, more assignment surface). The
 * point is that width becomes a DELIBERATE parameter instead of a skew accident.
 * Env-tunable so the tuner/backtest can adjudicate it later.
 *
 * WHY THE GOLDEN EV FELL WHEN THIS LANDED (read before "fixing" it back):
 * the golden fixture prices EVERY strike at one flat IV (fixtures.ts, sigma=iv),
 * so its far wing is cheap insurance and a WIDE spread genuinely wins on EV in
 * that world. Real chains are skewed — on IWM 2026-10-02 the wing the old 10Δ
 * rule picked (270P) traded at 7.1× its ATM-vol value. Worse, `markPnL` marks
 * every leg with ONE ATM sigma while entry premiums come from the real chain,
 * so a wide spread is handed a spurious inception P&L:
 *     290/270 → +$23 at t=0 = +11% of max profit, from nothing
 *     290/285 → −$9  at t=0 = −12%
 * Both the fixture and the live sim therefore FAVOR wide wings for reasons that
 * do not exist in the market. The live half of that bias is now FIXED — markPnL
 * marks each leg at its own `leg.iv` — so the sim no longer hands wide spreads a
 * phantom inception P&L. The fixture is still flat-vol by construction, so the
 * golden numbers keep their flat-vol reading; this constant remains what stops
 * the wing from wandering out to wherever skew puts it.
 */
export const CREDIT_SPREAD_WING_PCT =
  Number(process.env.CREDIT_SPREAD_WING_PCT) || 0.02

const ALL_STRATEGY_SPECS: StrategySpec[] = [
  // --- Debit spreads (buy near-ATM, sell further OTM) ---
  {
    type: 'bull_call_spread',
    legs: [
      { type: 'call', action: 'buy', targetDelta: 0.45 },
      { type: 'call', action: 'sell', targetDelta: 0.25 }
    ]
  },
  {
    type: 'bear_put_spread',
    legs: [
      { type: 'put', action: 'buy', targetDelta: 0.45 },
      { type: 'put', action: 'sell', targetDelta: 0.25 }
    ]
  },
  // --- Credit spreads (sell near-ATM, buy further OTM as hedge) ---
  {
    // Long wing by EQUAL-$ width, NOT by delta — same fix the iron condor took
    // (see CREDIT_SPREAD_WING_PCT). A 10Δ wing lands wherever skew puts it, so
    // the SAME rule produced a 3.7%-of-spot wing on TLT and a 6.6% one on IWM.
    type: 'bear_call_spread',
    legs: [
      { type: 'call', action: 'sell', targetDelta: 0.30 },
      { type: 'call', action: 'buy', widthPctFromShort: CREDIT_SPREAD_WING_PCT }
    ]
  },
  {
    type: 'bull_put_spread',
    legs: [
      { type: 'put', action: 'sell', targetDelta: 0.30 },
      { type: 'put', action: 'buy', widthPctFromShort: CREDIT_SPREAD_WING_PCT }
    ]
  },
  // --- Multi-leg / vol strategies ---
  {
    // Short legs carry the skew: the CALL short sits further OTM (13Δ) for the
    // upside room equity drift keeps eating, while the PUT short (20Δ) harvests
    // the richer, skewed put premium. Both long wings are placed an EQUAL dollar
    // width (2% of the same-side short strike) — a Δ offset made the put/call
    // wings wildly unequal under skew. Kept in lockstep with the tuner default
    // arm (put 20Δ, CONDOR_WING_PCT) so there is no static/tuned condor fork.
    type: 'iron_condor',
    legs: [
      { type: 'put', action: 'sell', targetDelta: 0.2 },
      { type: 'put', action: 'buy', widthPctFromShort: 0.02 },
      { type: 'call', action: 'sell', targetDelta: 0.13 },
      { type: 'call', action: 'buy', widthPctFromShort: 0.02 }
    ]
  },
  {
    type: 'short_strangle',
    legs: [
      { type: 'put', action: 'sell', targetDelta: 0.2 },
      { type: 'call', action: 'sell', targetDelta: 0.2 }
    ]
  },
  {
    type: 'long_straddle',
    legs: [
      { type: 'call', action: 'buy', targetDelta: 0.5 },
      { type: 'put', action: 'buy', targetDelta: 0.5 }
    ]
  }
]

// Strategies the account/broker can't trade are filtered out of recommendations.
// Default removes short_strangle (undefined-risk naked selling — most retail
// brokers disallow it). Override with DISABLED_STRATEGIES="" to re-enable, or
// add others comma-separated.
const DISABLED_STRATEGIES = new Set(
  (process.env.DISABLED_STRATEGIES ?? 'short_strangle')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
)

export const STRATEGY_SPECS: StrategySpec[] = ALL_STRATEGY_SPECS.filter(
  (s) => !DISABLED_STRATEGIES.has(s.type)
)

function emptyGreeks(): Greeks {
  return { delta: 0, gamma: 0, theta: 0, vega: 0 }
}

export type EnrichCtx = { spot: number; T: number; r: number; q: number }

/**
 * If a contract has IV but no greeks (e.g. Yahoo), compute them via BSM.
 */
export function enrichWithGreeks(chain: OptionContract[], ctx: EnrichCtx): OptionContract[] {
  return chain.map((c) => {
    if (c.greeks && Number.isFinite(c.greeks.delta)) return c
    if (!ivSane(c.iv)) return c
    const g = bsmGreeks({
      type: c.optionType,
      S: ctx.spot,
      K: c.strike,
      T: ctx.T,
      r: ctx.r,
      q: ctx.q,
      sigma: c.iv
    })
    return { ...c, greeks: g }
  })
}

/**
 * Liquid = real two-sided market with reasonable spread, minimum OI,
 * sane IV, and known delta.
 */
export function liquidContracts(chain: OptionContract[]): OptionContract[] {
  return chain.filter((c) => {
    if (c.bid <= 0 || c.ask <= 0 || c.ask < c.bid) return false
    if (c.greeks == null || !Number.isFinite(c.greeks.delta)) return false

    // Bid-ask spread check: reject contracts with excessively wide spreads
    const mid = (c.bid + c.ask) / 2
    if (mid > 0 && (c.ask - c.bid) / mid > MAX_SPREAD_PCT) return false

    // Open interest minimum
    if (c.openInterest < MIN_OPEN_INTEREST) return false

    // IV sanity check
    if (c.iv != null && !ivSane(c.iv)) return false

    return true
  })
}

/**
 * Nearest liquid contract of `type` to a target STRIKE (for equal-$ wings),
 * constrained to one side of an anchor so a wing can only land OTM of its short.
 * `bound.below`/`bound.above` keep only strictly-lower / strictly-higher strikes
 * — without this, a sparse chain's nearest strike can fall INSIDE the short.
 */
function pickByStrike(
  contracts: OptionContract[],
  type: 'call' | 'put',
  targetStrike: number,
  excludeStrikes?: Set<number>,
  bound?: { below?: number; above?: number }
): OptionContract | null {
  let filtered = contracts.filter((c) => c.optionType === type)
  if (excludeStrikes && excludeStrikes.size > 0) {
    filtered = filtered.filter((c) => !excludeStrikes.has(c.strike))
  }
  if (bound?.below != null) filtered = filtered.filter((c) => c.strike < bound.below!)
  if (bound?.above != null) filtered = filtered.filter((c) => c.strike > bound.above!)
  if (filtered.length === 0) return null
  return filtered.reduce((a, b) =>
    Math.abs(b.strike - targetStrike) < Math.abs(a.strike - targetStrike) ? b : a
  )
}

function pickByDelta(
  contracts: OptionContract[],
  type: 'call' | 'put',
  targetAbs: number,
  excludeStrikes?: Set<number>
): OptionContract | null {
  let filtered = contracts.filter((c) => c.optionType === type)
  if (excludeStrikes && excludeStrikes.size > 0) {
    filtered = filtered.filter((c) => !excludeStrikes.has(c.strike))
  }
  if (filtered.length === 0) return null
  // call delta positive, put delta negative
  const target = type === 'call' ? Math.abs(targetAbs) : -Math.abs(targetAbs)
  const best = filtered.reduce((a, b) => {
    const da = Math.abs((a.greeks?.delta ?? 0) - target)
    const db = Math.abs((b.greeks?.delta ?? 0) - target)
    return db < da ? b : a
  })

  // Reject if closest match is too far from the target delta
  const deviation = Math.abs((best.greeks?.delta ?? 0) - target)
  if (deviation > MAX_DELTA_DEVIATION) return null

  return best
}

export function legsFromSpec(
  specs: LegSpec[],
  chain: OptionContract[]
): OptionLeg[] | null {
  const liquid = liquidContracts(chain)
  if (liquid.length === 0) return null

  // Track used strikes per option type to avoid duplicate strikes within
  // the same side (e.g. two calls at $30), while allowing puts and calls
  // to share a strike number if needed.
  const usedPutStrikes = new Set<number>()
  const usedCallStrikes = new Set<number>()
  // Same-side short strike a width-based wing anchors to (set when a leg sells).
  const shortStrikeByType: { put?: number; call?: number } = {}
  const legs: OptionLeg[] = []

  for (const s of specs) {
    const exclude = s.type === 'put' ? usedPutStrikes : usedCallStrikes
    let c: OptionContract | null
    if (s.widthPctFromShort != null) {
      // Equal-$ wing: place |k × short strike| from the same-side short, and
      // CONSTRAIN it strictly OTM of the short (puts below, calls above) so a
      // sparse chain can't snap the wing inside the short and invert the spread.
      const anchor = shortStrikeByType[s.type]
      if (anchor == null) return null // a wing must be specced after its short
      const width = anchor * s.widthPctFromShort
      const target = s.type === 'put' ? anchor - width : anchor + width
      const otm = s.type === 'put' ? { below: anchor } : { above: anchor }
      c = pickByStrike(liquid, s.type, target, exclude, otm)
    } else if (s.targetDelta != null) {
      c = pickByDelta(liquid, s.type, s.targetDelta, exclude)
    } else {
      return null
    }
    if (!c) return null
    exclude.add(c.strike)
    if (s.action === 'sell') shortStrikeByType[s.type] = c.strike
    legs.push({
      type: s.type,
      action: s.action,
      strike: c.strike,
      premium: executionPremium(c, s.action),
      quantity: 1,
      // Carry the strike's own IV so the managed-exit sim marks this leg on the
      // same vol surface its premium came from (see markPnL). Without it a
      // skewed structure starts the sim at a phantom P&L.
      ...(c.iv != null ? { iv: c.iv } : {}),
      greeks: c.greeks
        ? {
            delta: c.greeks.delta,
            gamma: c.greeks.gamma,
            theta: c.greeks.theta,
            vega: c.greeks.vega
          }
        : emptyGreeks()
    })
  }

  // Structural validation for multi-leg strategies
  if (!validateLegStructure(specs, legs)) return null

  return legs
}

/**
 * Validate that multi-leg structures are well-formed:
 * - Distinct strikes within each option type
 * - Delta-ordering integrity: no inverted verticals (the leg the spec wants
 *   nearer the money must actually land nearer the money)
 * - Iron condor: put strikes below call strikes
 * `specs[i]` corresponds to `legs[i]` (legsFromSpec builds them in order).
 */
export function validateLegStructure(specs: LegSpec[], legs: OptionLeg[]): boolean {
  if (legs.length < 2) return true

  // Check strikes are distinct within the same option type.
  // Puts and calls MAY share a strike (e.g. long straddle = ATM call + ATM put).
  const putStrikes = legs.filter((l) => l.type === 'put').map((l) => l.strike)
  const callStrikes = legs.filter((l) => l.type === 'call').map((l) => l.strike)
  if (new Set(putStrikes).size !== putStrikes.length) return false
  if (new Set(callStrikes).size !== callStrikes.length) return false

  // Delta-ordering integrity — rejects inverted verticals. Within each option
  // type with two legs, the leg the SPEC wants nearer the money (higher
  // |targetDelta|) must land on the correctly-ordered strike: LOWER for calls,
  // HIGHER for puts. A violation means pickByDelta produced an inversion — e.g.
  // on a sparse/high-IV chain the far wing wasn't found within tolerance and
  // fell back INSIDE the short, turning a "condor" call side into a bullish
  // debit spread. Reject it rather than recommend a mislabeled directional bet.
  for (const type of ['call', 'put'] as const) {
    const pair: { strike: number; td: number }[] = []
    for (let i = 0; i < legs.length; i++) {
      if (legs[i].type === type) pair.push({ strike: legs[i].strike, td: Math.abs(specs[i]?.targetDelta ?? 0) })
    }
    if (pair.length !== 2) continue
    const [x, y] = pair
    const nearer = x.td >= y.td ? x : y
    const farther = nearer === x ? y : x
    const ok = type === 'call' ? nearer.strike < farther.strike : nearer.strike > farther.strike
    if (!ok) return false
  }

  // Iron condor: put strikes < call strikes
  const puts = legs.filter((l) => l.type === 'put')
  const calls = legs.filter((l) => l.type === 'call')
  if (puts.length === 2 && calls.length === 2) {
    const maxPut = Math.max(...puts.map((l) => l.strike))
    const minCall = Math.min(...calls.map((l) => l.strike))
    if (maxPut >= minCall) return false
  }

  return true
}

/**
 * Estimate ATM IV from chain by averaging IV of the call+put with strike
 * closest to spot.
 */
export function impliedVolFromChain(
  chain: OptionContract[],
  spot: number
): number | null {
  const withIv = chain.filter(
    (c) => c.bid > 0 && c.ask > 0 && ivSane(c.iv)
  )
  if (withIv.length === 0) return null

  const calls = withIv.filter((c) => c.optionType === 'call')
  const puts = withIv.filter((c) => c.optionType === 'put')
  if (calls.length === 0 && puts.length === 0) return null

  const closest = (xs: OptionContract[]) =>
    xs.length === 0
      ? null
      : xs.reduce((a, b) =>
          Math.abs(b.strike - spot) < Math.abs(a.strike - spot) ? b : a
        )

  const cATM = closest(calls)
  const pATM = closest(puts)
  const ivs = [cATM?.iv, pATM?.iv].filter(
    (x): x is number => x != null && Number.isFinite(x)
  )
  if (ivs.length === 0) return null
  return ivs.reduce((a, b) => a + b, 0) / ivs.length
}

/**
 * Estimate return skewness from the IV smile's put/call asymmetry.
 *
 * Reads IV at the ~25-delta put and ~25-delta call (a risk-reversal), normalizes
 * by ATM IV, and maps it to a return-skewness coefficient for the simulator.
 * Equity put skew (put IV > call IV) → NEGATIVE skewness (fat left tail).
 *
 * Returns 0 when the chain lacks usable OTM wings (e.g. flat-IV or sparse
 * chains), leaving the simulator at the symmetric lognormal default.
 */
export function skewFromChain(
  chain: OptionContract[],
  spot: number,
  atmIv: number
): number {
  if (!(atmIv > 0)) return 0
  const usable = chain.filter(
    (c) => ivSane(c.iv) && c.greeks != null && Number.isFinite(c.greeks.delta)
  )
  const puts = usable.filter((c) => c.optionType === 'put')
  const calls = usable.filter((c) => c.optionType === 'call')
  if (puts.length === 0 || calls.length === 0) return 0

  const nearestDelta = (xs: OptionContract[], target: number) =>
    xs.reduce((a, b) =>
      Math.abs((b.greeks!.delta) - target) < Math.abs((a.greeks!.delta) - target) ? b : a
    )
  const otmPut = nearestDelta(puts, -0.25)
  const otmCall = nearestDelta(calls, 0.25)

  // Bail if the closest wings are too far from 25-delta to be meaningful.
  if (Math.abs(otmPut.greeks!.delta + 0.25) > MAX_DELTA_DEVIATION) return 0
  if (Math.abs(otmCall.greeks!.delta - 0.25) > MAX_DELTA_DEVIATION) return 0

  // Risk-reversal normalized by ATM IV. Positive = put-skewed (equities).
  const riskReversal = (otmPut.iv! - otmCall.iv!) / atmIv
  // Map smile slope → return skewness. ~30d equity index: RR≈0.2 → γ≈-0.5.
  const SKEW_GAIN = 2.5
  const gamma = -SKEW_GAIN * riskReversal
  return Math.max(-1, Math.min(1, gamma))
}

export function dteFromExpiration(expiration: string, today = new Date()): number {
  const exp = new Date(expiration + 'T16:00:00-04:00') // ~ market close ET
  const ms = exp.getTime() - today.getTime()
  return Math.max(1, Math.round(ms / (1000 * 60 * 60 * 24)))
}

/**
 * Premium-weighted implied vol of the legs a structure SELLS — "the vol you
 * actually collect", as opposed to the ATM vol the state block reports.
 *
 * For a single-strike short these are close. For a multi-leg index structure
 * they can be far apart: the IWM 2026-10-02 condor sells a 276 put at 23.9% IV
 * and a 321 call at 15.2%, while its ATM IV is 18.2% — a number that describes
 * neither leg. Weighting by premium (not equally) is deliberate: the put
 * dominates the credit, so it should dominate the "is this rich?" verdict.
 *
 * Returns null when ANY sold leg lacks a sane IV or a positive premium weight —
 * a partial average would silently mix a real vol with an ATM stand-in, which
 * is the exact failure this function exists to remove. Callers fall back to ATM.
 *
 * CAVEAT for anyone tightening/loosening a gate on this: put skew is largely a
 * persistent RISK premium, not a mispricing. Comparing a skew-lifted 23.9% put
 * IV against a SYMMETRIC realized-vol estimate overstates the edge, because the
 * realized downside vol that put is priced off is higher than the two-sided RV.
 * This function measures the right vol; it does not fix the denominator.
 */
export function soldLegIv(legs: readonly OptionLeg[]): number | null {
  const sold = legs.filter((l) => l.action === 'sell')
  if (sold.length === 0) return null
  let wsum = 0
  let w = 0
  for (const l of sold) {
    if (!ivSane(l.iv)) return null
    const weight = Math.abs(l.premium) * l.quantity
    if (!(weight > 0)) return null
    wsum += l.iv * weight
    w += weight
  }
  return w > 0 ? wsum / w : null
}
