/**
 * View-skill gate — the AI directional view only tilts selection to the extent
 * it has EARNED skill weight. Both directional views (bullish, bearish) sit at
 * weight 0 today (bullish anti-predictive, bearish regime-confounded), so
 * neither changes the engine's ranking; neutral / neutral-vol keep full weight.
 * Guards against silently re-introducing an unearned directional tilt.
 * See feedback/viewSkill.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runEngineLive } from '../src/engine/index.js'
import { viewWeight, scaleByViewSkill } from '../src/feedback/viewSkill.js'
import { syntheticChain } from './fixtures.js'

const order = (r: ReturnType<typeof runEngineLive>) => r.results.map((x) => x.strategy).join(' > ')
const primary = (r: ReturnType<typeof runEngineLive>) =>
  r.results.filter((x) => x.tier === 'primary').map((x) => x.strategy).sort().join(',')

test('viewSkill: directional views gated to 0, vol/range views full weight', () => {
  assert.equal(viewWeight('bullish'), 0)
  assert.equal(viewWeight('bearish'), 0)
  assert.equal(viewWeight('neutral'), 1)
  assert.equal(viewWeight('neutral-vol'), 1)
  assert.equal(viewWeight(undefined), 0)
})

test('viewSkill: scale collapses gated views to 1, passes earned views through', () => {
  // weight 0 → no tilt regardless of the designed multiplier
  assert.equal(scaleByViewSkill(1.6, 'bullish'), 1)
  assert.equal(scaleByViewSkill(0.5, 'bearish'), 1)
  // weight 1 → full designed multiplier
  assert.equal(scaleByViewSkill(1.6, 'neutral'), 1.6)
  assert.equal(scaleByViewSkill(0.5, 'neutral'), 0.5)
  // a table override earns partial weight: 1 + 0.5·(1.6−1) = 1.3
  const t = new Map([['bullish' as const, 0.5]])
  assert.equal(scaleByViewSkill(1.6, 'bullish', t), 1.3)
})

test('engine: gated directional views change neither ranking nor tier vs no view', () => {
  const { chain, expiration, spot } = syntheticChain()
  const base = { symbol: 'TEST', spot, expiration, chain, ivRank: 30, seed: 42, simulations: 800 }
  const none = runEngineLive({ ...base })
  for (const view of ['bullish', 'bearish'] as const) {
    const r = runEngineLive({ ...base, view })
    assert.equal(order(r), order(none), `${view} must not reorder strategies`)
    assert.equal(primary(r), primary(none), `${view} must not change the primary tier`)
  }
})

test('engine: a full-weight view (neutral-vol) still tilts selection', () => {
  const { chain, expiration, spot } = syntheticChain()
  const base = { symbol: 'TEST', spot, expiration, chain, ivRank: 30, seed: 42, simulations: 800 }
  const none = runEngineLive({ ...base })
  const nv = runEngineLive({ ...base, view: 'neutral-vol' })
  assert.notEqual(
    order(nv) + '|' + primary(nv),
    order(none) + '|' + primary(none),
    'neutral-vol (weight 1) should still influence ranking or tier'
  )
})
