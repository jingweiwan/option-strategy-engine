/**
 * The 财报 tag must mean "this position wears the print", not "this company
 * reports someday".
 *
 * Regression: the tag keyed off `earn !== '—'` — an earnings date merely
 * EXISTING — which is true for nearly every name. On the 2026-09-01 board both
 * XOM cards were tagged 财报 (XOM reports 2026-10-30) while expiring 2026-10-16
 * and 2026-10-02, i.e. closed before the print. 财报 outranks 高 IV, so the cards
 * lost their real label and the AI copy wrote "10/29 财报临近，事件风险高" onto a
 * position that cannot see the event.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inferTag, validateTag } from '../src/ai/opportunities.js'
import type { ScannedOpp } from '../src/engine/oppScanner.js'

const opp = (over: Partial<ScannedOpp> = {}): ScannedOpp =>
  ({
    sym: 'XOM', strategyId: 'iron_condor', strategy: '铁鹰', expiration: '2026-10-16',
    ivr: 40, dte: 46, spot: 161.13, iv: 0.282, netPremium: 1.22,
    maxProfit: 1.22, maxLoss: -3.78, pop: 0.84, ev: 0.2, regime: 'sell',
    ...over
  }) as ScannedOpp

test('an earnings date AFTER expiration is not this position\'s risk', () => {
  // XOM reports 2026-10-30; the condor is settled 2026-10-16.
  const o = opp({ spansEarnings: false, ivr: 40 })
  assert.notEqual(inferTag(o, '10/30'), '财报')
  assert.equal(validateTag('财报', o, '10/30'), inferTag(o, '10/30'),
    'an AI-proposed 财报 must be rejected when the print lands after expiry')
})

test('an earnings date INSIDE the window still tags 财报', () => {
  const o = opp({ spansEarnings: true })
  assert.equal(inferTag(o, '10/09'), '财报')
  assert.equal(validateTag('财报', o, '10/09'), '财报')
})

test('the tag agrees with the sell-vol gate rather than contradicting it', () => {
  // spansEarnings is the SAME predicate that makes sellVolDecision refuse to
  // auto-sell through a print. A qualified credit card therefore can never
  // carry 财报 — if these disagree, one of them is lying to the reader.
  const qualified = opp({ spansEarnings: false, boardTier: 'qualified', ivr: 55 })
  assert.notEqual(inferTag(qualified, '10/30'), '财报')
  assert.equal(inferTag(qualified, '10/30'), '高 IV', 'falls through to the real label')
})

test('a missing earnings date is still not 财报', () => {
  assert.notEqual(inferTag(opp({ spansEarnings: false })), '财报')
  assert.notEqual(inferTag(opp({})), '财报')
})
