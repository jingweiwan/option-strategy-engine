/**
 * Portfolio-level risk aggregation (R1) — the recommended board is summed into
 * one book-level exposure so the correlation-1 short-vol tail (invisible on the
 * per-card view) is surfaced. See engine/portfolioRisk.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeBookRisk } from '../src/engine/portfolioRisk.js'
import type { ScannedOpp } from '../src/engine/oppScanner.js'

function opp(over: Partial<ScannedOpp>): ScannedOpp {
  return {
    sym: 'X', name: 'X', expiration: '2026-08-01', strategyId: 'iron_condor',
    strategy: '铁鹰', score: 1, spot: 100, iv: 0.3, ivr: 50, dte: 30,
    pop: 0.7, ev: 0.1, maxProfit: 1, maxLoss: -2, netPremium: 1,
    delta: 0, gamma: -0.02, vega: -0.1, theta: 0.05, regime: 'sell',
    rvAtScan: null, breakevens: [], legs: [],
    ...over
  }
}

test('empty board → zeroed risk, no flags', () => {
  const r = summarizeBookRisk([])
  assert.equal(r.positions, 0)
  assert.equal(r.aggMaxLossUsd, 0)
  assert.deepEqual(r.flags, [])
})

test('all-short-vol board → net short vega/gamma + correlation-1 tail flag', () => {
  const board = [opp({}), opp({}), opp({ maxLoss: -3 })]
  const r = summarizeBookRisk(board)
  assert.equal(r.positions, 3)
  assert.ok(r.netVega < 0 && r.netGamma < 0, 'net short vega and gamma')
  assert.equal(r.shortVolCount, 3)
  // Σ|maxLoss| = 2 + 2 + 3 = 7, ×100 = 700
  assert.equal(r.aggMaxLossUsd, 700)
  // carry: netTheta 0.15 ×100 = 15
  assert.ok(Math.abs(r.netThetaUsd - 15) < 1e-9)
  assert.ok(r.flags.some((f) => f.includes('净空 vega')), 'vega flag')
  assert.ok(r.flags.some((f) => f.includes('相关性→1')), 'correlation-1 tail flag')
})

test('undefined-risk position is flagged and excluded from aggMaxLoss', () => {
  const r = summarizeBookRisk([opp({ maxLoss: null }), opp({ maxLoss: -2 })])
  assert.equal(r.undefinedRiskCount, 1)
  assert.equal(r.aggMaxLossUsd, 200) // only the -2 counted
  assert.ok(r.flags.some((f) => f.includes('无定义风险')))
})

test('one-sided delta → directional-lean flag', () => {
  const r = summarizeBookRisk([opp({ delta: 0.8 }), opp({ delta: 0.9 })])
  assert.ok(r.netDelta > 1)
  assert.ok(r.flags.some((f) => f.includes('偏多')), 'directional lean flagged')
})

test('avgPairwiseCorrelation: identical series → 1, opposite → −1, thin data → null', async () => {
  const { avgPairwiseCorrelation } = await import('../src/engine/portfolioRisk.js')
  const mk = (vals: number[]) => new Map(vals.map((v, i) => [`d${i}`, v]))
  const base = Array.from({ length: 40 }, (_, i) => Math.sin(i) * 0.01)
  // identical
  const same = new Map([['A', mk(base)], ['B', mk(base)]])
  assert.ok(Math.abs(avgPairwiseCorrelation(same)! - 1) < 1e-9)
  // inverted
  const anti = new Map([['A', mk(base)], ['B', mk(base.map((x) => -x))]])
  assert.ok(Math.abs(avgPairwiseCorrelation(anti)! + 1) < 1e-9)
  // <2 symbols or <30 overlapping days → null
  assert.equal(avgPairwiseCorrelation(new Map([['A', mk(base)]])), null)
  const short = new Map([['A', mk(base.slice(0, 10))], ['B', mk(base.slice(0, 10))]])
  assert.equal(avgPairwiseCorrelation(short), null)
})
