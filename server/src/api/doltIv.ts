/**
 * Free 52-week IV high/low from the DoltHub `post-no-preference/options`
 * dataset's `volatility_history` table (public read-only SQL API).
 *
 * Used as the PRIMARY source for IV Rank until our own self-accumulated CBOE IV
 * history reaches a full trading year, at which point we graduate to the
 * self-sufficient store (see computeIvRankFromHistory). This makes IVR
 * trustworthy immediately instead of waiting ~6 months for self-accumulation —
 * e.g. AAPL reads a true ~73 and HOOD a true ~49 instead of a shallow-window 100.
 *
 * Weekly cache — the annual high/low move slowly. Unofficial community dataset
 * with no SLA, so every consumer MUST degrade gracefully on null (uncovered
 * symbol, timeout, downtime → caller falls back to the self-accumulated store).
 * Personal research use only.
 */
import { cached, DAY } from '../ai/cache.js'

const BASE = 'https://www.dolthub.com/api/v1alpha1/post-no-preference/options/master'
const TTL = 7 * DAY
const TIMEOUT_MS = 8000

export type DoltIvRange = { yearHigh: number; yearLow: number; asOf: string }

async function fetchRange(sym: string): Promise<DoltIvRange | null> {
  const q =
    'SELECT iv_year_high, iv_year_low, `date` FROM volatility_history' +
    ` WHERE act_symbol = '${sym}' ORDER BY \`date\` DESC LIMIT 1`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${BASE}?q=${encodeURIComponent(q)}`, { signal: ctrl.signal })
    if (!res.ok) return null
    const j = (await res.json()) as { rows?: Array<Record<string, string>> }
    const row = j.rows?.[0]
    if (!row) return null
    const hi = Number(row.iv_year_high)
    const lo = Number(row.iv_year_low)
    // Reject missing/degenerate ranges (uncovered or too-new symbols) → the
    // caller falls back to the self-accumulated store / shrinkage.
    if (!(hi > 0 && lo > 0 && hi - lo > 0.001)) return null
    return { yearHigh: hi, yearLow: lo, asOf: row.date }
  } catch {
    return null // network error / timeout / bad JSON → graceful null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 52-week IV range for `symbol`, or null if unavailable/uncovered. Cached a
 * week; the null case is cached too (via a wrapper) so uncovered symbols don't
 * re-hit DoltHub every scan.
 */
export async function getDoltIvRange(symbol: string): Promise<DoltIvRange | null> {
  const sym = symbol.toUpperCase().replace(/[^A-Z0-9.]/g, '') // sanitize before SQL interpolation
  if (!sym) return null
  const wrapped = await cached<{ range: DoltIvRange | null }>(
    `dolt-iv-${sym}`,
    TTL,
    async () => ({ range: await fetchRange(sym) })
  )
  return wrapped.range
}
