import type { Greeks } from './types.js'

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x)
  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const p = 0.3275911
  const t = 1.0 / (1.0 + p * ax)
  const y =
    1.0 -
    (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax)
  return sign * y
}

export function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.sqrt(2)))
}

export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI)
}

export type BSInput = {
  type: 'call' | 'put'
  S: number
  K: number
  T: number
  r: number
  q: number
  sigma: number
}

export function blackScholes({ type, S, K, T, r, q, sigma }: BSInput): number {
  if (T <= 0 || sigma <= 0) {
    if (type === 'call') return Math.max(0, S - K)
    return Math.max(0, K - S)
  }

  const sqrtT = Math.sqrt(T)
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT)
  const d2 = d1 - sigma * sqrtT

  const Se = S * Math.exp(-q * T)
  const Ke = K * Math.exp(-r * T)

  if (type === 'call') {
    return Se * normCdf(d1) - Ke * normCdf(d2)
  }
  return Ke * normCdf(-d2) - Se * normCdf(-d1)
}

export function greeks({ type, S, K, T, r, q, sigma }: BSInput): Greeks {
  if (T <= 0 || sigma <= 0) {
    // At expiration or zero-vol: return intrinsic delta
    const intrinsicDelta =
      type === 'call'
        ? S > K ? 1 : S < K ? 0 : 0.5
        : S < K ? -1 : S > K ? 0 : -0.5
    return { delta: intrinsicDelta, gamma: 0, theta: 0, vega: 0 }
  }

  const sqrtT = Math.sqrt(T)
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT)
  const d2 = d1 - sigma * sqrtT
  const pdf = normPdf(d1)

  const delta =
    type === 'call'
      ? Math.exp(-q * T) * normCdf(d1)
      : Math.exp(-q * T) * (normCdf(d1) - 1)

  const gamma = (Math.exp(-q * T) * pdf) / (S * sigma * sqrtT)

  const theta =
    type === 'call'
      ? (-(S * Math.exp(-q * T) * pdf * sigma) / (2 * sqrtT) -
          r * K * Math.exp(-r * T) * normCdf(d2) +
          q * S * Math.exp(-q * T) * normCdf(d1)) /
        365
      : (-(S * Math.exp(-q * T) * pdf * sigma) / (2 * sqrtT) +
          r * K * Math.exp(-r * T) * normCdf(-d2) -
          q * S * Math.exp(-q * T) * normCdf(-d1)) /
        365

  const vega = (S * Math.exp(-q * T) * pdf * sqrtT) / 100

  return { delta, gamma, theta, vega }
}

export function strikeFromDelta(
  type: 'call' | 'put',
  targetDelta: number,
  S: number,
  T: number,
  r: number,
  q: number,
  sigma: number
): number {
  const target = type === 'call' ? Math.abs(targetDelta) : -Math.abs(targetDelta)
  let lo = S * 0.3
  let hi = S * 3
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    const g = greeks({ type, S, K: mid, T, r, q, sigma })
    if (type === 'call') {
      if (g.delta > target) lo = mid
      else hi = mid
    } else {
      if (g.delta < target) hi = mid
      else lo = mid
    }
  }
  return Math.round((lo + hi) / 2)
}
