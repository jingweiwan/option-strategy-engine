/**
 * Condor exit-policy A/B (see managedExit.ts ExitPolicy):
 *   'managed' — TP 50% + stop 2× + close at 21 DTE (default, unchanged)
 *   'runner'  — stop 2× only, no TP, hold to expiration
 * Invariants: runner never takes profit early, holds the full DTE, keeps the
 * disaster stop; assignment is deterministic per (symbol × day); the engine
 * scores the condor under the chosen policy (display = learning).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  managedThresholds,
  managedHoldDays,
  runManagedExit,
  type MarkContext
} from '../src/engine/managedExit.js'
import { pickExitPolicy } from '../src/engine/oppScanner.js'
import { runEngineLive } from '../src/engine/index.js'
import { syntheticChain } from './fixtures.js'
import type { OptionLeg } from '../src/engine/types.js'

test('thresholds: runner drops the take-profit, keeps the 2× stop', () => {
  const managed = managedThresholds(2, 'managed')
  const runner = managedThresholds(2, 'runner')
  assert.equal(managed.takeProfit, 1)      // 50% of credit
  assert.equal(runner.takeProfit, Infinity) // never
  assert.equal(managed.stop, 4)
  assert.equal(runner.stop, 4)             // stop unchanged
  // debit structures are not part of the experiment — unchanged either way
  assert.deepEqual(managedThresholds(-2, 'runner'), managedThresholds(-2, 'managed'))
})

test('hold days: runner rides to expiry, managed closes at 21 DTE', () => {
  assert.equal(managedHoldDays('iron_condor', 30, 'managed'), 9)  // 30 − 21
  assert.equal(managedHoldDays('iron_condor', 30, 'runner'), 30) // full DTE
  assert.equal(managedHoldDays('iron_condor', 45, 'runner'), 45)
})

test('runManagedExit: a path that TPs under managed keeps running under runner', () => {
  // Sold OTM put (credit 2). Spot rallies away → the short put bleeds value →
  // marked P&L rises through +50% credit quickly.
  const legs: OptionLeg[] = [{
    type: 'put', action: 'sell', strike: 90, premium: 2, quantity: 1,
    greeks: { delta: -0.3, gamma: 0.01, theta: 0.02, vega: 0.1 }
  }]
  const path = [105, 110, 115, 120, 125, 130, 135, 140, 145, 150]
  const ctx: MarkContext = {
    tauAt: (i) => Math.max(0, (10 - i) / 252),
    r: 0.045, q: 0, sigma: 0.3
  }
  const managed = runManagedExit(legs, path, 2, ctx, 'managed')
  const runner = runManagedExit(legs, path, 2, ctx, 'runner')
  assert.equal(managed.reason, 'take_profit')
  assert.equal(managed.pnl, 1) // capped at 50% of credit
  assert.equal(runner.reason, 'end_of_window') // no TP — rides on
  assert.ok(runner.pnl > 1, `runner collects more than the TP cap: ${runner.pnl}`)
  // stop still protects the runner: crash path
  const crash = [70, 60, 50]
  const stopCtx: MarkContext = { tauAt: (i) => (3 - i) / 252, r: 0.045, q: 0, sigma: 0.3 }
  assert.equal(runManagedExit(legs, crash, 2, stopCtx, 'runner').reason, 'stop_loss')
})

test('pickExitPolicy: deterministic per (sym × day), both arms occur', () => {
  assert.equal(pickExitPolicy('AAPL', '2026-07-03'), pickExitPolicy('AAPL', '2026-07-03'))
  const syms = ['AAPL', 'NVDA', 'TSLA', 'META', 'AMZN', 'GOOGL', 'SPY', 'QQQ', 'AMD', 'HOOD']
  const arms = new Set(syms.map((s) => pickExitPolicy(s, '2026-07-03')))
  assert.equal(arms.size, 2, 'both arms should be assigned across a watchlist')
})

test('engine: exitPolicies changes the condor evaluation, leaves others alone', () => {
  const { chain, expiration, spot } = syntheticChain()
  const base = { symbol: 'TEST', spot, expiration, chain, ivRank: 60, seed: 42, simulations: 800 }
  const def = runEngineLive({ ...base })
  const run = runEngineLive({ ...base, exitPolicies: { iron_condor: 'runner' as const } })
  const ic = (r: typeof def) => r.results.find((x) => x.strategy === 'iron_condor')!
  const bps = (r: typeof def) => r.results.find((x) => x.strategy === 'bull_put_spread')!
  assert.notDeepEqual(ic(run).metrics, ic(def).metrics, 'condor metrics must reflect the policy')
  assert.deepEqual(bps(run).metrics, bps(def).metrics, 'other strategies untouched')
})
