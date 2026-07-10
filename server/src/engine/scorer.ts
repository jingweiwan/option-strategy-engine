import { totalPnL, findBreakevens, theoreticalExtremes, netPremium } from './payoff.js'
import { runManagedExit, type MarkContext, type ExitPolicy } from './managedExit.js'
import type { OptionLeg, RiskMetrics } from './types.js'

export function evaluateStrategy(
  pricePaths: number[],
  legs: OptionLeg[],
  discount: number
): RiskMetrics {
  const n = pricePaths.length
  if (n === 0) {
    throw new Error('evaluateStrategy: pricePaths is empty — cannot compute metrics')
  }
  const pnls = new Array<number>(n)
  let sum = 0
  let win = 0
  let simMaxProfit = -Infinity
  let simMaxLoss = Infinity

  for (let i = 0; i < n; i++) {
    const pnl = totalPnL(legs, pricePaths[i]) * discount
    pnls[i] = pnl
    sum += pnl
    if (pnl > 0) win++
    if (pnl > simMaxProfit) simMaxProfit = pnl
    if (pnl < simMaxLoss) simMaxLoss = pnl
  }

  const ev = sum / n
  let varSum = 0
  for (let i = 0; i < n; i++) varSum += (pnls[i] - ev) ** 2
  const stdDev = Math.sqrt(varSum / n)

  const sorted = [...pnls].sort((a, b) => a - b)
  const idx95 = Math.floor(0.05 * n)
  const var95 = sorted[idx95]
  let cvarSum = 0
  for (let i = 0; i <= idx95; i++) cvarSum += sorted[i]
  const cvar95 = cvarSum / (idx95 + 1)

  const sharpe = stdDev > 0 ? ev / stdDev : 0

  // Avoid spread operator for large arrays (stack overflow at ~65k elements)
  let lo = pricePaths[0]
  let hi = pricePaths[0]
  for (let i = 1; i < n; i++) {
    if (pricePaths[i] < lo) lo = pricePaths[i]
    if (pricePaths[i] > hi) hi = pricePaths[i]
  }
  const breakevens = findBreakevens(legs, lo * 0.8, hi * 1.2)

  const { theoMaxProfit, theoMaxLoss, unboundedProfit, unboundedLoss } =
    theoreticalExtremes(legs)

  return {
    ev,
    stdDev,
    sharpe,
    var95,
    cvar95,
    simMaxProfit,
    simMaxLoss,
    theoMaxProfit,
    theoMaxLoss,
    unboundedProfit,
    unboundedLoss,
    probabilityProfit: win / n,
    breakevens
  }
}

/**
 * Managed-exit evaluation: walk each simulated PATH through the same
 * take-profit / stop-loss rules the backtester applies to real bars, so the
 * displayed POP/EV equal what the feedback loop learns from. `maxSteps` is the
 * strategy-aware management window (how far down each path to walk).
 *
 * Structural fields (theoretical extremes, breakevens) stay payoff-based; the
 * sampled fields (ev, POP, var, cvar, sim extremes) come from managed outcomes.
 */
export function evaluateStrategyManaged(
  pricePaths: number[][],
  legs: OptionLeg[],
  mark: MarkContext,
  policy: ExitPolicy = 'managed'
): RiskMetrics {
  const n = pricePaths.length
  if (n === 0) {
    throw new Error('evaluateStrategyManaged: no paths')
  }
  const np = netPremium(legs)
  const pnls = new Array<number>(n)
  let sum = 0
  let win = 0
  let simMaxProfit = -Infinity
  let simMaxLoss = Infinity

  for (let i = 0; i < n; i++) {
    const pnl = runManagedExit(legs, pricePaths[i], np, mark, policy).pnl
    pnls[i] = pnl
    sum += pnl
    if (pnl > 0) win++
    if (pnl > simMaxProfit) simMaxProfit = pnl
    if (pnl < simMaxLoss) simMaxLoss = pnl
  }

  const ev = sum / n
  let varSum = 0
  for (let i = 0; i < n; i++) varSum += (pnls[i] - ev) ** 2
  const stdDev = Math.sqrt(varSum / n)
  const sharpe = stdDev > 0 ? ev / stdDev : 0

  const sorted = [...pnls].sort((a, b) => a - b)
  const idx95 = Math.floor(0.05 * n)
  const var95 = sorted[idx95]
  let cvarSum = 0
  for (let i = 0; i <= idx95; i++) cvarSum += sorted[i]
  const cvar95 = cvarSum / (idx95 + 1)

  const strikes = legs.map((l) => l.strike)
  const lo = Math.min(...strikes) * 0.7
  const hi = Math.max(...strikes) * 1.3
  const breakevens = findBreakevens(legs, lo, hi)

  const { theoMaxProfit, theoMaxLoss, unboundedProfit, unboundedLoss } =
    theoreticalExtremes(legs)

  return {
    ev,
    stdDev,
    sharpe,
    var95,
    cvar95,
    simMaxProfit,
    simMaxLoss,
    theoMaxProfit,
    theoMaxLoss,
    unboundedProfit,
    unboundedLoss,
    probabilityProfit: win / n,
    breakevens
  }
}
