/**
 * Phase B: AI-generated strategy rationale for /strategy page.
 *
 * Input: engine results (strategy type, legs, metrics, greeks) + market state
 *        (symbol, spot, IV, IVR, DTE, regime).
 * Output: Record<StrategyType, rationale string> — one paragraph per strategy.
 *
 * Cached per symbol + expiration + ET calendar day, 12h TTL.
 */

import { chatJson, type AiMessage } from './client.js'
import { cached, getCachedIfValid, etCalendarDay, HOUR } from './cache.js'

// ---------- Types ----------

export type RationaleInput = {
  symbol: string
  spot: number
  iv: number       // annualized ATM IV (0-1 scale)
  ivRank: number   // 0-100
  dte: number
  regime: 'sell' | 'buy' | 'mid'
  expectedMove: number
  /** Realized volatility (annualized, 0-1 scale). Optional. */
  currentRv?: number | null
  /** AI directional view (bullish / bearish / neutral / neutral-vol). Optional. */
  aiView?: string | null
  /** One-line reason behind the AI view. Optional. */
  aiViewReason?: string | null
  strategies: {
    strategy: string          // e.g. 'iron_condor'
    netPremium: number
    pop: number              // probabilityProfit (0-1)
    ev: number
    maxProfit: number | null  // null if unbounded
    maxLoss: number | null    // null if unbounded
    delta: number
    theta: number
    legs: { type: string; action: string; strike: number; premium: number }[]
  }[]
}

// ---------- Prompt ----------

const SYSTEM = `你是期权策略引擎的「策略深度分析」功能。为用户看到的每个策略写一段 **真实、有数据、有判断力的** 深度 rationale。

**规则：**
1. 每条 rationale **80-150 字**（中英混合，术语保留英文）
2. **必须引用输入中的真实数据**：IV、IVR、RV、IV-RV gap、DTE、EM、legs 的行权价、净权利金等
3. 不同策略类型重点不同：
   - bull_call_spread / bear_put_spread (debit) → 方向判断依据、debit 成本占 spread 比例、最大风险收益比、AI 方向性观点是否吻合
   - bear_call_spread / bull_put_spread (credit) → 方向判断依据、收取 credit 对比 spread 宽度、theta 衰减优势、IV-RV gap 是否支撑卖权、breakeven 与 spot 距离
   - iron_condor → IV-RV gap 是否支撑卖权、收取的 premium 对比风险宽度、theta/日 收益、IVR 水平
   - short_strangle → IVR 水平 + IV-RV gap 是否偏高、theta 衰减速度、裸露风险提示、适用场景
   - long_straddle → IV 偏低 + IV-RV gap 为负的机会、事件催化预期、盈亏平衡距离占 spot 百分比
4. **必须点评**：当前 regime（卖方有利 / 买方有利 / 中性）对该策略的影响
5. 若提供了 AI 方向性观点（aiView），**必须评价**策略方向是否与 AI 观点一致：一致=加分项，矛盾=需说明风险
6. 若提供了 RV，**必须点评** IV vs RV 的关系（IV > RV 说明隐含波动溢价，利于卖方；IV < RV 说明定价偏低，利于买方）
7. 数字保留 1-2 位小数，不要胡编乱造
8. Editorial 语气：简洁有判断力，像资深交易员点评，不要废话

**输出格式：** JSON object，key 是 strategy 名称（如 "iron_condor"），value 是 rationale 字符串。
不要 markdown，直接 JSON。`

function buildUserPrompt(input: RationaleInput): string {
  const rv = input.currentRv != null ? `${(input.currentRv * 100).toFixed(1)}%` : 'N/A'
  const ivRvGap =
    input.currentRv != null
      ? `${((input.iv - input.currentRv) * 100).toFixed(1)}pp（${input.iv > input.currentRv ? 'IV溢价，利卖方' : 'IV折价，利买方'}）`
      : 'N/A'

  let viewLine = ''
  if (input.aiView) {
    const labels: Record<string, string> = {
      bullish: '看涨', bearish: '看跌', neutral: '中性', 'neutral-vol': '看波动'
    }
    viewLine = `AI方向性观点: ${labels[input.aiView] ?? input.aiView}${input.aiViewReason ? `（${input.aiViewReason}）` : ''}`
  }

  return `为以下策略各写一段深度 rationale（80-150字）：

标的: ${input.symbol}
Spot: $${input.spot.toFixed(2)}
IV: ${(input.iv * 100).toFixed(1)}%
RV: ${rv}
IV-RV Gap: ${ivRvGap}
IVR: ${input.ivRank.toFixed(0)}
DTE: ${input.dte}d
EM: ±$${input.expectedMove.toFixed(2)}
Regime: ${input.regime === 'sell' ? '卖方有利' : input.regime === 'buy' ? '买方有利' : '中性'}
${viewLine ? viewLine + '\n' : ''}
策略列表：
\`\`\`json
${JSON.stringify(input.strategies, null, 2)}
\`\`\`

输出格式：
{
  "iron_condor": "80-150字深度分析，引用真实数据，点评 IV-RV 关系和 AI 观点一致性",
  "bull_call_spread": "..."
}

直接输出 JSON，不要 markdown。`
}

// ---------- Public API ----------

/**
 * Generate AI rationales for each strategy. Returns a Record<strategy, rationale>.
 * Cached per symbol + expiration + ET day (12h TTL).
 */
export async function getAiStrategyRationales(
  input: RationaleInput,
  expiration: string
): Promise<Record<string, string>> {
  const key = `rationale-${input.symbol}-${expiration}-${etCalendarDay()}`

  const hit = await getCachedIfValid<Record<string, string>>(key, 12 * HOUR)
  if (hit != null) return hit

  return cached<Record<string, string>>(key, 12 * HOUR, async () => {
    const messages: AiMessage[] = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: buildUserPrompt(input) }
    ]
    const { data, usage } = await chatJson<Record<string, string>>(messages, {
      model: 'deepseek-chat',  // lightweight model suffices
      temperature: 0.4,
      maxTokens: 2000
    })
    if (usage) {
      console.log(
        `[ai/rationale] ${input.symbol} tokens in=${usage.promptTokens} out=${usage.completionTokens}` +
          (usage.cachedTokens ? ` cached=${usage.cachedTokens}` : '')
      )
    }

    // Validate: must be an object with string values
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new Error('AI returned non-object for strategy rationales')
    }

    const result: Record<string, string> = {}
    for (const [strategy, rationale] of Object.entries(data)) {
      if (typeof rationale === 'string') {
        result[strategy] = rationale.slice(0, 300) // cap length
      }
    }

    console.log(`[ai/rationale] generated rationales for ${Object.keys(result).length} strategies (${input.symbol})`)
    return result
  })
}
