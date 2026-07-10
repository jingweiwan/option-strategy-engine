/**
 * Polygon.io REST client.
 * Free tier supports stocks reference + EOD; options snapshot generally requires
 * the Options Starter plan or higher. Keep responses tolerant.
 *
 * Docs:
 *   - https://polygon.io/docs/options/get_v3_snapshot_options__underlyingasset
 *   - https://polygon.io/docs/options/get_v3_reference_options_contracts
 *   - https://polygon.io/docs/stocks/get_v2_last_trade__stocksticker
 */

import type { Quote, OptionContract } from './types.js'

export type { Quote, OptionContract } from './types.js'

const base = process.env.POLYGON_BASE ?? 'https://api.polygon.io'
const apiKey = process.env.POLYGON_API_KEY ?? ''

async function polyFetch<T = any>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  if (!apiKey) throw new Error('POLYGON_API_KEY not configured')
  const url = new URL(base + path)
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v))
  }
  url.searchParams.set('apiKey', apiKey)
  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json' }
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Polygon ${res.status}: ${text.slice(0, 280)}`)
  }
  return (await res.json()) as T
}

/**
 * Last trade price from Polygon. On free tier this is delayed.
 */
export async function getQuote(symbol: string): Promise<Quote> {
  // Try the snapshot endpoint first — it includes a ticker quote with bid/ask.
  // On free tier, snapshot for stocks may not be available; fall back to last trade.
  try {
    const data = await polyFetch<any>(
      `/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(symbol)}`
    )
    const t = data?.ticker
    if (t) {
      const last = t.lastTrade?.p ?? t.day?.c ?? 0
      const bid = t.lastQuote?.p ?? 0 // bid
      const ask = t.lastQuote?.P ?? 0 // ask
      if (Number.isFinite(last) && last > 0) {
        return { symbol, last, bid, ask }
      }
    }
  } catch {
    /* fall through to last trade */
  }

  const trade = await polyFetch<any>(`/v2/last/trade/${encodeURIComponent(symbol)}`)
  const last = trade?.results?.p ?? 0
  if (!Number.isFinite(last) || last <= 0) {
    throw new Error(`No price for ${symbol}`)
  }
  return { symbol, last, bid: 0, ask: 0 }
}

/**
 * Returns all upcoming expiration dates for a ticker, sorted ascending.
 * Polygon doesn't have a dedicated "list expirations" endpoint — we list
 * contracts and dedupe by expiration_date.
 */
export async function getExpirations(symbol: string): Promise<string[]> {
  const today = new Date().toISOString().slice(0, 10)
  const data = await polyFetch<any>('/v3/reference/options/contracts', {
    underlying_ticker: symbol,
    'expiration_date.gte': today,
    expired: 'false',
    limit: 1000,
    order: 'asc',
    sort: 'expiration_date'
  })
  const list = (data?.results ?? []) as Array<{ expiration_date?: string }>
  const set = new Set<string>()
  for (const c of list) {
    if (c.expiration_date) set.add(c.expiration_date)
  }
  return Array.from(set).sort()
}

/**
 * Full option chain snapshot for a given expiration, with greeks + IV
 * + bid/ask + OI + volume. Handles pagination via next_url.
 */
export async function getOptionChain(
  symbol: string,
  expiration: string
): Promise<OptionContract[]> {
  const out: OptionContract[] = []

  let pathOrUrl = `/v3/snapshot/options/${encodeURIComponent(symbol)}`
  let params: Record<string, string | number> = {
    expiration_date: expiration,
    limit: 250
  }

  for (let page = 0; page < 6; page++) {
    let data: any
    if (pathOrUrl.startsWith('http')) {
      // next_url path — call directly with apiKey appended
      const url = new URL(pathOrUrl)
      url.searchParams.set('apiKey', apiKey)
      const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`Polygon ${res.status}: ${text.slice(0, 280)}`)
      }
      data = await res.json()
    } else {
      data = await polyFetch<any>(pathOrUrl, params)
    }

    const results = data?.results ?? []
    for (const r of results) {
      const d = r?.details
      if (!d || !d.expiration_date || d.expiration_date !== expiration) continue
      const bid = r?.last_quote?.bid ?? 0
      const ask = r?.last_quote?.ask ?? 0
      const mid =
        bid > 0 && ask > 0
          ? (bid + ask) / 2
          : r?.last_quote?.midpoint ?? r?.day?.close ?? 0
      const greeksRaw = r?.greeks
      const ivVal = r?.implied_volatility ?? greeksRaw?.iv ?? null
      const greeks =
        greeksRaw && Number.isFinite(greeksRaw.delta)
          ? {
              delta: greeksRaw.delta,
              gamma: greeksRaw.gamma ?? 0,
              theta: greeksRaw.theta ?? 0,
              vega: greeksRaw.vega ?? 0
            }
          : undefined

      out.push({
        symbol: d.ticker,
        strike: d.strike_price,
        optionType: d.contract_type,
        bid,
        ask,
        mid,
        last: r?.day?.close ?? 0,
        openInterest: r?.open_interest ?? 0,
        volume: r?.day?.volume ?? 0,
        expiration: d.expiration_date,
        iv: Number.isFinite(ivVal) ? ivVal : undefined,
        greeks
      })
    }

    if (data?.next_url) {
      pathOrUrl = data.next_url
      params = {}
    } else {
      break
    }
  }

  return out
}
