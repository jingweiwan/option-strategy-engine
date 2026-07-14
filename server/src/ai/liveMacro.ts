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

// Last successful SPY/VIXY read — used as a stale fallback so a transient
// Finnhub blip (429 / Cloudflare 502) degrades the header to slightly-old real
// numbers instead of nuking the whole dashboard.
let lastGoodMacro: LiveMacro | null = null

/** Live SPY + VIXY. Throws if Finnhub is unavailable; use liveOrStaleMacro to
 *  degrade gracefully. Populates the stale cache on success. */
export async function fetchLiveMacro(): Promise<LiveMacro> {
  if (LIVE_MACRO_OFF) throw new Error('LIVE_MACRO=0 (live macro disabled by env)')
  if (!finnhubKeySet()) throw new Error('FINNHUB_API_KEY not configured')
  const { spy, vixy } = await fetchSpyVixy()
  lastGoodMacro = { asof: formatAsofEt(), spy, vixy }
  return lastGoodMacro
}

/**
 * Best-available macro, NEVER throws: live → else last-known (stale) → else null.
 * The SPY/VIXY header is a secondary display; a transient Finnhub outage must not
 * take down the opportunity board / tickers with it. Stale-by-minutes real
 * numbers beat both a crash and fake zeros.
 */
async function liveOrStaleMacro(): Promise<LiveMacro | null> {
  try {
    return await fetchLiveMacro()
  } catch (e) {
    console.warn(
      `[liveMacro] live fetch failed: ${(e as Error).message}` +
        (lastGoodMacro ? ' → using last-known (stale)' : ' → no cached macro, skipping header')
    )
    return lastGoodMacro
  }
}

/** Overlay live-or-stale macro onto a MarketSnapshot (never throws). */
export async function mergeLiveMacroIntoSnapshot(snap: MarketSnapshot): Promise<MarketSnapshot> {
  const live = await liveOrStaleMacro()
  return live ? { ...snap, ...live } : snap
}

type MacroHeader = {
  asof: string
  spy: { v: number; chg: number }
  vixy: { v: number; chg: number }
}

/** Patch dashboard `market` header (SPY/VIXY/asof) with live-or-stale macro.
 *  Never throws — a Finnhub outage degrades the header, not the whole board. */
export async function mergeLiveMacroIntoDashboardMarket<M extends MacroHeader>(market: M): Promise<M> {
  const live = await liveOrStaleMacro()
  return live ? { ...market, ...live } : market
}
