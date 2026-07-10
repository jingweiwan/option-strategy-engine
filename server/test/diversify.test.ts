/**
 * Correlation-aware board selection (oppScanner.selectDiverse):
 *   - a candidate correlated with an already-picked name is down-weighted, so a
 *     lower-scored but uncorrelated name can take the slot instead
 *   - a much stronger correlated candidate still survives (floor, not a ban)
 *   - no return history → plain score order (graceful degradation)
 * Plus a direct check of the pairwiseCorrelation helper it relies on.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectDiverse } from '../src/engine/oppScanner.js'
import type { ScannedOpp } from '../src/engine/oppScanner.js'
import { pairwiseCorrelation } from '../src/engine/portfolioRisk.js'

const opp = (sym: string, score: number): ScannedOpp =>
  ({ sym, score } as unknown as ScannedOpp)

/** Deterministic return series; same seed → identical, +π phase → anti-correlated. */
function series(phase: number, n = 40): Map<string, number> {
  const m = new Map<string, number>()
  for (let i = 0; i < n; i++) m.set(`d${i}`, Math.sin(i * 0.7 + phase) * 0.01)
  return m
}

test('pairwiseCorrelation: identical → 1, opposite → −1, thin overlap → null', () => {
  const a = series(0)
  assert.ok(Math.abs(pairwiseCorrelation(a, a)! - 1) < 1e-9)
  const anti = new Map([...a].map(([d, v]) => [d, -v] as [string, number]))
  assert.ok(Math.abs(pairwiseCorrelation(a, anti)! + 1) < 1e-9)
  const short = new Map([...a].slice(0, 10))
  assert.equal(pairwiseCorrelation(short, short), null) // < 30 overlap
})

test('selectDiverse: down-weights a candidate correlated with the picked board', () => {
  const base = series(0)
  const returnsBySym = new Map<string, Map<string, number>>([
    ['A', base],
    ['B', base],          // ρ(A,B) = 1
    ['C', series(1.9)]    // not positively correlated with A → a diversifier
  ])
  // A picked first (top score). B (0.95) is knocked to ~0.475 by ρ=1 with A,
  // so C (0.9, ~uncorrelated) takes the second slot.
  const picks = selectDiverse([opp('A', 1.0), opp('B', 0.95), opp('C', 0.9)], 2, returnsBySym)
  assert.deepEqual(picks.map((o) => o.sym), ['A', 'C'])
})

test('selectDiverse: a much stronger correlated candidate still survives (floor, not ban)', () => {
  const base = series(0)
  const returnsBySym = new Map([['A', base], ['B', base], ['C', series(1.9)]])
  // B is dominant (2.0); even correlation with A can only halve it → still > C.
  const picks = selectDiverse([opp('A', 1.0), opp('B', 2.0), opp('C', 0.9)], 2, returnsBySym)
  assert.ok(picks.map((o) => o.sym).includes('B'))
})

test('selectDiverse: no return history → plain score order', () => {
  const picks = selectDiverse([opp('A', 0.5), opp('B', 0.9), opp('C', 0.7)], 2, new Map())
  assert.deepEqual(picks.map((o) => o.sym), ['B', 'C'])
})
