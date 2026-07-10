/**
 * AI-powered directional view per symbol.
 *
 * Before the engine scores strategies, we ask DeepSeek for a fundamental
 * directional opinion (bullish / bearish / neutral) per symbol based on:
 *   - recent price action (chg%)
 *   - IV / IVR / RV dynamics
 *   - market context (SPY trend, VIX level)
 *   - upcoming catalysts (earnings, etc.)
 *
 * The view feeds into the engine's existing `viewBonus()` which gives
 * 1.6× weight to aligned strategies (e.g. bullish → bull_call_spread).
 *
 * Cached per ET calendar day, 12h TTL.
 */

import { chatJson, type AiMessage } from './client.js'
import { cached, getCachedIfValid, etCalendarDay, HOUR } from './cache.js'
import type { View } from '../engine/index.js'

// ---------- Types ----------

export type SymbolContext = {
  sym: string
  px: number | null
  chg: number | null
  /** 5-day cumulative return (%). */
  chg5d?: number | null
  /** 20-day cumulative return (%). */
  chg20d?: number | null
  /** Position within 52-week range (0=at low, 100=at high). */
  week52Pct?: number | null
  iv: number | null
  ivr: number | null
  rv: number | null
  em: number | null
  earn: string
  regime: string
  // Technical indicators
  /** RSI(14) value 0-100. */
  rsi14?: number | null
  /** MACD histogram (positive=bullish, negative=bearish). */
  macdHist?: number | null
  /** Whether price is above 20-day SMA. */
  aboveSma20?: boolean | null
  /** Whether price is above 50-day SMA. */
  aboveSma50?: boolean | null
  /** Latest volume / 20d avg volume. > 1.5 = unusual activity. */
  volumeRatio?: number | null
}

export type DirectionalView = {
  sym: string
  view: View
  confidence: number // 0-1
  reason: string     // 1-sentence rationale
}

// ---------- AI prompt ----------

const SYSTEM = `你是一位资深美股期权策略分析师。根据每个标的的市场数据和技术指标，给出**方向性判断**用于指导期权策略选择。

**你会收到：** 每个标的的：
- 价格与动量：现价(px)、当日涨跌(chg)、5日涨跌(chg5d)、20日涨跌(chg20d)
- 52周位置：week52Pct（0=52周低点，100=52周高点）
- 技术指标：RSI(14)、MACD柱状图(macdHist)、SMA 位置（aboveSma20/aboveSma50）、成交量比(volumeRatio)
- 波动率：IV、IVR、RV、regime、预期波动(em)
- 事件：近期财报(earn)

**你输出：** 对每个标的给出 view + confidence + reason。

**view 取值规则：**
- "bullish"：看涨（适合 bull_call_spread）
  - 趋势向上（chg5d > 2%、或 chg20d > 5%）
  - 技术面强势（MACD柱 > 0、RSI 50-70、价格在 SMA20 和 SMA50 之上）
  - 52周位置偏高不一定看空 — 强势股经常在高位运行
- "bearish"：看跌（适合 bear_put_spread）
  - 趋势向下（chg5d < -2%、或 chg20d < -5%）
  - 技术面弱势（MACD柱 < 0、RSI < 40、价格在 SMA20 和 SMA50 之下）
- "neutral"：中性/震荡（适合 iron_condor / short_strangle）
  - IVR 高（≥ 60）且趋势不明确 → 适合卖方收割时间价值
  - 技术面混合信号（部分看多部分看空）
- "neutral-vol"：看波动放大（适合 long_straddle）
  - IVR 极低（< 20）→ IV 可能均值回归
  - 临近财报/重大事件 + IV 偏低
  - 成交量异常放大（volumeRatio > 2）暗示大行情酝酿

**判断优先级：**
1. **趋势信号最重要**：chg5d + chg20d + MACD 三者共振 → 高 confidence 方向判断
2. **IVR 决定卖方 vs 买方**：IVR ≥ 60 且方向不明 → neutral；IVR < 20 → neutral-vol
3. **技术面辅助验证**：RSI 超买超卖、SMA 位置、成交量异常 → 调整 confidence
4. **chg 仅作参考**：当日 chg 可能为 0（假日/盘前），chg5d/chg20d 更可靠

**confidence 标定：**
- 0.3-0.4 = 数据大量缺失
- 0.5 = 数据有但信号极弱，各指标矛盾
- 0.55-0.65 = 一定信号（chg5d 1-3%，或技术面有倾向）
- 0.65-0.8 = 信号较强（趋势 + 技术面共振）
- 0.8-1.0 = 非常强信号（大幅波动 + 技术面一致 + 催化剂）
- **只要有 price 数据，confidence 至少给 0.55**

**多样性要求：不要所有标的都给 "neutral"！**
- chg5d > 2% 且 MACD > 0 → 必须给 "bullish"
- chg5d < -2% 且 MACD < 0 → 必须给 "bearish"
- IVR < 20 且趋势不明 → 给 "neutral-vol"
- 只有 IVR ≥ 60 + 方向不明 才给 "neutral"

**reason: ≤ 30 字，引用关键数据**

**输出 JSON 数组，与输入顺序一致：**
[{ "sym": "AAPL", "view": "bullish", "confidence": 0.7, "reason": "5日+3.2%，MACD翻多，RSI 58，趋势确立" }]
直接 JSON，不要 markdown。`

function fmtPct(v: number | null | undefined): string {
  if (v == null) return '不可用'
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}

function buildPrompt(symbols: SymbolContext[]): string {
  const data = symbols.map((s) => ({
    sym: s.sym,
    px: s.px != null ? `$${s.px.toFixed(2)}` : '不可用',
    chg: fmtPct(s.chg),
    chg5d: fmtPct(s.chg5d),
    chg20d: fmtPct(s.chg20d),
    week52Pct: s.week52Pct != null ? Math.round(s.week52Pct) : '不可用',
    iv: s.iv != null ? `${(s.iv * 100).toFixed(1)}%` : '不可用',
    ivr: s.ivr != null ? Math.round(s.ivr) : '不可用',
    rv: s.rv != null ? `${(s.rv * 100).toFixed(1)}%` : '不可用',
    em: s.em != null ? `±$${s.em.toFixed(2)}` : '不可用',
    regime: s.regime,
    rsi14: s.rsi14 ?? '不可用',
    macdHist: s.macdHist ?? '不可用',
    aboveSma20: s.aboveSma20 ?? '不可用',
    aboveSma50: s.aboveSma50 ?? '不可用',
    volumeRatio: s.volumeRatio ?? '不可用',
    earn: s.earn
  }))

  return `为以下标的给出方向性判断：

\`\`\`json
${JSON.stringify(data, null, 2)}
\`\`\`

输出 JSON 数组（与输入顺序一致）。直接 JSON，不要 markdown。`
}

type AiViewResult = {
  sym: string
  view: string
  confidence: number
  reason: string
}

const VALID_VIEWS = new Set<string>(['bullish', 'bearish', 'neutral', 'neutral-vol'])

// ---------- Public API ----------

/**
 * Get AI directional views for a batch of symbols.
 * Cached per ET day (12h TTL).
 */
export async function getDirectionalViews(
  symbols: SymbolContext[]
): Promise<Map<string, DirectionalView>> {
  if (symbols.length === 0) return new Map()

  const symKey = symbols.map((s) => s.sym).sort().join(',')
  const key = `directional-view-v2-${etCalendarDay()}-${symKey}`

  const hit = await getCachedIfValid<DirectionalView[]>(key, 12 * HOUR)
  if (hit != null) {
    return new Map(hit.map((v) => [v.sym, v]))
  }

  return new Map(
    (
      await cached<DirectionalView[]>(key, 12 * HOUR, async () => {
        try {
          const messages: AiMessage[] = [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: buildPrompt(symbols) }
          ]
          const { data, usage } = await chatJson<AiViewResult[]>(messages, {
            model: 'deepseek-chat',
            temperature: 0.3,
            maxTokens: 1500
          })
          if (usage) {
            console.log(
              `[ai/view] tokens in=${usage.promptTokens} out=${usage.completionTokens}` +
                (usage.cachedTokens ? ` cached=${usage.cachedTokens}` : '')
            )
          }

          if (!Array.isArray(data)) return fallbackViews(symbols)

          return data.map((d, i) => {
            const sym = d.sym ?? symbols[i]?.sym ?? 'UNKNOWN'
            const view = VALID_VIEWS.has(d.view) ? (d.view as View) : 'neutral'
            return {
              sym,
              view,
              confidence: typeof d.confidence === 'number' ? d.confidence : 0.5,
              reason: d.reason?.slice(0, 60) ?? ''
            }
          })
        } catch (err) {
          console.warn('[ai/view] directional view failed:', (err as Error).message)
          return fallbackViews(symbols)
        }
      })
    ).map((v) => [v.sym, v])
  )
}

/** Fallback: technicals-based heuristic when AI is unavailable. */
function fallbackViews(symbols: SymbolContext[]): DirectionalView[] {
  return symbols.map((s) => {
    let view: View = 'neutral'
    let conf = 0.4
    const dir = s.chg5d ?? s.chg
    const macd = s.macdHist

    if (s.regime === 'sell') {
      // High IVR sell regime: stay neutral unless strong directional signal
      if (dir != null && dir > 3 && macd != null && macd > 0) {
        view = 'bullish'; conf = 0.55
      } else if (dir != null && dir < -3 && macd != null && macd < 0) {
        view = 'bearish'; conf = 0.55
      } else {
        view = 'neutral'; conf = 0.5
      }
    } else if (s.regime === 'buy') {
      if (dir != null && dir > 2) { view = 'bullish'; conf = 0.55 }
      else if (dir != null && dir < -2) { view = 'bearish'; conf = 0.55 }
      else { view = 'neutral-vol'; conf = 0.5 }
    } else {
      // mid regime — use IVR + technicals
      if (s.ivr != null && s.ivr < 20) {
        view = 'neutral-vol'; conf = 0.55
      } else if (dir != null && dir > 2 && (macd == null || macd > 0)) {
        view = 'bullish'; conf = 0.55
      } else if (dir != null && dir < -2 && (macd == null || macd < 0)) {
        view = 'bearish'; conf = 0.55
      }
    }

    const reason = `fallback: chg5d=${dir?.toFixed(1) ?? '?'}% macd=${macd ?? '?'}`
    return { sym: s.sym, view, confidence: conf, reason: reason.slice(0, 60) }
  })
}
