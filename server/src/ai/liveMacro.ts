/**
 * Live broad-market proxies: SPY (S&P 500 ETF) and VIXY (VIX futures ETF).
 *
 * Why ETFs not the actual indices?
 *   Finnhub free tier rejects index symbols (^VIX / ^GSPC / SPX) with
 *   "Market data subscription required for CFD indices". MarketData free
 *   tier likewise has no /v1/indices access. So we report ETFs honestly:
 *   - SPY tracks S&P 500 1:1 in direction; price ≈ SPX / 10
 *   - VIXY tracks VIX *futures*, not the spot VIX index; absolute level
 *     is contango-distorted, but daily change% still correlates well
 *
 * The field names (`spy`, `vixy`) make this explicit in every consumer —
 * UI / AI / cache key all see "SPY" not "SPX", removing the silent lie.
 */

import { getQuotePctChange } from '../api/finnhub.js'
import type { MarketSnapshot } from './marketNarrative.js'

const LIVE_MACRO_OFF = process.env.LIVE_MACRO === '0'

const finnhubKeySet = (): boolean => Boolean(process.env.FINNHUB_API_KEY?.trim())

export function formatAsofEt(): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short'
  }).format(new Date())
}

async function fetchSpyVixy(): Promise<{
  spy: { v: number; chg: number }
  vixy: { v: number; chg: number }
}> {
  const [spy, vixy] = await Promise.all([
    getQuotePctChange('SPY'),
    getQuotePctChange('VIXY')
  ])
  return { spy, vixy }
}

type LiveMacro = {
  asof: string
  spy: { v: number; chg: number }
  vixy: { v: number; chg: number }
}

/**
 * Live SPY + VIXY header. Throws if Finnhub is unavailable (no key, disabled,
 * or fetch error). Caller decides whether to return 502 or surface partial.
 *
 * Why no silent fallback: `/api/dashboard` is supposed to render TODAY's
 * market state. Stale mock data is worse than an error chip — the AI
 * narrative would dutifully analyze the wrong numbers.
 */
export async function fetchLiveMacro(): Promise<LiveMacro> {
  if (LIVE_MACRO_OFF) throw new Error('LIVE_MACRO=0 (live macro disabled by env)')
  if (!finnhubKeySet()) throw new Error('FINNHUB_API_KEY not configured')
  const { spy, vixy } = await fetchSpyVixy()
  return { asof: formatAsofEt(), spy, vixy }
}

/**
 * Overlay live macro onto a MarketSnapshot. Throws on live failure — caller
 * should handle (e.g. `/api/dashboard` returns 502, scheduler logs and skips).
 */
export async function mergeLiveMacroIntoSnapshot(snap: MarketSnapshot): Promise<MarketSnapshot> {
  const live = await fetchLiveMacro()
  return { ...snap, ...live }
}

type MacroHeader = {
  asof: string
  spy: { v: number; chg: number }
  vixy: { v: number; chg: number }
}

/** Patch dashboard `market` header only (SPY/VIXY/asof). Throws on failure. */
export async function mergeLiveMacroIntoDashboardMarket<M extends MacroHeader>(market: M): Promise<M> {
  const live = await fetchLiveMacro()
  return { ...market, ...live }
}
