/**
 * Two-tier cache for AI responses:
 *   L1: in-memory Map (per process)
 *   L2: filesystem under ./cache/ (survives restart, gitignored)
 *
 * Keys are strings; values are JSON-serializable. TTL is per-call.
 *
 * Use:
 *   const v = await cached('dash-2026-05-08', 12 * HOUR, async () => {
 *     return await callAI(...)
 *   })
 */
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const MIN = 60 * 1000
export const HOUR = 60 * MIN
export const DAY = 24 * HOUR

/** ET calendar day as YYYY-MM-DD. Shared by all daily-keyed caches. */
export function etCalendarDay(): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date())
  const y = parts.find((p) => p.type === 'year')?.value ?? ''
  const m = parts.find((p) => p.type === 'month')?.value ?? ''
  const d = parts.find((p) => p.type === 'day')?.value ?? ''
  return `${y}-${m}-${d}`
}

const CACHE_DIR = process.env.AI_CACHE_DIR
  ? resolve(process.env.AI_CACHE_DIR)
  : resolve(process.cwd(), 'cache')

type Entry<T> = { v: T; expiry: number }
const mem = new Map<string, Entry<unknown>>()
const inflight = new Map<string, Promise<unknown>>()
const MEM_MAX = 500

/** Evict expired entries; if still over limit, drop oldest by insertion order. */
function evictIfNeeded(): void {
  if (mem.size <= MEM_MAX) return
  const now = Date.now()
  for (const [k, e] of mem) {
    if (e.expiry <= now) mem.delete(k)
  }
  if (mem.size <= MEM_MAX) return
  // Drop oldest entries (Map iterates in insertion order)
  let toDrop = mem.size - MEM_MAX
  for (const k of mem.keys()) {
    if (toDrop-- <= 0) break
    mem.delete(k)
  }
}

function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200)
}

async function ensureDir() {
  try {
    await mkdir(CACHE_DIR, { recursive: true })
  } catch {
    /* ignore */
  }
}

/** L2 entry as written, expiry included, regardless of whether it is expired. */
async function readFsEntry<T>(key: string): Promise<Entry<T> | null> {
  try {
    const path = join(CACHE_DIR, safeKey(key) + '.json')
    return JSON.parse(await readFile(path, 'utf8')) as Entry<T>
  } catch {
    return null
  }
}

async function readFs<T>(key: string): Promise<T | null> {
  const entry = await readFsEntry<T>(key)
  if (entry != null && entry.expiry > Date.now()) return entry.v
  return null
}

async function writeFs<T>(key: string, entry: Entry<T>): Promise<void> {
  await ensureDir()
  try {
    const path = join(CACHE_DIR, safeKey(key) + '.json')
    await writeFile(path, JSON.stringify(entry), 'utf8')
  } catch (err) {
    console.warn('[cache] write failed:', (err as Error).message)
  }
}

/**
 * L1 / L2 read only; does not run `produce`.
 *
 * Promoting an L2 hit into L1 keeps the entry's ORIGINAL expiry. Re-stamping it
 * as `now + ttl` silently extended every entry's life by up to a full TTL on
 * each promotion, and — because `expiry - ttl` is how production time is
 * recovered — it also made an old payload look freshly built, which would have
 * reported a genuinely stale dashboard as `stale:false / ageSec:0`. That is the
 * exact failure `cachedSWR` exists to prevent.
 *
 * `ttlMsForL1` is now only a floor for entries written without one.
 */
export async function getCachedIfValid<T>(key: string, ttlMsForL1: number): Promise<T | null> {
  const now = Date.now()
  const m = mem.get(key)
  if (m && m.expiry > now) return m.v as T
  const e = await readFsEntry<T>(key)
  if (e != null && e.expiry > now) {
    mem.set(key, { v: e.v, expiry: Number.isFinite(e.expiry) ? e.expiry : now + ttlMsForL1 })
    return e.v
  }
  return null
}

/**
 * 叙事专用：先读 `narrative-YYYY-MM-DD.json`；若无则匹配同日 `narrative-YYYY-MM-DD-*.json`（旧版按快照拼的 key），
 * 取磁盘上最新 mtime 且未过期的一条，并写入 L1，避免每次 miss 都打 Finnhub + DeepSeek。
 */
export async function getCachedNarrativeDailyWithLegacy<T>(
  canonicalKey: string,
  ttlMsForL1: number
): Promise<T | null> {
  const hit = await getCachedIfValid<T>(canonicalKey, ttlMsForL1)
  if (hit != null) return hit

  const sk = safeKey(canonicalKey)
  if (!/^narrative-\d{4}-\d{2}-\d{2}$/.test(sk)) return null

  try {
    const names = await readdir(CACHE_DIR)
    const loose = names.filter((f) => f.startsWith(`${sk}-`) && f.endsWith('.json'))
    let best: { mtime: number; v: T } | null = null
    for (const f of loose) {
      const fp = join(CACHE_DIR, f)
      let raw: string
      try {
        raw = await readFile(fp, 'utf8')
      } catch {
        continue
      }
      let entry: Entry<T>
      try {
        entry = JSON.parse(raw) as Entry<T>
      } catch {
        continue
      }
      if (entry.expiry <= Date.now()) continue
      const st = await stat(fp).catch(() => null)
      const mt = st?.mtimeMs ?? 0
      if (!best || mt > best.mtime) best = { mtime: mt, v: entry.v }
    }
    if (best == null) return null
    mem.set(canonicalKey, { v: best.v, expiry: Date.now() + ttlMsForL1 })
    return best.v
  } catch {
    return null
  }
}

/**
 * Read an entry even when it is past `ttlMs`, as long as it is younger than
 * `graceMs`. Returns the value plus how stale it is.
 *
 * `Entry.expiry` is stamped as `producedAt + ttlMs` by whoever wrote it, so the
 * production time is recoverable as `expiry - ttlMs`.
 */
async function readStale<T>(
  key: string,
  ttlMs: number,
  graceMs: number
): Promise<{ v: T; ageMs: number } | null> {
  const now = Date.now()
  const pick = (e: Entry<T> | undefined): { v: T; ageMs: number } | null => {
    if (!e) return null
    const producedAt = e.expiry - ttlMs
    const ageMs = now - producedAt
    return ageMs <= graceMs ? { v: e.v, ageMs } : null
  }
  const m = pick(mem.get(key) as Entry<T> | undefined)
  if (m) return m
  return pick((await readFsEntry<T>(key)) ?? undefined)
}

/**
 * Stale-while-revalidate.
 *
 * `cached()` treats TTL expiry as a hard miss, so the FIRST request after the
 * window pays the full rebuild — for the dashboard that is 15-50s of blocking
 * wait (36 CBOE payloads at concurrency 6, which the provider then throttles).
 * The user sees a blank page for something whose inputs are ~15 minutes delayed
 * to begin with: the wait buys no freshness at all.
 *
 * So within `graceMs` of expiry, serve the stale value IMMEDIATELY and refresh
 * in the background. `stale` is returned so the UI can say "更新中" rather than
 * silently showing old numbers — staleness the reader can't see is the thing
 * worth avoiding, not staleness itself.
 *
 * Past `graceMs` this degrades to plain `cached()` and blocks, because
 * arbitrarily old market data is worse than a wait.
 */
export async function cachedSWR<T>(
  key: string,
  ttlMs: number,
  graceMs: number,
  produce: () => Promise<T>
): Promise<{ v: T; stale: boolean; ageMs: number }> {
  const fresh = await getCachedIfValid<T>(key, ttlMs)
  if (fresh != null) return { v: fresh, stale: false, ageMs: 0 }

  const stale = await readStale<T>(key, ttlMs, graceMs)
  if (stale != null) {
    // Fire-and-forget refresh; `cached` dedupes so concurrent readers share it.
    void cached(key, ttlMs, produce).catch((e) => {
      console.warn(`[cache] background refresh failed for ${key}:`, (e as Error).message)
    })
    return { v: stale.v, stale: true, ageMs: stale.ageMs }
  }

  return { v: await cached(key, ttlMs, produce), stale: false, ageMs: 0 }
}

export async function cached<T>(
  key: string,
  ttlMs: number,
  produce: () => Promise<T>
): Promise<T> {
  const hit = await getCachedIfValid<T>(key, ttlMs)
  if (hit != null) return hit

  // Deduplicate concurrent calls for the same key (thundering herd protection).
  const existing = inflight.get(key) as Promise<T> | undefined
  if (existing) return existing

  const p = produce()
    .then((v) => {
      const entry: Entry<T> = { v, expiry: Date.now() + ttlMs }
      mem.set(key, entry)
      evictIfNeeded()
      writeFs(key, entry) // fire-and-forget
      return v
    })
    .finally(() => {
      inflight.delete(key)
    })

  inflight.set(key, p)
  return p
}

/**
 * Is there ANY unexpired entry whose key starts with `prefix`?
 *
 * `getCachedIfValid` needs the exact key, which is useless for "has today been
 * warmed?" checks against keys that carry a version, a pool fingerprint and a
 * board signature. Probing an exact prefix as if it were a key silently answers
 * "no" forever.
 */
export async function hasFreshEntry(prefix: string): Promise<boolean> {
  const now = Date.now()
  for (const [k, e] of mem) {
    if (k.startsWith(prefix) && e.expiry > now) return true
  }
  const sp = safeKey(prefix)
  try {
    const names = await readdir(CACHE_DIR)
    for (const f of names) {
      if (!f.startsWith(sp) || !f.endsWith('.json')) continue
      try {
        const e = JSON.parse(await readFile(join(CACHE_DIR, f), 'utf8')) as Entry<unknown>
        if (e.expiry > now) return true
      } catch { /* unreadable entry — treat as absent */ }
    }
  } catch { /* no cache dir yet */ }
  return false
}

/**
 * Drop cached entries by prefix. L1 clears synchronously; the RETURNED promise
 * settles once the L2 files are gone.
 *
 * Awaiting matters: a caller that busts a poisoned entry and immediately calls
 * `cached()` on the same key would otherwise race the unlink — L1 is empty, the
 * L2 file is still on disk, and `getCachedIfValid` hands the poisoned value
 * straight back without ever running the producer. Legacy callers that ignore
 * the return value behave exactly as before.
 */
export function bust(prefix?: string): Promise<void> {
  if (!prefix) {
    mem.clear()
    return bustFs().catch(() => {})
  }
  for (const k of mem.keys()) {
    if (k.startsWith(prefix)) mem.delete(k)
  }
  return bustFs(prefix).catch(() => {})
}

/** Remove L2 filesystem cache entries matching prefix. */
async function bustFs(prefix?: string): Promise<void> {
  try {
    const names = await readdir(CACHE_DIR)
    const { unlink } = await import('node:fs/promises')
    for (const f of names) {
      if (!f.endsWith('.json')) continue
      if (prefix && !f.startsWith(safeKey(prefix))) continue
      await unlink(join(CACHE_DIR, f)).catch(() => {})
    }
  } catch {
    /* dir may not exist */
  }
}
