/**
 * Pre-trade checklist — turns a recommended structure into the 10-point
 * "filter out bad trades before opening" review an experienced options trader
 * runs in their head:
 *
 *   1 事件  2 IV位置  3 剩余期限  4 Delta  5 流动性
 *   6 关键位  7 盈亏比  8 仓位  9 退出规则  10 盈利来源
 *
 * Each item is judged buyer-vs-seller aware (the same fact reads differently
 * for a premium buyer than a premium seller). Items 6 (key levels) and 8
 * (position sizing) are placeholders until macro/levels and broker data land.
 */
import type { StrategyType, OptionLeg, RiskMetrics } from './types.js'
import { getAccountSize } from '../api/rhPositions.js'

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'na'

export type ChecklistItem = {
  id: string
  label: string
  status: CheckStatus
  detail: string
}

export type PreTradeChecklist = {
  /** True for credit/premium-selling structures. */
  sellerSide: boolean
  /** Plain-language answer to "what does this trade make money on?" */
  profitSource: string
  items: ChecklistItem[]
  passCount: number
  warnCount: number
  failCount: number
}

export type ChecklistInput = {
  strategy: StrategyType
  legs: OptionLeg[]
  netPremium: number
  metrics: RiskMetrics
  iv: number
  ivRank: number
  currentRv?: number | null
  dte: number
  regime: 'sell' | 'buy' | 'mid'
  earningsDate?: string | null
  earningsInWindow?: boolean
}

const pct = (x: number, d = 0) => (x * 100).toFixed(d)

function maxAbsDelta(legs: OptionLeg[], action: 'buy' | 'sell'): number | null {
  const side = legs.filter((l) => l.action === action)
  if (side.length === 0) return null
  return Math.max(...side.map((l) => Math.abs(l.greeks?.delta ?? 0)))
}

function profitSourceFor(strategy: StrategyType, sellerSide: boolean): string {
  if (strategy === 'long_straddle') return '波动 + 速度(不押方向)'
  if (sellerSide) return '时间(Theta)+ 概率(高 POP)+ 风控'
  return '方向 + 速度'
}

export function buildPreTradeChecklist(input: ChecklistInput): PreTradeChecklist {
  const { strategy, legs, netPremium, metrics, iv, ivRank, currentRv, dte, regime } = input
  const sellerSide = netPremium > 0
  const ivRvGapPp = currentRv != null && currentRv > 0 ? (iv - currentRv) * 100 : null
  const items: ChecklistItem[] = []

  // 1 事件 ----------------------------------------------------------------
  if (input.earningsInWindow) {
    items.push({
      id: 'event', label: '事件', status: sellerSide ? 'warn' : 'pass',
      detail: sellerSide
        ? `财报 ${input.earningsDate} 在到期前 — 卖方防跳空(已计入跳空模型)`
        : `财报 ${input.earningsDate} 在到期前 — 买方可博这波波动`
    })
  } else {
    items.push({ id: 'event', label: '事件', status: 'pass', detail: '到期前无财报(宏观日历待接入)' })
  }

  // 2 IV 位置 / 风险溢价 ---------------------------------------------------
  {
    const ivr = Math.round(ivRank)
    const gapTxt = ivRvGapPp != null ? `,IV ${ivRvGapPp >= 0 ? '高于' : '低于'} RV ${Math.abs(ivRvGapPp).toFixed(1)}pp` : ''
    let status: CheckStatus
    let detail: string
    if (sellerSide) {
      if (regime === 'sell') { status = 'pass'; detail = `IVR ${ivr}${gapTxt} — 有风险溢价,适合卖` }
      else if (regime === 'mid') { status = 'warn'; detail = `IVR ${ivr}${gapTxt} — 溢价一般,权利金未必够厚` }
      else { status = 'fail'; detail = `IVR ${ivr}${gapTxt} — 在卖便宜的波动,不划算` }
    } else {
      if (regime === 'buy') { status = 'pass'; detail = `IVR ${ivr}${gapTxt} — IV 偏便宜,适合买` }
      else if (regime === 'mid') { status = 'warn'; detail = `IVR ${ivr}${gapTxt} — IV 中性,留意回落` }
      else { status = 'warn'; detail = `IVR ${ivr}${gapTxt} — IV 偏贵,小心方向对也被 IV 回落吃掉` }
    }
    items.push({ id: 'iv', label: 'IV 位置', status, detail })
  }

  // 3 剩余期限 / Gamma ----------------------------------------------------
  if (sellerSide) {
    items.push(dte < 14
      ? { id: 'dte', label: '剩余期限', status: 'warn', detail: `剩 ${dte} 天 — 临期 Gamma 变凶,价格一动盈亏摆动剧烈` }
      : { id: 'dte', label: '剩余期限', status: 'pass', detail: `剩 ${dte} 天 — Gamma 风险可控` })
  } else {
    items.push(dte < 10
      ? { id: 'dte', label: '剩余期限', status: 'warn', detail: `剩 ${dte} 天偏短 — 除非做事件/日内,否则 Theta 流血快` }
      : { id: 'dte', label: '剩余期限', status: 'pass', detail: `剩 ${dte} 天` })
  }

  // 4 Delta 位置 / 安全边际 -----------------------------------------------
  if (sellerSide) {
    const sd = maxAbsDelta(legs, 'sell')
    if (sd == null) items.push({ id: 'delta', label: 'Delta', status: 'na', detail: '无空头腿' })
    else items.push(sd <= 0.35
      ? { id: 'delta', label: 'Delta', status: 'pass', detail: `空头腿 ${pct(sd)} delta — 有安全边际` }
      : { id: 'delta', label: 'Delta', status: 'warn', detail: `空头腿 ${pct(sd)} delta — 离现价偏近,为多收权利金牺牲了安全边际` })
  } else {
    const ld = maxAbsDelta(legs, 'buy')
    if (ld == null) items.push({ id: 'delta', label: 'Delta', status: 'na', detail: '无多头腿' })
    else if (ld < 0.35) items.push({ id: 'delta', label: 'Delta', status: 'warn', detail: `主腿 ${pct(ld)} delta — 偏深虚,需要更大移动才回本` })
    else if (ld > 0.7) items.push({ id: 'delta', label: 'Delta', status: 'warn', detail: `主腿 ${pct(ld)} delta — 偏深实,成本高、弹性低` })
    else items.push({ id: 'delta', label: 'Delta', status: 'pass', detail: `主腿 ${pct(ld)} delta — 弹性合适` })
  }

  // 5 流动性 (legs already passed liquidContracts upstream) ----------------
  items.push({ id: 'liquidity', label: '流动性', status: 'pass', detail: '已通过流动性筛选:双边报价、OI≥5、买卖价差<40%' })

  // 6 关键位 — placeholder -------------------------------------------------
  items.push({ id: 'levels', label: '关键位', status: 'na', detail: '支撑/阻力/突破确认点 — 待接入' })

  // 7 盈亏比 / 最坏会亏多少 ------------------------------------------------
  {
    const pop = pct(metrics.probabilityProfit)
    if (sellerSide) {
      if (metrics.unboundedLoss) items.push({ id: 'rr', label: '盈亏比', status: 'fail', detail: `最坏亏损无界(裸卖)— 必须严格止损 + 留足保证金` })
      else items.push({ id: 'rr', label: '盈亏比', status: 'pass', detail: `最坏亏 $${Math.abs(metrics.theoMaxLoss).toFixed(2)},POP ${pop}% — 风险有界` })
    } else {
      const rr = metrics.unboundedProfit || metrics.theoMaxLoss === 0
        ? null : metrics.theoMaxProfit / Math.abs(metrics.theoMaxLoss)
      if (rr == null) items.push({ id: 'rr', label: '盈亏比', status: 'pass', detail: `最大赚不封顶,最多亏 $${Math.abs(metrics.theoMaxLoss).toFixed(2)}` })
      else items.push(rr >= 1.5
        ? { id: 'rr', label: '盈亏比', status: 'pass', detail: `盈亏比 ${rr.toFixed(1)}:1 — 赚 $${metrics.theoMaxProfit.toFixed(2)} / 亏 $${Math.abs(metrics.theoMaxLoss).toFixed(2)},值得` }
        : { id: 'rr', label: '盈亏比', status: 'warn', detail: `盈亏比 ${rr.toFixed(1)}:1 — 涨了也未必值得,赔率偏低` })
    }
  }

  // 8 仓位压力 — per-trade risk as % of account (ACCOUNT_SIZE env) ---------
  // Retail sizing bands: ≤2% of account at risk per trade = fine, 2–5% = heavy,
  // >5% = a single max-loss dents the account. Undefined-risk stays warn.
  const acct = getAccountSize()
  if (!acct) {
    items.push({ id: 'sizing', label: '仓位', status: 'na', detail: '刷新 RH 持仓或设置 ACCOUNT_SIZE 后自动评估单笔风险占比' })
  } else if (metrics.unboundedLoss || !Number.isFinite(metrics.theoMaxLoss)) {
    items.push({ id: 'sizing', label: '仓位', status: 'warn', detail: '无定义风险 — 单笔敞口无法按最大亏损预算' })
  } else {
    const riskPct = ((Math.abs(metrics.theoMaxLoss) * 100) / acct.size) * 100
    const detail = `1 张最大亏 $${(Math.abs(metrics.theoMaxLoss) * 100).toFixed(0)} ≈ 账户 ${riskPct.toFixed(2)}%`
    items.push(
      riskPct <= 2
        ? { id: 'sizing', label: '仓位', status: 'pass', detail: `${detail}（≤2% 预算内）` }
        : riskPct <= 5
          ? { id: 'sizing', label: '仓位', status: 'warn', detail: `${detail}（2–5%，偏重）` }
          : { id: 'sizing', label: '仓位', status: 'fail', detail: `${detail}（>5%，单笔过重）` }
    )
  }

  // 9 退出规则 ------------------------------------------------------------
  items.push(sellerSide
    ? { id: 'exit', label: '退出规则', status: 'pass', detail: '止盈:收回 50% 权利金 / 止损:2× 权利金 / ≤21DTE 移仓避 Gamma' }
    : { id: 'exit', label: '退出规则', status: 'pass', detail: '止盈:盈利翻倍先收回本金 / 止损:亏到 50% 成本直接走' })

  // 10 盈利来源 ------------------------------------------------------------
  const profitSource = profitSourceFor(strategy, sellerSide)
  items.push({ id: 'profit', label: '盈利来源', status: 'pass', detail: `靠 ${profitSource} 赚钱 — 逻辑说得清` })

  return {
    sellerSide,
    profitSource,
    items,
    passCount: items.filter((i) => i.status === 'pass').length,
    warnCount: items.filter((i) => i.status === 'warn').length,
    failCount: items.filter((i) => i.status === 'fail').length
  }
}
