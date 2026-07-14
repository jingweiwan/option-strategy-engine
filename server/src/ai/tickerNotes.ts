/**
 * AI-generated one-liner notes for each watchlist ticker.
 *
 * Input: same live ticker data as opps (IV, IVR, EM, earn, chg).
 * Output: Record<sym, note> — one short sentence per ticker.
 *
 * Cached per ET calendar day, 12h TTL.
 */

import { chatJson, type AiMessage } from './client.js'
import { cached, getCachedIfValid, etCalendarDay, HOUR } from './cache.js'

// ---------- Types ----------

export type TickerNotesInput = {
  tickers: {
    sym: string
    px: number | null
    chg: number | null
    iv: number | null
    ivr: number | null
    /** false → IVR is an rv-fallback proxy (no real IV history), not trustworthy. */
    ivrReliable?: boolean
    em: number | null
    earn: string
  }[]
}

// ---------- Prompt ----------

const SYSTEM = `你是期权策略引擎的"引擎备注"功能。对自选表的每只标的，写 **一句话**（≤12 字）的交易视角备注。

**规则：**
1. 基于输入数据中的 IVR / IV / EM / earn / chg 做判断
2. 视角是"期权交易者看这只票应该注意什么"
3. 常见模式：
   - IVR ≥ 60 → 高 IV 卖方相关（"高 IV，适合卖方"、"IV 偏高，收 premium"）
   - IVR ≤ 25 → 低 IV 买方相关（"低 IV，买跨待事件"、"IV 偏低，关注催化"）
   - earn ≤ 14 天 → 财报相关（"财报前 IV 抬升"、"X 天后财报"）
   - |chg| > 2% → 动量相关（"放量上涨，趋势延续"、"急跌后 IV 扩张"）
   - 指数 ETF → 对冲相关（"对冲组合用"）
4. 不要重复同一个模板，每条要有区分度
5. 数据不全（IV/IVR 为 null）的标的写"数据待更新"
6. **ivrReliable=false**：该 IVR 是缺乏真实 IV 历史时的 RV 代理值，高值只代表近期波动大、不代表 IV 贵——**绝不能写"高 IV 卖方/卖方天堂/收 premium"**，应写"IVR 为 RV 代理，暂不可信"或转而基于 IV/EM/chg 判断
7. 中英混合，术语英文（IV、IVR、EM、premium 等）

**输出格式：** JSON object，key 是 ticker symbol，value 是备注字符串。
不要 markdown，直接 JSON。`

function buildUserPrompt(input: TickerNotesInput): string {
  return `为以下自选表标的各写一句引擎备注：

\`\`\`json
${JSON.stringify(input.tickers, null, 2)}
\`\`\`

输出格式示例：
{
  "NVDA": "财报前 IV 抬升",
  "TSLA": "高 IV，适合卖方"
}

直接输出 JSON，不要 markdown。`
}

// ---------- Cache ----------

// ---------- Public API ----------

/**
 * Generate AI notes for each ticker. Returns a Record<symbol, note>.
 * Cached per ET calendar day (12h TTL).
 */
export async function getAiTickerNotes(
  input: TickerNotesInput
): Promise<Record<string, string>> {
  const key = `ticker-notes-${etCalendarDay()}`

  const hit = await getCachedIfValid<Record<string, string>>(key, 12 * HOUR)
  if (hit != null) return hit

  return cached<Record<string, string>>(key, 12 * HOUR, async () => {
    const messages: AiMessage[] = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: buildUserPrompt(input) }
    ]
    const { data, usage } = await chatJson<Record<string, string>>(messages, {
      model: 'deepseek-chat',  // lightweight model suffices for short notes
      temperature: 0.4,
      maxTokens: 1000
    })
    if (usage) {
      console.log(
        `[ai/notes] tokens in=${usage.promptTokens} out=${usage.completionTokens}` +
          (usage.cachedTokens ? ` cached=${usage.cachedTokens}` : '')
      )
    }

    // Validate: must be an object with string values
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new Error('AI returned non-object for ticker notes')
    }

    const result: Record<string, string> = {}
    for (const [sym, note] of Object.entries(data)) {
      if (typeof note === 'string') {
        result[sym.toUpperCase()] = note.slice(0, 20) // cap length
      }
    }

    console.log(`[ai/notes] generated notes for ${Object.keys(result).length} tickers`)
    return result
  })
}
