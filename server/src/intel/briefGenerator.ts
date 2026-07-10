/**
 * Daily intelligence brief generator.
 *
 * Aggregates Finnhub news, SEC filings, and analyst recommendations for a
 * watchlist, then sends them through DeepSeek for structured analysis.
 *
 * Cached per ET calendar day with 4-hour TTL (news changes faster than
 * strategy data).
 */

import { fetchCompanyNews, fetchSecFilings, fetchRecommendations } from '../api/finnhubIntel.js'
import type { FinnhubNewsItem, FinnhubFiling, FinnhubRecommendation } from '../api/finnhubIntel.js'
import { chatJson } from '../ai/client.js'
import { cached, etCalendarDay, HOUR } from '../ai/cache.js'

// ---------- Output types ----------

export type IntelItem = {
  sym: string
  category: 'news' | 'filing' | 'rating' | 'earnings'
  headline: string
  source: string
  time: string            // e.g. '04:31' or 'Yesterday' or '2d'
  tldr: string            // AI one-line summary
  thesisImpact: 'positive' | 'negative' | 'neutral' | 'monitor'
  relevance: string       // AI: why this matters for this ticker
  unread: boolean
}

export type CrossLink = {
  from: string            // ticker
  to: string              // ticker(s), e.g. 'META' or 'CVS+ELV'
  title: string
  strength: 'High' | 'Medium' | 'Low'
  body: string
}

export type DailyIntelBrief = {
  date: string
  scannedDocs: number
  scannedFilings: number
  topItems: IntelItem[]      // sorted by relevance, max 12
  crossLinks: CrossLink[]    // max 5
  generatedAt: string        // ISO timestamp
}

// ---------- Date helpers ----------

function daysAgoIso(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString().slice(0, 10)
}

function formatRelativeTime(unixTs: number): string {
  const now = Date.now()
  const diffMs = now - unixTs * 1000
  if (diffMs < 0) return 'now'
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 60) return `${diffMin}m`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) {
    const mm = String(new Date(unixTs * 1000).getUTCMinutes()).padStart(2, '0')
    const hh = String(new Date(unixTs * 1000).getUTCHours()).padStart(2, '0')
    return `${hh}:${mm}`
  }
  const diffDays = Math.floor(diffHr / 24)
  if (diffDays === 1) return 'Yesterday'
  return `${diffDays}d`
}

// ---------- Raw data collection ----------

type SymbolRawData = {
  sym: string
  news: FinnhubNewsItem[]
  filings: FinnhubFiling[]
  recommendations: FinnhubRecommendation[]
}

async function fetchSymbolData(symbol: string): Promise<SymbolRawData> {
  const today = new Date().toISOString().slice(0, 10)
  const news3d = daysAgoIso(3)
  const filings7d = daysAgoIso(7)

  const [news, filings, recommendations] = await Promise.allSettled([
    fetchCompanyNews(symbol, news3d, today),
    fetchSecFilings(symbol, filings7d, today),
    fetchRecommendations(symbol)
  ])

  const rawNews = news.status === 'fulfilled' ? news.value : []
  const rawFilings = filings.status === 'fulfilled' ? filings.value : []
  const rawRecs = recommendations.status === 'fulfilled' ? recommendations.value : []

  // Sort by recency, cap to avoid token bloat
  const sortedNews = rawNews
    .sort((a, b) => b.datetime - a.datetime)
    .slice(0, 5)

  const sortedFilings = rawFilings
    .sort((a, b) => b.filedDate.localeCompare(a.filedDate))
    .slice(0, 3)

  return {
    sym: symbol.toUpperCase(),
    news: sortedNews,
    filings: sortedFilings,
    recommendations: rawRecs.slice(0, 3) // latest 3 months
  }
}

// ---------- AI brief generation ----------

const SYSTEM_PROMPT = `你是一个专注于期权策略的 hedge fund PM 分析师。你需要分析给定的新闻、SEC filing 和分析师评级数据，生成一份结构化的每日情报摘要。

要求：
1. 对每条新闻/filing 做一行 tldr（中文为主，保留英文术语如 earnings beat、guidance raised、FDA approval 等）
2. 判断 thesisImpact: positive / negative / neutral / monitor
3. 用一句话说明 relevance（对该标的期权策略的影响）
4. 识别跨标的关联（cross-links），例如供应链、竞争对手、行业趋势
5. 按重要性排序，最多返回 12 条 topItems 和 5 条 crossLinks

输出严格 JSON，schema:
{
  "topItems": [
    {
      "sym": "AAPL",
      "category": "news" | "filing" | "rating" | "earnings",
      "headline": "原标题",
      "source": "来源",
      "time": "相对时间",
      "tldr": "一行中文摘要",
      "thesisImpact": "positive" | "negative" | "neutral" | "monitor",
      "relevance": "对期权策略的影响",
      "unread": true
    }
  ],
  "crossLinks": [
    {
      "from": "AAPL",
      "to": "MSFT",
      "title": "标题",
      "strength": "High" | "Medium" | "Low",
      "body": "关联说明"
    }
  ]
}`

function buildUserPrompt(allData: SymbolRawData[]): string {
  const sections: string[] = []

  for (const d of allData) {
    const parts: string[] = [`=== ${d.sym} ===`]

    if (d.news.length > 0) {
      parts.push('--- News ---')
      for (const n of d.news) {
        parts.push(`[${formatRelativeTime(n.datetime)}] ${n.headline} (${n.source})`)
        if (n.summary) parts.push(`  Summary: ${n.summary.slice(0, 300)}`)
      }
    }

    if (d.filings.length > 0) {
      parts.push('--- SEC Filings ---')
      for (const f of d.filings) {
        parts.push(`[${f.filedDate}] ${f.form} — ${f.accessNumber}`)
      }
    }

    if (d.recommendations.length > 0) {
      parts.push('--- Analyst Recommendations (latest months) ---')
      for (const r of d.recommendations) {
        parts.push(
          `[${r.period}] strongBuy=${r.strongBuy} buy=${r.buy} hold=${r.hold} sell=${r.sell} strongSell=${r.strongSell}`
        )
      }
    }

    sections.push(parts.join('\n'))
  }

  return sections.join('\n\n')
}

// ---------- Public API ----------

export async function generateDailyBrief(symbols: string[]): Promise<DailyIntelBrief> {
  const day = etCalendarDay()
  const sortedSyms = [...symbols].map((s) => s.toUpperCase()).sort()
  const cacheKey = `intel-brief-${day}-${sortedSyms.join(',')}`

  return cached(cacheKey, 4 * HOUR, async () => {
    console.log(`[intel] generating daily brief for ${sortedSyms.join(',')}`)

    // Fetch all symbol data in parallel
    const results = await Promise.allSettled(
      sortedSyms.map((sym) => fetchSymbolData(sym))
    )

    const allData: SymbolRawData[] = []
    let totalDocs = 0
    let totalFilings = 0

    for (const r of results) {
      if (r.status === 'fulfilled') {
        allData.push(r.value)
        totalDocs += r.value.news.length
        totalFilings += r.value.filings.length
      }
    }

    if (allData.length === 0) {
      console.warn('[intel] no data fetched for any symbol')
      return {
        date: day,
        scannedDocs: 0,
        scannedFilings: 0,
        topItems: [],
        crossLinks: [],
        generatedAt: new Date().toISOString()
      }
    }

    // Call DeepSeek for analysis
    const { data } = await chatJson<{
      topItems: IntelItem[]
      crossLinks: CrossLink[]
    }>(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(allData) }
      ],
      { temperature: 0.4, maxTokens: 10000 }
    )

    const topItems = Array.isArray(data.topItems)
      ? data.topItems.slice(0, 12).map((item) => ({
          ...item,
          unread: true
        }))
      : []

    const crossLinks = Array.isArray(data.crossLinks)
      ? data.crossLinks.slice(0, 5)
      : []

    console.log(
      `[intel] brief generated: ${topItems.length} items, ${crossLinks.length} crossLinks, ${totalDocs} docs, ${totalFilings} filings`
    )

    return {
      date: day,
      scannedDocs: totalDocs,
      scannedFilings: totalFilings,
      topItems,
      crossLinks,
      generatedAt: new Date().toISOString()
    }
  })
}
