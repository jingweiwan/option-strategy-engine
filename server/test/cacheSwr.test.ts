import test from 'node:test'
import assert from 'node:assert/strict'
import { cachedSWR, cached, bust } from '../src/ai/cache.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('cachedSWR: fresh hit does not rebuild', async () => {
  bust('swr-fresh')
  let builds = 0
  const produce = async () => { builds++; return builds }
  const a = await cachedSWR('swr-fresh', 5_000, 60_000, produce)
  const b = await cachedSWR('swr-fresh', 5_000, 60_000, produce)
  assert.equal(builds, 1)
  assert.equal(a.stale, false)
  assert.equal(b.stale, false)
  assert.equal(b.v, 1)
})

// The whole point: past the TTL the caller must NOT wait for the rebuild.
test('cachedSWR: inside grace serves the stale value immediately, rebuilds behind', async () => {
  bust('swr-stale')
  let builds = 0
  const slow = async () => { builds++; await sleep(120); return builds }

  assert.equal((await cachedSWR('swr-stale', 40, 60_000, slow)).v, 1)
  await sleep(60) // past TTL, well inside grace

  const t0 = Date.now()
  const hit = await cachedSWR('swr-stale', 40, 60_000, slow)
  const waited = Date.now() - t0

  assert.equal(hit.v, 1, 'must serve the previous value, not wait for the new one')
  assert.equal(hit.stale, true, 'staleness must be reported, never silent')
  assert.ok(waited < 60, `caller must not block on the rebuild; waited ${waited}ms`)
  assert.ok(hit.ageMs >= 40, `age should reflect real staleness, got ${hit.ageMs}`)

  await sleep(200)
  assert.equal(builds, 2, 'a background rebuild should have run')
  assert.equal((await cachedSWR('swr-stale', 40, 60_000, slow)).v, 2)
})

// Arbitrarily old market data is worse than a wait — grace has to be a real bound.
test('cachedSWR: past grace it blocks rather than serving ancient data', async () => {
  bust('swr-grace')
  let builds = 0
  const produce = async () => { builds++; return builds }

  assert.equal((await cachedSWR('swr-grace', 20, 40, produce)).v, 1)
  await sleep(90) // past TTL *and* past grace

  const hit = await cachedSWR('swr-grace', 20, 40, produce)
  assert.equal(hit.v, 2, 'must rebuild rather than serve beyond the grace window')
  assert.equal(hit.stale, false)
  assert.equal(builds, 2)
})

test('cachedSWR: cold key with nothing cached builds synchronously', async () => {
  bust('swr-cold')
  const hit = await cachedSWR('swr-cold', 5_000, 60_000, async () => 'built')
  assert.equal(hit.v, 'built')
  assert.equal(hit.stale, false)
})
