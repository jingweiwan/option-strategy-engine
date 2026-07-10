import { ref, watch, computed } from 'vue';
const STORAGE_KEY = 'ose-positions';
function load() {
    if (typeof localStorage === 'undefined')
        return [];
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw)
            return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    }
    catch {
        return [];
    }
}
const positions = ref(load());
watch(positions, (val) => {
    if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(val));
    }
}, { deep: true });
function uid() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
export function usePositions() {
    function add(p) {
        const full = {
            ...p,
            id: uid(),
            openedAt: Date.now()
        };
        positions.value = [full, ...positions.value];
        return full;
    }
    function remove(id) {
        positions.value = positions.value.filter((p) => p.id !== id);
    }
    function update(id, patch) {
        positions.value = positions.value.map((p) => (p.id === id ? { ...p, ...patch } : p));
    }
    /** Per-position open cost in dollars (×100 ×contracts). Negative = credit received. */
    function openCost(p) {
        return -p.netPremium * 100 * p.contracts;
    }
    /** Per-position mark-to-market P&L in dollars.
     *  P&L = opening cash flow − closing cash flow.
     *  netPremium uses CREDIT>0 convention; closing means reversing the position,
     *  so closing cash flow = −markPrem. Thus P&L = netPremium − markPrem.
     *  (Credit seller profits when markPrem shrinks toward 0.)
     */
    function pnl(p) {
        const markPrem = p.lastMarkPremium ?? p.netPremium;
        return (p.netPremium - markPrem) * 100 * p.contracts;
    }
    /** Unique uppercase symbols with open positions. */
    const heldSymbols = computed(() => [...new Set(positions.value.map((p) => p.symbol.toUpperCase()))]);
    const aggregate = computed(() => {
        let totalPnl = 0;
        let totalCost = 0;
        let netDelta = 0;
        let netGamma = 0;
        let netTheta = 0;
        let netVega = 0;
        for (const p of positions.value) {
            totalPnl += pnl(p);
            totalCost += Math.abs(openCost(p));
            netDelta += p.netGreeks.delta * p.contracts;
            netGamma += p.netGreeks.gamma * p.contracts;
            netTheta += p.netGreeks.theta * p.contracts;
            netVega += p.netGreeks.vega * p.contracts;
        }
        return { totalPnl, totalCost, netDelta, netGamma, netTheta, netVega };
    });
    return {
        positions,
        heldSymbols,
        aggregate,
        add,
        remove,
        update,
        openCost,
        pnl
    };
}
