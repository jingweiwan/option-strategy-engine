import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Isolate L2 from the real cache dir BEFORE importing the module — CACHE_DIR is
// resolved at load time. `node --test` gives each file its own process, so this
// cannot leak into other suites.
const DIR = mkdtempSync(join(tmpdir(), 'ose-cache-'))
process.env.AI_CACHE_DIR = DIR
const { cachedSWR, cached, getCachedIfValid, bust } = await import('../src/ai/cache.js')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Write an L2 entry directly with a chosen expiry.
 *
 * Going through `cached()` would not do: both its `writeFs` and `bust()`'s
 * delete are fire-and-forget, so a test that produced then busted raced them —
 * which is exactly why the first version of this suite was flaky. Building the
 * file by hand makes the L2-promotion behaviour deterministic.
 */
function seedL2(key: string, v: unknown, expiryFromNowMs: number): void {
  writeFileSync(join(DIR, key + '.json'), JSON.stringify({ v, expiry: Date.now() + expiryFromNowMs }))
}

test('cachedSWR: fresh hit does not rebuild', async () => {
  let builds = 0
  const produce = async () => { builds++; return builds }
  const a = await cachedSWR('swr-fresh', 30_000, 60_000, produce)
  const b = await cachedSWR('swr-fresh', 30_000, 60_000, produce)
  assert.equal(builds, 1)
  assert.equal(a.stale, false)
  assert.equal(b.stale, false)
  assert.equal(b.v, 1)
})

// The whole point: past the TTL the caller must NOT wait for the rebuild.
test('cachedSWR: inside grace serves the stale value immediately, rebuilds behind', async () => {
  const key = 'swr-stale'
  const TTL = 1_000
  seedL2(key, 'old', -200) // produced 1.2s ago → 200ms past a 1s TTL

  let builds = 0
  const slow = async () => { builds++; await sleep(400); return 'new' }

  const t0 = Date.now()
  const hit = await cachedSWR(key, TTL, 60_000, slow)
  const waited = Date.now() - t0

  assert.equal(hit.v, 'old', 'must serve the previous value, not wait for the new one')
  assert.equal(hit.stale, true, 'staleness must be reported, never silent')
  assert.ok(waited < 200, `caller must not block on the rebuild; waited ${waited}ms`)
  assert.ok(hit.ageMs >= 1_000, `age must reflect real staleness, got ${hit.ageMs}`)

  await sleep(700)
  assert.equal(builds, 1, 'a background rebuild should have run')
  assert.equal((await cachedSWR(key, TTL, 60_000, slow)).v, 'new')
})

// Arbitrarily old market data is worse than a wait — grace has to be a real bound.
test('cachedSWR: past grace it blocks rather than serving ancient data', async () => {
  const key = 'swr-grace'
  seedL2(key, 'ancient', -60_000) // an hour of TTL ago; well past any grace

  let builds = 0
  const hit = await cachedSWR(key, 1_000, 5_000, async () => { builds++; return 'rebuilt' })
  assert.equal(hit.v, 'rebuilt', 'must rebuild rather than serve beyond the grace window')
  assert.equal(hit.stale, false)
  assert.equal(builds, 1)
})

test('cachedSWR: cold key with nothing cached builds synchronously', async () => {
  const hit = await cachedSWR('swr-cold', 30_000, 60_000, async () => 'built')
  assert.equal(hit.v, 'built')
  assert.equal(hit.stale, false)
})

// L2→L1 promotion used to re-stamp expiry as `now + ttl`, extending an entry's
// life by up to a full TTL on every promotion — and since production time is
// recovered as `expiry - ttl`, it also made an old payload look freshly built.
// A genuinely stale dashboard would then report stale:false / ageSec:0, the
// exact failure cachedSWR exists to prevent.
test('cache: promoting an L2 hit into L1 must not extend its life', async () => {
  const key = 'swr-no-extend'
  seedL2(key, 'v1', 250) // 250ms of life left, under a 10s nominal TTL

  assert.equal(await getCachedIfValid<string>(key, 10_000), 'v1', 'still valid before expiry')
  await sleep(400) // past the entry's OWN expiry, far inside the nominal TTL

  assert.equal(
    await getCachedIfValid<string>(key, 10_000), null,
    'entry must expire on its original schedule, not be renewed by the read'
  )
})

test('cachedSWR: reports real age after an L2 promotion', async () => {
  const key = 'swr-age-after-promote'
  const TTL = 1_000
  seedL2(key, 'old', -500) // produced 1.5s ago

  const hit = await cachedSWR(key, TTL, 60_000, async () => { await sleep(300); return 'new' })
  assert.equal(hit.v, 'old')
  assert.equal(hit.stale, true, 'must not report a promoted stale entry as fresh')
  assert.ok(hit.ageMs >= 1_400, `age must reflect the ORIGINAL production time, got ${hit.ageMs}`)
  bust(key)
})
