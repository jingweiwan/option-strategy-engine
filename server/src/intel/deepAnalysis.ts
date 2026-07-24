/**
 * Layer 2: OCIFQ deep fundamental analysis.
 *
 * On-demand per-ticker analysis combining:
 *   O — 寡头定价权 (Oligopoly pricing power)
 *   C — 长周期催化 (Long-cycle catalyst)
 *   I — 行业利润断层 (Industry profit gap)
 *   F — 财务三爆 (Financial triple explosion: revenue + margin + FCF)
 *   Q — 连续季报验证 (Consecutive quarterly validation)
 *
 * Data sources: Finnhub financials + news + filings + recommendations.
 * AI model: DeepSeek deepseek-chat with structured JSON output.
 *
 * Cached per ticker per ET calendar day, 6-hour TTL.
 */

import {
  fetchCompanyProfile,
  fetchBasicFinancials,
  fetchPeers,
  fetchEarningsSurprises
} from '../api/finnhubFinancials.js'
import type {
  CompanyProfile,
  BasicFinancials,
  EarningsSurprise
} from '../api/finnhubFinancials.js'
import { fetchFmpFinancials, fetchQuarterlyIncome } from '../api/fmpFinancials.js'
import type { FmpFinancialData, EarningsTranscript } from '../api/fmpFinancials.js'
import { scrapeRecentTranscripts } from '../api/transcriptScraper.js'
import { fetchCompanyNews, fetchRecommendations } from '../api/finnhubIntel.js'
import type { FinnhubNewsItem, FinnhubRecommendation } from '../api/finnhubIntel.js'
import { chatJson } from '../ai/client.js'
import { cached, etCalendarDay, HOUR } from '../ai/cache.js'
import {
  buildQuarterContext,
  fiscalFromIncomeRow,
  formatFiscalQuarter,
  type QuarterContext
} from './quarterContext.js'

// ---------- Output types ----------

export type OcifqScore = {
  /** 0-10 score per dimension */
  O: number
  C: number
  I: number
  F: number
  Q: number
  /** Weighted total 0-100 */
  total: number
}

export type OcifqDimKey = 'O' | 'C' | 'I' | 'F' | 'Q'

/** Canonical Chinese labels — never trust the LLM for these (it sometimes
 *  omits "C: 长周期催化", leaving a blank row in the UI). */
export const OCIFQ_DIM_LABELS: Record<OcifqDimKey, string> = {
  O: '寡头定价权',
  C: '长周期催化',
  I: '行业利润断层',
  F: '财务三爆',
  Q: '连续季报验证'
}

export type OcifqDimension = {
  key: OcifqDimKey
  label: string
  score: number
  maxScore: number
  reasoning: string
  /** Key data points supporting the score */
  evidence: string[]
  /** 'bullish' | 'bearish' | 'neutral' */
  signal: 'bullish' | 'bearish' | 'neutral'
}

/** Force canonical labels + stable O→C→I→F→Q order. Exported for tests. */
export function normalizeOcifqDimensions(
  raw: Array<Partial<OcifqDimension> & { key?: string }> | undefined | null
): OcifqDimension[] {
  const byKey = new Map<string, Partial<OcifqDimension>>()
  for (const d of raw ?? []) {
    if (d?.key) byKey.set(d.key, d)
  }
  return (Object.keys(OCIFQ_DIM_LABELS) as OcifqDimKey[]).map((key) => {
    const d = byKey.get(key) ?? {}
    const score = typeof d.score === 'number' && Number.isFinite(d.score) ? d.score : 0
    return {
      key,
      label: OCIFQ_DIM_LABELS[key],
      score: Math.max(0, Math.min(10, score)),
      maxScore: 10,
      reasoning: typeof d.reasoning === 'string' ? d.reasoning : '',
      evidence: Array.isArray(d.evidence) ? d.evidence.filter((e) => typeof e === 'string') : [],
      signal: d.signal === 'bullish' || d.signal === 'bearish' || d.signal === 'neutral'
        ? d.signal
        : 'neutral'
    }
  })
}

export type ThesisItem = {
  id: number
  text: string
  status: 'validated' | 'challenged' | 'no_change'
  delta: string
  date: string
  /** Concrete, measurable condition that would falsify this thesis. */
  invalidation: string
  /** Fiscal quarter this delta primarily references (e.g. "2026Q2"). */
  referenceQuarter?: string
}

export type ToneWord = {
  word: string
  count: number
}

export type CallTone = {
  available: boolean
  quarter?: string
  confidenceScore?: number
  hedgeWordCount?: number
  confidenceWordCount?: number
  /** Specific confidence words found, with occurrence counts */
  confidenceWords?: ToneWord[]
  /** Specific hedge/negative words found, with occurrence counts */
  hedgeWords?: ToneWord[]
  guidanceTone?: 'raise' | 'maintain' | 'lower' | 'none'
  toneShift?: 'improving' | 'stable' | 'deteriorating' | 'unknown'
  keyQuotes?: string[]
  confidenceQuotes?: string[]
  hedgeQuotes?: string[]
  summary?: string
}

export type DeepAnalysis = {
  symbol: string
  name: string
  industry: string
  marketCap: number
  peers: string[]
  /** OCIFQ scores */
  scores: OcifqScore
  /** Detailed breakdown per dimension */
  dimensions: OcifqDimension[]
  /** AI-generated thesis tracker items */
  thesisItems: ThesisItem[]
  /** FMP vs transcript fiscal-quarter alignment (prevents mixed Q labels). */
  quarterContext: {
    fmpLatest: string | null
    transcriptLatest: string | null
    lag: boolean
    message: string | null
  }
  /** CallTone: management tone analysis from earnings call */
  callTone: CallTone
  /** One-paragraph executive summary */
  summary: string
  /** Option strategy implication */
  optionImplication: string
  /** AI directional view derived from analysis */
  view: 'bullish' | 'bearish' | 'neutral'
  viewConfidence: number
  /** Raw data stats */
  dataStats: {
    newsCount: number
    earningsQuarters: number
    peersCount: number
    hasFinancials: boolean
    fmpIncomeQuarters: number
    fmpCashFlowQuarters: number
    transcriptQuarters: number
  }
  generatedAt: string
}

// ---------- Data collection ----------

/**
 * Clean a raw peers list from the FMP/Finnhub peers API:
 *   - drop the analyzed symbol itself (case-insensitive) so it isn't listed as its own peer
 *   - de-duplicate (case-insensitive, keeping first-seen casing)
 *   - drop empties, then cap at 8
 */
function cleanPeers(raw: string[], symbol: string): string[] {
  const self = symbol.trim().toUpperCase()
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of raw) {
    if (typeof p !== 'string') continue
    const t = p.trim()
    if (!t) continue
    const up = t.toUpperCase()
    if (up === self || seen.has(up)) continue
    seen.add(up)
    out.push(t)
  }
  return out.slice(0, 8)
}

type RawData = {
  profile: CompanyProfile | null
  financials: BasicFinancials
  fmpFinancials: FmpFinancialData
  transcripts: EarningsTranscript[]
  peers: string[]
  earnings: EarningsSurprise[]
  news: FinnhubNewsItem[]
  recommendations: FinnhubRecommendation[]
}

async function collectData(symbol: string): Promise<RawData> {
  const today = new Date().toISOString().slice(0, 10)
  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10)

  // Phase 1: fetch everything in parallel (except transcripts which need FMP dates)
  const [profile, financials, fmpFinancials, peers, earnings, news, recommendations] = await Promise.allSettled([
    fetchCompanyProfile(symbol),
    fetchBasicFinancials(symbol),
    fetchFmpFinancials(symbol),
    fetchPeers(symbol),
    fetchEarningsSurprises(symbol),
    fetchCompanyNews(symbol, weekAgo, today),
    fetchRecommendations(symbol)
  ])

  const fmpData: FmpFinancialData = fmpFinancials.status === 'fulfilled'
    ? fmpFinancials.value
    : { income: [], cashFlow: [] }

  // Phase 2: scrape transcripts using FMP income dates + company name for accurate URL targeting
  const companyName = profile.status === 'fulfilled' ? profile.value?.name : undefined
  let transcripts: EarningsTranscript[] = []
  try {
    transcripts = await scrapeRecentTranscripts(
      symbol,
      1,
      fmpData.income.length > 0 ? fmpData.income : undefined,
      companyName ?? undefined
    )
  } catch (e) {
    console.warn(`[ocifq] transcript scraping failed for ${symbol}:`, (e as Error).message)
  }

  return {
    profile: profile.status === 'fulfilled' ? profile.value : null,
    financials: financials.status === 'fulfilled' ? financials.value : { metric: {}, series: {} },
    fmpFinancials: fmpData,
    transcripts,
    peers: peers.status === 'fulfilled' ? cleanPeers(peers.value, symbol) : [],
    earnings: earnings.status === 'fulfilled' ? earnings.value : [],
    news: news.status === 'fulfilled'
      ? news.value.sort((a, b) => b.datetime - a.datetime).slice(0, 10)
      : [],
    recommendations: recommendations.status === 'fulfilled'
      ? recommendations.value.slice(0, 6)
      : []
  }
}

// ---------- Prompt ----------

const SYSTEM_PROMPT = `你是一个 buy-side hedge fund 的高级分析师，专注于期权策略和基本面深度研究。

## ⚠️ 数据纪律（最高优先级硬约束，违反即为严重错误）
1. **只准引用下方"源数据"中真实出现的数字。** 每一个百分比、每一个金额、每一个增速，都必须能在源数据里逐字找到（含"(computed)"预算好的块）。找不到的数字，一律不许写。
2. **严禁计算或估算利润率。** 毛利率/营业利润率/净利率一律使用源数据里已给出的百分比（见 Margin Trend 块），不要自己用金额去除——你会算错。
3. **前瞻指引（guidance）只能来自 transcript 原文。** 仅当电话会 transcript 中出现明确的指引数字时才可引用，并注明是哪一季电话会给的、指的是哪一季。**若源数据里没有指引数字，必须写"未获取到前瞻指引"，严禁编造任何"管理层指引 X%"。**
4. **区分 GAAP 与 non-GAAP，区分实际值与指引值。** 不得把某季度实际毛利率说成"指引"，也不得把 GAAP 净亏损与毛利率扩张混为一谈（大额减值季可同时"毛利率上升 + GAAP 净利为负"）。
5. evidence / delta / invalidation 里的每个数字都受本纪律约束。宁可少写一个数字，也不许编一个。
6. **thesisItems 季度一致性（硬约束）**：
   - 先读 Quarter Alignment 块：FMP 最新合并报表季 vs transcript 最新电话会季可能不一致（财报刚发布后 transcript 常滞后 1 季）。
   - 合并口径（CapEx、FCF、总 revenue、EPS、margin）：只引用 FMP 最新季，delta 里写明该季（如 2026Q2）。
   - 分部口径（Cloud、Search、backlog 等）：只来自 transcript；若 transcript 季落后于 FMP，必须写明「2026Q1 电话会」等，**禁止**把旧季分部数据标成 FMP 最新季。
   - 所有 thesisItems 的 delta 里出现的财报季标签必须自洽；不允许 #1 写 Q1、#3 写 Q2  unless 明确区分 consolidated vs segment 且标注来源季。
7. thesisItems.date = 分析日期 (YYYY-MM-DD)；财报季写在 delta / referenceQuarter，不要混用。

你需要对给定标的做 OCIFQ 五维评分，每个维度 0-10 分：

## O — 寡头定价权 (Oligopoly Pricing Power)（满分 10）
核心问题：该公司是否处于定价权极强的寡头/双寡头结构？
评估：
- 行业集中度（CR2/CR3 > 60%）
- 提价能力：是否连续多年 ASP 上涨 or 能 pass-through 成本
- 转换成本 / 网络效应 / 嵌入式生态 — 客户离开的摩擦
- 竞争格局变化趋势（是否正在巩固 or 被侵蚀）

## C — 长周期催化 (Long-Cycle Catalyst)（满分 10）
核心问题：有无 2-5 年以上的结构性增长催化剂？
评估：
- 产业周期位置（是否处于渗透率 S-curve 前半段）
- 政策/法规红利（如 CHIPS Act、能源转型、AI infra）
- 管理层资本配置是否对齐催化主题
- 催化是否已被市场 fully priced

## I — 行业利润断层 (Industry Profit Gap)（满分 10）
核心问题：该公司是否捕获了行业超额利润？
评估：
- 毛利率 vs 行业中位数（>15pp 溢价 = 强）
- ROIC vs WACC spread（>10pp = 优秀）
- 行业 peers 的利润率差距是否在扩大
- 结构性护城河 vs 周期性利润

## F — 财务三爆 (Financial Triple Explosion)（满分 10）
核心问题：收入、利润率、自由现金流三者是否同时扩张？

你会收到最近 8 个季度的完整 income statement 和 cash flow statement 数据。
请基于真实数据逐季对比，给出有数据支撑的精确评分。

评估维度（三爆 = 收入 + 利润率 + FCF 三者同时改善）：

1. 收入增速：
   - 计算最近 4 个季度的 YoY 增速，判断是否 >15% 且是否在加速
   - 对比连续季度 YoY: 如 Q1=+20% → Q2=+25% → Q3=+30% = 加速
   - 仅看绝对增速不够，趋势（加速/减速/平稳）是关键

2. 利润率扩张：
   - 毛利率 QoQ 趋势：是否连续 2+ 季度扩张？
   - EBITDA margin QoQ 趋势：运营杠杆是否体现？
   - Operating margin 是否跟随毛利率改善？

3. FCF 质量：
   - FCF conversion = FCF / Operating Cash Flow，是否 >60% 且提升？
   - SBC 占收入比是否在下降（质量改善信号）？
   - CapEx intensity（CapEx / Revenue）是否稳定或下降？

评分标准：
- 三者齐动（收入加速 + 利润率扩张 + FCF 改善）= 8-10
- 两者改善 = 6-7
- 一者改善 = 3-5
- 全面恶化 = 0-2

evidence 必须包含具体季度数据（如"Q3 2024 毛利率 75.2% vs Q2 74.1%"）。

## Q — 连续季报验证 (Quarterly Validation)（满分 10）
核心问题：最近 2-4 个季度是否连续 beat & raise？

你会收到两类数据：
1. **EPS surprise 数据**（Finnhub）：每季度 actual vs estimate，surprise %
2. **Earnings call transcript**（如可用）：管理层发言原文

### 数据有 transcript 时的评估：
- EPS surprise 连续 positive（几个季度连续？幅度是否扩大？）
- Revenue beat 连续（结合 income statement 的实际 revenue vs 分析师预期）
- 管理层语气分析（CallTone）——需要同时检测正面和负面信号：

  **正面信号（信心词）：**
  strong, confident, excellent, record, accelerat*, outperform*, robust,
  exceeded, momentum, best-in-class, transformative, inflection, tailwind*

  **负面信号（对冲/悲观词）——必须高度敏感：**
  uncertain*, challeng*, headwind*, cautious*, moderate*, soften*, slow*,
  pressure*, constrain*, disappoint*, weaken*, decline*, contraction,
  macro concern*, volatile*, difficult*, cautiously optimistic（这是对冲伪装）,
  prudent*, conservative*, measured*, temper*, normalize*, reset*

  **Guidance 措辞——区分正负面：**
  · 正面：raise, increase, above, higher, upside, ahead of expectations
  · 负面：lower, below, reduce, revised down, narrowed, tighten*, right-size*,
    defer*, push out*, reprioritize*, "in line with"（常用来掩盖 miss）

  **话术降级检测——重点关注跨季度措辞变化：**
  · 从 "strong growth" → "solid performance" = 降级
  · 从 "accelerating" → "normalizing" = 降级
  · 从 "raise guidance" → "maintain guidance" = 降级信号
  · 从具体数字承诺 → 模糊定性描述 = 降级
  · 回避某个领域的问题 / 对分析师追问转移话题 = 重大红旗

- Guidance raise 频率和幅度
- **重要：不要因为管理层话术客气就默认 positive。大多数管理层即使业绩下滑也会用积极措辞包装。你必须穿透话术看实质。**

### 数据没有 transcript 时的评估：
- 仅用 EPS surprise 数据 + income statement 的 EPS 轨迹推断
- 在 reasoning 中说明 "无 transcript 数据，评分基于定量指标"
- 评分上限为 7（因缺少定性信号无法给满分）

评分标准：
- 4 季连续 beat + raise + 管理层语气正面 = 9-10
- 3 季连续 beat + guidance 稳/升 = 7-8
- 2 季 beat 但有 miss = 5-6
- 最近季度 miss 或 guide down = 2-4
- 连续 miss = 0-1

## 输出要求
输出严格 JSON，schema:
{
  "scores": { "O": 0-10, "C": 0-10, "I": 0-10, "F": 0-10, "Q": 0-10, "total": 0-100 },
  "dimensions": [
    {
      "key": "O" | "C" | "I" | "F" | "Q",
      "label": "中文维度名称",
      "score": 0-10,
      "maxScore": 10,
      "reasoning": "2-3 句评分理由",
      "evidence": ["关键数据点1", "关键数据点2"],
      "signal": "bullish" | "bearish" | "neutral"
    }
  ],
  "thesisItems": [
    {
      "id": 1,
      "text": "核心论点",
      "status": "validated" | "challenged" | "no_change",
      "delta": "最新变化说明（须含财报季标签，如 2026Q2）",
      "date": "分析日期 YYYY-MM-DD",
      "referenceQuarter": "2026Q2",
      "invalidation": "证伪条件：什么可观测、可量化的数据出现会推翻这条论点"
    }
  ],
  "callTone": {
    "available": true/false,
    "quarter": "2025Q1",
    "confidenceScore": 0-100,
    "guidanceTone": "raise" | "maintain" | "lower" | "none",
    "toneShift": "improving" | "stable" | "deteriorating" | "unknown",
    "summary": "一句话总结管理层语气（中文）"
  },
  "summary": "一段话总结（中文，150字以内）",
  "optionImplication": "对期权策略的建议（中文）",
  "view": "bullish" | "bearish" | "neutral",
  "viewConfidence": 0-100
}

total = (O + C + I + F + Q) * 2，即 0-100 分。
thesisItems 给出 3-5 条关键投资论点，并基于最新数据标注 status。
每条论点必须给出 invalidation（证伪条件）：一个具体、可观测、可量化的触发器，出现即说明该论点不再成立。
  好例子："数据中心收入 YoY 增速跌破 30%" / "毛利率连续 2 季环比下滑" / "EPS surprise 转负或 guidance 下调"。
  坏例子（太空泛，禁止）："竞争加剧" / "宏观恶化" / "增长放缓"。
  这是把分析变成可执行框架的关键——逼自己写下"我错在哪会知道"。
callTone: 仅当提供了 earnings call transcript 时 available=true。只分析最近一个季度。
  注意：confidenceWords、hedgeWords、keyQuotes、confidenceQuotes、hedgeQuotes 由系统程序化提取，你不需要返回这些字段。
  你只需要返回以下字段：
  - confidenceScore: 0=极度悲观 50=中性 100=极度乐观。校准：大部分公司 40-70。beat+raise+措辞强硬才 >80，guidance 下调/措辞降级应 <50。
  - guidanceTone: 区分 raise vs maintain。"reaffirm" = maintain，不是 raise。
  - toneShift: 对比本季 vs 上季措辞。仅 1 个季度则设 "unknown"。
  - summary: 一句话中文总结管理层语气。
如果没有 transcript 数据，设 available=false。
如果数据不足以评分某维度，给保守分数 (3-4) 并在 reasoning 中说明。`

// ---------- Programmatic tone extraction (no AI fabrication) ----------

const CONF_PATTERNS = [
  'strong', 'confident', 'excellent', 'record', 'accelerat',
  'outperform', 'robust', 'exceeded', 'momentum', 'tailwind',
  'exceptional', 'remarkable', 'tremendous', 'impressive',
  'thrilled', 'excited', 'optimistic', 'pleased', 'incredible'
]
const HEDGE_PATTERNS = [
  'uncertain', 'challeng', 'headwind', 'cautious', 'moderate',
  'soften', 'slowdown', 'slowing', 'pressure', 'constrain',
  'disappoint', 'weaken', 'decline', 'contraction', 'volatile',
  'difficult', 'prudent', 'conservative', 'normalize',
  'restructur'
  // NOTE: 'visibility' was removed — in earnings calls it is almost always
  // positive ("strong/multiyear visibility"), so counting it as a hedge word
  // systematically inflated the hedge tally and depressed CallTone.
  // 'temper' was also removed: the stem matches "temperature"/"temperament",
  // and genuine "temper expectations" usage is rare enough not to be worth the
  // false positives.
]

function countWord(text: string, stem: string): { word: string; count: number } | null {
  const re = new RegExp(`\\b(${stem}\\w*)`, 'gi')
  const matches = text.match(re)
  if (!matches || matches.length === 0) return null
  return { word: matches[0].toLowerCase(), count: matches.length }
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#160;|&nbsp;/g, ' ')
}

/** Get management text from transcript — excludes Operator and analyst speakers */
function getMgmtText(transcript: EarningsTranscript): string {
  if (transcript.entries.length === 0) return transcript.content
  // Try C-suite title match first
  const cSuite = transcript.entries.filter(e =>
    /CEO|CFO|COO|CTO|President|Chief/i.test(e.speaker)
  )
  if (cSuite.length > 0) return decodeHtmlEntities(cSuite.map(e => e.text).join(' '))
  // Fallback: exclude Operator and analyst-like speakers (common in Motley Fool transcripts)
  return decodeHtmlEntities(
    transcript.entries
      .filter(e => !/Operator|Analyst|Director|Wells Fargo|Morgan Stanley|Goldman|Blair|Wolfe|Stifel|BTIG|Piper|Barclays|BofA|Citi|JPMorgan|UBS|Bernstein/i.test(e.speaker))
      .map(e => e.text).join(' ')
  )
}

function extractToneWords(transcript: EarningsTranscript): {
  confidenceWords: ToneWord[]
  hedgeWords: ToneWord[]
} {
  const mgmtText = getMgmtText(transcript)

  const conf: ToneWord[] = []
  for (const p of CONF_PATTERNS) {
    const r = countWord(mgmtText, p)
    if (r) conf.push(r)
  }
  const hedge: ToneWord[] = []
  for (const p of HEDGE_PATTERNS) {
    const r = countWord(mgmtText, p)
    if (r) hedge.push(r)
  }

  return {
    confidenceWords: conf.sort((a, b) => b.count - a.count).slice(0, 8),
    hedgeWords: hedge.sort((a, b) => b.count - a.count).slice(0, 8)
  }
}

function extractKeyQuotes(transcript: EarningsTranscript): {
  confidenceQuotes: string[]
  hedgeQuotes: string[]
} {
  const mgmtText = getMgmtText(transcript)

  const sentences = mgmtText
    .replace(/([.!?])\s+/g, '$1\n')
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length > 40 && s.length < 300)

  const hedgeRe = new RegExp(`\\b(${HEDGE_PATTERNS.join('|')})\\w*\\b`, 'i')
  const confRe = new RegExp(`\\b(${CONF_PATTERNS.join('|')})\\w*\\b`, 'i')

  const confidenceQuotes: string[] = []
  const hedgeQuotes: string[] = []
  const used = new Set<string>()

  // Score sentences by number of tone-word hits for better ranking
  function toneHits(s: string, re: RegExp): number {
    const globalRe = new RegExp(re.source, 'gi')
    return (s.match(globalRe) ?? []).length
  }

  // Collect hedge quotes (up to 3)
  const hedgeCandidates = sentences
    .filter(s => hedgeRe.test(s))
    .sort((a, b) => toneHits(b, hedgeRe) - toneHits(a, hedgeRe))
  for (const s of hedgeCandidates) {
    if (hedgeQuotes.length >= 3) break
    if (!used.has(s)) {
      hedgeQuotes.push(s)
      used.add(s)
    }
  }

  // Collect confidence quotes (up to 3)
  const confCandidates = sentences
    .filter(s => confRe.test(s))
    .sort((a, b) => toneHits(b, confRe) - toneHits(a, confRe))
  for (const s of confCandidates) {
    if (confidenceQuotes.length >= 3) break
    if (!used.has(s)) {
      confidenceQuotes.push(s)
      used.add(s)
    }
  }

  return { confidenceQuotes, hedgeQuotes }
}

function buildUserPrompt(symbol: string, data: RawData, quarterCtx: QuarterContext): string {
  const parts: string[] = [`=== ${symbol} Deep Analysis ===`, ...quarterCtx.promptLines]

  if (data.profile) {
    parts.push(`\n--- Company Profile ---`)
    parts.push(`Name: ${data.profile.name}`)
    parts.push(`Industry: ${data.profile.finnhubIndustry}`)
    parts.push(`Market Cap: $${(data.profile.marketCapitalization / 1000).toFixed(1)}B`)
    parts.push(`Exchange: ${data.profile.exchange}`)
  }

  if (data.peers.length > 0) {
    parts.push(`\n--- Peers ---`)
    parts.push(data.peers.join(', '))
  }

  const m = data.financials.metric
  const metricKeys = [
    '10DayAverageTradingVolume', '52WeekHigh', '52WeekLow',
    'beta', 'bookValuePerShareAnnual', 'currentRatioAnnual',
    'dividendYieldIndicatedAnnual', 'epsAnnual', 'epsGrowthTTMYoy',
    'grossMarginAnnual', 'grossMarginTTM',
    'netIncomeEmployeeAnnual', 'netMarginAnnual',
    'operatingMarginAnnual', 'operatingMarginTTM',
    'peAnnual', 'peNormalizedAnnual', 'pfcfShareAnnual',
    'psTTM', 'ptbvAnnual',
    'revenuePerShareAnnual', 'revenuePerShareTTM',
    'roaRfy', 'roeRfy', 'roiAnnual', 'roeTTM',
    'revenueGrowthQuarterlyYoy', 'revenueGrowthTTMYoy',
    'netProfitMarginTTM', 'freeCashFlowPerShareTTM',
    'currentDividendYieldTTM', 'debtEquityAnnual'
  ]
  const available = metricKeys.filter((k) => m[k] != null)
  if (available.length > 0) {
    parts.push(`\n--- Key Financials ---`)
    for (const k of available) {
      parts.push(`${k}: ${m[k]}`)
    }
  }

  // Quarterly series from Finnhub (fallback if FMP unavailable)
  const qSeries = data.financials.series?.quarterly
  if (qSeries) {
    const seriesKeys = ['grossMargin', 'operatingMargin', 'revenuePerShare', 'eps']
    for (const sk of seriesKeys) {
      const points = qSeries[sk]
      if (Array.isArray(points) && points.length > 0) {
        const recent = points.slice(0, 8)
        parts.push(`${sk} (quarterly): ${recent.map((p) => `${p.period}=${p.v}`).join(', ')}`)
      }
    }
  }

  // --- FMP: Structured quarterly financial statements ---
  const { income, cashFlow } = data.fmpFinancials

  if (income.length > 0) {
    parts.push(`\n--- Quarterly Income Statement (last ${income.length} quarters, newest first) ---`)
    const fmt = (n: number) => {
      if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
      if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`
      return `$${n.toLocaleString()}`
    }
    const pct = (n: number) => `${(n * 100).toFixed(1)}%`
    for (const q of income) {
      parts.push(
        `[${q.fiscalYear} ${q.period}] ` +
        `Revenue=${fmt(q.revenue)}, ` +
        `GrossProfit=${fmt(q.grossProfit)} (${pct(q.grossProfitRatio)}), ` +
        `OpIncome=${fmt(q.operatingIncome)} (${pct(q.operatingIncomeRatio)}), ` +
        `EBITDA=${fmt(q.ebitda)} (${pct(q.ebitdaratio)}), ` +
        `NetIncome=${fmt(q.netIncome)} (${pct(q.netIncomeRatio)}), ` +
        `EPS=${q.epsdiluted.toFixed(2)}`
      )
    }

    // Pre-compute YoY revenue growth for AI convenience
    if (income.length >= 5) {
      parts.push(`\n--- Revenue YoY Growth (computed) ---`)
      for (let i = 0; i < income.length - 4; i++) {
        const curr = income[i]
        const yAgo = income[i + 4]
        if (yAgo.revenue > 0) {
          const growth = ((curr.revenue - yAgo.revenue) / yAgo.revenue) * 100
          parts.push(
            `[${curr.fiscalYear} ${curr.period}] ` +
            `${growth >= 0 ? '+' : ''}${growth.toFixed(1)}% YoY ` +
            `(${fmt(yAgo.revenue)} → ${fmt(curr.revenue)})`
          )
        }
      }
    }

    // Pre-compute the margin QoQ trend so the LLM READS the trend instead of
    // recomputing it (and getting 40.4% wrong as 39.4%). These are the ONLY
    // margin numbers it may cite. GAAP net margin can be negative on impairment
    // quarters even while gross margin expands — spell both out so the model
    // doesn't conflate them.
    parts.push(`\n--- Margin Trend QoQ, GAAP (computed — cite these exact figures, do not recompute) ---`)
    for (const q of income) {
      parts.push(
        `[${q.fiscalYear} ${q.period}] ` +
        `GrossMargin=${pct(q.grossProfitRatio)}, ` +
        `OpMargin=${pct(q.operatingIncomeRatio)}, ` +
        `NetMargin=${pct(q.netIncomeRatio)}`
      )
    }
  }

  if (cashFlow.length > 0) {
    parts.push(`\n--- Quarterly Cash Flow Statement (last ${cashFlow.length} quarters, newest first) ---`)
    const fmt = (n: number) => {
      if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
      if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`
      return `$${n.toLocaleString()}`
    }
    for (const q of cashFlow) {
      const fcfConversion = q.operatingCashFlow !== 0
        ? ((q.freeCashFlow / q.operatingCashFlow) * 100).toFixed(0)
        : 'N/A'
      parts.push(
        `[${q.fiscalYear} ${q.period}] ` +
        `OpCF=${fmt(q.operatingCashFlow)}, ` +
        `CapEx=${fmt(q.capitalExpenditure)}, ` +
        `FCF=${fmt(q.freeCashFlow)} (conversion=${fcfConversion}%), ` +
        `SBC=${fmt(q.stockBasedCompensation)}, ` +
        `Buyback=${fmt(q.commonStockRepurchased)}`
      )
    }
  }

  if (data.earnings.length > 0) {
    parts.push(`\n--- Earnings Surprises (last ${data.earnings.length} quarters) ---`)
    for (const e of data.earnings) {
      parts.push(
        `[${e.period}] actual=${e.actual} est=${e.estimate} surprise=${e.surprise} (${e.surprisePercent > 0 ? '+' : ''}${e.surprisePercent.toFixed(1)}%)`
      )
    }

    // Pre-compute streak info for AI
    let beatStreak = 0
    for (const e of data.earnings) {
      if (e.surprisePercent > 0) beatStreak++
      else break
    }
    if (beatStreak > 0) {
      parts.push(`→ Consecutive EPS beat streak: ${beatStreak} quarters`)
    }
  }

  // --- Earnings Call Transcript (most recent quarter only) ---
  if (data.transcripts.length > 0) {
    const latest = data.transcripts[0]
    parts.push(`\n--- Earnings Call Transcript: ${latest.symbol} ${latest.year}Q${latest.quarter} (${latest.date}) ---`)
    parts.push(`[NOTE: This is the ACTUAL transcript text. CallTone analysis must use ONLY words and sentences from this text. Do NOT fabricate quotes.]`)

    if (latest.entries.length > 0) {
      const isAnalystOrOp = (s: string) =>
        /Operator|Analyst|Director|Wells Fargo|Morgan Stanley|Goldman|Blair|Wolfe|Stifel|BTIG|Piper|Barclays|BofA|Citi|JPMorgan|UBS|Bernstein/i.test(s)
      const mgmt = latest.entries.filter(e => !isAnalystOrOp(e.speaker))
      const analysts = latest.entries.filter(e => isAnalystOrOp(e.speaker) && !/Operator/i.test(e.speaker))

      if (mgmt.length > 0) {
        parts.push(`\n[Management Remarks - ${mgmt.length} segments]`)
        for (const e of mgmt.slice(0, 10)) {
          const text = e.text.length > 2000 ? e.text.slice(0, 2000) + '...' : e.text
          parts.push(`${e.speaker}:\n${text}`)
        }
      }

      if (analysts.length > 0) {
        parts.push(`\n[Q&A - ${Math.min(analysts.length, 8)} exchanges]`)
        for (let i = 0; i < Math.min(analysts.length, 8); i++) {
          const q = analysts[i]
          const text = q.text.length > 500 ? q.text.slice(0, 500) + '...' : q.text
          parts.push(`${q.speaker}: ${text}`)
          // Find the management response right after
          const qIdx = latest.entries.indexOf(q)
          if (qIdx >= 0 && qIdx + 1 < latest.entries.length) {
            const resp = latest.entries[qIdx + 1]
            if (!isAnalystOrOp(resp.speaker)) {
              const rText = resp.text.length > 1000 ? resp.text.slice(0, 1000) + '...' : resp.text
              parts.push(`${resp.speaker}: ${rText}`)
            }
          }
        }
      }
    } else {
      const preview = latest.content.length > 6000 ? latest.content.slice(0, 6000) + '\n...[truncated]' : latest.content
      parts.push(preview)
    }

    // Provide older quarter labels for toneShift comparison (but not full text)
    if (data.transcripts.length > 1) {
      parts.push(`\n[Previous quarters available for toneShift comparison: ${data.transcripts.slice(1).map(t => `${t.year}Q${t.quarter}`).join(', ')}]`)
    }
  } else {
    parts.push(`\n[NOTE: No earnings call transcript data available. Q dimension should rely on quantitative EPS data only. Set callTone.available=false.]`)
  }

  if (data.recommendations.length > 0) {
    parts.push(`\n--- Analyst Recommendations ---`)
    for (const r of data.recommendations) {
      parts.push(
        `[${r.period}] strongBuy=${r.strongBuy} buy=${r.buy} hold=${r.hold} sell=${r.sell} strongSell=${r.strongSell}`
      )
    }
  }

  if (data.news.length > 0) {
    parts.push(`\n--- Recent News (last 7 days) ---`)
    for (const n of data.news) {
      const d = new Date(n.datetime * 1000).toISOString().slice(0, 16)
      parts.push(`[${d}] ${n.headline} (${n.source})`)
      if (n.summary) parts.push(`  ${n.summary.slice(0, 200)}`)
    }
  }

  return parts.join('\n')
}

// ---------- Public API ----------

export async function generateDeepAnalysis(symbol: string): Promise<DeepAnalysis> {
  const sym = symbol.toUpperCase()
  const day = etCalendarDay()

  // Light probe for cache key — avoid full collectData on cache hits.
  let fmpKey = 'none'
  try {
    const income = await fetchQuarterlyIncome(sym)
    const fq = income.length > 0 ? fiscalFromIncomeRow(income[0]) : null
    if (fq) fmpKey = formatFiscalQuarter(fq)
  } catch {
    /* non-fatal — fall back to day-only key segment */
  }
  const cacheKey = `ocifq-v6-${fmpKey}-${day}-${sym}`

  return cached(cacheKey, 6 * HOUR, async () => {
    console.log(`[ocifq] generating deep analysis for ${sym} (fmp=${fmpKey})`)

    const data = await collectData(sym)
    const quarterCtx = buildQuarterContext({
      income: data.fmpFinancials.income,
      transcripts: data.transcripts
    })

    if (quarterCtx.lag) {
      console.warn(`[ocifq] ${sym} quarter lag: FMP ${formatFiscalQuarter(quarterCtx.fmpLatest!)} > transcript ${formatFiscalQuarter(quarterCtx.transcriptLatest!)}`)
    }

    const hasTranscripts = data.transcripts.length > 0
    const { data: aiResult } = await chatJson<{
      scores: OcifqScore
      dimensions: OcifqDimension[]
      thesisItems: ThesisItem[]
      callTone: CallTone
      summary: string
      optionImplication: string
      view: 'bullish' | 'bearish' | 'neutral'
      viewConfidence: number
    }>(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(sym, data, quarterCtx) }
      ],
      { temperature: 0.3, maxTokens: hasTranscripts ? 8000 : 4000 }
    )

    // Ensure total is consistent
    const scores = aiResult.scores ?? { O: 0, C: 0, I: 0, F: 0, Q: 0, total: 0 }
    scores.total = (scores.O + scores.C + scores.I + scores.F + scores.Q) * 2

    // Labels come from OCIFQ_DIM_LABELS — LLM sometimes returns empty label for C.
    const dimensions = normalizeOcifqDimensions(aiResult.dimensions)

    const defaultRefQuarter = quarterCtx.fmpLatest
      ? formatFiscalQuarter(quarterCtx.fmpLatest)
      : quarterCtx.transcriptLatest
        ? formatFiscalQuarter(quarterCtx.transcriptLatest)
        : undefined

    const thesisItems = Array.isArray(aiResult.thesisItems)
      ? aiResult.thesisItems.slice(0, 5).map((item, i) => ({
          ...item,
          id: item.id ?? i + 1,
          invalidation: item.invalidation ?? '',
          referenceQuarter: item.referenceQuarter ?? defaultRefQuarter
        }))
      : []

    console.log(
      `[ocifq] ${sym} total=${scores.total}, view=${aiResult.view}, confidence=${aiResult.viewConfidence}`
    )

    // Normalize callTone — words + quotes are programmatic (AI fabricates these)
    // AI only provides: confidenceScore, guidanceTone, toneShift, summary
    const toneExtract = hasTranscripts ? extractToneWords(data.transcripts[0]) : null
    const realQuotes = hasTranscripts ? extractKeyQuotes(data.transcripts[0]) : { confidenceQuotes: [], hedgeQuotes: [] }

    const callTone: CallTone = aiResult.callTone?.available && hasTranscripts
      ? {
          available: true,
          quarter: aiResult.callTone.quarter ?? `${data.transcripts[0].year}Q${data.transcripts[0].quarter}`,
          confidenceScore: aiResult.callTone.confidenceScore ?? 50,
          // Programmatic — override AI output
          confidenceWords: toneExtract!.confidenceWords,
          hedgeWords: toneExtract!.hedgeWords,
          confidenceWordCount: toneExtract!.confidenceWords.reduce((s, w) => s + w.count, 0),
          hedgeWordCount: toneExtract!.hedgeWords.reduce((s, w) => s + w.count, 0),
          keyQuotes: [...realQuotes.confidenceQuotes, ...realQuotes.hedgeQuotes].slice(0, 3),
          confidenceQuotes: realQuotes.confidenceQuotes,
          hedgeQuotes: realQuotes.hedgeQuotes,
          // AI-provided (interpretation, not extraction)
          guidanceTone: aiResult.callTone.guidanceTone ?? 'none',
          toneShift: aiResult.callTone.toneShift ?? 'unknown',
          summary: aiResult.callTone.summary ?? ''
        }
      : { available: false }

    if (hasTranscripts && !callTone.available) {
      console.warn(`[ocifq] ${sym} callTone=false despite ${data.transcripts.length} transcripts — likely token truncation`)
    }
    console.log(
      `[ocifq] ${sym} callTone: available=${callTone.available}` +
        (callTone.available ? ` confidence=${callTone.confidenceScore} guidance=${callTone.guidanceTone} shift=${callTone.toneShift}` : '')
    )

    return {
      symbol: sym,
      name: data.profile?.name ?? sym,
      industry: data.profile?.finnhubIndustry ?? '',
      marketCap: data.profile?.marketCapitalization ?? 0,
      peers: data.peers,
      scores,
      dimensions,
      thesisItems,
      quarterContext: {
        fmpLatest: quarterCtx.fmpLatest ? formatFiscalQuarter(quarterCtx.fmpLatest) : null,
        transcriptLatest: quarterCtx.transcriptLatest
          ? formatFiscalQuarter(quarterCtx.transcriptLatest)
          : null,
        lag: quarterCtx.lag,
        message: quarterCtx.lagMessage
      },
      callTone,
      summary: aiResult.summary ?? '',
      optionImplication: aiResult.optionImplication ?? '',
      view: aiResult.view ?? 'neutral',
      viewConfidence: aiResult.viewConfidence ?? 50,
      dataStats: {
        newsCount: data.news.length,
        earningsQuarters: data.earnings.length,
        peersCount: data.peers.length,
        hasFinancials: Object.keys(data.financials.metric).length > 0,
        fmpIncomeQuarters: data.fmpFinancials.income.length,
        fmpCashFlowQuarters: data.fmpFinancials.cashFlow.length,
        transcriptQuarters: data.transcripts.length
      },
      generatedAt: new Date().toISOString()
    }
  })
}
