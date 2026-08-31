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
const { cachedSWR, cached, getCachedIfValid, hasFreshEntry, bust } = await import('../src/ai/cache.js')

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

// bust() clears L1 synchronously but unlinks L2 asynchronously. A caller that
// busted a poisoned entry and immediately called cached() on the same key found
// an empty L1, read the still-present L2 file, and got the poisoned value back
// WITHOUT the producer ever running — the fix resurrecting the bug it fixed.
// bust() now returns a promise that settles once L2 is gone.
test('bust: awaiting it guarantees the next cached() call rebuilds', async () => {
  const key = 'swr-bust-await'
  seedL2(key, 'poisoned', 60_000)

  await bust(key)

  let ran = false
  const v = await cached(key, 60_000, async () => { ran = true; return 'clean' })
  assert.equal(ran, true, 'producer must run — the L2 file was supposed to be gone')
  assert.equal(v, 'clean', 'must not resurrect the busted entry')
})

test('bust: without awaiting, the L2 file may still be readable (documents the race)', async () => {
  const key = 'swr-bust-race'
  seedL2(key, 'poisoned', 60_000)
  const p = bust(key)
  // Not awaited yet: this is precisely the window the old code ran in. We assert
  // only that bust returns something awaitable — the race itself is timing
  // dependent, so asserting the poisoned read would be a flaky test.
  assert.ok(typeof (p as Promise<void>)?.then === 'function', 'bust must be awaitable')
  await p
  assert.equal(await getCachedIfValid<string>(key, 60_000), null, 'gone once awaited')
})

// The warmer's "has today been warmed?" probe used an exact key
// (`narrative-${day}`) while entries are written as
// `narrative-v3-${day}-${pool}-${board}`. getCachedIfValid needs the exact key,
// so the probe matched nothing that is ever written and answered "no" forever.
test('hasFreshEntry: finds an entry by prefix, not just by exact key', async () => {
  const day = '2026-08-26'
  const prefix = `narrative-v3-${day}-`
  assert.equal(await hasFreshEntry(prefix), false, 'nothing written yet')

  seedL2(`narrative-v3-${day}-wl36xabc-2-IWM_XOM`, { deck: 'x' }, 60_000)
  assert.equal(await hasFreshEntry(prefix), true, 'must match by prefix')

  // The old exact-key probe is what failed: prove it still fails, so the test
  // documents WHY the prefix probe exists.
  assert.equal(await getCachedIfValid(`narrative-${day}`, 60_000), null)
})

test('hasFreshEntry: an expired entry does not count as warmed', async () => {
  const prefix = 'narrative-v3-2026-08-27-'
  seedL2('narrative-v3-2026-08-27-wl1xz-standby', { deck: 'old' }, -1_000)
  assert.equal(await hasFreshEntry(prefix), false, 'expired must read as not-warmed')
})

test('hasFreshEntry: a different day does not satisfy the probe', async () => {
  seedL2('narrative-v3-2026-08-28-wl1xz-standby', { deck: 'y' }, 60_000)
  assert.equal(await hasFreshEntry('narrative-v3-2026-08-29-'), false)
})

// The daily refresh busts then immediately re-warms. If the busts are not
// awaited, the re-warm reads the still-present L2 files and warms the OLD
// entries back in — the refresh re-serves exactly what it meant to replace.
test('bust: awaited busts are gone before the next read, in parallel', async () => {
  const keys = ['dr-narrative-a', 'dr-opps-a', 'dr-ticker-notes-a']
  for (const k of keys) seedL2(k, 'stale', 60_000)
  for (const k of keys) assert.ok(await hasFreshEntry(k), `${k} seeded`)

  await Promise.all(keys.map((k) => bust(k)))

  for (const k of keys) {
    assert.equal(await hasFreshEntry(k), false, `${k} must be gone once the bust is awaited`)
  }
})

// Structural guard. bust() was made awaitable in one round and five call sites
// in the warmer were left un-awaited in the same round — the fix shipped
// without taking effect where it mattered most. A per-call-site assertion is
// the only thing that catches "changed the primitive, missed the callers".
test('bust: every call site in src/ awaits it', async () => {
  const { readdirSync, readFileSync: rf, statSync } = await import('node:fs')
  const { join: j } = await import('node:path')
  const root = new URL('../src/', import.meta.url).pathname

  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = j(dir, n)
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
    })

  const offenders: string[] = []
  for (const file of walk(root)) {
    const src = rf(file, 'utf8')
    for (const m of src.matchAll(/\bbust\(/g)) {
      const at = m.index!
      const before = src.slice(Math.max(0, at - 260), at)
      // The definition and the internal helper are not call sites.
      if (/function\s+$/.test(before) || src.slice(at - 4, at) === 'Fs') continue
      if (/(^|[^A-Za-z])bustFs\($/.test(src.slice(Math.max(0, at - 7), at + 5))) continue
      // Inside a comment line?
      const lineStart = src.lastIndexOf('\n', at) + 1
      const linePrefix = src.slice(lineStart, at)
      if (/^\s*(\*|\/\/)/.test(linePrefix)) continue
      if (/function bust$|export function bust$/.test(before.trimEnd())) continue
      // Acceptable: directly awaited, directly returned, or an element of a
      // Promise.all([...]) that the caller awaits.
      if (/(await|return)\s+$/.test(before)) continue
      const openAll = before.lastIndexOf('Promise.all([')
      const closeAll = before.lastIndexOf('])')
      if (openAll !== -1 && openAll > closeAll) continue
      const line = src.slice(lineStart, src.indexOf('\n', at))
      offenders.push(`${file.replace(root, 'src/')}  ${line.trim()}`)
    }
  }
  assert.deepEqual(
    offenders, [],
    `bust() must be awaited (its L2 unlink is async) — un-awaited call sites:\n${offenders.join('\n')}`
  )
})
