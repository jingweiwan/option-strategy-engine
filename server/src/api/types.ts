export type Quote = {
  symbol: string
  last: number
  bid: number
  ask: number
  /** Absolute change from previous close (price units). */
  change?: number
  /** Percent change from previous close (e.g. 0.61 means +0.61%). */
  changePct?: number
}

export type ContractGreeks = {
  delta: number
  gamma: number
  theta: number
  vega: number
}

/**
 * Vendor-agnostic option contract.
 * Some sources only return IV (Yahoo) — greeks are optional and the engine
 * fills them via BSM when missing.
 */
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
  expiration: string // YYYY-MM-DD
  iv?: number
  greeks?: ContractGreeks
}
