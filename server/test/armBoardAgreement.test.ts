/**
 * The scanner used to pick the arm its own board gate would reject.
 *
 * scoreStrategy is EV/CVaR. A far-OTM 0.12Δ short has a small EV but a far
 * smaller CVaR, so the RATIO favours the thinnest arm — while CREDIT_WIDTH_FLOOR
 * exists precisely to refuse thin credit/width ("this must win 90% of the time
 * just to break even"). Two selection rules that disagree by construction.
 *
 * Measured on 2026-08-26, IWM bull_put_spread, same chain, same expiration:
 *   sd0.12  credit/width 0.059   ← surfaced, then demoted to `reference`
 *   sd0.16  credit/width 0.090   ← also below the 0.10 floor
 *   sd0.20  credit/width 0.115   ← passes
 *   sd0.25  credit/width 0.147   ← passes
 *   sd0.30  credit/width 0.188   ← passes
 * The board came up EMPTY with three passing arms sitting right there.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { armBeatsCurrent, sellVolDecision, CREDIT_WIDTH_FLOOR } from '../src/engine/oppScanner.js'

test('a boarding arm beats a higher-scoring arm that cannot board', () => {
  // The exact inversion: the thin arm scores better and still must lose.
  const thinButHigherScore = { score: 9.9, boards: false }
  const fatButLowerScore = { score: 1.1, boards: true }
  assert.equal(armBeatsCurrent(fatButLowerScore, thinButHigherScore), true)
  assert.equal(armBeatsCurrent(thinButHigherScore, fatButLowerScore), false)
})

test('among arms that all board, score still decides', () => {
  assert.equal(armBeatsCurrent({ score: 2, boards: true }, { score: 1, boards: true }), true)
  assert.equal(armBeatsCurrent({ score: 1, boards: true }, { score: 2, boards: true }), false)
})

test('when NO arm boards, score still decides — the near-miss must not vanish', () => {
  assert.equal(armBeatsCurrent({ score: 2, boards: false }, { score: 1, boards: false }), true)
  assert.equal(armBeatsCurrent({ score: 1, boards: false }, { score: 2, boards: false }), false)
})

test('the first arm is always taken', () => {
  assert.equal(armBeatsCurrent({ score: -5, boards: false }, null), true)
})

test('the IWM 2026-08-26 ladder: the picker must land on a gate-passing arm', () => {
  // credit/width per arm, measured from that day's chain. Scores are the
  // observed inversion — thinner arm, higher EV/CVaR.
  const ladder = [
    { variant: 'sd0.12', creditWidth: 0.059, score: 5.0 },
    { variant: 'sd0.16', creditWidth: 0.090, score: 4.0 },
    { variant: 'sd0.20', creditWidth: 0.115, score: 3.0 },
    { variant: 'sd0.25', creditWidth: 0.147, score: 2.0 },
    { variant: 'sd0.30', creditWidth: 0.188, score: 1.0 }
  ]
  let best: { score: number; boards: boolean } | null = null
  let pick = ''
  for (const a of ladder) {
    const boards =
      sellVolDecision('bull_put_spread', 45, false, false, 0.228, 0.143, a.creditWidth).tier === 'qualified'
    if (armBeatsCurrent({ score: a.score, boards }, best)) {
      best = { score: a.score, boards }
      pick = a.variant
    }
  }
  assert.equal(pick, 'sd0.20', 'must take the best-scoring arm that actually boards')
  assert.equal(best?.boards, true)
  // Sanity: the arm the OLD rule would have picked is genuinely sub-floor.
  assert.ok(ladder[0].creditWidth < CREDIT_WIDTH_FLOOR)
})
