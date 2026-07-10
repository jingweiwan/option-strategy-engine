/**
 * Client-side cache for OCIFQ deep analysis results.
 *
 * - Stores results by symbol in a reactive Map (survives route navigation)
 * - Persisted to localStorage (survives page refresh)
 * - Tracks fetch order for "recent analyses" list
 * - Client TTL: 30 min — after that, next access re-fetches (server cache
 *   still responds instantly if within its own 6h TTL)
 * - Max 20 entries in memory; oldest evicted on overflow
 */
import { reactive, computed } from 'vue';
import { fetchDeepAnalysis } from '@/api/client';
import { useThesisDrift } from './useThesisDrift';
const STORAGE_KEY = 'ose-deep-analysis-v1';
const CLIENT_TTL_MS = 30 * 60000; // 30 min
const MAX_ENTRIES = 20;
/** Reactive state lives outside the composable → shared across all components. */
const cache = reactive(new Map());
const order = reactive([]); // most-recent-first
const currentSymbol = reactive({ value: '' });
// ---------- localStorage persistence ----------
function persist() {
    try {
        const entries = {};
        for (const sym of order) {
            const e = cache.get(sym);
            if (e && !e.loading && e.data != null) {
                entries[sym] = { data: e.data, fetchedAt: e.fetchedAt };
            }
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ order: [...order], entries }));
    }
    catch { /* quota exceeded or private mode — ignore */ }
}
function hydrate() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw)
            return;
        const parsed = JSON.parse(raw);
        if (!parsed.order || !parsed.entries)
            return;
        const now = Date.now();
        for (const sym of parsed.order) {
            const entry = parsed.entries[sym];
            if (!entry?.data)
                continue;
            // Skip entries older than 6 hours (aligned with server TTL)
            if (now - entry.fetchedAt > 6 * 60 * 60000)
                continue;
            cache.set(sym, { data: entry.data, fetchedAt: entry.fetchedAt, loading: false, error: null });
            order.push(sym);
        }
    }
    catch { /* corrupted — start fresh */ }
}
// Hydrate on module load (runs once)
hydrate();
// ---------- Internal helpers ----------
function touchOrder(sym) {
    const idx = order.indexOf(sym);
    if (idx >= 0)
        order.splice(idx, 1);
    order.unshift(sym);
    // evict oldest
    while (order.length > MAX_ENTRIES) {
        const old = order.pop();
        cache.delete(old);
    }
}
function isStale(entry) {
    if (entry.loading)
        return false;
    return Date.now() - entry.fetchedAt > CLIENT_TTL_MS;
}
// ---------- Public API ----------
export function useDeepAnalysisStore() {
    const entry = computed(() => {
        const sym = currentSymbol.value;
        if (!sym)
            return null;
        return cache.get(sym) ?? null;
    });
    const data = computed(() => entry.value?.data ?? null);
    const loading = computed(() => entry.value?.loading ?? false);
    const error = computed(() => entry.value?.error ?? null);
    const recentSymbols = computed(() => order
        .filter((s) => {
        const e = cache.get(s);
        return e && !e.loading && e.data != null;
    })
        .map((s) => {
        const e = cache.get(s);
        return {
            symbol: s,
            name: e.data.name,
            total: e.data.scores.total,
            view: e.data.view,
            generatedAt: e.data.generatedAt
        };
    }));
    /** Load a symbol — serves from cache if fresh, otherwise fetches. */
    async function load(sym, forceRefresh = false) {
        const s = sym.toUpperCase().trim();
        if (!s)
            return;
        currentSymbol.value = s;
        // Check cache
        const existing = cache.get(s);
        if (existing && !forceRefresh && !isStale(existing)) {
            touchOrder(s);
            return; // already have fresh data (or currently loading)
        }
        // Mark loading
        cache.set(s, { data: null, fetchedAt: Date.now(), loading: true, error: null });
        touchOrder(s);
        try {
            const result = await fetchDeepAnalysis(s);
            cache.set(s, { data: result, fetchedAt: Date.now(), loading: false, error: null });
            // Record thesis snapshot for drift detection
            const { record } = useThesisDrift();
            record(result);
            persist();
        }
        catch (e) {
            cache.set(s, { data: null, fetchedAt: Date.now(), loading: false, error: e?.message ?? 'failed' });
        }
    }
    function setSymbol(sym) {
        currentSymbol.value = sym.toUpperCase().trim();
    }
    function clearSymbol() {
        currentSymbol.value = '';
    }
    return {
        /** Current active symbol */
        symbol: computed(() => currentSymbol.value),
        /** DeepAnalysis for current symbol (null if not loaded) */
        data,
        loading,
        error,
        /** List of previously analyzed symbols with summary info */
        recentSymbols,
        /** Load (or serve from cache) a symbol's analysis */
        load,
        /** Switch active symbol without fetching (for cache hits) */
        setSymbol,
        clearSymbol
    };
}
