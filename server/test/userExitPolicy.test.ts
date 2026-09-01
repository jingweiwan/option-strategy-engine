/**
 * The 'user' exit policy — the rule THIS account actually follows, and since
 * 2026-08-31 the engine's default.
 *
 * Why it exists: under 'managed' (TP 50% / stop 2×) the mechanical breakeven win
 * rate is stop/(stop+TP) = 80% for EVERY credit structure, regardless of how much
 * credit it collects. The 2× stop truncates the loss and that truncation was doing
 * all the work — the board's +EV verdicts were an artifact of a stop the account
 * never places. These tests pin the rule, its default status, and the one place it
 * cannot be taken literally (unbounded loss).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  managedThresholds,
  managedHoldDays,
  runManagedExit,
  USER_TAKE_PROFIT_FRACTION,
  USER_UNBOUNDED_STOP_MULTIPLE,
  type MarkContext
} from '../src/engine/managedExit.js'
import { runEngineLive } from '../src/engine/index.js'
import { LEGACY_EXIT_POLICY } from '../src/feedback/settlementVersion.js'
import { netPremium, theoreticalExtremes } from '../src/engine/payoff.js'
import { syntheticChain } from './fixtures.js'
import type { OptionLeg } from '../src/engine/types.js'

const g = (delta: number) => ({ delta, gamma: 0.01, theta: 0.02, vega: 0.1 })

/** Defined-risk credit spread: sell 95P / buy 90P for 2. Max loss = 5 − 2 = 3. */
const spread: OptionLeg[] = [
  { type: 'put', action: 'sell', strike: 95, premium: 3, quantity: 1, greeks: g(-0.3) },
  { type: 'put', action: 'buy', strike: 90, premium: 1, quantity: 1, greeks: g(-0.15) }
]

test("the 80% bar is an artifact of 'managed', and 'user' does not have it", () => {
  // 'managed': breakeven WR = stop/(stop+TP) = 2c/(2c+0.5c) = 80%, for ANY credit.
  for (const credit of [0.4, 0.73, 2, 11]) {
    const { takeProfit, stop } = managedThresholds(credit, 'managed')
    assert.equal(Math.round((stop / (stop + takeProfit)) * 1000) / 1000, 0.8,
      `managed's breakeven WR must be credit-invariant — that is the whole problem`)
  }
  // 'user': no stop, so the bar is set by the STRUCTURE's max loss and does vary.
  const bars = [
    { credit: 0.73, maxLoss: 5.27 },  // IWM 279/273P, 2026-08-31 board
    { credit: 0.40, maxLoss: 1.60 }   // XLE 59/57P
  ].map(({ credit, maxLoss }) => {
    const { takeProfit, stop } = managedThresholds(credit, 'user', maxLoss)
    assert.equal(stop, Infinity)
    return maxLoss / (maxLoss + takeProfit)
  })
  assert.ok(bars[0] > 0.9 && bars[1] > 0.84 && bars[0] !== bars[1],
    `user's breakeven WR must depend on the structure, not be a constant 80%`)
})

test("'user' takes 75% of credit and places no stop on a defined-risk structure", () => {
  const credit = netPremium(spread)
  const maxLoss = Math.abs(theoreticalExtremes(spread).theoMaxLoss)
  assert.equal(credit, 2)
  assert.equal(maxLoss, 3)
  const th = managedThresholds(credit, 'user', maxLoss)
  assert.equal(th.takeProfit, credit * USER_TAKE_PROFIT_FRACTION)
  assert.equal(th.stop, Infinity, 'a bounded loss makes "no stop" exact, not an approximation')
})

test('"no stop" is undefined without a max loss, so a naked structure keeps a floor', () => {
  const naked: OptionLeg[] = [
    { type: 'put', action: 'sell', strike: 100, premium: 2, quantity: 1, greeks: g(-0.3) }
  ]
  assert.equal(theoreticalExtremes(naked).unboundedLoss, true)
  const th = managedThresholds(2, 'user', Infinity)
  assert.equal(th.stop, 2 * USER_UNBOUNDED_STOP_MULTIPLE)
  // runManagedExit must reach that conclusion from the legs alone.
  // Marking at tau=0 is expiration intrinsic, so each path must open BELOW the
  // 75% take-profit (pnl < 1.5) or it exits on bar 0 before anything is tested.
  const ctx: MarkContext = { tauAt: () => 0, r: 0.045, q: 0, sigma: 0.3 }
  const deep = runManagedExit(naked, [99, 91], 2, ctx, 'user') // pnl +1 → −7, past the −6 floor
  assert.equal(deep.reason, 'stop_loss')
  // The DEFINED-risk spread has no floor to hit: its loss is capped at −3 by the
  // long wing, so the same kind of move rides to the end of the window.
  const rides = runManagedExit(spread, [94, 91], 2, ctx, 'user') // pnl +1 → −2
  assert.equal(rides.reason, 'end_of_window')
  assert.equal(rides.pnl, -2)
})

test("'user' rides the whole cycle — no 21-DTE close-out", () => {
  assert.equal(managedHoldDays('iron_condor', 45, 'managed'), 24) // 45 − 21
  assert.equal(managedHoldDays('iron_condor', 45, 'user'), 45)
  assert.equal(managedHoldDays('bull_put_spread', 45, 'user'), 45)
})

test("'user' is the default everywhere it is not named", () => {
  assert.deepEqual(managedThresholds(2, undefined, 3), managedThresholds(2, 'user', 3))
  assert.equal(managedHoldDays('iron_condor', 45), managedHoldDays('iron_condor', 45, 'user'))

  // …and in the engine: an unqualified run must equal an explicitly-'user' run,
  // and must NOT equal the old 'managed' default.
  const { chain, expiration, spot } = syntheticChain({ iv: 0.3 })
  const base = { symbol: 'T', spot, expiration, chain, ivRank: 60, seed: 1, simulations: 600, currentRv: 0.18 }
  const pops = (extra: Record<string, unknown>) =>
    runEngineLive({ ...base, ...extra }).results.map((r) => [r.strategy, r.metrics.probabilityProfit])
  const all = (p: string) => Object.fromEntries(
    ['iron_condor', 'bull_put_spread', 'bear_call_spread', 'bear_put_spread',
     'bull_call_spread', 'long_straddle'].map((s) => [s, p])
  )
  assert.deepEqual(pops({}), pops({ exitPolicies: all('user') }))
  assert.notDeepEqual(pops({}), pops({ exitPolicies: all('managed') }))
})

test('removing the stop raises the win rate AND raises the bar — both must move', () => {
  // The engine reports a higher POP under 'user' (no stop knocks the position
  // out), but the loss it takes when wrong is the full max loss. A card that
  // showed the higher POP against the 80% bar would be reading two frames at
  // once — the mistake this policy exists to make impossible.
  const { chain, expiration, spot } = syntheticChain({ iv: 0.3 })
  const base = { symbol: 'T', spot, expiration, chain, ivRank: 60, seed: 1, simulations: 2000, currentRv: 0.18 }
  const pick = (p: 'user' | 'managed') => {
    const all = Object.fromEntries(
      ['iron_condor', 'bull_put_spread', 'bear_call_spread'].map((s) => [s, p])
    )
    return runEngineLive({ ...base, exitPolicies: all as never })
      .results.find((r) => r.strategy === 'bull_put_spread')!
  }
  const u = pick('user'), m = pick('managed')
  assert.ok(u.metrics.probabilityProfit > m.metrics.probabilityProfit,
    'no stop ⇒ fewer forced exits ⇒ higher win rate')

  const credit = netPremium(u.legs)
  const maxLoss = Math.abs(theoreticalExtremes(u.legs).theoMaxLoss)
  const barUser = maxLoss / (maxLoss + managedThresholds(credit, 'user', maxLoss).takeProfit)
  assert.ok(barUser > 0.8, 'and a higher bar to clear — otherwise the comparison is free money')
})

// --- The historical book must not be re-measured ----------------------------
test('an unstamped snapshot still settles under the rule its card displayed', () => {
  // Every recommendation before 2026-08-31 predates the exitPolicy stamp,
  // because 'managed' was then the only default. If this constant ever tracks
  // the CURRENT default, the whole historical book silently gets re-measured
  // against a rule it never claimed — the tuner and calibration table would be
  // learning from rewritten history with nothing to signal it.
  assert.equal(LEGACY_EXIT_POLICY, 'managed')
  // The current default is 'user' (pinned above). The two must DIFFER — if a
  // later change makes the fallback follow the default they become the same
  // value and this line is the tripwire.
  const currentDefault = managedHoldDays('iron_condor', 45) === 45 ? 'user' : 'managed'
  assert.equal(currentDefault, 'user')
  assert.notEqual(LEGACY_EXIT_POLICY, currentDefault)

  // And the fallback must actually change the settlement window, which is what
  // makes getting it wrong consequential rather than cosmetic.
  assert.notEqual(
    managedHoldDays('iron_condor', 45, LEGACY_EXIT_POLICY),
    managedHoldDays('iron_condor', 45, 'user')
  )
})
