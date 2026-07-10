/**
 * Default dashboard / opp-scan watchlist + parsing for ?symbols= API.
 */

export type WatchlistEntry = {
  sym: string
  name: string
}

export const DEFAULT_WATCHLIST: WatchlistEntry[] = [
  { sym: 'NVDA', name: 'NVIDIA Corp.' },
  { sym: 'TSLA', name: 'Tesla, Inc.' },
  { sym: 'AAPL', name: 'Apple Inc.' },
  { sym: 'AMZN', name: 'Amazon.com, Inc.' },
  { sym: 'META', name: 'Meta Platforms' },
  { sym: 'GOOGL', name: 'Alphabet Inc.' },
  { sym: 'AMD', name: 'Advanced Micro Dev.' },
  // Index ETFs — no single-name earnings, deep liquid options: the natural home
  // for systematic condor selling. Keeping them in the pool means the gated
  // board usually has *some* event-free candidate instead of going empty.
  { sym: 'SPY', name: 'S&P 500 ETF' },
  { sym: 'QQQ', name: 'Nasdaq 100 ETF' },
  { sym: 'IWM', name: 'Russell 2000 ETF' }
]

const NAME_BY_SYM: Record<string, string> = Object.fromEntries(
  DEFAULT_WATCHLIST.map((e) => [e.sym, e.name])
)

const SYM_RE = /^[A-Z][A-Z0-9.-]{0,9}$/

const MAX_SYMBOLS = 16

/** Stable cache key segment for a watchlist (sorted tickers). */
export const watchlistCacheSlug = (entries: WatchlistEntry[]): string =>
  entries
    .map((e) => e.sym.toUpperCase())
    .sort()
    .join(',')

/**
 * Parse `?symbols=NVDA,TSLA` (or repeated query). Invalid tokens skipped.
 * Empty / all-invalid → default watchlist.
 */
export const parseWatchlistSymbolsQuery = (raw: string | string[] | undefined): WatchlistEntry[] => {
  const str = Array.isArray(raw) ? raw.join(',') : raw ?? ''
  const tokens = str
    .split(/[,\s]+/)
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean)

  const seen = new Set<string>()
  const out: WatchlistEntry[] = []

  for (const sym of tokens) {
    if (!SYM_RE.test(sym)) continue
    if (seen.has(sym)) continue
    seen.add(sym)
    out.push({ sym, name: NAME_BY_SYM[sym] ?? sym })
    if (out.length >= MAX_SYMBOLS) break
  }

  return out.length > 0 ? out : [...DEFAULT_WATCHLIST]
}
