/**
 * Yahoo Finance — unofficial but widely used.
 * No API key, no signup. Data is delayed ~15min.
 *
 * Auth strategy (incremental, to avoid hammering /v1/test/getcrumb which
 * aggressively rate-limits with 429):
 *   1. First try the endpoint with browser-like headers, no cookies, no crumb.
 *      Many regions accept this for read-only endpoints.
 *   2. On 401: fetch fc.yahoo.com to seed A1/A3 cookies, retry.
 *   3. On 401 again: fetch /v1/test/getcrumb (once per process), retry with
 *      cookies + ?crumb=...
 *
 * Cookies and crumb are cached in-memory for the server lifetime.
 */

import type { Quote, OptionContract } from './types.js'

export type { Quote, OptionContract } from './types.js'

const base = process.env.YAHOO_BASE ?? 'https://query1.finance.yahoo.com'

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  Accept: 'application/json,text/plain,*/*',
  'Accept-Language': 'en-US,en;q=0.9'
}

let cachedCookie: string | null = null
let cachedCrumb: string | null = null
let crumbAttempted = false

function parseSetCookie(headers: Headers): string {
  const raw = (headers as any).getSetCookie?.() as string[] | undefined
  if (raw && raw.length) return raw.map((c) => c.split(';')[0]).join('; ')
  const single = headers.get('set-cookie')
  if (!single) return ''
  return single
    .split(/,(?=[^ ]+=)/)
    .map((c) => c.split(';')[0].trim())
    .join('; ')
}

async function ensureCookies(): Promise<void> {
  if (cachedCookie) return
  try {
    const res = await fetch('https://fc.yahoo.com/', {
      headers: HEADERS,
      redirect: 'manual'
    })
    cachedCookie = parseSetCookie(res.headers)
  } catch {
    cachedCookie = ''
  }
}

async function ensureCrumb(): Promise<void> {
  if (cachedCrumb || crumbAttempted) return
  crumbAttempted = true
  await ensureCookies()
  const res = await fetch(`${base}/v1/test/getcrumb`, {
    headers: { ...HEADERS, ...(cachedCookie ? { Cookie: cachedCookie } : {}) }
  })
  if (res.ok) {
    cachedCrumb = (await res.text()).trim()
  } else if (res.status === 429) {
    throw new Error(
      `Yahoo rate-limited the crumb handshake (429). Wait ~15 min before retrying — please don't click repeatedly.`
    )
  } else {
    throw new Error(`Yahoo crumb fetch failed (${res.status}).`)
  }
}

async function rawFetch(path: string, withCrumb: boolean): Promise<Response> {
  let url = `${base}${path}`
  if (withCrumb && cachedCrumb) {
    const sep = url.includes('?') ? '&' : '?'
    url += `${sep}crumb=${encodeURIComponent(cachedCrumb)}`
  }
  return fetch(url, {
    headers: { ...HEADERS, ...(cachedCookie ? { Cookie: cachedCookie } : {}) }
  })
}

async function yfFetch<T = any>(path: string): Promise<T> {
  // Step 1: try as-is
  let res = await rawFetch(path, false)
  if (res.ok) return (await res.json()) as T

  // Step 2: seed cookies, retry
  if (res.status === 401) {
    await ensureCookies()
    res = await rawFetch(path, false)
    if (res.ok) return (await res.json()) as T
  }

  // Step 3: get crumb (once), retry
  if (res.status === 401) {
    await ensureCrumb()
    res = await rawFetch(path, true)
    if (res.ok) return (await res.json()) as T
  }

  const text = await res.text().catch(() => '')
  throw new Error(`Yahoo ${res.status}: ${text.slice(0, 200)}`)
}

function unixToDate(t: number): string {
  return new Date(t * 1000).toISOString().slice(0, 10)
}

function dateToUnix(yyyymmdd: string): number {
  return Math.floor(new Date(yyyymmdd + 'T00:00:00Z').getTime() / 1000)
}

export async function getQuote(symbol: string): Promise<Quote> {
  const data = await yfFetch<any>(`/v7/finance/options/${encodeURIComponent(symbol)}`)
  const r = data?.optionChain?.result?.[0]
  const q = r?.quote
  if (!q) throw new Error(`No quote for ${symbol}`)
  const last = q.regularMarketPrice ?? q.postMarketPrice ?? 0
  if (!Number.isFinite(last) || last <= 0) {
    throw new Error(`No price for ${symbol}`)
  }
  return { symbol, last, bid: q.bid ?? 0, ask: q.ask ?? 0 }
}

export async function getExpirations(symbol: string): Promise<string[]> {
  const data = await yfFetch<any>(`/v7/finance/options/${encodeURIComponent(symbol)}`)
  const r = data?.optionChain?.result?.[0]
  const ts: number[] = r?.expirationDates ?? []
  return ts.map(unixToDate)
}

function mapContract(c: any, type: 'call' | 'put', expiration: string): OptionContract {
  const bid = Number.isFinite(c.bid) ? c.bid : 0
  const ask = Number.isFinite(c.ask) ? c.ask : 0
  const last = Number.isFinite(c.lastPrice) ? c.lastPrice : 0
  const mid = bid > 0 && ask > 0 && ask >= bid ? (bid + ask) / 2 : last
  const iv =
    Number.isFinite(c.impliedVolatility) && c.impliedVolatility > 0
      ? c.impliedVolatility
      : undefined
  return {
    symbol: c.contractSymbol ?? '',
    strike: c.strike,
    optionType: type,
    bid,
    ask,
    mid,
    last,
    openInterest: Number.isFinite(c.openInterest) ? c.openInterest : 0,
    volume: Number.isFinite(c.volume) ? c.volume : 0,
    expiration,
    iv
  }
}

export async function getOptionChain(
  symbol: string,
  expiration: string
): Promise<OptionContract[]> {
  const ts = dateToUnix(expiration)
  const data = await yfFetch<any>(
    `/v7/finance/options/${encodeURIComponent(symbol)}?date=${ts}`
  )
  const r = data?.optionChain?.result?.[0]
  const opts = r?.options?.[0]
  if (!opts) return []
  const calls: any[] = opts.calls ?? []
  const puts: any[] = opts.puts ?? []
  return [
    ...calls.map((c) => mapContract(c, 'call', expiration)),
    ...puts.map((c) => mapContract(c, 'put', expiration))
  ]
}
