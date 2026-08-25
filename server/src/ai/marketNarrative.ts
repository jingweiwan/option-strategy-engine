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
  /** Watchlist earnings within the entry-span window (≤45d), soonest first —
   *  the honest event signal. Replaces the old whole-market `earningsToday`
   *  count, which was 0 on most days and said nothing about the watchlist. */
  earningsUpcoming?: { sym: string; label: string; daysUntil: number }[]
  fedDays?: number
  /** ivrReliable=false → the IVR is an rv-fallback proxy (no real IV history);
   *  a high value means "recently thrashing", NOT rich implied vol — don't
   *  headline it or call it a sell-vol setup. */
  watchlistTickers?: { sym: string; iv: number; ivr: number; ivrReliable?: boolean; em: number; chg: number }[]
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
  "deck": "50-120 字中文。**不要**写 SPY/VIXY 的价格或涨跌幅%（系统已写在文首）；从第二意群起写 IVR、FOMC、波动结构与引擎机会。财报只依据 earningsUpcoming（watchlist 未来财报列表，含 daysUntil）来写；该数组为空才说'近端无 watchlist 财报'，**不得**因此断言'缺乏事件驱动'或'波动率难以放大'。",
  "enginePose": "70-130 字中文。**必须与 board 对齐**：board.qualifiedCount=0 → 只说明无达标机会+emptyReason+建议空仓,不推荐任何策略;>0 → 只围绕 board.setups 里实际上板的标的与策略给判断。绝不推荐 short strangle(已禁用)。",
  "factors": [
    {
      "tone": "gain | accent | ink",
      "label": "8-14 字中文现象标签",
      "detail": "20-40 字中文；引用 IVR、earningsUpcoming（若非空）、fedDays 等；**不要**写 SPY/VIXY 价格或涨跌幅%，也**不要**凭 earningsUpcoming 为空就编造'缺乏事件驱动'"
    }
  ]
}

约束:
- 不要使用 markdown
- factors 至少 3 条最多 4 条
- **IVR 可靠性**：watchlistTickers 里 ivrReliable=false 的标的，其 IVR 是缺乏真实 IV 历史时的 RV 代理值——**高值只代表近期实际波动大，不代表隐含波动贵，绝不能当卖方机会/"卖方天堂"，更不能上 heroLine 头条**。这类标的若要提及，须点明"IVR 为 RV 代理、暂不可信"。ETF（SPY/QQQ/IWM 等）无个股财报，不得为其 IVR 编造"财报预期驱动"之类理由。
`

export const narrativeCacheDayKey = etCalendarDay

/** Signature of what the board actually holds — so the cached narrative refreshes
 *  when the setups change within a day (not just on empty↔active). */
function boardSignature(snap?: MarketSnapshot): string {
  const b = snap?.board
  if (!b) return 'nb' // no board info → generic IVR-based narrative
  if (b.qualifiedCount === 0) return 'standby' // stand-aside narrative
  const syms = (b.setups ?? []).map((s) => s.sym).sort().join('_')
  return `${b.qualifiedCount}-${syms || 'na'}`
}

export function narrativeCacheKey(snap?: MarketSnapshot): string {
  // v2: board-grounded prompt. Key on the actual board contents so a narrative
  // generated for one set of setups (e.g. "SPY") doesn't linger after the board
  // changes to another (e.g. "GOOGL, UNH") within the same day.
  return `narrative-v2-${narrativeCacheDayKey()}-${boardSignature(snap)}`
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

/**
 * Uppercase runs that are NOT tickers — jargon the prompt explicitly allows,
 * plus common macro/technical abbreviations the writer reaches for.
 */
const NON_TICKER_TOKENS = new Set([
  'IV', 'IVR', 'RV', 'EV', 'POP', 'DTE', 'ATM', 'OTM', 'ITM', 'VRP',
  'FOMC', 'CPI', 'PPI', 'PCE', 'PMI', 'GDP', 'ISM', 'NFP', 'QT', 'QE',
  'AI', 'ETF', 'ETFS', 'US', 'USD', 'EPS', 'PE', 'ROE', 'IPO', 'MA',
  'SMA', 'EMA', 'RSI', 'MACD', 'BOLL', 'EM', 'TP', 'SL', 'PNL', 'YTD',
  'Q1', 'Q2', 'Q3', 'Q4', 'H1', 'H2', 'FY', 'OK', 'ID', 'API'
])

/**
 * Every ticker the model is ALLOWED to name — strictly what it was fed.
 *
 * SPY/VIXY are always in: they are handed over as the macro line.
 */
function groundedTickers(snap: MarketSnapshot): Set<string> {
  const set = new Set<string>(['SPY', 'VIXY'])
  for (const t of snap.watchlistTickers ?? []) set.add(t.sym.toUpperCase())
  for (const e of snap.earningsUpcoming ?? []) set.add(e.sym.toUpperCase())
  for (const b of snap.board?.setups ?? []) set.add(b.sym.toUpperCase())
  return set
}

/**
 * Tickers the narrative names that were never in its input.
 *
 * The prompt already forbids this ("不要点名不在 setups 里的标的"), and the model
 * still did it: on 2026-08-25 the engine card read "其余标的 IVR 虽有个别偏高
 * (如 ADBE 72)" — ADBE was not in `watchlistTickers` (it is a HOLDING, and the
 * narrative is not even given the book), and no symbol anywhere had an IVR of
 * 72; the only 72 in the payload was VST's earnings `daysUntil`. The advice
 * happened to land somewhere reasonable, which is precisely the danger: the
 * next fabrication can point the other way and the reader has no way to tell.
 *
 * An instruction the model can ignore is not a control. This is the control.
 */
export function ungroundedTickers(n: DashboardNarrative, snap: MarketSnapshot): string[] {
  const allowed = groundedTickers(snap)
  const text = [
    n.heroLine1, n.heroLine2, n.deck, n.enginePose,
    ...(n.factors ?? []).flatMap((f) => [f.label, f.detail])
  ].filter((x) => typeof x === 'string').join(' ')

  const bad = new Set<string>()
  for (const m of text.matchAll(/\b[A-Z]{2,5}\b/g)) {
    const tok = m[0]
    if (NON_TICKER_TOKENS.has(tok)) continue
    if (allowed.has(tok)) continue
    bad.add(tok)
  }
  return [...bad]
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
    // Two attempts: the retry names the fabricated tickers back at the model.
    // A third attempt is not worth the latency — by then the run is unusable.
    let correction = ''
    for (let attempt = 1; attempt <= 2; attempt++) {
      const messages: AiMessage[] = [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: USER_TEMPLATE(snap) + correction }
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
      const bad = ungroundedTickers(data, snap)
      if (bad.length === 0) return data
      console.warn(
        `[ai/narrative] attempt ${attempt}: fabricated ticker(s) ${bad.join(', ')} — not in the input snapshot`
      )
      // Never cache or display a fabricated symbol: throwing leaves the card
      // showing "引擎判断不可用" instead of a confident invented number.
      if (attempt === 2) {
        throw new Error(`AI named ticker(s) absent from the snapshot: ${bad.join(', ')}`)
      }
      correction =
        `\n\n【上一次生成不合格】你点名了快照中不存在的标的：${bad.join('、')}。` +
        '只能点名 watchlistTickers / board.setups / earningsUpcoming 中出现过的代码，' +
        '且任何数字必须能在快照里逐字找到，不得推测或凭印象填写。请重写。'
    }
    throw new Error('unreachable')
  })
  return hydrateDashboardNarrative(raw, snap)
}
