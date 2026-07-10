/**
 * "今日机会" cards — engine-driven + AI copywriting.
 *
 * Flow:
 *   1. oppScanner runs the real engine across watchlist × multiple expirations
 *   2. Top N results (by engine score) become the opp cards
 *   3. AI writes thesis + why (copywriting only, no strategy selection)
 *
 * Cached per ET calendar day, 12h TTL.
 */

import { chatJson, type AiMessage } from './client.js'
import { cached, getCachedIfValid, etCalendarDay, HOUR } from './cache.js'
import type { ScannedOpp } from '../engine/oppScanner.js'
import type { StrategyType } from '../engine/types.js'

// ---------- Types ----------

export type OppTag = '财报' | '高 IV' | '事件'

export type OppLeg = {
  type: 'call' | 'put'
  action: 'buy' | 'sell'
  strike: number
  premium: number
}

/** Suggested trade-management rules (per-share P&L, same units as netPremium).
 *  profitTarget/rollDte are null for the 'runner' exit arm (no TP, no early roll). */
export type OppManagement = {
  profitTarget: number | null
  stopLoss: number
  rollDte: number | null
  note: string
}

export type Opp = {
  sym: string
  thesis: string
  strategy: string
  strategyId: ScannedOpp['strategyId']
  expiration: string
  edge: string
  pop: number
  ev: number
  ivr: number
  dte: number
  spot: number
  netPremium: number
  maxProfit: number | null
  maxLoss: number | null
  breakevens: number[]
  legs: OppLeg[]
  why: string
  /** 2-3 sentence analyst-grade reasoning */
  analysis: string
  tag: OppTag
  /** Suggested profit-target / stop-loss / roll rules. */
  management: OppManagement
  /** AI directional view that guided strategy selection */
  aiView?: string | null
  aiViewReason?: string | null
  /** Buy regime (RV>IV): the engine has no proven edge here — surfaced so the
   *  card can carry a low-conviction badge. */
  lowConviction?: boolean
  /** Auto-board tier: 'qualified' recommends, 'reference' is a labeled near-miss
   *  (IVR below the floor) shown as "参考位 · 不建议开仓". */
  boardTier?: 'qualified' | 'reference'
}

// ---------- AI copywriting ----------

const CREDIT_IDS = new Set<StrategyType>(['iron_condor', 'short_strangle', 'bear_call_spread', 'bull_put_spread'])

const SYSTEM = `你是一位资深期权策略分析师，擅长结合波动率定价分析和引擎量化结果，给出有交易指导价值的判断。

引擎已经用真实期权链跑完蒙特卡洛模拟，选出了每个标的的最优策略。你的任务是为每个机会写出**分析师级别**的推荐报告。

**你会收到：** 每条含 strategyId、positionKind、IV、RV（已实现波动率）、ivRvGap（IV-RV缺口）、regime（引擎判定的市场环境）、legs（具体合约腿）、breakevens（盈亏平衡点）、aiView（AI方向性判断）、aiViewReason（判断理由）等。

**netPremium 符号约定（极其重要）：**
- **正数**：净收取权利金 → **信用 / 卖方**（Credit），可说「收取权利金」。
- **负数**：净支付权利金 → **债务 / 买方**（Debit），必须说「净支出」「Debit」，**禁止**说「收割 premium」。

**策略与 positionKind 对应（以输入字段为准）：**
- iron_condor、short_strangle、bear_call_spread、bull_put_spread → 信用卖方
- bull_call_spread、bear_put_spread、long_straddle → 债务买方

**你输出：** 对每个机会，写 thesis + why + analysis + tag。

**规则：**
1. thesis: ≤ 15 字，核心立场（如「IV 溢价 7pp 卖方收租」「RV > IV 买入波动」）
2. why: 50-100 字，引用 IV、RV、IV-RV 缺口、IVR、DTE、POP、EV、netPremium、regime 等数据
3. analysis: 100-200 字，**分析师深度判断**，必须包含：
   - **方向性逻辑**：引用 aiView 和 aiViewReason 解释为什么选了这个方向（看涨/看跌/中性/看波动），如果 aiView 存在，必须在 analysis 中说明
   - IV-RV 缺口的交易含义（期权是贵了还是便宜了）
   - 为什么引擎选了这个策略而非其他（aiView 方向 + regime 波动率定价 的组合逻辑）
   - 具体合约腿的定价优势（引用 legs 中的行权价和权利金）
   - 风险提示（breakeven 位置、最大亏损、什么情况下策略失效）
4. tag: 根据策略和市场状态
   - iron_condor / short_strangle / bear_call_spread / bull_put_spread 且 regime=sell → "高 IV"
   - long_straddle → "事件"
   - bull_call_spread / bear_put_spread → "事件"
   - 近期有财报（earn 字段非 "—"） → 优先标 "财报"
5. 中文为主，术语保留英文（IV、RV、IVR、POP、EV、DTE、Debit、Credit、theta 等）
6. 不要编造数字，所有数字从输入中引用
7. 语气：专业、克制、有判断力。不要空泛的废话，每句话要能指导交易决策。

**输出格式：** JSON 数组，与输入顺序一致。
[{ "thesis": "...", "why": "...", "analysis": "...", "tag": "高 IV" }]
不要 markdown，直接 JSON。`

function positionKind(strategyId: StrategyType): 'credit' | 'debit' {
  return CREDIT_IDS.has(strategyId) ? 'credit' : 'debit'
}

/**
 * Suggested management rules — mirrors the managed-exit simulation in
 * feedback/outcome.ts so the cards show the same thresholds the backtest uses.
 *   Credit: take 50% of credit, stop at 2× credit, roll ~21 DTE
 *   Debit:  take 100% of debit (1:1), stop at 50% debit, roll ~21 DTE
 */
function buildManagement(
  strategyId: StrategyType,
  netPremium: number,
  exitPolicy?: 'managed' | 'runner' | null
): OppManagement {
  const amt = Math.abs(netPremium)
  if (CREDIT_IDS.has(strategyId)) {
    if (exitPolicy === 'runner') {
      // Condor exit A/B experimental arm: no take-profit, ride to expiration.
      return {
        profitTarget: null,
        stopLoss: amt * 2,
        rollDte: null,
        note: '实验组：扛到期吃满权利金，不设止盈；仅浮亏达 2× 权利金止损兜底'
      }
    }
    return {
      profitTarget: amt * 0.5,
      stopLoss: amt * 2,
      rollDte: 21,
      note: '收回 50% 权利金即离场；浮亏达 2× 权利金止损；≤21 DTE 移仓避免 gamma 风险'
    }
  }
  return {
    profitTarget: amt,
    stopLoss: amt * 0.5,
    rollDte: 21,
    note: '盈利达已付 Debit（1:1）离场；亏损 50% Debit 止损；≤21 DTE 了结'
  }
}

function netPremiumWords(strategyId: StrategyType, net: number): string {
  const abs = Math.abs(net).toFixed(2)
  if (CREDIT_IDS.has(strategyId)) {
    return `信用：净收取权利金 $${abs}（netPremium=${net.toFixed(2)}）`
  }
  return `债务：净支付权利金 $${abs} / Debit $${abs}（netPremium=${net.toFixed(2)}，负号表示现金流出）`
}

function buildUserPrompt(opps: ScannedOpp[], earns: Record<string, string>): string {
  const data = opps.map((o) => {
    const pk = positionKind(o.strategyId)
    const rv = o.rvAtScan
    const ivPct = (o.iv * 100).toFixed(1)
    const rvPct = rv != null ? (rv * 100).toFixed(1) : null
    const gap = rv != null ? ((o.iv - rv) * 100).toFixed(1) : null

    return {
      sym: o.sym,
      strategyId: o.strategyId,
      strategy: o.strategy,
      positionKind: pk,
      positionKindCn: pk === 'credit' ? '信用卖方' : '债务买方',
      spot: o.spot.toFixed(2),
      iv: ivPct + '%',
      rv: rvPct != null ? rvPct + '%' : '不可用',
      ivRvGap: gap != null ? gap + 'pp' : '不可用',
      ivr: Math.round(o.ivr),
      regime: o.regime,
      dte: o.dte,
      pop: (o.pop * 100).toFixed(1) + '%',
      ev: o.ev.toFixed(2),
      netPremium: o.netPremium.toFixed(2),
      netPremiumWords: netPremiumWords(o.strategyId, o.netPremium),
      maxProfit: o.maxProfit != null ? o.maxProfit.toFixed(2) : '无上限',
      maxLoss: o.maxLoss != null ? o.maxLoss.toFixed(2) : '无下限',
      breakevens: o.breakevens?.map((b) => '$' + b.toFixed(2)) ?? [],
      legs: o.legs?.map((l) => ({
        action: l.action === 'buy' ? '买' : '卖',
        type: l.type === 'call' ? 'Call' : 'Put',
        strike: '$' + l.strike,
        premium: '$' + l.premium.toFixed(2)
      })) ?? [],
      earn: earns[o.sym] ?? '—',
      aiView: o.aiView ?? '无（引擎根据 regime 和量化指标自动选择策略）',
      aiViewReason: o.aiViewReason ?? ''
    }
  })

  return `为以下引擎筛选出的机会写分析报告：

\`\`\`json
${JSON.stringify(data, null, 2)}
\`\`\`

输出 JSON 数组（与输入顺序一致）：
[{ "thesis": "≤15字核心立场", "why": "50-100字关键理由", "analysis": "100-200字深度分析", "tag": "高 IV" }]

直接 JSON，不要 markdown。`
}

type AiCopy = { thesis: string; why: string; analysis: string; tag: string }

// ---------- Tag inference (fallback when AI tag is invalid) ----------

const VALID_TAGS: Set<string> = new Set(['财报', '高 IV', '事件'])

function inferTag(opp: ScannedOpp, earn?: string): OppTag {
  if (earn && earn !== '—') return '财报'
  if (CREDIT_IDS.has(opp.strategyId) && opp.ivr >= 50) return '高 IV'
  return '事件'
}

/**
 * Validate AI-assigned tag against actual data.
 * Prevents contradictions like "高 IV" when IVR is actually low.
 */
function validateTag(aiTag: string, opp: ScannedOpp, earn?: string): OppTag {
  if (!VALID_TAGS.has(aiTag)) return inferTag(opp, earn)

  // "高 IV" requires IVR ≥ 40 — don't label low-IVR opps as high IV
  if (aiTag === '高 IV' && opp.ivr < 40) return inferTag(opp, earn)

  // "财报" should only be used when earnings data exists
  if (aiTag === '财报' && (!earn || earn === '—')) return inferTag(opp, earn)

  return aiTag as OppTag
}

// ---------- Edge formatting ----------

/** Display IVR-based edge as a descriptive label. */
function formatEdge(ivr: number): string {
  if (ivr >= 80) return 'IVR 极高'
  if (ivr >= 60) return 'IVR 偏高'
  if (ivr >= 40) return 'IVR 中位'
  if (ivr >= 20) return 'IVR 偏低'
  return 'IVR 极低'
}

// ---------- Public API ----------

/**
 * Build Opp cards from engine scan results + AI copywriting.
 * Cached per ET day (12h TTL).
 */
export async function buildOppsFromScan(
  scannedOpps: ScannedOpp[],
  earns: Record<string, string>
): Promise<Opp[]> {
  if (scannedOpps.length === 0) return []

  const symKey = [...new Set(scannedOpps.map((o) => o.sym))].sort().join(',')
  const key = `opps-copy-v6-${etCalendarDay()}-${symKey}`

  const hit = await getCachedIfValid<Opp[]>(key, 12 * HOUR)
  if (hit != null) return hit

  return cached<Opp[]>(key, 12 * HOUR, async () => {
    // AI writes thesis + why + tag
    let aiCopies: AiCopy[] = []
    try {
      const messages: AiMessage[] = [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: buildUserPrompt(scannedOpps, earns) }
      ]
      const { data, usage } = await chatJson<AiCopy[]>(messages, {
        model: 'deepseek-chat',
        temperature: 0.4,
        maxTokens: 4000
      })
      if (usage) {
        console.log(
          `[ai/opps-copy] tokens in=${usage.promptTokens} out=${usage.completionTokens}` +
            (usage.cachedTokens ? ` cached=${usage.cachedTokens}` : '')
        )
      }
      if (Array.isArray(data)) aiCopies = data
    } catch (err) {
      console.warn('[ai/opps-copy] AI copywriting failed:', (err as Error).message)
      // Fallback: generate basic copies without AI
    }

    // Merge engine data + AI copy
    const opps: Opp[] = scannedOpps.map((o, i) => {
      const copy = aiCopies[i]
      const tag = copy ? validateTag(copy.tag, o, earns[o.sym]) : inferTag(o, earns[o.sym])

      return {
        sym: o.sym,
        thesis: copy?.thesis?.slice(0, 30) ?? `${o.strategy}机会`,
        strategy: o.strategy,
        strategyId: o.strategyId,
        expiration: o.expiration,
        edge: formatEdge(o.ivr),
        pop: Math.round(o.pop * 100),
        ev: o.ev,
        ivr: Math.round(o.ivr),
        dte: o.dte,
        spot: o.spot,
        netPremium: o.netPremium,
        maxProfit: o.maxProfit,
        maxLoss: o.maxLoss,
        breakevens: o.breakevens ?? [],
        legs: (o.legs ?? []).map((l) => ({
          type: l.type,
          action: l.action,
          strike: l.strike,
          premium: l.premium
        })),
        why:
          copy?.why?.slice(0, 150) ??
          `IVR ${Math.round(o.ivr)}，POP ${(o.pop * 100).toFixed(0)}%，${netPremiumWords(o.strategyId, o.netPremium)}，引擎推荐 ${o.strategy}`,
        analysis:
          copy?.analysis?.slice(0, 400) ??
          `${o.sym} 当前 IV ${(o.iv * 100).toFixed(1)}%，引擎判定 regime=${o.regime}，推荐 ${o.strategy}。`,
        tag,
        management: buildManagement(o.strategyId, o.netPremium, o.exitPolicy),
        aiView: o.aiView ?? null,
        aiViewReason: o.aiViewReason ?? null,
        lowConviction: o.regime === 'buy',
        boardTier: o.boardTier
      }
    })

    console.log(`[ai/opps] built ${opps.length} opportunities:`, opps.map((o) => `${o.sym}/${o.strategyId}`).join(', '))
    return opps
  })
}
