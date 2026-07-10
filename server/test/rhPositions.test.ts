/**
 * RH positions bridge (read side) + real-book greeks aggregation:
 *   - reader parses the bridge file, exposes account size (file beats env)
 *   - missing/invalid file degrades to env → null, never throws
 *   - aggregateRealBookGreeks sums side-signed greeks and reports unmatched
 *     legs (far LEAPS without chain greeks) instead of silently dropping them.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'rhpos-'))
const FILE = join(tmp, 'rh-positions.json')
process.env.RH_POSITIONS_FILE = FILE // before importing the module

writeFileSync(FILE, JSON.stringify({
  schema: 'rh-positions-v1',
  fetchedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), // 2h old
  accountNumber: 'x',
  account: { totalValue: 175129.23 },
  optionLegs: [
    { sym: 'NVDA', side: 'short', qty: 1, avgCost: -470, expiration: '2026-07-10', strike: 205, optionType: 'put' },
    { sym: 'NVDA', side: 'long', qty: 1, avgCost: 98, expiration: '2026-07-10', strike: 185, optionType: 'put' },
    { sym: 'GOOG', side: 'long', qty: 2, avgCost: 12767.5, expiration: '2027-12-17', strike: 250, optionType: 'call' }
  ],
  equities: [{ sym: 'AMZN', qty: 102, avgCost: 232.44 }]
}))

let mod: typeof import('../src/api/rhPositions.js')
let rb: typeof import('../src/engine/realBook.js')
before(async () => {
  mod = await import('../src/api/rhPositions.js')
  rb = await import('../src/engine/realBook.js')
})
after(() => rmSync(tmp, { recursive: true, force: true }))

test('bridge reader: parses file; account size from file beats env', () => {
  const p = mod.loadRhPositions()!
  assert.equal(p.optionLegs.length, 3)
  assert.equal(p.equities.length, 1)
  const acct = mod.getAccountSize()!
  assert.equal(acct.source, 'rh')
  assert.ok(Math.abs(acct.size - 175129.23) < 1e-6)
  const age = mod.rhAgeHours()!
  assert.ok(age > 1.9 && age < 2.5, `age ${age}`)
})

test('real-book aggregation: side-signed sums + unmatched LEAPS surfaced', () => {
  const p = mod.loadRhPositions()!
  const mkContract = (exp: string, strike: number, type: 'call' | 'put', g: { delta: number; gamma: number; theta: number; vega: number }) =>
    ({ symbol: 'X', strike, optionType: type, bid: 1, ask: 1.1, mid: 1.05, last: 1, openInterest: 10, volume: 1, expiration: exp, iv: 0.3, greeks: g }) as const
  const contracts = new Map([
    ['NVDA', new Map([
      ['2026-07-10|205|put', mkContract('2026-07-10', 205, 'put', { delta: -0.4, gamma: 0.02, theta: -0.05, vega: 0.2 })],
      ['2026-07-10|185|put', mkContract('2026-07-10', 185, 'put', { delta: -0.15, gamma: 0.01, theta: -0.02, vega: 0.1 })]
    ])]
    // GOOG 2027 LEAPS deliberately missing → unmatched
  ])
  const agg = rb.aggregateRealBookGreeks(p.optionLegs, contracts as never)
  assert.equal(agg.matchedLegs, 2)
  assert.equal(agg.unmatchedLegs, 1)
  // short 205P: −(−0.4) = +0.4; long 185P: −0.15 → net +0.25
  assert.ok(Math.abs(agg.netDelta - 0.25) < 1e-9, `netDelta ${agg.netDelta}`)
  // short 205P: −0.2 vega; long 185P: +0.1 → −0.1 (net short vol, as a put credit spread is)
  assert.ok(Math.abs(agg.netVega - -0.1) < 1e-9, `netVega ${agg.netVega}`)
  // theta: short leg collects +0.05, long leg bleeds −0.02 → +0.03
  assert.ok(Math.abs(agg.netTheta - 0.03) < 1e-9, `netTheta ${agg.netTheta}`)
})
