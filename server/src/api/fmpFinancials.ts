/**
 * Financial Modeling Prep (FMP) client for structured financial statements.
 *
 * Provides quarterly income statement + cash flow statement data that
 * Finnhub's free tier lacks. This feeds the OCIFQ F-dimension (财务三爆)
 * with granular revenue, COGS, EBITDA, CapEx, FCF data.
 *
 * Free tier: 250 requests/day.
 * Docs: https://site.financialmodelingprep.com/developer/docs
 *
 * Endpoints used (stable API — v3 is deprecated for new users):
 *   GET /stable/income-statement?symbol=...&period=quarter&limit=${QUARTERS_LIMIT}
 *   GET /stable/cash-flow-statement?symbol=...&period=quarter&limit=${QUARTERS_LIMIT}
 */

const base = process.env.FMP_BASE ?? 'https://financialmodelingprep.com'
const apiKey = process.env.FMP_API_KEY ?? ''

// The current FMP plan caps `limit` at 5 — asking for more returns a 402 that
// Promise.allSettled swallowed into empty data, so quarterly financials were
// silently blank for EVERY symbol (no latest quarter, no QoQ). 5 quarters still
// covers "latest vs prior 4". Bump via FMP_QUARTERS_LIMIT if the plan upgrades.
const QUARTERS_LIMIT = Math.min(Number(process.env.FMP_QUARTERS_LIMIT) || 5, 5)

async function fmpFetch<T = any>(path: string): Promise<T> {
  if (!apiKey) throw new Error('FMP_API_KEY not configured')
  const sep = path.includes('?') ? '&' : '?'
  const url = `${base}${path}${sep}apikey=${encodeURIComponent(apiKey)}`
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`FMP ${res.status}: ${text.slice(0, 200)}`)
  }
  return (await res.json()) as T
}

// ---------- Types ----------

export type QuarterlyIncome = {
  date: string            // 'YYYY-MM-DD' — quarter end date (NOT earnings call date)
  filingDate: string      // 'YYYY-MM-DD' — SEC filing / earnings call date
  period: string          // 'Q1', 'Q2', etc.
  fiscalYear: string      // '2024'
  revenue: number
  costOfRevenue: number
  grossProfit: number
  grossProfitRatio: number
  operatingIncome: number
  operatingIncomeRatio: number
  ebitda: number
  ebitdaratio: number
  netIncome: number
  netIncomeRatio: number
  eps: number
  epsdiluted: number
  weightedAverageShsOutDil: number
}

export type QuarterlyCashFlow = {
  date: string
  period: string
  fiscalYear: string
  operatingCashFlow: number
  capitalExpenditure: number
  freeCashFlow: number
  stockBasedCompensation: number
  netCashProvidedByInvestingActivities: number
  netDebtIssuance: number
  commonStockRepurchased: number
  commonDividendsPaid: number
}

export type FmpFinancialData = {
  income: QuarterlyIncome[]
  cashFlow: QuarterlyCashFlow[]
}

// ---------- API functions ----------

export async function fetchQuarterlyIncome(symbol: string): Promise<QuarterlyIncome[]> {
  const sym = symbol.toUpperCase()
  const data = await fmpFetch<any[]>(
    `/stable/income-statement?symbol=${encodeURIComponent(sym)}&period=quarter&limit=${QUARTERS_LIMIT}`
  )
  if (!Array.isArray(data)) return []
  return data.map((d) => ({
    date: d.date ?? '',
    filingDate: d.filingDate ?? '',
    period: d.period ?? '',
    fiscalYear: d.fiscalYear ?? d.calendarYear ?? '',
    revenue: d.revenue ?? 0,
    costOfRevenue: d.costOfRevenue ?? 0,
    grossProfit: d.grossProfit ?? 0,
    grossProfitRatio: d.grossProfitRatio ?? 0,
    operatingIncome: d.operatingIncome ?? 0,
    operatingIncomeRatio: d.operatingIncomeRatio ?? 0,
    ebitda: d.ebitda ?? 0,
    ebitdaratio: d.ebitdaratio ?? 0,
    netIncome: d.netIncome ?? 0,
    netIncomeRatio: d.netIncomeRatio ?? 0,
    eps: d.eps ?? 0,
    epsdiluted: d.epsdiluted ?? 0,
    weightedAverageShsOutDil: d.weightedAverageShsOutDil ?? d.weightedAverageShsOut ?? 0
  }))
}

export async function fetchQuarterlyCashFlow(symbol: string): Promise<QuarterlyCashFlow[]> {
  const sym = symbol.toUpperCase()
  const data = await fmpFetch<any[]>(
    `/stable/cash-flow-statement?symbol=${encodeURIComponent(sym)}&period=quarter&limit=${QUARTERS_LIMIT}`
  )
  if (!Array.isArray(data)) return []
  return data.map((d) => ({
    date: d.date ?? '',
    period: d.period ?? '',
    fiscalYear: d.fiscalYear ?? d.calendarYear ?? '',
    operatingCashFlow: d.operatingCashFlow ?? d.netCashProvidedByOperatingActivities ?? 0,
    capitalExpenditure: d.capitalExpenditure ?? d.investmentsInPropertyPlantAndEquipment ?? 0,
    freeCashFlow: d.freeCashFlow ?? 0,
    stockBasedCompensation: d.stockBasedCompensation ?? 0,
    netCashProvidedByInvestingActivities: d.netCashProvidedByInvestingActivities ?? 0,
    netDebtIssuance: d.netDebtIssuance ?? 0,
    commonStockRepurchased: d.commonStockRepurchased ?? 0,
    commonDividendsPaid: d.commonDividendsPaid ?? d.dividendsPaid ?? 0
  }))
}

/**
 * Fetch both income statement and cash flow statement in parallel.
 * Returns empty arrays on failure (non-blocking).
 */
export async function fetchFmpFinancials(symbol: string): Promise<FmpFinancialData> {
  const [income, cashFlow] = await Promise.allSettled([
    fetchQuarterlyIncome(symbol),
    fetchQuarterlyCashFlow(symbol)
  ])
  return {
    income: income.status === 'fulfilled' ? income.value : [],
    cashFlow: cashFlow.status === 'fulfilled' ? cashFlow.value : []
  }
}

// ---------- Earnings Call Transcripts ----------
// Requires FMP Starter plan ($29/mo). Returns empty on free tier (HTTP 402).
// When available, powers OCIFQ Q-dimension + CallTone analysis.

export type TranscriptEntry = {
  /** Speaker name (e.g. "Tim Cook - CEO") */
  speaker: string
  /** What was said */
  text: string
}

export type EarningsTranscript = {
  symbol: string
  quarter: number
  year: number
  date: string
  content: string
  /** Parsed speaker entries (if content is parseable) */
  entries: TranscriptEntry[]
}

/**
 * Fetch earnings call transcript for a specific quarter.
 * Returns null if endpoint is unavailable (free tier) or no transcript exists.
 *
 * FMP stable endpoint: /stable/earning-call-transcript?symbol=...&year=...&quarter=...
 */
export async function fetchEarningsTranscript(
  symbol: string,
  year: number,
  quarter: number
): Promise<EarningsTranscript | null> {
  if (!apiKey) return null
  const sym = symbol.toUpperCase()
  const url = `${base}/stable/earning-call-transcript?symbol=${encodeURIComponent(sym)}&year=${year}&quarter=${quarter}&apikey=${encodeURIComponent(apiKey)}`

  let res: Response
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } })
  } catch {
    return null
  }

  // 402 = paid tier required; silently degrade
  if (res.status === 402 || res.status === 403) {
    return null
  }
  if (!res.ok) return null

  const data = await res.json().catch(() => null) as any
  if (!data) return null

  // Response can be array or object
  const item = Array.isArray(data) ? data[0] : data
  if (!item?.content && !item?.transcript) return null

  const content: string = item.content ?? item.transcript ?? ''
  const entries = parseTranscriptSpeakers(content)

  return {
    symbol: sym,
    quarter: item.quarter ?? quarter,
    year: item.year ?? year,
    date: item.date ?? '',
    content,
    entries
  }
}

/**
 * Fetch transcripts for the last N quarters. Returns only successfully
 * fetched ones (may be empty on free tier).
 */
export async function fetchRecentTranscripts(
  symbol: string,
  quarters: number = 3
): Promise<EarningsTranscript[]> {
  // Determine the last N quarter/year combos
  const now = new Date()
  const currentQ = Math.ceil((now.getMonth() + 1) / 3)
  const currentY = now.getFullYear()

  const qyPairs: [number, number][] = []
  let q = currentQ
  let y = currentY
  for (let i = 0; i < quarters + 1; i++) { // +1 buffer — current quarter may not have a call yet
    qyPairs.push([y, q])
    q--
    if (q === 0) { q = 4; y-- }
  }

  const results = await Promise.allSettled(
    qyPairs.map(([yr, qr]) => fetchEarningsTranscript(symbol, yr, qr))
  )

  return results
    .map((r) => r.status === 'fulfilled' ? r.value : null)
    .filter((t): t is EarningsTranscript => t != null && t.content.length > 100)
    .slice(0, quarters)
}

/**
 * Parse raw transcript text into speaker entries.
 * FMP transcripts typically follow the pattern:
 *   "Speaker Name - Title\nWhat they said\n\nNext Speaker..."
 */
function parseTranscriptSpeakers(content: string): TranscriptEntry[] {
  if (!content) return []
  const entries: TranscriptEntry[] = []

  // Common patterns: "Name - Title:" or "Name - Title\n"
  // Split by lines that look like speaker headers
  const lines = content.split('\n')
  let currentSpeaker = ''
  let currentText: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    // Detect speaker line: "Name - Title" or "Name, Title" followed by colon or newline
    const speakerMatch = trimmed.match(
      /^([A-Z][a-zA-Z.' -]+)\s*[-–—,]\s*(CEO|CFO|COO|CTO|President|VP|Director|Analyst|Chief|Senior|Managing|Head|Executive|Operator|Moderator)[^:]*:?\s*$/i
    )
    if (speakerMatch || (trimmed.endsWith(':') && trimmed.length < 80 && trimmed.includes(' '))) {
      // Save previous speaker's text
      if (currentSpeaker && currentText.length > 0) {
        entries.push({ speaker: currentSpeaker, text: currentText.join(' ').trim() })
      }
      currentSpeaker = trimmed.replace(/:$/, '').trim()
      currentText = []
    } else if (trimmed) {
      currentText.push(trimmed)
    }
  }

  // Last speaker
  if (currentSpeaker && currentText.length > 0) {
    entries.push({ speaker: currentSpeaker, text: currentText.join(' ').trim() })
  }

  return entries
}
