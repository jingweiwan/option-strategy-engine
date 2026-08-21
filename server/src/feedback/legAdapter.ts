import type { OptionLeg } from '../engine/types.js'
import type { StoredLeg } from './types.js'

const zeroGreeks = { delta: 0, gamma: 0, theta: 0, vega: 0 }

export const storedLegsToOptionLegs = (legs: StoredLeg[]): OptionLeg[] =>
  legs.map((l) => ({
    type: l.type,
    action: l.action,
    strike: l.strike,
    premium: l.premium,
    quantity: l.quantity,
    greeks: zeroGreeks,
    // Carried, not defaulted: markPnL falls back to the context sigma when a
    // leg has no IV, which is what pre-skew snapshots must keep doing.
    ...(l.iv != null ? { iv: l.iv } : {})
  }))
