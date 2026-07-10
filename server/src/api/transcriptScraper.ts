/**
 * Earnings call transcript scraper — Motley Fool.
 *
 * Strategy: discover transcript URLs from the Fool's quote page, then fetch.
 *   1. GET /quote/{exchange}/{ticker}/ — HTML embeds a JSON list of all
 *      transcript paths for that ticker (no guessing slugs or dates)
 *   2. Match desired quarters from the discovered URLs
 *   3. Fetch each transcript page, parse HTML → structured data
 *   4. Cache on disk per symbol+quarter, 30-day TTL
 *
 * Total requests per symbol: 1 (discovery) + N (one per quarter).
 * Rate limiting: 2 s between requests.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = join(__dirname, '..', '..', 'data', 'transcripts')
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export type { EarningsTranscript, TranscriptEntry } from './fmpFinancials.js'
import type { EarningsTranscript, TranscriptEntry } from './fmpFinancials.js'

// ---------- Disk cache ----------

mkdirSync(CACHE_DIR, { recursive: true })

function cacheKey(symbol: string, year: number, quarter: number): string {
  return `${symbol}_${year}_Q${quarter}.json`
}

function readCache(symbol: string, year: number, quarter: number): EarningsTranscript | null {
  const path = join(CACHE_DIR, cacheKey(symbol, year, quarter))
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    if (Date.now() - (raw._cachedAt ?? 0) > CACHE_TTL_MS) return null
    delete raw._cachedAt
    return raw as EarningsTranscript
  } catch {
    return null
  }
}

function writeCache(symbol: string, year: number, quarter: number, data: EarningsTranscript): void {
  const path = join(CACHE_DIR, cacheKey(symbol, year, quarter))
  try {
    writeFileSync(path, JSON.stringify({ ...data, _cachedAt: Date.now() }), 'utf-8')
  } catch (e) {
    console.warn('[transcript] cache write failed:', (e as Error).message)
  }
}

// ---------- Rate limiting ----------

let lastFetchTs = 0

async function throttledFetch(url: string): Promise<Response> {
  const now = Date.now()
  const wait = Math.max(0, 2000 - (now - lastFetchTs))
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastFetchTs = Date.now()
  return fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    redirect: 'follow'
  })
}

// ---------- URL discovery ----------

type DiscoveredTranscript = {
  url: string
  quarter: number
  year: number
}

const EXCHANGES = ['nasdaq', 'nyse', 'nysemkt'] as const
const URL_PATTERN = /call-transcripts\/(\d{4})\/(\d{2})\/(\d{2})\/[a-z0-9-]+-q(\d)-(\d{4})-earnings-call-transcript\//g

/**
 * Discover all transcript URLs for a ticker from the Motley Fool quote page.
 * One HTTP request — the page HTML embeds transcript paths as JSON data.
 */
async function discoverTranscriptUrls(ticker: string): Promise<DiscoveredTranscript[]> {
  const tk = ticker.toLowerCase()

  for (const exchange of EXCHANGES) {
    const quoteUrl = `https://www.fool.com/quote/${exchange}/${tk}/`
    try {
      const res = await throttledFetch(quoteUrl)
      if (res.status !== 200) continue
      const html = await res.text()

      // Extract transcript paths from embedded JSON data in the page
      const matches = [...html.matchAll(URL_PATTERN)]
      if (matches.length === 0) continue

      // Deduplicate (paths appear twice in the HTML — once in JSON, once in rendered links)
      const seen = new Set<string>()
      const results: DiscoveredTranscript[] = []
      for (const m of matches) {
        const path = m[0]
        if (seen.has(path)) continue
        seen.add(path)
        const quarter = parseInt(m[4], 10)
        const year = parseInt(m[5], 10)
        results.push({
          url: `https://www.fool.com/earnings/${path}`,
          quarter,
          year
        })
      }

      if (results.length > 0) {
        console.log(`[transcript] ${ticker}: discovered ${results.length} transcripts via /quote/${exchange}/${tk}/`)
        return results
      }
    } catch {
      continue
    }
  }

  console.log(`[transcript] ${ticker}: no transcripts found on quote page`)
  return []
}

// ---------- HTML parsing ----------

function parseTranscriptHtml(html: string): { content: string; entries: TranscriptEntry[] } {
  const startIdx = html.indexOf('article-body-transcript')
  if (startIdx < 0) return { content: '', entries: [] }

  const endIdx = html.indexOf('</article>', startIdx)
  const chunk = html.slice(startIdx, endIdx > 0 ? endIdx : startIdx + 100000)

  const text = chunk
    .replace(/<h2[^>]*>/gi, '\n\n### ')
    .replace(/<\/h2>/gi, '\n')
    .replace(/<p[^>]*>/gi, '\n')
    .replace(/<strong>/gi, '**')
    .replace(/<\/strong>/gi, '**')
    .replace(/<em>/gi, '')
    .replace(/<\/em>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  const fccIdx = text.indexOf('Full Conference Call Transcript')
  const content = fccIdx >= 0 ? text.slice(fccIdx) : text

  const entries: TranscriptEntry[] = []
  const speakerRegex = /\*\*([^*]+?)\*\*[:\s]*([^*]*?)(?=\*\*[A-Z]|\n### |$)/gs
  let match: RegExpExecArray | null
  while ((match = speakerRegex.exec(content)) !== null) {
    const speaker = match[1].trim().replace(/:$/, '')
    const spText = match[2].trim()
    if (speaker && spText.length > 20) {
      entries.push({ speaker, text: spText })
    }
  }

  const cleanContent = content.replace(/\*\*/g, '').replace(/### /g, '')
  return { content: cleanContent, entries }
}

// ---------- Public API ----------

/**
 * Scrape an earnings call transcript from a known Motley Fool URL.
 */
async function fetchTranscript(
  url: string,
  symbol: string,
  year: number,
  quarter: number
): Promise<EarningsTranscript | null> {
  try {
    const res = await throttledFetch(url)
    if (res.status === 429) {
      console.warn(`[transcript] ${symbol} ${year}Q${quarter}: 429 rate-limited, skipping`)
      return null
    }
    if (res.status !== 200) return null

    const html = await res.text()
    if (!html.includes('article-body-transcript')) return null

    const { content, entries } = parseTranscriptHtml(html)
    if (content.length < 500) return null

    console.log(`[transcript] ${symbol} ${year}Q${quarter}: fetched (${content.length} chars, ${entries.length} speakers)`)

    const result: EarningsTranscript = {
      symbol,
      quarter,
      year,
      date: '',
      content,
      entries
    }
    writeCache(symbol, year, quarter, result)
    return result
  } catch {
    return null
  }
}

/**
 * Scrape the most recent N transcripts for a symbol.
 *
 * Flow: discover all transcript URLs from the quote page (1 request),
 * then fetch the N most recent ones (N requests). Total: N+1 requests.
 */
export async function scrapeRecentTranscripts(
  symbol: string,
  quarters: number = 3,
  _incomeData?: unknown,
  _companyName?: string
): Promise<EarningsTranscript[]> {
  const sym = symbol.toUpperCase()

  // Check how many quarters are already cached
  // (avoid the discovery request if all desired quarters are cached)
  // We don't know which quarters to check without discovery, so just proceed

  // Step 1: Discover transcript URLs from quote page (1 request)
  const discovered = await discoverTranscriptUrls(sym)
  if (discovered.length === 0) return []

  // Step 2: Take the N most recent (they come in reverse chronological order)
  const toFetch = discovered.slice(0, quarters)

  // Step 3: Fetch each, checking cache first
  const results: EarningsTranscript[] = []
  for (const d of toFetch) {
    const cached = readCache(sym, d.year, d.quarter)
    if (cached) {
      console.log(`[transcript] ${sym} ${d.year}Q${d.quarter}: cache hit (${cached.content.length} chars)`)
      results.push(cached)
      continue
    }

    const t = await fetchTranscript(d.url, sym, d.year, d.quarter)
    if (t) results.push(t)
  }

  return results
}

/**
 * Scrape a single transcript. Discovers URL from quote page if needed.
 */
export async function scrapeTranscript(
  symbol: string,
  year: number,
  quarter: number,
  _reportDate?: string,
  _companyName?: string
): Promise<EarningsTranscript | null> {
  const sym = symbol.toUpperCase()

  const cached = readCache(sym, year, quarter)
  if (cached) {
    console.log(`[transcript] ${sym} ${year}Q${quarter}: cache hit (${cached.content.length} chars)`)
    return cached
  }

  const discovered = await discoverTranscriptUrls(sym)
  const match = discovered.find(d => d.year === year && d.quarter === quarter)
  if (!match) {
    console.log(`[transcript] ${sym} ${year}Q${quarter}: not found in discovery`)
    return null
  }

  return fetchTranscript(match.url, sym, year, quarter)
}
