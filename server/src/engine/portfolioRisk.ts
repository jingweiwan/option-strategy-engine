/**
 * Portfolio-level risk view (R1) — the "risk manager" layer on top of the
 * per-symbol signal engine.
 *
 * The engine ranks opportunities one symbol at a time; this aggregates the whole
 * recommended board into one book-level risk picture, answering the question the
 * per-card view can't: "if I took everything on the board, what is my NET
 * exposure, and where does it all hurt at once?"
 *
 * Why it matters: after the sell-vol refactor the board is mostly short-premium
 * structures on a watchlist of correlated large-caps. Individually each is a
 * defined-risk, high-POP trade; TOGETHER they are one concentrated short-vol /
 * short-gamma bet whose tail is correlation-1 — a market-wide IV spike or gap
 * hits every position simultaneously. That book-level tail is invisible on the
 * per-card view and is exactly what a real desk sizes against.
 *
 * v1 aggregates the RECOMMENDED basket at 1 contract each (broker positions
 * aren't reachable yet — see the RH bridge note). So the numbers show posture
 * and worst-case shape at unit size, not your actual dollar book.
 */
import type { ScannedOpp } from './oppScanner.js'
import { getDailyBars } from '../api/marketdata.js'
import { getAccountSize, rhAgeHours } from '../api/rhPositions.js'

const CONTRACT = 100 // shares per option contract → dollar-scale greeks / max loss

// Book-level risk budget: flag when the board's aggregate max loss exceeds this
// share of the account (real RH equity via the bridge file, ACCOUNT_SIZE env
// as fallback; RISK_BUDGET_PCT tunes the line).
const RISK_BUDGET_PCT = Number(process.env.RISK_BUDGET_PCT) || 10

export type BookRisk = {
  positions: number
  /** Net greeks, summed at 1 contract each (sign + relative magnitude = posture). */
  netDelta: number
  netGamma: number
  netVega: number
  netTheta: number
  /** Worst case if every defined-risk position hits max loss at once ($, 1 lot each). */
  aggMaxLossUsd: number
  /** Carry the book earns per day from theta ($, 1 lot each). */
  netThetaUsd: number
  undefinedRiskCount: number
  shortVolCount: number
  /** Account context (RH bridge file, else ACCOUNT_SIZE env); null when unset. */
  accountSize: number | null
  /** Where accountSize came from: 'rh' bridge or 'env' fallback. */
  accountSource: 'rh' | 'env' | null
  /** Hours since the RH bridge file was pulled; null when absent. */
  rhAgeHours: number | null
  /** aggMaxLossUsd as % of account; null when account size unset. */
  maxLossPctOfAccount: number | null
  /** Measured avg pairwise 60d return correlation across board symbols
   *  (null until enriched / not enough overlapping history). */
  avgPairwiseCorrelation: number | null
  /** Plain-language risk warnings, most important first. */
  flags: string[]
}

export function summarizeBookRisk(opps: ScannedOpp[]): BookRisk {
  let netDelta = 0
  let netGamma = 0
  let netVega = 0
  let netTheta = 0
  let aggMaxLoss = 0
  let undefinedRiskCount = 0
  let shortVolCount = 0

  for (const o of opps) {
    netDelta += o.delta
    netGamma += o.gamma
    netVega += o.vega
    netTheta += o.theta
    if (o.maxLoss == null) undefinedRiskCount++
    else aggMaxLoss += Math.abs(o.maxLoss)
    if (o.vega < 0) shortVolCount++
  }

  const n = opps.length
  const flags: string[] = []
  const acct = getAccountSize()
  const accountSize = acct?.size ?? null
  const accountSource = acct?.source ?? null
  const age = rhAgeHours()
  const maxLossPctOfAccount = accountSize ? (aggMaxLoss * CONTRACT) / accountSize * 100 : null

  if (n === 0) return {
    positions: 0, netDelta: 0, netGamma: 0, netVega: 0, netTheta: 0,
    aggMaxLossUsd: 0, netThetaUsd: 0, undefinedRiskCount: 0, shortVolCount: 0,
    accountSize, accountSource, rhAgeHours: age,
    maxLossPctOfAccount: null, avgPairwiseCorrelation: null, flags
  }

  if (maxLossPctOfAccount != null && maxLossPctOfAccount > RISK_BUDGET_PCT) {
    flags.push(
      `同时打满将抹掉账户 ${maxLossPctOfAccount.toFixed(1)}% —— 超过 ${RISK_BUDGET_PCT}% 风险预算线，考虑减仓/减名`
    )
  }

  if (netVega < 0) {
    flags.push(`净空 vega ${netVega.toFixed(2)} → 全市场 IV 上冲会同时打击整个篮子(尾部同向)`)
  }
  if (netGamma < 0) {
    flags.push(`净空 gamma ${netGamma.toFixed(2)} → 标的跳空时亏损加速(短 gamma 的压路机风险)`)
  }
  if (shortVolCount === n && n >= 2) {
    flags.push(`${n} 个仓位全是卖波动、且都在相关大盘股 → "分散"是假象,崩盘时相关性→1 一起爆`)
  } else if (shortVolCount > n / 2) {
    flags.push(`${shortVolCount}/${n} 仓位卖波动 → 篮子整体偏空波动`)
  }
  if (undefinedRiskCount > 0) {
    flags.push(`${undefinedRiskCount} 个无定义风险仓位 → 尾部无封顶`)
  }
  if (Math.abs(netDelta) > 1) {
    flags.push(`净 delta ${netDelta.toFixed(2)} → 篮子整体偏${netDelta > 0 ? '多' : '空'},不是方向中性`)
  }

  return {
    positions: n,
    netDelta, netGamma, netVega, netTheta,
    aggMaxLossUsd: aggMaxLoss * CONTRACT,
    netThetaUsd: netTheta * CONTRACT,
    undefinedRiskCount,
    shortVolCount,
    accountSize,
    accountSource,
    rhAgeHours: age,
    maxLossPctOfAccount,
    avgPairwiseCorrelation: null,
    flags
  }
}

// ---------- Measured correlation (A3) ----------

/** Pearson correlation of two aligned return series. */
function corr(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  let ma = 0, mb = 0
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i] }
  ma /= n; mb /= n
  let cov = 0, va = 0, vb = 0
  for (let i = 0; i < n; i++) {
    cov += (a[i] - ma) * (b[i] - mb)
    va += (a[i] - ma) ** 2
    vb += (b[i] - mb) ** 2
  }
  const d = Math.sqrt(va * vb)
  return d > 0 ? cov / d : 0
}

/** Pearson correlation of two dated return series over their shared dates.
 *  null when fewer than `minOverlap` (default 30) overlapping observations. */
export function pairwiseCorrelation(
  ra: Map<string, number>,
  rb: Map<string, number>,
  minOverlap = 30
): number | null {
  const dates = [...ra.keys()].filter((d) => rb.has(d))
  if (dates.length < minOverlap) return null
  return corr(dates.map((d) => ra.get(d)!), dates.map((d) => rb.get(d)!))
}

/** Avg pairwise correlation across symbols' date-aligned log returns.
 *  Pure + exported for tests. Pairs need ≥30 overlapping days. */
export function avgPairwiseCorrelation(returnsBySym: Map<string, Map<string, number>>): number | null {
  const syms = [...returnsBySym.keys()]
  if (syms.length < 2) return null
  const vals: number[] = []
  for (let i = 0; i < syms.length; i++) {
    for (let j = i + 1; j < syms.length; j++) {
      const rho = pairwiseCorrelation(returnsBySym.get(syms[i])!, returnsBySym.get(syms[j])!)
      if (rho != null) vals.push(rho)
    }
  }
  if (vals.length === 0) return null
  return vals.reduce((x, y) => x + y, 0) / vals.length
}

const CORR_LOOKBACK_DAYS = 90 // calendar days → ~60 trading bars

/**
 * Replace the assumed correlation-tail flag with a MEASURED one: fetch daily
 * bars (cached Nasdaq source) for the board's symbols, compute avg pairwise
 * 60d return correlation, and rewrite the flag with the number. Degrades to
 * the unmeasured summary on any data failure.
 */
export async function enrichBookRiskWithCorrelation(risk: BookRisk, opps: ScannedOpp[]): Promise<BookRisk> {
  const syms = [...new Set(opps.map((o) => o.sym))]
  if (syms.length < 2) return risk
  try {
    const to = new Date().toISOString().slice(0, 10)
    const from = new Date(Date.now() - CORR_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10)
    const returnsBySym = new Map<string, Map<string, number>>()
    await Promise.all(syms.map(async (sym) => {
      const bars = await getDailyBars(sym, from, to)
      const m = new Map<string, number>()
      for (let i = 1; i < bars.length; i++) {
        m.set(bars[i].date, Math.log(bars[i].close / bars[i - 1].close))
      }
      if (m.size >= 30) returnsBySym.set(sym, m)
    }))
    const rho = avgPairwiseCorrelation(returnsBySym)
    if (rho == null) return risk
    const flags = risk.flags.map((f) =>
      f.includes('相关大盘股')
        ? f.replace('且都在相关大盘股', `60 天平均两两相关 ${rho.toFixed(2)}`)
        : f
    )
    if (rho > 0.6 && !flags.some((f) => f.includes('两两相关'))) {
      flags.push(`板上标的 60 天平均两两相关 ${rho.toFixed(2)} → 高度同涨同跌，风险并不分散`)
    }
    return { ...risk, avgPairwiseCorrelation: rho, flags }
  } catch {
    return risk // measured correlation is best-effort; keep the assumed flag
  }
}
