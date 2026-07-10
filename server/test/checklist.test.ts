/**
 * Pre-trade checklist — buyer/seller awareness + the items that depend on
 * existing data actually reflect it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPreTradeChecklist, type ChecklistInput } from '../src/engine/preTradeChecklist.js'
import type { OptionLeg, RiskMetrics } from '../src/engine/types.js'

const g = (delta: number) => ({ delta, gamma: 0, theta: 0, vega: 0 })
const metrics = (over: Partial<RiskMetrics> = {}): RiskMetrics => ({
  ev: 0.1, stdDev: 1, sharpe: 0.1, var95: -2, cvar95: -3,
  simMaxProfit: 1, simMaxLoss: -3, theoMaxProfit: 1.5, theoMaxLoss: -3.5,
  unboundedProfit: false, unboundedLoss: false, probabilityProfit: 0.72, breakevens: [], ...over
})

// A bull put spread: sell 30-delta put, buy 10-delta put → net CREDIT (seller).
const creditLegs: OptionLeg[] = [
  { type: 'put', action: 'sell', strike: 95, premium: 2.0, quantity: 1, greeks: g(-0.30) },
  { type: 'put', action: 'buy', strike: 90, premium: 0.5, quantity: 1, greeks: g(-0.10) }
]

const base: ChecklistInput = {
  strategy: 'bull_put_spread', legs: creditLegs, netPremium: 1.5, metrics: metrics(),
  iv: 0.35, ivRank: 72, currentRv: 0.28, dte: 30, regime: 'sell',
  earningsDate: null, earningsInWindow: false
}

test('checklist: credit spread reads as seller, profit source = time/prob/risk', () => {
  const c = buildPreTradeChecklist(base)
  assert.equal(c.sellerSide, true)
  assert.match(c.profitSource, /时间/)
  assert.equal(c.items.length, 10)
  // IV pass in sell regime; rr bounded; delta has margin at 30
  assert.equal(c.items.find((i) => i.id === 'iv')!.status, 'pass')
  assert.equal(c.items.find((i) => i.id === 'rr')!.status, 'pass')
  assert.equal(c.items.find((i) => i.id === 'delta')!.status, 'pass')
})

test('checklist: earnings in window warns the seller, not the buyer', () => {
  const seller = buildPreTradeChecklist({ ...base, earningsInWindow: true, earningsDate: '2026-07-01' })
  assert.equal(seller.items.find((i) => i.id === 'event')!.status, 'warn')

  const buyer = buildPreTradeChecklist({
    ...base, strategy: 'long_straddle', netPremium: -3.0,
    legs: [
      { type: 'call', action: 'buy', strike: 100, premium: 2, quantity: 1, greeks: g(0.5) },
      { type: 'put', action: 'buy', strike: 100, premium: 2, quantity: 1, greeks: g(-0.5) }
    ],
    earningsInWindow: true, earningsDate: '2026-07-01'
  })
  assert.equal(buyer.sellerSide, false)
  assert.equal(buyer.items.find((i) => i.id === 'event')!.status, 'pass') // buyer wants the event
  assert.match(buyer.profitSource, /波动/)
})

test('checklist: selling cheap vol fails the IV check; near-the-money short warns on delta', () => {
  const cheapVol = buildPreTradeChecklist({ ...base, regime: 'buy', ivRank: 18 })
  assert.equal(cheapVol.items.find((i) => i.id === 'iv')!.status, 'fail')

  const nearMoney = buildPreTradeChecklist({
    ...base,
    legs: [
      { type: 'put', action: 'sell', strike: 99, premium: 3, quantity: 1, greeks: g(-0.45) },
      { type: 'put', action: 'buy', strike: 94, premium: 1, quantity: 1, greeks: g(-0.15) }
    ]
  })
  assert.equal(nearMoney.items.find((i) => i.id === 'delta')!.status, 'warn')
})

test('checklist: naked undefined-risk loss fails the risk/reward check', () => {
  const naked = buildPreTradeChecklist({
    ...base, strategy: 'short_strangle',
    metrics: metrics({ unboundedLoss: true })
  })
  assert.equal(naked.items.find((i) => i.id === 'rr')!.status, 'fail')
})
