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
  targetDelta: number // absolute, e.g. 0.16 means 16-delta
}

export type StrategySpec = {
  type: StrategyType
  legs: LegSpec[]
}

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
    type: 'bear_call_spread',
    legs: [
      { type: 'call', action: 'sell', targetDelta: 0.30 },
      { type: 'call', action: 'buy', targetDelta: 0.10 }
    ]
  },
  {
    type: 'bull_put_spread',
    legs: [
      { type: 'put', action: 'sell', targetDelta: 0.30 },
      { type: 'put', action: 'buy', targetDelta: 0.10 }
    ]
  },
  // --- Multi-leg / vol strategies ---
  {
    // Asymmetric on purpose: equities drift up and carry put skew, so the CALL
    // short sits further OTM (13Δ) to give the upside room the drift keeps
    // eating, while the PUT short (20Δ) harvests the richer, skewed put premium.
    // Wings at ~10Δ / 7Δ (not the old 5Δ): tighter, more liquid, far better
    // risk/reward than the wide 5Δ wings that risked a lot to collect little.
    type: 'iron_condor',
    legs: [
      { type: 'put', action: 'sell', targetDelta: 0.2 },
      { type: 'put', action: 'buy', targetDelta: 0.1 },
      { type: 'call', action: 'sell', targetDelta: 0.13 },
      { type: 'call', action: 'buy', targetDelta: 0.07 }
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
  const legs: OptionLeg[] = []

  for (const s of specs) {
    const exclude = s.type === 'put' ? usedPutStrikes : usedCallStrikes
    const c = pickByDelta(liquid, s.type, s.targetDelta, exclude)
    if (!c) return null
    exclude.add(c.strike)
    legs.push({
      type: s.type,
      action: s.action,
      strike: c.strike,
      premium: executionPremium(c, s.action),
      quantity: 1,
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
