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
    greeks: zeroGreeks
  }))
