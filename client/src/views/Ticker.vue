<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { fetchTicker } from '@/api/client'
import SkewChart from '@/components/SkewChart.vue'
import type { TickerResponse, OptionContract } from '@/types'

const route = useRoute()
const router = useRouter()

const symbol = computed(() => ((route.query.sym as string) || 'AAPL').toUpperCase())
const queryExp = computed(() => route.query.exp as string | undefined)

const data = ref<TickerResponse | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const symbolInput = ref(symbol.value)
const expInput = ref('')

async function load(sym: string, exp?: string) {
  if (!sym) return
  loading.value = true
  error.value = null
  try {
    const out = await fetchTicker(sym, exp)
    data.value = out
    expInput.value = out.expiration
    symbolInput.value = out.quote.symbol
  } catch (e: any) {
    error.value = e?.message ?? 'failed to load'
    data.value = null
  } finally {
    loading.value = false
  }
}

onMounted(() => load(symbol.value, queryExp.value))

watch(symbol, (s) => load(s, queryExp.value))

function changeExpiration(exp: string) {
  router.push({ path: '/ticker', query: { sym: symbol.value, exp } })
}

function applySymbol() {
  const sym = symbolInput.value.trim().toUpperCase()
  if (!sym) return
  router.push({ path: '/ticker', query: { sym } })
}

// Chain table: pivot calls + puts side-by-side around shared strikes,
// only show ATM ±20% range to keep readable.
const pivotedRows = computed(() => {
  if (!data.value) return []
  const spot = data.value.quote.last
  const minK = spot * 0.85
  const maxK = spot * 1.15
  const callMap = new Map<number, OptionContract>()
  const putMap = new Map<number, OptionContract>()
  for (const c of data.value.chain) {
    if (c.strike < minK || c.strike > maxK) continue
    if (c.optionType === 'call') callMap.set(c.strike, c)
    else putMap.set(c.strike, c)
  }
  const strikes = Array.from(new Set([...callMap.keys(), ...putMap.keys()])).sort(
    (a, b) => a - b
  )
  return strikes.map((k) => ({
    strike: k,
    call: callMap.get(k),
    put: putMap.get(k),
    isAtm: Math.abs(k - spot) < spot * 0.02
  }))
})

function fmt(n: number | undefined, d = 2) {
  if (n == null || !Number.isFinite(n)) return '—'
  return n.toFixed(d)
}
function fmtSigned(n: number | undefined, d = 2) {
  if (n == null || !Number.isFinite(n)) return '—'
  return (n >= 0 ? '+' : '') + n.toFixed(d)
}

function goRecommend() {
  router.push({ path: '/recommend', query: { sym: symbol.value } })
}

const dteFor = (exp: string) => {
  const ms = new Date(exp).getTime() - Date.now()
  return Math.max(0, Math.round(ms / 86400000))
}
</script>

<template>
  <div class="page">
    <button class="back-link mono" @click="router.push('/')">← 返回总览</button>

    <!-- Symbol search bar -->
    <div class="symbol-bar">
      <input
        class="mono symbol-input"
        v-model="symbolInput"
        @keyup.enter="applySymbol"
        placeholder="输入 ticker 例如 AAPL"
      />
      <button class="btn ghost tiny" @click="applySymbol">查询</button>
    </div>

    <div v-if="loading && !data" class="loading mono">加载中…</div>
    <div v-else-if="error" class="error">⚠ {{ error }}</div>

    <template v-else-if="data">
      <!-- Hero -->
      <div class="hero">
        <div>
          <div class="eyebrow" style="margin-bottom: 10px">{{ data.quote.symbol }} · 标的详情</div>
          <div class="hero-row">
            <span class="serif sym-big">{{ data.quote.symbol }}</span>
            <span class="serif tnum px-big">{{ fmt(data.quote.last) }}</span>
          </div>
          <div class="hero-sub mono">
            <template v-if="data.quote.bid">买 {{ fmt(data.quote.bid) }} · 卖 {{ fmt(data.quote.ask) }} ·</template>
            合约数 <b>{{ data.chain.length }}</b> · 到期日选项 <b>{{ data.expirations.length }}</b>
          </div>
        </div>
        <button class="btn primary" @click="goRecommend">引擎推荐 →</button>
      </div>

      <!-- Expiration selector -->
      <section class="expiration-bar">
        <div class="eyebrow">到期日</div>
        <div class="exp-pills">
          <button
            v-for="e in data.expirations.slice(0, 8)"
            :key="e"
            :class="['exp-pill', { on: e === data.expiration }]"
            @click="changeExpiration(e)"
          >
            <span class="exp-date">{{ e }}</span>
            <span class="exp-dte mono">{{ dteFor(e) }}d</span>
          </button>
        </div>
      </section>

      <!-- Skew chart -->
      <section class="block">
        <div class="block-head">
          <div>
            <div class="eyebrow">波动率倾斜 · {{ data.expiration }}</div>
            <div class="serif block-title">每个 strike 的 IV</div>
          </div>
          <div class="legend mono">
            <span><span class="dot" style="background: var(--gain)"></span>Calls IV</span>
            <span><span class="dot" style="background: var(--loss)"></span>Puts IV</span>
          </div>
        </div>
        <SkewChart :chain="data.chain" :spot="data.quote.last" />
      </section>

      <!-- Option chain -->
      <section class="block">
        <div class="block-head">
          <div>
            <div class="eyebrow">期权链 · {{ data.expiration }}</div>
            <div class="serif block-title">{{ pivotedRows.length }} 个 strike · ±15% 区间</div>
          </div>
        </div>

        <table class="chain-table">
          <thead>
            <tr class="group-head-row">
              <th colspan="5" class="group-call">看涨期权 Calls</th>
              <th class="strike-col">行权价</th>
              <th colspan="5" class="group-put">看跌期权 Puts</th>
            </tr>
            <tr class="col-head-row">
              <th class="rt">Δ</th>
              <th class="rt">IV</th>
              <th class="rt">买价</th>
              <th class="rt">卖价</th>
              <th class="rt">OI</th>
              <th></th>
              <th class="rt">OI</th>
              <th class="rt">买价</th>
              <th class="rt">卖价</th>
              <th class="rt">IV</th>
              <th class="rt">Δ</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in pivotedRows" :key="row.strike" :class="{ atm: row.isAtm }">
              <td class="rt mono tnum" :class="{ itm: row.call && row.strike < data.quote.last }">{{ fmt(row.call?.greeks?.delta, 2) }}</td>
              <td class="rt mono tnum" :class="{ itm: row.call && row.strike < data.quote.last }">{{ fmt(row.call?.iv ? row.call.iv * 100 : undefined, 1) }}</td>
              <td class="rt mono tnum" :class="{ itm: row.call && row.strike < data.quote.last }">{{ fmt(row.call?.bid) }}</td>
              <td class="rt mono tnum" :class="{ itm: row.call && row.strike < data.quote.last }">{{ fmt(row.call?.ask) }}</td>
              <td class="rt mono tnum dim" :class="{ itm: row.call && row.strike < data.quote.last }">{{ row.call?.openInterest ?? '—' }}</td>
              <td class="strike-cell mono tnum">{{ row.strike }}</td>
              <td class="rt mono tnum dim" :class="{ itm: row.put && row.strike > data.quote.last }">{{ row.put?.openInterest ?? '—' }}</td>
              <td class="rt mono tnum" :class="{ itm: row.put && row.strike > data.quote.last }">{{ fmt(row.put?.bid) }}</td>
              <td class="rt mono tnum" :class="{ itm: row.put && row.strike > data.quote.last }">{{ fmt(row.put?.ask) }}</td>
              <td class="rt mono tnum" :class="{ itm: row.put && row.strike > data.quote.last }">{{ fmt(row.put?.iv ? row.put.iv * 100 : undefined, 1) }}</td>
              <td class="rt mono tnum" :class="{ itm: row.put && row.strike > data.quote.last }">{{ fmt(row.put?.greeks?.delta, 2) }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>
  </div>
</template>

<style scoped>
.back-link {
  background: transparent;
  border: 0;
  color: var(--ink-3);
  font-size: 11px;
  padding: 0;
  margin-bottom: 14px;
  cursor: pointer;
}
.back-link:hover { color: var(--ink); }

.symbol-bar {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-bottom: 22px;
}
.symbol-input {
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--rule-soft);
  padding: 4px 0;
  font-size: 14px;
  color: var(--ink);
  width: 160px;
  text-transform: uppercase;
  outline: 0;
}
.symbol-input:focus { border-bottom-color: var(--accent); }

.hero {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 24px;
  align-items: end;
  border-bottom: 1px solid var(--rule);
  padding-bottom: 22px;
}
.hero-row {
  display: flex;
  align-items: baseline;
  gap: 18px;
}
.sym-big {
  font-size: 64px;
  line-height: 0.95;
  font-weight: 600;
  letter-spacing: -0.03em;
}
.px-big {
  font-size: 36px;
  font-weight: 500;
  letter-spacing: -0.02em;
}
.hero-sub {
  margin-top: 10px;
  font-size: 12px;
  color: var(--ink-3);
}
.hero-sub b { color: var(--ink); font-weight: 500; }

.expiration-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 18px 0;
  border-bottom: 1px solid var(--rule);
}
.exp-pills {
  display: flex;
  gap: 0;
  border: 1px solid var(--rule-soft);
  flex-wrap: wrap;
}
.exp-pill {
  background: transparent;
  border: 0;
  border-right: 1px solid var(--rule-soft);
  padding: 6px 12px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-2);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  min-width: 80px;
}
.exp-pill:last-child { border-right: 0; }
.exp-pill:hover { background: var(--paper-2); }
.exp-pill.on {
  background: var(--ink);
  color: var(--paper);
}
.exp-pill .exp-date { font-weight: 500; }
.exp-pill .exp-dte { font-size: 9.5px; color: var(--ink-3); }
.exp-pill.on .exp-dte { color: var(--paper-3); }

.block {
  margin-top: 32px;
}
.block-head {
  display: flex;
  justify-content: space-between;
  align-items: end;
  margin-bottom: 14px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--rule);
}
.block-title {
  font-size: 22px;
  font-weight: 500;
  letter-spacing: -0.01em;
  margin-top: 4px;
}
.legend {
  display: flex;
  gap: 16px;
  font-size: 11px;
  color: var(--ink-3);
}
.legend .dot {
  display: inline-block;
  width: 10px;
  height: 3px;
  margin-right: 6px;
  vertical-align: 2px;
}

/* chain table */
.chain-table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--mono);
  font-size: 11.5px;
}
.chain-table .group-head-row th {
  padding: 8px 10px;
  border-top: 1px solid var(--rule);
  border-bottom: 1px solid var(--rule);
  background: var(--paper-2);
  color: var(--ink-3);
  font-size: 10.5px;
  letter-spacing: 0.1em;
  font-weight: 600;
  text-transform: uppercase;
}
.chain-table .group-head-row .strike-col {
  background: transparent;
  color: var(--accent);
  border-left: 1px solid var(--rule);
  border-right: 1px solid var(--rule);
}
.chain-table .col-head-row {
  border-bottom: 1px solid var(--rule);
}
.chain-table .col-head-row th {
  padding: 6px 10px;
  font-weight: 500;
  color: var(--ink-3);
  font-size: 10px;
}
.chain-table th.rt { text-align: right; }
.chain-table tbody td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--rule-hair);
  color: var(--ink-2);
}
.chain-table tbody td.rt { text-align: right; }
.chain-table tbody td.dim { color: var(--ink-3); }
.chain-table tbody td.strike-cell {
  text-align: center;
  background: var(--paper-2);
  font-weight: 600;
  color: var(--ink);
  border-left: 1px solid var(--rule-hair);
  border-right: 1px solid var(--rule-hair);
}
.chain-table tbody tr.atm td.strike-cell {
  background: var(--accent-2);
  color: var(--accent);
}
.chain-table tbody tr.atm {
  border-bottom: 1px solid var(--accent);
}
.chain-table tbody td.itm {
  color: var(--ink);
  background: rgba(0, 0, 0, 0.02);
}

.loading {
  font-size: 12px;
  color: var(--ink-3);
  padding: 80px 0;
  text-align: center;
}
.error {
  border: 1px solid var(--loss);
  color: var(--loss);
  background: var(--loss-wash);
  padding: 12px 16px;
  font-family: var(--mono);
  font-size: 12px;
}
</style>
