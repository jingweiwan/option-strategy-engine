/**
 * Dashboard hero + deck narrative (DeepSeek JSON). Cached per ET calendar day.
 */

import { chatJson, type AiMessage } from './client.js'
import { cached, getCachedNarrativeDailyWithLegacy, etCalendarDay, HOUR } from './cache.js'

export type MarketSnapshot = {
  asof: string
  spy: { v: number; chg: number }
  vixy: { v: number; chg: number }
  ivRankMedian: number
  fearGreed?: number | null
  earningsToday?: number
  fedDays?: number
  watchlistTickers?: { sym: string; iv: number; ivr: number; em: number; chg: number }[]
  /** What the gated scanner actually surfaced — grounds enginePose so the
   *  narrative can't recommend setups the board doesn't have. */
  board?: {
    qualifiedCount: number
    /** Why the board is empty (only when qualifiedCount === 0). */
    emptyReason?: string
    /** A few on-board setups when non-empty. */
    setups?: { sym: string; strategy: string }[]
  }
}

export type DashboardNarrative = {
  heroLine1: string
  heroLine2: string
  deck: string
  enginePose: string
  factors: { tone: 'gain' | 'accent' | 'ink'; label: string; detail: string }[]
}

const SYSTEM = `你是一份高密度市场快讯的资深中文主笔，风格类似财经媒体深度点评专栏。
**所有输出必须为中文**，仅在以下术语出现时保留英文缩写：IV, IVR, RV, FOMC, SPY, VIXY, DTE, EV, POP。
其余一律用中文书写，包括 heroLine1/heroLine2。

你写的所有文字必须满足:
1. 中文为主，上述术语保留英文
2. 克制、有判断力、避免空话和套话
3. **数字必须直接引用提供的 snapshot，不得编造**
4. 严格按要求的 JSON schema 输出，不要多余字段或 markdown

**重要：当前数据源限制**
snapshot 给的是 ETF 代理：
- \`spy\` = SPY ETF；\`vixy\` = VIXY ETF
- \`fearGreed\` = CNN F&G (0-100)，可能为 null

**输出规则（硬约束）：**
1. **SPY / VIXY 的价格与涨跌幅%由服务端与侧栏同步写入 deck 文首，你不要在 deck / factors.detail 里再写这些数字**；可写「大盘」「波动率」定性承接。
2. **绝对不要把 fearGreed 的具体数值印进 prose**。
3. 绝对不要说 "SPX" 或 "VIX" 指数点位，只说 SPY/VIXY 或定性描述。

不要写"今日市场充满不确定性"这种废话。每一句必须能落地一个交易判断。

**引擎机会板对齐（硬约束，优先级最高）：**
snapshot 里的 \`board\` 是引擎跑完全部硬门槛后**真正筛出的合格机会**,你的 enginePose 与 deck 必须和它一致,不能自说自话:
- \`board.qualifiedCount === 0\`：今日**没有**达标卖方机会。enginePose 与 deck **只能说明原因(引用 \`board.emptyReason\`)并建议空仓等待,严禁推荐任何可开的策略**(不许说"适合卖铁鹰/宽跨/收租"之类)。IVR 再高也一样——门槛没过就是没机会。
- \`board.qualifiedCount > 0\`：enginePose **只围绕 \`board.setups\` 里实际上板的标的与策略**展开,**不要点名不在 setups 里的标的**(哪怕它 IVR 高)。
- **永远不要推荐"卖出宽跨式 / short strangle"**——该策略已被引擎禁用(裸卖无限风险),推荐它就是错的。
- 若 \`board\` 缺失,才退回按 IVR/RV 定性判断。`

const USER_TEMPLATE = (snap: MarketSnapshot) => `
基于以下当日市场快照，写一份首页"今日总览"内容：

\`\`\`json
${JSON.stringify(snap, null, 2)}
\`\`\`

请按以下 JSON schema 输出，不要多余字段：

{
  "heroLine1": "8-14 字中文。带 <em>...</em> 标签包住核心判断词。例：'<em>波动率偏斜</em>加深，利率焦虑升温'",
  "heroLine2": "8-14 字中文。承接 line1 的递进。",
  "deck": "50-120 字中文。**不要**写 SPY/VIXY 的价格或涨跌幅%（系统已写在文首）；从第二意群起写 IVR、盈利日历、FOMC、波动结构与引擎机会。",
  "enginePose": "70-130 字中文。**必须与 board 对齐**：board.qualifiedCount=0 → 只说明无达标机会+emptyReason+建议空仓,不推荐任何策略;>0 → 只围绕 board.setups 里实际上板的标的与策略给判断。绝不推荐 short strangle(已禁用)。",
  "factors": [
    {
      "tone": "gain | accent | ink",
      "label": "8-14 字中文现象标签",
      "detail": "20-40 字中文；引用 IVR、earningsToday、fedDays 等；**不要**写 SPY/VIXY 价格或涨跌幅%"
    }
  ]
}

约束:
- 不要使用 markdown
- factors 至少 3 条最多 4 条
`

export const narrativeCacheDayKey = etCalendarDay

export function narrativeCacheKey(snap?: MarketSnapshot): string {
  // v2: board-grounded prompt. Split empty vs active so a stand-aside narrative
  // and an active one don't overwrite each other within a day (the board can
  // flip as IVR/earnings shift).
  const standby = snap?.board?.qualifiedCount === 0 ? '-standby' : ''
  return `narrative-v2-${narrativeCacheDayKey()}${standby}`
}

export function fmtSignedPct(n: number, d = 2): string {
  return (n >= 0 ? '+' : '') + n.toFixed(d)
}

export function macroDeckLine(snap: MarketSnapshot): string {
  const sp = fmtSignedPct(snap.spy.chg)
  const vx = fmtSignedPct(snap.vixy.chg)
  return `SPY ${snap.spy.v.toFixed(2)} ${sp}%，VIXY ${snap.vixy.v.toFixed(2)} ${vx}%。`
}

function stripAiMacroPrefixFromDeck(deck: string): string {
  const t = deck.trim()
  if (!/^SPY/i.test(t) || !/(?:%|％)/.test(t.slice(0, 220))) return t
  const cut = t.indexOf('。')
  if (cut !== -1 && cut < 220) return t.slice(cut + 1).trim()
  return t
}

export function hydrateDashboardNarrative(n: DashboardNarrative, snap: MarketSnapshot): DashboardNarrative {
  const line = macroDeckLine(snap)
  const rest = stripAiMacroPrefixFromDeck(n.deck)
  const deck = rest.length > 0 ? `${line} ${rest}` : line
  return { ...n, deck }
}

export async function getMarketNarrative(snap: MarketSnapshot): Promise<DashboardNarrative> {
  const key = narrativeCacheKey(snap)
  const pre = await getCachedNarrativeDailyWithLegacy<DashboardNarrative>(key, 12 * HOUR)
  if (pre != null) return hydrateDashboardNarrative(pre, snap)

  const raw = await cached<DashboardNarrative>(key, 12 * HOUR, async () => {
    const messages: AiMessage[] = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: USER_TEMPLATE(snap) }
    ]
    const { data, usage } = await chatJson<DashboardNarrative>(messages, {
      model: 'deepseek-chat',
      temperature: 0.5,
      maxTokens: 2000
    })
    if (usage) {
      console.log(
        `[ai/narrative] tokens in=${usage.promptTokens} out=${usage.completionTokens}` +
          (usage.cachedTokens ? ` cached=${usage.cachedTokens}` : '')
      )
    }
    if (!data.heroLine1 || !data.deck || !data.enginePose || !Array.isArray(data.factors)) {
      throw new Error('AI returned malformed narrative shape')
    }
    return data
  })
  return hydrateDashboardNarrative(raw, snap)
}
