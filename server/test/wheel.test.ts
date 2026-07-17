/**
 * Wheel scanner invariants:
 *   1. fundamentalGate hard-fails broken businesses (losses, low ROE, high
 *      leverage, collapsing revenue) and passes ETFs neutrally.
 *   2. pickCoveredCallStrike NEVER picks a strike below cost basis — the rule
 *      that prevents locking in a loss on assignment (the FIG-25C mistake).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fundamentalGate, pickCoveredCallStrike } from '../src/engine/wheelScanner.js'
import type { Fundamentals } from '../src/api/fundamentals.js'

const base: Fundamentals = {
  sym: 'TEST', pe: 20, netMargin: 15, roe: 20, debtToEquity: 0.8,
  revenueGrowth: 10, epsGrowth: 12, beta: 1.1, week52High: 120, week52Low: 80, dividendYield: null
}

test('fundamentalGate: healthy company passes with mid-high score', () => {
  const v = fundamentalGate(base)
  assert.equal(v.pass, true)
  assert.equal(v.kind, 'company')
  assert.ok(v.score > 0.5, `score=${v.score}`)
})

test('fundamentalGate: hard fails — losses / low ROE / collapsing revenue', () => {
  assert.equal(fundamentalGate({ ...base, netMargin: -3 }).pass, false)
  assert.equal(fundamentalGate({ ...base, roe: 2 }).pass, false)
  assert.equal(fundamentalGate({ ...base, revenueGrowth: -15 }).pass, false)
})

test('fundamentalGate: high leverage is a soft penalty (banks), not a hard fail', () => {
  // JPM/GS run D/E 3-12 structurally — must pass, but score below the low-debt twin.
  const levered = fundamentalGate({ ...base, debtToEquity: 4.5 })
  assert.equal(levered.pass, true)
  assert.ok(levered.notes.some((n) => n.includes('高杠杆')))
  assert.ok(levered.score < fundamentalGate({ ...base, debtToEquity: 0.3 }).score)
})

test('fundamentalGate: ETF / missing data passes neutrally at 0.6', () => {
  const v = fundamentalGate({ ...base, pe: null, netMargin: null, roe: null })
  assert.equal(v.pass, true)
  assert.equal(v.kind, 'etf')
  assert.equal(v.score, 0.6)
  assert.equal(fundamentalGate(null).pass, true)
})

test('fundamentalGate: cheap+profitable scores above expensive+levered', () => {
  const cheap = fundamentalGate({ ...base, pe: 14, debtToEquity: 0.3 })
  const rich = fundamentalGate({ ...base, pe: 38, debtToEquity: 2.5 })
  assert.ok(cheap.score > rich.score, `${cheap.score} vs ${rich.score}`)
})

const mkCall = (strike: number, delta: number, bid = 1, ask = 1.2) =>
  ({ strike, bid, ask, mid: (bid + ask) / 2, greeks: { delta } })

test('pickCoveredCallStrike: never below cost basis, even when spot is lower', () => {
  // FIG scenario: cost 31.44, spot 23.41 — strikes below cost must be skipped.
  const calls = [mkCall(25, 0.35), mkCall(27, 0.28), mkCall(30, 0.2), mkCall(32, 0.12), mkCall(35, 0.07)]
  const pick = pickCoveredCallStrike(calls, 23.41, 31.44)
  assert.ok(pick, 'should find a strike')
  assert.ok(pick!.strike >= 31.44, `picked ${pick!.strike} below cost 31.44`)
})

test('pickCoveredCallStrike: normal case prefers ~0.25 delta above spot', () => {
  const calls = [mkCall(100, 0.5), mkCall(105, 0.35), mkCall(110, 0.26), mkCall(115, 0.15)]
  const pick = pickCoveredCallStrike(calls, 100, 90)
  assert.equal(pick!.strike, 110)
})

test('pickCoveredCallStrike: no eligible strike → null (not a bad pick)', () => {
  const calls = [mkCall(20, 0.6), mkCall(22, 0.5)]
  assert.equal(pickCoveredCallStrike(calls, 23.41, 31.44), null)
})
