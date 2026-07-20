/**
 * CBOE delayed-quotes options feed.
 *
 * Public JSON the cboe.com site itself consumes — no auth, ~15-minute delayed,
 * covers US listed options with IV + full greeks. Crucially, ONE request
 * returns a symbol's ENTIRE chain (all expirations), so it sidesteps the
 * per-(symbol, expiration) request caps that exhaust MarketData's free tier.
 *
 *   GET https://cdn.cboe.com/api/global/delayed_quotes/options/{SYMBOL}.json
 *
 * Indices/cash products (SPX, VIX, …) are served under an underscore prefix.
 * Use for personal research only — it is not a contracted feed.
 */
import type { Quote, OptionContract, ContractGreeks } from './types.js'

export type { Quote, OptionContract } from './types.js'

const BASE = 'https://cdn.cboe.com/api/global/delayed_quotes/options'

/** Cash/index symbols CBOE serves with an underscore prefix. */
const INDEX_SYMBOLS = new Set(['SPX', 'VIX', 'NDX', 'RUT', 'XSP', 'DJX', 'OEX', 'VIXW'])

type RawOption = {
  option: string
  bid: number
  ask: number
  iv: number
  open_interest: number
  volume: number
  delta: number
  gamma: number
  vega: number
  theta: number
  last_trade_price: number
}
type RawData = {
  current_price: number
  price_change: number
  price_change_percent: number
  bid: number
  ask: number
  prev_day_close: number
  options: RawOption[]
}

// One fetch returns every expiration, so cache the raw payload briefly and let
// getQuote / getExpirations / getOptionChain for the same symbol share it.
const TTL_MS = 60_000
const cache = new Map<string, { ts: number; data: RawData }>()

// In-flight dedup. A scan asks for the same symbol's quote, expirations and
// chain at once; without this each fires its own copy of a payload that can
// exceed 1MB, tripling the load that gets us throttled in the first place.
const inFlight = new Map<string, Promise<RawData>>()

// CBOE has no daily cap but does throttle a rolling window, and it is now the
// primary source for quotes AND chains — so a burst 429s the tail of the scan.
// Retrying at the call site can't help (every caller shares one budget), so
// back off here: 429 is transient, and the window clears in seconds.
const RETRY_DELAYS_MS = [800, 2500, 6000]

function cboeSymbol(sym: string): string {
  const s = sym.toUpperCase()
  return INDEX_SYMBOLS.has(s) ? `_${s}` : s
}

async function fetchOnce(sym: string): Promise<RawData> {
  const url = `${BASE}/${encodeURIComponent(cboeSymbol(sym))}.json`
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' }
  })
  if (!res.ok) throw new Error(`CBOE ${res.status} for ${sym}`)
  const json = (await res.json()) as { data?: RawData }
  const data = json?.data
  if (!data || !Array.isArray(data.options)) {
    throw new Error(`CBOE: no option data for ${sym}`)
  }
  return data
}

async function fetchWithBackoff(sym: string): Promise<RawData> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchOnce(sym)
    } catch (e) {
      const throttled = (e as Error).message.includes('CBOE 429')
      if (!throttled || attempt >= RETRY_DELAYS_MS.length) throw e
      // Jitter so concurrent callers don't retry in lockstep and re-burst.
      const wait = RETRY_DELAYS_MS[attempt] * (0.75 + Math.random() * 0.5)
      await new Promise((r) => setTimeout(r, wait))
    }
  }
}

async function fetchRaw(symbol: string): Promise<RawData> {
  const sym = symbol.toUpperCase()
  const hit = cache.get(sym)
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.data

  const pending = inFlight.get(sym)
  if (pending) return pending

  const p = fetchWithBackoff(sym)
    .then((data) => {
      cache.set(sym, { ts: Date.now(), data })
      return data
    })
    .finally(() => inFlight.delete(sym))
  inFlight.set(sym, p)
  return p
}

/**
 * Parse an OCC option symbol from the right — the root is variable length
 * (1-6 chars), the suffix is always YYMMDD + C/P + strike×1000 (8 digits).
 *   AAPL260610C00250000 → call, strike 250, 2026-06-10
 */
function parseOcc(
  occ: string
): { optionType: 'call' | 'put'; strike: number; expiration: string } | null {
  if (occ.length < 15) return null
  const ymd = occ.slice(-15, -9)
  const cp = occ.slice(-9, -8)
  const strike = parseInt(occ.slice(-8), 10) / 1000
  if (!/^\d{6}$/.test(ymd) || (cp !== 'C' && cp !== 'P') || !Number.isFinite(strike)) {
    return null
  }
  const expiration = `20${ymd.slice(0, 2)}-${ymd.slice(2, 4)}-${ymd.slice(4, 6)}`
  return { optionType: cp === 'C' ? 'call' : 'put', strike, expiration }
}

/**
 * Raw one-shot payload (underlying quote + every contract of every
 * expiration). Exposed for the daily chain archiver — storing the unmapped
 * vendor payload keeps all fields available for future offline replay.
 */
export async function getRawPayload(symbol: string): Promise<unknown> {
  return fetchRaw(symbol)
}

export async function getQuote(symbol: string): Promise<Quote> {
  const d = await fetchRaw(symbol)
  const last = d.current_price
  if (!Number.isFinite(last) || last <= 0) throw new Error(`No price for ${symbol}`)
  return {
    symbol: symbol.toUpperCase(),
    last,
    bid: d.bid ?? 0,
    ask: d.ask ?? 0,
    change: Number.isFinite(d.price_change) ? d.price_change : undefined,
    changePct: Number.isFinite(d.price_change_percent) ? d.price_change_percent : undefined
  }
}

/** Pure mappers over a raw payload — shared by the live fetch and the offline
 *  chain-archive replay (which stores exactly this `data` object). */
export function rawExpirations(raw: unknown): string[] {
  const opts = (raw as RawData)?.options
  if (!Array.isArray(opts)) return []
  const set = new Set<string>()
  for (const o of opts) {
    const p = parseOcc(o.option)
    if (p) set.add(p.expiration)
  }
  return [...set].sort()
}

export function rawSpot(raw: unknown): number | null {
  const px = (raw as RawData)?.current_price
  return Number.isFinite(px) && px > 0 ? px : null
}

export function mapRawChain(raw: unknown, expiration: string): OptionContract[] {
  const opts = (raw as RawData)?.options
  if (!Array.isArray(opts)) return []
  const out: OptionContract[] = []
  for (const o of opts) {
    const p = parseOcc(o.option)
    if (!p || p.expiration !== expiration) continue

    const bid = o.bid ?? 0
    const ask = o.ask ?? 0
    const mid =
      bid > 0 && ask > 0 && ask >= bid ? (bid + ask) / 2 : (o.last_trade_price ?? 0)
    const greeks: ContractGreeks | undefined = Number.isFinite(o.delta)
      ? { delta: o.delta, gamma: o.gamma, theta: o.theta, vega: o.vega }
      : undefined

    out.push({
      symbol: o.option,
      strike: p.strike,
      optionType: p.optionType,
      bid,
      ask,
      mid,
      last: o.last_trade_price ?? 0,
      openInterest: o.open_interest ?? 0,
      volume: o.volume ?? 0,
      expiration,
      iv: Number.isFinite(o.iv) && o.iv > 0 ? o.iv : undefined,
      greeks
    })
  }
  return out
}

export async function getExpirations(symbol: string): Promise<string[]> {
  return rawExpirations(await fetchRaw(symbol))
}

export async function getOptionChain(
  symbol: string,
  expiration: string
): Promise<OptionContract[]> {
  const d = await fetchRaw(symbol)
  const out = mapRawChain(d, expiration)
  return out
}
