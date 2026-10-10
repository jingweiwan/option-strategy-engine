/**
 * Which underlying price belongs with an option chain?
 *
 * Options only quote during the regular session, so outside it the chain is
 * frozen at the close — while a quote's `last` keeps following extended-hours
 * trading. Pairing the two prices a structure whose premiums assume one spot
 * against paths that start at another. Observed 2026-10-09 05:30 ET: QQQ `last`
 * 754.21 (pre-market) over a chain still marked at the 747.58 close. Same legs
 * (778/794 call spread, 3.92 credit): POP 75.8% / EV −0.35 at 754.21 versus
 * 81.4% / EV +0.47 at the close. The matching put spread moved the other way
 * (83.8% / +0.28 versus 78.2% / −0.35), so the EV sign flipped on both sides.
 *
 * This is not a pre-market corner case: the daily scan runs just after ET
 * midnight. Across 3129 archived symbol-days the extended-hours last sat more
 * than 0.5% from the close on 12.3% of them and more than 1% on 3.3% (up to 15%
 * on earnings nights).
 *
 * The rule needs no clock or holiday calendar: CBOE reports the regular-session
 * last separately, and it EQUALS `last` whenever the market is open (34 of 34
 * intraday archive samples). So "use regularClose when it differs" is a no-op
 * in regular hours and the close everywhere else, holidays included.
 */
import type { Quote } from './types.js'

export type SpotBasis = {
  /** 'live': `spot` is the quote's last (market open, or the provider does not
   *  report a regular-session price). 'regular_close': the quote had moved in
   *  extended hours, so `spot` is the close the chain was quoted against. */
  basis: 'live' | 'regular_close'
  /** The spot to price the chain with. */
  spot: number
  /** The extended-hours last that was set aside (null when basis is 'live'). */
  extendedLast: number | null
  /** extendedLast vs spot, in percent (0.84 = +0.84%). null when 'live'. */
  extendedGapPct: number | null
  /** ET time of the last regular-session trade, when known. */
  asOf: string | null
}

export function chainSpotBasis(q: Quote): SpotBasis {
  const asOf = q.regularTradeTime ?? null
  const close = q.regularClose
  if (close == null || !Number.isFinite(close) || close <= 0 || !(q.last > 0) || close === q.last) {
    return { basis: 'live', spot: q.last, extendedLast: null, extendedGapPct: null, asOf }
  }
  return {
    basis: 'regular_close',
    spot: close,
    extendedLast: q.last,
    extendedGapPct: (q.last / close - 1) * 100,
    asOf
  }
}

/** The quote with `last` moved onto the chain's session. Everything else
 *  (change, bid/ask) is left as reported. */
export function alignQuoteToChain<Q extends Quote>(q: Q): Q {
  const b = chainSpotBasis(q)
  return b.basis === 'live' ? q : { ...q, last: b.spot }
}
