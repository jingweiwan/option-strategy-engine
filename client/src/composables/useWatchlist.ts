import { ref, computed } from 'vue'

const STORAGE_V2 = 'ose-watchlist-v2'
const STORAGE_V1 = 'ose-watchlist-syms-v1'
const MAX_SYMBOLS = 40

export type WatchlistItem = {
  sym: string
  /** Display name (Finnhub description or server default catalog). */
  name: string
}

/** Filled by `preloadWatchlistDefaults()` from `GET /api/watchlist/default` — same as server `DEFAULT_WATCHLIST`. */
let cachedServerDefaults: WatchlistItem[] | null = null

const defaultName = (sym: string): string =>
  cachedServerDefaults?.find((e) => e.sym === sym)?.name ?? sym

const entries = ref<WatchlistItem[]>([])
let inited = false

export async function preloadWatchlistDefaults(force = false): Promise<void> {
  if (cachedServerDefaults && cachedServerDefaults.length > 0 && !force) return
  try {
    const r = await fetch('/api/watchlist/default')
    if (!r.ok) throw new Error(String(r.status))
    const d = (await r.json()) as { entries?: unknown }
    const raw = d.entries
    if (!Array.isArray(raw)) {
      cachedServerDefaults = []
      return
    }
    const out: WatchlistItem[] = []
    for (const row of raw) {
      if (!row || typeof row !== 'object') continue
      const sym = String((row as any).sym ?? '').trim().toUpperCase()
      const name = String((row as any).name ?? '').trim()
      if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(sym)) continue
      out.push({ sym, name: name || sym })
    }
    cachedServerDefaults = out
  } catch {
    if (!cachedServerDefaults) cachedServerDefaults = []
  }
}

const parseV2 = (raw: string): WatchlistItem[] | null => {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return null
    const out: WatchlistItem[] = []
    const seen = new Set<string>()
    for (const row of parsed) {
      if (!row || typeof row !== 'object') continue
      const sym = String((row as any).sym ?? '').trim().toUpperCase()
      if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(sym)) continue
      if (seen.has(sym)) continue
      seen.add(sym)
      const name = String((row as any).name ?? '').trim() || defaultName(sym)
      out.push({ sym, name })
      if (out.length >= MAX_SYMBOLS) break
    }
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

const migrateV1 = (raw: string): WatchlistItem[] | null => {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return null
    const syms = parsed
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.trim().toUpperCase())
      .filter((x) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(x))
    const dedup: WatchlistItem[] = []
    const seen = new Set<string>()
    for (const sym of syms) {
      if (seen.has(sym)) continue
      seen.add(sym)
      dedup.push({ sym, name: defaultName(sym) })
      if (dedup.length >= MAX_SYMBOLS) break
    }
    return dedup.length > 0 ? dedup : null
  } catch {
    return null
  }
}

const readStorage = (): WatchlistItem[] => {
  try {
    const v2 = localStorage.getItem(STORAGE_V2)
    if (v2) {
      const parsed = parseV2(v2)
      if (parsed) return parsed
    }
    const v1 = localStorage.getItem(STORAGE_V1)
    if (v1) {
      const parsed = migrateV1(v1)
      if (parsed) return parsed
    }
  } catch {
    /* ignore */
  }
  return cachedServerDefaults?.length ? [...cachedServerDefaults] : []
}

const persist = () => {
  localStorage.setItem(STORAGE_V2, JSON.stringify(entries.value))
}

/**
 * Dashboard watchlist: persisted in localStorage; default list comes only from server `/api/watchlist/default`.
 * Call `preloadWatchlistDefaults()` from `main.ts` before mount.
 */
export const useWatchlist = () => {
  if (!inited) {
    inited = true
    entries.value = readStorage()
  }

  const syms = computed(() => entries.value.map((e) => e.sym))

  const add = (
    symbol: string,
    displayName: string
  ): { ok: true } | { ok: false; reason: string } => {
    const s = symbol.trim().toUpperCase()
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(s)) {
      return { ok: false, reason: '代码格式无效' }
    }
    if (entries.value.some((e) => e.sym === s)) {
      return { ok: false, reason: '已在自选列表中' }
    }
    if (entries.value.length >= MAX_SYMBOLS) {
      return { ok: false, reason: `最多 ${MAX_SYMBOLS} 只标的` }
    }
    const name = (displayName || '').trim() || defaultName(s)
    entries.value = [...entries.value, { sym: s, name }]
    persist()
    return { ok: true }
  }

  const remove = (symbol: string) => {
    entries.value = entries.value.filter((e) => e.sym !== symbol)
    persist()
  }

  const resetDefault = async () => {
    await preloadWatchlistDefaults(true)
    if (cachedServerDefaults?.length) {
      entries.value = cachedServerDefaults.map((e) => ({ ...e }))
      persist()
    }
  }

  const notifyChanged = () => {
    window.dispatchEvent(new CustomEvent('ose:watchlist-changed'))
  }

  return { entries, syms, add, remove, resetDefault, notifyChanged, MAX_SYMBOLS, defaultName }
}
