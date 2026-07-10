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

async function readFs<T>(key: string): Promise<T | null> {
  try {
    const path = join(CACHE_DIR, safeKey(key) + '.json')
    const raw = await readFile(path, 'utf8')
    const entry = JSON.parse(raw) as Entry<T>
    if (entry.expiry > Date.now()) return entry.v
    return null
  } catch {
    return null
  }
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

/** L1 / L2 read only; does not run `produce`. */
export async function getCachedIfValid<T>(key: string, ttlMsForL1: number): Promise<T | null> {
  const now = Date.now()
  const m = mem.get(key)
  if (m && m.expiry > now) return m.v as T
  const f = await readFs<T>(key)
  if (f != null) {
    mem.set(key, { v: f, expiry: now + ttlMsForL1 })
    return f
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

export function bust(prefix?: string): void {
  if (!prefix) {
    mem.clear()
    bustFs().catch(() => {})
    return
  }
  for (const k of mem.keys()) {
    if (k.startsWith(prefix)) mem.delete(k)
  }
  bustFs(prefix).catch(() => {})
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
