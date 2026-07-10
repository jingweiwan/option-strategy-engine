/**
 * Deterministic test fixtures.
 *
 * Builds a synthetic option chain whose premiums are internally consistent
 * (priced with the same Black–Scholes used to fill greeks), so the engine sees
 * realistic, well-formed data without touching any network/API. Combined with
 * a fixed RNG seed this makes the whole engine output reproducible.
 */

import { blackScholes } from '../src/engine/pricing.js'
import type { OptionContract } from '../src/api/types.js'

export const r2 = (x: number, p = 4): number => Math.round(x * 10 ** p) / 10 ** p

/** YYYY-MM-DD that is `days` calendar days from now (keeps DTE ~constant per run). */
export function expirationInDays(days: number): string {
  const d = new Date(Date.now() + days * 86400000)
  return d.toISOString().slice(0, 10)
}

export type ChainOpts = {
  spot?: number
  dteDays?: number
  iv?: number
  r?: number
  q?: number
  /** strike grid bounds + step */
  loStrike?: number
  hiStrike?: number
  step?: number
}

/**
 * Synthetic chain centered on `spot`. Greeks are left undefined on purpose so
 * the engine's enrichWithGreeks path is exercised (it fills them via BSM).
 */
export function syntheticChain(opts: ChainOpts = {}): {
  chain: OptionContract[]
  expiration: string
  spot: number
  dteDays: number
  iv: number
} {
  const spot = opts.spot ?? 100
  const dteDays = opts.dteDays ?? 30
  const iv = opts.iv ?? 0.3
  const rate = opts.r ?? 0.045
  const q = opts.q ?? 0
  const lo = opts.loStrike ?? 60
  const hi = opts.hiStrike ?? 140
  const step = opts.step ?? 2.5
  const T = dteDays / 365
  const expiration = expirationInDays(dteDays)

  const chain: OptionContract[] = []
  for (let K = lo; K <= hi + 1e-9; K += step) {
    const strike = r2(K, 2)
    for (const optionType of ['call', 'put'] as const) {
      const fair = blackScholes({ type: optionType, S: spot, K: strike, T, r: rate, q, sigma: iv })
      const mid = Math.max(0.05, r2(fair, 2))
      const halfSpread = Math.max(0.02, r2(mid * 0.02, 2)) // ~4% wide, well under 40% guard
      const bid = r2(Math.max(0.01, mid - halfSpread), 2)
      const ask = r2(mid + halfSpread, 2)
      chain.push({
        symbol: 'TEST',
        strike,
        optionType,
        bid,
        ask,
        mid: r2((bid + ask) / 2, 2),
        last: mid,
        openInterest: 500,
        volume: 100,
        expiration,
        iv
      })
    }
  }

  return { chain, expiration, spot, dteDays, iv }
}
