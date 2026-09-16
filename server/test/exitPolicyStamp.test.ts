/**
 * The exit-policy stamp: one rule scores the trade, prints the card, and settles
 * the outcome.
 *
 * The gap this locks shut (2026-08-31 → 2026-09-16): the engine's default moved
 * to 'user' (TP 75%, no stop, ride to expiry) but the scanner stamped only
 * iron_condor, writing `exitPolicy: null` on every credit spread. The settler
 * read that null as LEGACY_EXIT_POLICY = 'managed' — so 3,515 bull put / bear
 * call snapshots were scored and displayed under one rule and learned from under
 * another (TP 50% / stop 2× / close at 21 DTE), 684 of them already settled.
 * "Display and learning share one managed exit" was true at a moment and false
 * across the round trip.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_EXIT_POLICY, managedThresholds, managedHoldDays } from '../src/engine/managedExit.js'
import { exitPolicyOf, LEGACY_EXIT_POLICY, USER_DEFAULT_SINCE } from '../src/feedback/settlementVersion.js'
import type { RecommendationSnapshot } from '../src/feedback/types.js'

const base = {
  etDay: '2026-09-16',
  capturedAt: '2026-09-16T13:45:00Z'
}

test('resolver: a stamp always wins, whatever the date', () => {
  assert.equal(exitPolicyOf({ ...base, exitPolicy: 'runner' }), 'runner')
  assert.equal(exitPolicyOf({ ...base, exitPolicy: 'managed' }), 'managed')
  // Even a legacy-era row settles under its own stamp, not the date rule.
  assert.equal(exitPolicyOf({ etDay: '2026-06-01', exitPolicy: 'runner' }), 'runner')
})

test('resolver: unstamped ON/AFTER the cutoff settles under the default the card used', () => {
  assert.equal(exitPolicyOf({ ...base, exitPolicy: null }), DEFAULT_EXIT_POLICY)
  assert.equal(exitPolicyOf({ etDay: USER_DEFAULT_SINCE }), DEFAULT_EXIT_POLICY)
  // This is the whole defect: it used to come back 'managed'.
  assert.notEqual(exitPolicyOf({ ...base, exitPolicy: null }), LEGACY_EXIT_POLICY)
})

test('resolver: unstamped BEFORE the cutoff keeps the legacy rule (no history rewrite)', () => {
  assert.equal(exitPolicyOf({ etDay: '2026-08-30', exitPolicy: null }), LEGACY_EXIT_POLICY)
  assert.equal(exitPolicyOf({ etDay: '2026-06-01' }), LEGACY_EXIT_POLICY)
})

test('resolver: falls back to capturedAt when etDay is absent', () => {
  assert.equal(exitPolicyOf({ capturedAt: '2026-09-16T13:45:00Z' }), DEFAULT_EXIT_POLICY)
  assert.equal(exitPolicyOf({ capturedAt: '2026-07-01T13:45:00Z' }), LEGACY_EXIT_POLICY)
  // No date at all → the conservative answer, never today's default.
  assert.equal(exitPolicyOf({}), LEGACY_EXIT_POLICY)
})

test('the two rulers really do differ — the resolver is not cosmetic', () => {
  const credit = 2
  const user = managedThresholds(credit, 'user', 8)
  const managed = managedThresholds(credit, 'managed', 8)
  assert.equal(user.takeProfit, 1.5)        // 75% of credit
  assert.equal(managed.takeProfit, 1)       // 50%
  assert.equal(user.stop, Infinity)         // bounded risk → no stop
  assert.equal(managed.stop, 4)             // 2× credit
  assert.equal(managedHoldDays('bull_put_spread', 30, 'user'), 30)
  assert.equal(managedHoldDays('bull_put_spread', 30, 'managed'), 9) // 21-DTE close
})

/**
 * The scanner's own contract: whatever `exitPolicyBy` resolves for a strategy is
 * what lands on the snapshot. Re-stated on the shape the store actually holds,
 * so a future `?? null` in makeOpp fails here rather than in the learning record
 * three weeks later.
 */
test('a stamped snapshot never leaves the scanner with a null policy', () => {
  const stamped: Pick<RecommendationSnapshot, 'exitPolicy' | 'etDay'>[] = [
    { etDay: '2026-09-16', exitPolicy: DEFAULT_EXIT_POLICY }, // bull put / bear call
    { etDay: '2026-09-16', exitPolicy: 'runner' }             // condor A/B arm
  ]
  for (const s of stamped) {
    assert.notEqual(s.exitPolicy, null)
    assert.equal(exitPolicyOf(s), s.exitPolicy)
  }
})
