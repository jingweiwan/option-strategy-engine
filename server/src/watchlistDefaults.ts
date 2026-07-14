/**
 * Default dashboard / opp-scan watchlist + parsing for ?symbols= API.
 */

export type WatchlistEntry = {
  sym: string
  name: string
}

// A deliberately BROAD, sector-diversified universe. The short-vol edge is rare
// (needs IV genuinely rich vs RV, event-free), so a narrow tech-heavy list left
// the gated board empty most days AND gave the correlation-aware selector no
// truly independent names to pick from. Widening the net — without lowering any
// gate — raises the odds that *some* name sits in the rare rich-and-calm window,
// and hands selectDiverse real cross-sector / cross-asset choices. All names are
// deep-liquid optionable large caps or event-free ETFs. Earnings-spanning names
// are still auto-excluded by boardTier when their report is near — membership
// here doesn't relax that.
export const DEFAULT_WATCHLIST: WatchlistEntry[] = [
  // Mega-cap tech (high mutual correlation — the selector will spread across them)
  { sym: 'NVDA', name: 'NVIDIA Corp.' },
  { sym: 'TSLA', name: 'Tesla, Inc.' },
  { sym: 'AAPL', name: 'Apple Inc.' },
  { sym: 'AMZN', name: 'Amazon.com, Inc.' },
  { sym: 'META', name: 'Meta Platforms' },
  { sym: 'GOOGL', name: 'Alphabet Inc.' },
  { sym: 'MSFT', name: 'Microsoft Corp.' },
  { sym: 'AMD', name: 'Advanced Micro Dev.' },
  // Financials
  { sym: 'JPM', name: 'JPMorgan Chase' },
  { sym: 'GS', name: 'Goldman Sachs' },
  { sym: 'BAC', name: 'Bank of America' },
  // Healthcare
  { sym: 'LLY', name: 'Eli Lilly' },
  { sym: 'JNJ', name: 'Johnson & Johnson' },
  // Energy
  { sym: 'XOM', name: 'Exxon Mobil' },
  { sym: 'CVX', name: 'Chevron' },
  // Consumer (staples + discretionary)
  { sym: 'COST', name: 'Costco' },
  { sym: 'WMT', name: 'Walmart' },
  { sym: 'HD', name: 'Home Depot' },
  { sym: 'MCD', name: "McDonald's" },
  // Payments
  { sym: 'V', name: 'Visa Inc.' },
  // Broad-index ETFs — no single-name earnings, deep liquid options: the natural
  // home for systematic condor selling, always event-free so always eligible.
  { sym: 'SPY', name: 'S&P 500 ETF' },
  { sym: 'QQQ', name: 'Nasdaq 100 ETF' },
  { sym: 'IWM', name: 'Russell 2000 ETF' },
  { sym: 'DIA', name: 'Dow Jones ETF' },
  // Cross-asset / sector ETFs — genuinely uncorrelated with the equity names, so
  // they give the diversity selector real independent candidates (and never have
  // earnings): gold, long Treasuries, energy, financials, emerging markets.
  { sym: 'GLD', name: 'SPDR Gold Shares' },
  { sym: 'TLT', name: 'iShares 20+Yr Treasury' },
  { sym: 'XLE', name: 'Energy Select SPDR' },
  { sym: 'XLF', name: 'Financial Select SPDR' },
  { sym: 'EEM', name: 'iShares MSCI Emerging Mkts' },
  // Held names — keep the book's own underlyings in view so the scanner surfaces
  // roll/add candidates on what the user already owns (and the watchlist table +
  // position alerts stay aligned). These carry single-name earnings and are
  // gated like any other when a report is near.
  { sym: 'UNH', name: 'UnitedHealth Group' },
  { sym: 'MU', name: 'Micron Technology' },
  { sym: 'VST', name: 'Vistra Corp.' },
  { sym: 'GOOG', name: 'Alphabet Inc. (C)' },
  { sym: 'FIG', name: 'Figma Inc.' },
  { sym: 'CRCL', name: 'Circle Internet Group' },
  { sym: 'PLTR', name: 'Palantir Technologies' }
]

const NAME_BY_SYM: Record<string, string> = Object.fromEntries(
  DEFAULT_WATCHLIST.map((e) => [e.sym, e.name])
)

const SYM_RE = /^[A-Z][A-Z0-9.-]{0,9}$/

const MAX_SYMBOLS = 40

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
