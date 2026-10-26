/**
 * AI directional views silently fell back to the technical heuristic on every
 * scan from 2026-09-07 to 10-26. Cause: chatJson runs DeepSeek in JSON mode
 * (`response_format: json_object`), which only allows an object at the top
 * level, so the requested array came back wrapped —
 * `{"type":"json_object","items":[…]}` (captured 2026-10-26, 36 symbols) — and
 * `!Array.isArray(data)` returned the fallback, which was then cached for 12h.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { jsonArrayOf } from '../src/ai/client.js'
import { mergeAiViews, type SymbolContext } from '../src/ai/directionalView.js'

const ctx = (sym: string): SymbolContext => ({
  sym, px: 100, chg: 0, chg5d: 1.2, iv: 0.3, ivr: 60, rv: 0.2, em: 5, earn: '—', regime: 'sell', macdHist: 0.3
})

test('the wrapped array DeepSeek returns in JSON mode is unwrapped', () => {
  const wrapped = { type: 'json_object', items: [{ sym: 'NVDA', view: 'neutral', confidence: 0.55, reason: 'x' }] }
  assert.deepEqual(jsonArrayOf(wrapped), wrapped.items)
  assert.deepEqual(jsonArrayOf({ views: [1, 2] }), [1, 2])
  assert.deepEqual(jsonArrayOf([1]), [1])
})

test('no single array → null (caller treats as failure, not as a fallback to cache)', () => {
  assert.equal(jsonArrayOf({ a: [1], b: [2] }), null)
  assert.equal(jsonArrayOf({ a: 1 }), null)
  assert.equal(jsonArrayOf(null), null)
  assert.equal(jsonArrayOf('[]'), null)
})

test('views are matched by symbol, not position; skipped symbols get the fallback', () => {
  const syms = [ctx('SPY'), ctx('IWM'), ctx('AMZN')]
  const out = mergeAiViews(syms, [
    { sym: 'iwm', view: 'bearish', confidence: 0.6, reason: 'r1' },
    { sym: 'SPY', view: 'neutral', confidence: 0.7, reason: 'r2' }
  ])
  assert.deepEqual(out.map((v) => v.sym), ['SPY', 'IWM', 'AMZN'])
  assert.equal(out[0].view, 'neutral')
  assert.equal(out[0].confidence, 0.7)
  assert.equal(out[1].view, 'bearish')
  assert.match(out[2].reason, /^fallback/)
})

test('an unknown view string degrades to neutral', () => {
  const out = mergeAiViews([ctx('SPY')], [{ sym: 'SPY', view: 'moon', confidence: 0.6, reason: '' }])
  assert.equal(out[0].view, 'neutral')
})

test('answering under half the symbols is a failed call', () => {
  const syms = ['A', 'B', 'C', 'D', 'E'].map(ctx)
  assert.throws(() => mergeAiViews(syms, [{ sym: 'A', view: 'neutral', confidence: 0.6, reason: '' }]), /answered 1\/5/)
})
