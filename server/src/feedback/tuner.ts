/**
 * Online parameter tuner — Thompson sampling over strategy-construction knobs.
 *
 * Phase 2 of the self-optimization plan. Knob: the SHORT-LEG DELTA — for credit
 * spreads (bull_put / bear_call) arms {0.25, 0.30, 0.35}; for the iron condor
 * the PUT short arms {0.16, 0.20, 0.24} (the call short drifts off it; both long
 * wings are equal-$ via CONDOR_WING_PCT). Each dashboard recommendation picks an
 * arm by Thompson-sampling a Normal posterior over its mean per-trade P&L (per
 * strategy × regime bucket); the chosen variant id is recorded on the snapshot,
 * so every backtested outcome sharpens the posterior — recommendations drift
 * toward the arm that makes the most $/trade.
 *
 * Why Thompson sampling: with only a handful of resolved trades per day,
 * epsilon-greedy wastes exploration and grid search overfits. A Normal posterior
 * over each arm's mean reward explores exactly in proportion to remaining
 * uncertainty (variance/n + a prior spread).
 *
 * REWARD = raw per-share P&L (= $/contract ÷ 100), NOT win/loss and NOT a ratio.
 * The account trades a FIXED number of contracts, so the objective is absolute
 * $/trade. Two ratio attempts both mis-ranked, each caught by the replay:
 *   - ÷maxLoss (return-on-risk) favors the bigger-credit/tighter arm regardless
 *     of realized $ (the condor reward↔$ inversion);
 *   - ÷spot (return-on-notional) over-credits wins on cheap underlyings, so a
 *     lower-$ arm that lands more on low-priced names scores higher.
 * Plain mean P&L ranks arms by the money they actually make. The Normal
 * posterior updates from {n, Σpnl, Σpnl²}; its mean is what we maximize.
 *
 * Honest expectations: convergence is weeks-to-months at this trade volume.
 * Keep arms few. Legacy credit-spread snapshots (before variants existed) seed
 * the 0.30 arm they all traded; legacy condor snapshots used the old symmetric
 * structure and are skipped, so the condor arms start fresh.
 *
 * Disable with STRATEGY_TUNER=0 (falls back to the static 0.30 spec).
 */
import type { StrategyType } from '../engine/types.js'
import type { Regime } from '../engine/index.js'
import type { LegSpec } from '../engine/liveStrategies.js'
import type { RecommendationSnapshot } from './types.js'
import { outcomePnl } from './calibration.js'

export const TUNER_ENABLED = process.env.STRATEGY_TUNER !== '0'

// Credit spreads sell one leg near the money; arms tune that short delta.
export const SHORT_DELTA_ARMS = [0.25, 0.3, 0.35] as const
export const DEFAULT_SHORT_DELTA = 0.3
/** Long wing stays at the spec's 10-delta; only the short leg is tuned. */
const WING_DELTA = 0.1

// The iron condor arm tunes the PUT short delta; the call short drifts off it
// (CONDOR_CALL_DRIFT, keeping the put-skew) and both long wings are placed an
// EQUAL dollar width from their short (CONDOR_WING_PCT). Condors sell further
// OTM than one-sided credit spreads, hence their own, lower arm set.
export const CONDOR_ARMS = [0.16, 0.2, 0.24] as const
export const DEFAULT_CONDOR_PUT_DELTA = 0.2
const CONDOR_CALL_DRIFT = 0.07 // call short sits this many Δ further OTM than the put short
const CONDOR_MIN_CALL_SHORT = 0.08 // don't let the tightest arm collapse the call short
// Both long wings are placed this fraction of their same-side SHORT STRIKE away
// (equal-$ wings), instead of a Δ offset — a Δ offset produced wildly unequal
// dollar widths under skew (25-wide put / 5-wide call), decoupling maxLoss (and
// therefore normalizedReward) from realized $. See test/condorWings.test.ts.
const CONDOR_WING_PCT = 0.02
// Structure epoch: bump when the condor leg geometry changes so legacy snapshots
// (recorded under the old structure) map to a DIFFERENT variant id and cannot
// pollute the new arms' posteriors. 'w2' = the equal-$ wing structure.
export const CONDOR_STRUCT_EPOCH = 'w2'

export const TUNED_STRATEGIES: ReadonlyArray<StrategyType> = [
  'bull_put_spread',
  'bear_call_spread',
  'iron_condor'
]

/** Candidate short deltas (arms) for a tuned strategy. */
export function armsFor(strategy: StrategyType): readonly number[] {
  return strategy === 'iron_condor' ? CONDOR_ARMS : SHORT_DELTA_ARMS
}

/** Arm a tuned strategy falls back to when no posterior wins. */
function defaultDeltaFor(strategy: StrategyType): number {
  return strategy === 'iron_condor' ? DEFAULT_CONDOR_PUT_DELTA : DEFAULT_SHORT_DELTA
}

// Pre-variant history: credit spreads all traded the hardcoded 0.30 short delta,
// so their variant-less snapshots seed that arm. The condor is DELIBERATELY
// absent — its pre-tuner snapshots used a different (symmetric, wide-wing)
// structure that maps to no current arm, so they're skipped and the condor arms
// start fresh (see buildArmStats).
const LEGACY_DEFAULT: Partial<Record<StrategyType, number>> = {
  bull_put_spread: DEFAULT_SHORT_DELTA,
  bear_call_spread: DEFAULT_SHORT_DELTA
}

export function variantId(shortDelta: number, strategy: StrategyType): string {
  const base = `sd${shortDelta.toFixed(2)}`
  // strategy is REQUIRED so a condor call can't silently drop its structure
  // epoch: the epoch keeps legacy (old-geometry) snapshots from matching a live
  // arm — see CONDOR_STRUCT_EPOCH.
  return strategy === 'iron_condor' ? `${base}@${CONDOR_STRUCT_EPOCH}` : base
}

/**
 * key `${strategy}|${regime}|${variant}` → mean-variance sufficient stats over
 * per-trade RAW per-share P&L (= $/contract ÷ 100 — NOT pnl/spot). The account
 * trades a FIXED number of contracts, so the objective is absolute $/trade; arms
 * are ranked by mean P&L, with variance driving exploration (see pickShortDelta).
 * Return-on-risk (÷maxLoss) OR return-on-notional (÷spot) both favor the wrong
 * arm regardless of realized $ — the reward↔$ inversion the offline replay caught.
 */
export type ArmStats = Map<string, { n: number; sum: number; sumSq: number }>

export function armKey(strategy: StrategyType, regime: Regime, variant: string): string {
  return `${strategy}|${regime}|${variant}`
}

export function buildArmStats(snaps: RecommendationSnapshot[]): ArmStats {
  const stats: ArmStats = new Map()
  // A surfaced (dashboard) row and its same-day shadow row describe the SAME
  // arm on the same underlying's path — count once, preferring the surfaced row.
  const surfaced = new Set<string>()
  for (const s of snaps) {
    if (s.source !== 'shadow' && s.variant != null) {
      surfaced.add(`${s.etDay}|${s.sym}|${s.strategyId}|${s.variant}`)
    }
  }
  for (const s of snaps) {
    if (!TUNED_STRATEGIES.includes(s.strategyId)) continue
    if (!s.outcome) continue
    if (s.source === 'shadow' && surfaced.has(`${s.etDay}|${s.sym}|${s.strategyId}|${s.variant}`)) continue
    const pnl = outcomePnl(s.outcome)
    if (pnl == null) continue
    // Attribute to the recorded arm; variant-less snapshots seed the strategy's
    // legacy default. The condor has no legacy default (structure changed) → its
    // variant-less snapshots are skipped so the new arms start uncontaminated.
    const legacy = LEGACY_DEFAULT[s.strategyId]
    const v = s.variant ?? (legacy != null ? variantId(legacy, s.strategyId) : null)
    if (v == null) continue
    const k = armKey(s.strategyId, s.regime, v)
    const cur = stats.get(k) ?? { n: 0, sum: 0, sumSq: 0 }
    // Reward = raw per-share P&L (= $/contract ÷ 100). The account trades a
    // FIXED number of contracts, so the objective is absolute $/trade — NOT
    // return-on-notional. Dividing by spot (return) re-inverts the ranking: it
    // over-credits wins on cheap underlyings, so a lower-$ arm that lands more
    // on low-priced names scores higher (the OOS replay confirmed this).
    const r = pnl
    cur.n++
    cur.sum += r
    cur.sumSq += r * r
    stats.set(k, cur)
  }
  return stats
}

// ---------- Gaussian sampling (Box–Muller) ----------

function sampleNormal(rng: () => number): number {
  let u = 0
  let v = 0
  while (u === 0) u = rng()
  while (v === 0) v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

// ---------- Arm selection ----------

export type VariantPick = { shortDelta: number; variant: string }

// Prior over an arm's mean per-trade P&L ($/share, ~O(1)). Neutral mean; a wide
// spread so an unexplored arm samples broadly and gets explored, while a
// well-sampled arm converges to its realized mean.
const ARM_PRIOR_MEAN = 0
const ARM_PRIOR_SE = 0.6

/**
 * Thompson-sample a short delta for `strategy` in `regime`. Each arm's posterior
 * over its MEAN per-trade P&L is Normal(mean, se): se combines the sampling
 * error (variance/n) with a prior spread so few-trade arms keep exploring.
 * Unexplored arms sample Normal(ARM_PRIOR_MEAN, ARM_PRIOR_SE). Ranking by mean
 * P&L maximizes absolute $/trade (fixed-contract account); variance only explores.
 * Returns null for strategies outside the tuned set.
 */
export function pickShortDelta(
  strategy: StrategyType,
  regime: Regime,
  stats: ArmStats,
  rng: () => number = Math.random
): VariantPick | null {
  if (!TUNED_STRATEGIES.includes(strategy)) return null
  let bestDelta = defaultDeltaFor(strategy)
  let bestSample = -Infinity
  for (const d of armsFor(strategy)) {
    const s = stats.get(armKey(strategy, regime, variantId(d, strategy)))
    let mean: number
    let se: number
    if (!s || s.n === 0) {
      mean = ARM_PRIOR_MEAN
      se = ARM_PRIOR_SE
    } else {
      mean = s.sum / s.n
      const variance = Math.max(s.sumSq / s.n - mean * mean, 0)
      se = Math.sqrt(variance / s.n + (ARM_PRIOR_SE * ARM_PRIOR_SE) / (s.n + 1))
    }
    const sample = mean + sampleNormal(rng) * se
    if (sample > bestSample) {
      bestSample = sample
      bestDelta = d
    }
  }
  return { shortDelta: bestDelta, variant: variantId(bestDelta, strategy) }
}

/**
 * Leg specs for a tuned strategy at the chosen short delta.
 *   credit spreads: shortDelta = the single short leg; wing fixed at 10Δ.
 *   iron_condor:    shortDelta = the PUT short; the call short drifts off it and
 *                   both long wings are equal-$ (widthPctFromShort). See the
 *                   CONDOR_* constants.
 */
export function legsForShortDelta(strategy: StrategyType, shortDelta: number): LegSpec[] | null {
  if (strategy === 'bull_put_spread') {
    return [
      { type: 'put', action: 'sell', targetDelta: shortDelta },
      { type: 'put', action: 'buy', targetDelta: WING_DELTA }
    ]
  }
  if (strategy === 'bear_call_spread') {
    return [
      { type: 'call', action: 'sell', targetDelta: shortDelta },
      { type: 'call', action: 'buy', targetDelta: WING_DELTA }
    ]
  }
  if (strategy === 'iron_condor') {
    const putShort = shortDelta
    const callShort = Math.max(putShort - CONDOR_CALL_DRIFT, CONDOR_MIN_CALL_SHORT)
    return [
      { type: 'put', action: 'sell', targetDelta: putShort },
      { type: 'put', action: 'buy', widthPctFromShort: CONDOR_WING_PCT },
      { type: 'call', action: 'sell', targetDelta: callShort },
      { type: 'call', action: 'buy', widthPctFromShort: CONDOR_WING_PCT }
    ]
  }
  return null
}

/**
 * Rebuild the scanner's chosen leg-spec overrides from the frozen variant ids it
 * attached to each opp (e.g. { iron_condor: 'sd0.24' }). The detail page (`/api/
 * strategies/live`) re-runs the engine fresh; without replaying these it would
 * use the STATIC default specs and surface a different structure than the card.
 * Deterministic — no armStats / probing needed: variant id ↔ short delta ↔ legs.
 */
export function specOverridesFromVariants(
  variants: Partial<Record<StrategyType, string>>
): Partial<Record<StrategyType, LegSpec[]>> {
  const out: Partial<Record<StrategyType, LegSpec[]>> = {}
  for (const [key, variant] of Object.entries(variants)) {
    const st = key as StrategyType
    if (!variant) continue
    const delta = armsFor(st).find((d) => variantId(d, st) === variant)
    if (delta == null) {
      // Unknown/stale variant (e.g. a pre-@w2 condor bookmark or an old deep
      // link). Don't silently fall back to the default arm — warn so a wrong
      // structure is visible; the caller then renders the default arm.
      console.warn(`[tuner] stale/unknown variant ${st}=${variant}; falling back to default arm`)
      continue
    }
    const legs = legsForShortDelta(st, delta)
    if (legs) out[st] = legs
  }
  return out
}
