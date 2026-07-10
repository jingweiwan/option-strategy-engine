/**
 * Leg→structure pairing + tasty management alerts (engine/rhStructures):
 *   - vertical pairing is greedy nearest-strike (NVDA 3-leg case: 160L pairs
 *     with 200S, 205S stands alone as a naked short put)
 *   - credit put spread + credit call spread same exp → iron condor
 *   - leftover longs merge into one LEAPS combo line
 *   - alerts: ≤21 DTE emphasis, short-leg ITM (needs spot), 50% TP line
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRhStructures } from '../src/engine/rhStructures.js'

type L = Parameters<typeof buildRhStructures>[0][number]
const leg = (o: Partial<L>): L => ({
  sym: 'X', side: 'short', qty: 1, avgCost: -100, expiration: '2099-01-01',
  strike: 100, optionType: 'put', unrealized: 0, ...o
})
const far = '2099-01-01' // far future → no 21-DTE alert unless we choose near dates
const near = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10)

test('pairing: NVDA 3-leg → spread(160/200) + standalone short put 205', () => {
  const s = buildRhStructures([
    leg({ sym: 'NVDA', side: 'long', strike: 160, avgCost: 158, expiration: far }),
    leg({ sym: 'NVDA', side: 'short', strike: 205, avgCost: -1633, expiration: far }),
    leg({ sym: 'NVDA', side: 'short', strike: 200, avgCost: -885, expiration: far })
  ], new Map())
  assert.equal(s.length, 2)
  const spread = s.find((x) => x.kind === 'put_spread')!
  const lone = s.find((x) => x.kind === 'short_put')!
  assert.equal(spread.label, 'Put 价差 160/200')
  assert.equal(lone.label, '卖 Put 205')
  assert.ok(spread.credit && lone.credit)
})

test('condor: credit put spread + credit call spread same exp merge', () => {
  const s = buildRhStructures([
    leg({ side: 'long', optionType: 'put', strike: 330, avgCost: 56, expiration: far }),
    leg({ side: 'short', optionType: 'put', strike: 342.5, avgCost: -216, expiration: far }),
    leg({ side: 'short', optionType: 'call', strike: 380, avgCost: -68, expiration: far }),
    leg({ side: 'long', optionType: 'call', strike: 392.5, avgCost: 24, expiration: far })
  ], new Map())
  assert.equal(s.length, 1)
  assert.equal(s[0].kind, 'iron_condor')
  assert.equal(s[0].label, '铁鹰 330/342.5 · 380/392.5')
  assert.equal(s[0].legs.length, 4)
})

test('LEAPS: leftover longs merge into one combo line with qty', () => {
  const s = buildRhStructures([
    leg({ sym: 'FIG', side: 'long', optionType: 'call', strike: 15, avgCost: 857, expiration: far }),
    leg({ sym: 'FIG', side: 'long', optionType: 'call', strike: 17.5, avgCost: 882.5, qty: 2, expiration: far })
  ], new Map())
  assert.equal(s.length, 1)
  assert.equal(s[0].kind, 'long_combo')
  assert.equal(s[0].label, '买 Call 15 + 17.5 ×2')
  assert.equal(s[0].credit, false) // debit → no tasty short-premium alerts
  assert.deepEqual(s[0].alerts, [])
})

test('alerts: ≤21 DTE emphasis + short-leg ITM + 50% TP line', () => {
  // 4d-out credit spread, short 205 ITM (spot 190), unrealized at 60% of credit
  const s = buildRhStructures([
    leg({ sym: 'NVDA', side: 'short', strike: 205, avgCost: -470, expiration: near, unrealized: 150 }),
    leg({ sym: 'NVDA', side: 'long', strike: 185, avgCost: 98, expiration: near, unrealized: 80 })
  ], new Map([['NVDA', 190]]))
  assert.equal(s.length, 1)
  const texts = s[0].alerts.map((a) => a.text).join(' | ')
  assert.ok(texts.includes('到期') || texts.includes('21'), `21-DTE alert missing: ${texts}`)
  assert.ok(texts.includes('ITM'), `ITM alert missing: ${texts}`)
  assert.ok(s[0].alerts.length <= 2, 'alerts capped at 2, most urgent first')
})

test('alerts: 50% take-profit fires when winning and not time-pressed', () => {
  // far expiration, credit 372, unrealized +230 (>50%) → good TP alert
  const s = buildRhStructures([
    leg({ side: 'short', strike: 205, avgCost: -470, expiration: far, unrealized: 300 }),
    leg({ side: 'long', strike: 185, avgCost: 98, expiration: far, unrealized: -70 })
  ], new Map())
  const a = s[0].alerts
  assert.equal(a.length, 1)
  assert.equal(a[0].level, 'good')
  assert.ok(a[0].text.includes('50%'))
})
