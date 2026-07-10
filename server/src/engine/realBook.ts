/**
 * Real-book risk (R1 full) — net greeks of the user's ACTUAL Robinhood option
 * positions, not the hypothetical recommended board.
 *
 * Legs come from the on-demand bridge file (api/rhPositions); greeks come from
 * the live CBOE chain (cached), matched by (symbol, expiration, strike, type).
 * Same scale convention as the board's netGreeks: per-share greek × qty,
 * signed by side — so the board card and the real book read side by side.
 *
 * Far-dated LEAPS sometimes have no greeks on the delayed chain; those legs
 * count as `unmatched` and are surfaced rather than silently dropped — a net
 * number that quietly excludes half the book would be worse than none.
 */
import { loadRhPositions, rhAgeHours, type RhOptionLeg } from '../api/rhPositions.js'
import { getOptionChain } from '../api/marketdata.js'
import type { OptionContract } from '../api/types.js'

export type RealBook = {
  fetchedAt: string
  ageHours: number | null
  accountSize: number | null
  optionLegCount: number
  equityCount: number
  symbols: string[]
  netDelta: number
  netGamma: number
  netVega: number
  netTheta: number
  /** Legs whose greeks resolved from the live chain vs not. */
  matchedLegs: number
  unmatchedLegs: number
}

const keyOf = (exp: string, strike: number, type: 'call' | 'put') => `${exp}|${strike}|${type}`

/** Pure: sum side-signed greeks for the legs a chain lookup could resolve. */
export function aggregateRealBookGreeks(
  legs: RhOptionLeg[],
  contractsBySym: Map<string, Map<string, OptionContract>>
): Pick<RealBook, 'netDelta' | 'netGamma' | 'netVega' | 'netTheta' | 'matchedLegs' | 'unmatchedLegs'> {
  let netDelta = 0, netGamma = 0, netVega = 0, netTheta = 0
  let matched = 0, unmatched = 0
  for (const leg of legs) {
    const c = contractsBySym.get(leg.sym)?.get(keyOf(leg.expiration, leg.strike, leg.optionType))
    const g = c?.greeks
    if (!g) { unmatched++; continue }
    const sign = leg.side === 'long' ? 1 : -1
    netDelta += sign * g.delta * leg.qty
    netGamma += sign * g.gamma * leg.qty
    netVega += sign * g.vega * leg.qty
    netTheta += sign * g.theta * leg.qty
    matched++
  }
  return { netDelta, netGamma, netVega, netTheta, matchedLegs: matched, unmatchedLegs: unmatched }
}

/** Real book from bridge file + cached chains; null when no bridge file. */
export async function computeRealBook(): Promise<RealBook | null> {
  const p = loadRhPositions()
  if (!p) return null

  // One chain fetch per (symbol, expiration) — CBOE serves all expirations per
  // symbol in one payload, so this is cheap and mostly cache hits.
  const pairs = [...new Set(p.optionLegs.map((l) => `${l.sym}|${l.expiration}`))]
  const contractsBySym = new Map<string, Map<string, OptionContract>>()
  await Promise.all(pairs.map(async (pair) => {
    const [sym, exp] = pair.split('|')
    try {
      const chain = await getOptionChain(sym, exp)
      const m = contractsBySym.get(sym) ?? new Map<string, OptionContract>()
      for (const c of chain) m.set(keyOf(c.expiration, c.strike, c.optionType), c)
      contractsBySym.set(sym, m)
    } catch { /* leg stays unmatched */ }
  }))

  const agg = aggregateRealBookGreeks(p.optionLegs, contractsBySym)
  return {
    fetchedAt: p.fetchedAt,
    ageHours: rhAgeHours(),
    accountSize: p.account.totalValue,
    optionLegCount: p.optionLegs.length,
    equityCount: p.equities.length,
    symbols: [...new Set(p.optionLegs.map((l) => l.sym))],
    ...agg
  }
}
