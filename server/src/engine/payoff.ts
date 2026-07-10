import type { OptionLeg } from './types.js'

function intrinsic(leg: OptionLeg, price: number): number {
  if (leg.type === 'call') return Math.max(0, price - leg.strike)
  return Math.max(0, leg.strike - price)
}

export function legPnL(leg: OptionLeg, price: number): number {
  const value = intrinsic(leg, price)
  const sign = leg.action === 'buy' ? 1 : -1
  const cost = leg.action === 'buy' ? leg.premium : -leg.premium
  return (sign * value - cost) * leg.quantity
}

export function totalPnL(legs: OptionLeg[], price: number): number {
  let s = 0
  for (const leg of legs) s += legPnL(leg, price)
  return s
}

export function netPremium(legs: OptionLeg[]): number {
  let s = 0
  for (const leg of legs) {
    const sign = leg.action === 'buy' ? -1 : 1
    s += sign * leg.premium * leg.quantity
  }
  return s
}

export function netGreeks(legs: OptionLeg[]) {
  const acc = { delta: 0, gamma: 0, theta: 0, vega: 0 }
  for (const leg of legs) {
    const sign = leg.action === 'buy' ? 1 : -1
    acc.delta += sign * leg.greeks.delta * leg.quantity
    acc.gamma += sign * leg.greeks.gamma * leg.quantity
    acc.theta += sign * leg.greeks.theta * leg.quantity
    acc.vega += sign * leg.greeks.vega * leg.quantity
  }
  return acc
}

export function theoreticalExtremes(legs: OptionLeg[]) {
  let slopeUp = 0
  let slopeDown = 0
  for (const leg of legs) {
    const sign = leg.action === 'buy' ? 1 : -1
    if (leg.type === 'call') slopeUp += sign * leg.quantity
    else slopeDown += -sign * leg.quantity
  }

  const unboundedProfit = slopeUp > 0
  // slopeUp < 0: naked short call — price → ∞ causes unbounded loss
  // slopeDown > 0: naked short put — price → 0 causes large loss (bounded by strike,
  //   but we flag it as "unbounded" since the loss can vastly exceed premium received)
  // Note: slopeDown < 0 means LONG puts dominate → defined risk (profit capped at strike)
  const unboundedLoss = slopeUp < 0 || slopeDown > 0

  const strikes = Array.from(new Set(legs.map((l) => l.strike))).sort((a, b) => a - b)
  const checkpoints = [0, ...strikes]
  const payoffs = checkpoints.map((p) => totalPnL(legs, p))

  let theoMaxProfit = Math.max(...payoffs)
  let theoMaxLoss = Math.min(...payoffs)

  if (unboundedProfit) theoMaxProfit = Infinity
  if (unboundedLoss) theoMaxLoss = -Infinity

  return { theoMaxProfit, theoMaxLoss, unboundedProfit, unboundedLoss }
}

export function findBreakevens(legs: OptionLeg[], lo: number, hi: number, steps = 2000): number[] {
  const xs: number[] = []
  const dx = (hi - lo) / steps
  let prev = totalPnL(legs, lo)
  for (let i = 1; i <= steps; i++) {
    const p = lo + dx * i
    const cur = totalPnL(legs, p)
    if ((prev <= 0 && cur > 0) || (prev >= 0 && cur < 0)) {
      const t = prev / (prev - cur)
      xs.push(p - dx + dx * t)
    }
    prev = cur
  }
  return xs
}
