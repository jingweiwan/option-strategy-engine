export type Quote = {
  symbol: string
  last: number
  bid: number
  ask: number
}

export type OptionContract = {
  symbol: string
  strike: number
  optionType: 'call' | 'put'
  bid: number
  ask: number
  mid: number
  last: number
  openInterest: number
  volume: number
  expiration: string
  greeks?: {
    delta: number
    gamma: number
    theta: number
    vega: number
    midIv: number
  }
}

const base = process.env.TRADIER_BASE ?? 'https://sandbox.tradier.com'
const token = process.env.TRADIER_TOKEN ?? ''

async function tradierFetch(path: string): Promise<any> {
  if (!token) throw new Error('TRADIER_TOKEN not configured')
  const res = await fetch(`${base}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json'
    }
  })
  if (!res.ok) throw new Error(`Tradier ${res.status}: ${await res.text()}`)
  return res.json()
}

export async function getQuote(symbol: string): Promise<Quote> {
  const data = await tradierFetch(
    `/v1/markets/quotes?symbols=${encodeURIComponent(symbol)}`
  )
  const q = data?.quotes?.quote
  if (!q) throw new Error(`No quote for ${symbol}`)
  return {
    symbol: q.symbol,
    last: q.last,
    bid: q.bid,
    ask: q.ask
  }
}

export async function getExpirations(symbol: string): Promise<string[]> {
  const data = await tradierFetch(
    `/v1/markets/options/expirations?symbol=${encodeURIComponent(symbol)}&includeAllRoots=true`
  )
  const dates = data?.expirations?.date
  if (!dates) return []
  return Array.isArray(dates) ? dates : [dates]
}

export async function getOptionChain(
  symbol: string,
  expiration: string
): Promise<OptionContract[]> {
  const data = await tradierFetch(
    `/v1/markets/options/chains?symbol=${encodeURIComponent(symbol)}&expiration=${expiration}&greeks=true`
  )
  const list = data?.options?.option
  if (!list) return []
  const arr = Array.isArray(list) ? list : [list]
  return arr.map((o: any) => ({
    symbol: o.symbol,
    strike: o.strike,
    optionType: o.option_type,
    bid: o.bid ?? 0,
    ask: o.ask ?? 0,
    mid: o.bid && o.ask ? (o.bid + o.ask) / 2 : (o.last ?? 0),
    last: o.last ?? 0,
    openInterest: o.open_interest ?? 0,
    volume: o.volume ?? 0,
    expiration: o.expiration_date,
    greeks: o.greeks
      ? {
          delta: o.greeks.delta,
          gamma: o.greeks.gamma,
          theta: o.greeks.theta,
          vega: o.greeks.vega,
          midIv: o.greeks.mid_iv
        }
      : undefined
  }))
}
