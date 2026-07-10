<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { fetchRhPositions } from '@/api/client'
import type { RhPositionsView, RhStructure } from '@/types'

const data = ref<RhPositionsView | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const showSmallEq = ref(false)

onMounted(async () => {
  try {
    data.value = await fetchRhPositions()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
})

const totalUnrealized = computed(() =>
  data.value ? data.value.optionsUnrealized + data.value.equityUnrealized : 0
)

type Bucket = { id: string; title: string; structures: RhStructure[]; subtotal: number }

/** Expiration buckets: this-week / month / further / LEAPS(merged by symbol). */
const buckets = computed<Bucket[]>(() => {
  if (!data.value) return []
  const s = data.value.structures
  // Long-dated pure-long stacks read as "LEAPS" regardless of exact DTE;
  // spreads/credit structures stay in time buckets where management applies.
  const isLeaps = (x: RhStructure) => x.kind === 'long_combo' && x.dte > 90
  const timed = s.filter((x) => !isLeaps(x))
  const inRange = (lo: number, hi: number) => timed.filter((x) => x.dte >= lo && x.dte <= hi)
  const sub = (xs: RhStructure[]) => xs.reduce((a, b) => a + (b.unrealized ?? 0), 0)

  const week = inRange(0, 7)
  const month = inRange(8, 30)
  const far = inRange(31, 100000)

  // LEAPS: merge same-symbol structures into one display row
  const leapsRaw = s.filter(isLeaps)
  const bySym = new Map<string, RhStructure[]>()
  for (const x of leapsRaw) {
    const arr = bySym.get(x.sym) ?? []
    arr.push(x)
    bySym.set(x.sym, arr)
  }
  const leaps: RhStructure[] = [...bySym.entries()].map(([sym, xs]) => {
    if (xs.length === 1) return xs[0]
    const sorted = [...xs].sort((a, b) => Math.min(...a.legs.map((l) => l.strike)) - Math.min(...b.legs.map((l) => l.strike)))
    // "买 Call 90" + "买 Call 150" → "买 Call 90 + 150"
    const prefix = sorted[0].label.match(/^买 (Call|Put) /)?.[0] ?? ''
    const parts = sorted.map((x) => x.label.replace(/^买 (Call|Put) /, ''))
    const un = sorted.every((x) => x.unrealized != null) ? sorted.reduce((a, b) => a + b.unrealized!, 0) : null
    return {
      ...sorted[0], sym,
      label: prefix ? prefix + parts.join(' + ') : sorted.map((x) => x.label).join(' + '),
      legs: sorted.flatMap((x) => x.legs),
      netCost: sorted.reduce((a, b) => a + b.netCost, 0),
      unrealized: un,
      expiration: sorted.map((x) => x.expiration).join(' / '),
      alerts: []
    }
  })

  const minDte = week.length ? Math.min(...week.map((x) => x.dte)) : null
  const out: Bucket[] = []
  if (week.length) out.push({ id: 'week', title: `本周到期 · ${minDte} 天`, structures: week, subtotal: sub(week) })
  if (month.length) out.push({ id: 'month', title: '一个月内', structures: month, subtotal: sub(month) })
  if (far.length) out.push({ id: 'far', title: '更远', structures: far, subtotal: sub(far) })
  if (leaps.length) out.push({ id: 'leaps', title: `长期 LEAPS · ${leaps.length} 只标的`, structures: leaps, subtotal: sub(leaps) })
  return out
})

const BIG_EQ = 300
const bigEquities = computed(() =>
  data.value ? data.value.equities.filter((e) => Math.abs(e.unrealized ?? 0) >= BIG_EQ).sort((a, b) => Math.abs(b.unrealized ?? 0) - Math.abs(a.unrealized ?? 0)) : []
)
const smallEquities = computed(() =>
  data.value ? data.value.equities.filter((e) => Math.abs(e.unrealized ?? 0) < BIG_EQ) : []
)
const smallEqTotal = computed(() => smallEquities.value.reduce((a, b) => a + (b.unrealized ?? 0), 0))

const usd = (n: number) => (n >= 0 ? '+$' : '−$') + Math.abs(Math.round(n)).toLocaleString('en-US')
const cls = (n: number | null | undefined) => (n == null ? 'dim' : n >= 0 ? 'gain' : 'loss')
const dteBadge = (x: RhStructure) =>
  x.kind === 'long_combo' && x.dte > 90
    ? x.expiration.split(' / ').map((e) => e.slice(2, 7).replace('-', '–')).join(' / ')
    : `${x.dte}d`
</script>

<template>
  <section class="rhb" v-if="loading || error || data">
    <div class="rhb-head">
      <div class="rhb-title mono">RH · 真实持仓</div>
      <div class="rhb-meta mono" v-if="data">
        <span :class="{ loss: (data.ageHours ?? 0) > 24 }">
          数据 {{ Math.round(data.ageHours ?? 0) }}h 前
          <template v-if="(data.ageHours ?? 0) > 24"> · 已过期,在 Claude 里说"刷新持仓"</template>
        </span>
      </div>
    </div>

    <div v-if="loading" class="dim mono">拉取真实持仓…</div>
    <div v-else-if="error" class="dim mono">RH 持仓不可用:{{ error }}</div>
    <template v-else-if="data">
      <!-- 汇总行 -->
      <div class="rhb-sum">
        <span class="rhb-sum-big" :class="cls(totalUnrealized)">{{ usd(totalUnrealized) }}</span>
        <span class="rhb-sum-label">未实现</span>
        <span class="rhb-sum-sep">·</span>
        <span>期权 <b class="mono" :class="cls(data.optionsUnrealized)">{{ usd(data.optionsUnrealized) }}</b></span>
        <span>股票 <b class="mono" :class="cls(data.equityUnrealized)">{{ usd(data.equityUnrealized) }}</b></span>
        <template v-if="data.realized">
          <span class="rhb-sum-sep">·</span>
          <span>近3月已实现 <b class="mono" :class="cls(data.realized.last3m)">{{ usd(data.realized.last3m) }}</b></span>
          <span class="rhb-sum-sep">·</span>
          <span>账户 <b class="mono">${{ Math.round(data.account.totalValue).toLocaleString() }}</b></span>
          <span>全历史 <b class="mono" :class="cls(data.realized.totalAll)">{{ (data.realized.rateAll * 100).toFixed(1) }}%</b></span>
        </template>
      </div>

      <!-- 到期分桶 -->
      <div v-for="b in buckets" :key="b.id" class="rhb-bucket">
        <div class="rhb-bucket-head">
          <span class="rhb-bucket-title mono">{{ b.title }}</span>
          <span class="mono dim">{{ b.structures.length }} 个结构 · <b :class="cls(b.subtotal)">{{ usd(b.subtotal) }}</b></span>
        </div>
        <div v-for="(x, i) in b.structures" :key="i" class="rhb-row">
          <span class="rhb-dte mono" :class="{ hot: x.dte <= 21 && x.credit && x.dte <= 365 }">{{ dteBadge(x) }}</span>
          <span class="rhb-sym serif">{{ x.sym }}</span>
          <span class="rhb-desc mono">
            {{ x.label }}
            <span v-for="(a, j) in x.alerts" :key="j" class="rhb-alert" :class="a.level">{{ a.text }}</span>
          </span>
          <span class="rhb-pnl mono" :class="cls(x.unrealized)">{{ x.unrealized != null ? usd(x.unrealized) : '—' }}</span>
        </div>
      </div>

      <!-- 股票持仓 -->
      <div class="rhb-bucket">
        <div class="rhb-bucket-head">
          <span class="rhb-bucket-title mono">股票持仓 · {{ data.equities.length }} 只</span>
          <span class="mono dim">合计 <b :class="cls(data.equityUnrealized)">{{ usd(data.equityUnrealized) }}</b></span>
        </div>
        <div class="rhb-eq-grid">
          <div v-for="e in bigEquities" :key="e.sym" class="rhb-eq-row mono">
            <span class="rhb-eq-sym">{{ e.sym }}</span>
            <span class="dim">{{ e.qty }} @ ${{ e.avgCost.toFixed(2) }}</span>
            <span :class="cls(e.unrealized)">{{ e.unrealized != null ? usd(e.unrealized) : '—' }}</span>
          </div>
        </div>
        <div v-if="smallEquities.length" class="rhb-eq-small mono dim" @click="showSmallEq = !showSmallEq">
          其他 {{ smallEquities.length }} 只(|盈亏| &lt; ${{ BIG_EQ }}),合计 <b :class="cls(smallEqTotal)">{{ usd(smallEqTotal) }}</b> · {{ showSmallEq ? '收起' : '展开' }}
        </div>
        <div v-if="showSmallEq" class="rhb-eq-grid" style="margin-top: 8px">
          <div v-for="e in smallEquities" :key="e.sym" class="rhb-eq-row mono">
            <span class="rhb-eq-sym">{{ e.sym }}</span>
            <span class="dim">{{ e.qty }} @ ${{ e.avgCost.toFixed(2) }}</span>
            <span :class="cls(e.unrealized)">{{ e.unrealized != null ? usd(e.unrealized) : '—' }}</span>
          </div>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.rhb { margin: 0 0 34px; }
.gain { color: var(--gain); }
.loss { color: var(--loss); }
.dim { color: var(--ink-3); }

.rhb-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px; }
.rhb-title { font-size: 11px; letter-spacing: 0.14em; color: var(--ink-3); }
.rhb-meta { font-size: 12px; color: var(--ink-3); }

.rhb-sum {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px 14px;
  font-size: 13.5px; color: var(--ink-2); margin-bottom: 22px;
}
.rhb-sum-big { font-size: 34px; font-weight: 500; line-height: 1; }
.rhb-sum-label { color: var(--ink-2); }
.rhb-sum-sep { color: var(--ink-4, var(--ink-3)); }
.rhb-sum b { font-weight: 500; }

.rhb-bucket { border-top: 1px solid var(--rule); padding: 14px 0 10px; }
.rhb-bucket-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
.rhb-bucket-title { font-size: 11px; letter-spacing: 0.12em; color: var(--ink-3); }
.rhb-bucket-head b { font-weight: 500; }

.rhb-row {
  display: grid; grid-template-columns: 64px 76px 1fr auto;
  align-items: baseline; gap: 12px; padding: 9px 0;
  border-bottom: 1px dashed var(--rule-hair, var(--rule));
}
.rhb-row:last-child { border-bottom: none; }
.rhb-dte { font-size: 11.5px; color: var(--ink-3); }
.rhb-dte.hot { color: var(--warn, var(--accent-2, var(--loss))); font-weight: 700; }
.rhb-sym { font-size: 15px; font-weight: 500; color: var(--ink); }
.rhb-desc { font-size: 12.5px; color: var(--ink-2); min-width: 0; }
.rhb-alert { display: inline-block; margin-left: 10px; font-size: 11.5px; }
.rhb-alert.warn { color: var(--loss); }
.rhb-alert.good { color: var(--gain); }
.rhb-alert.info { color: var(--warn, var(--accent-2, var(--ink-2))); }
.rhb-pnl { font-size: 13.5px; font-weight: 500; white-space: nowrap; }

.rhb-eq-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 2px 26px; }
.rhb-eq-row { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; padding: 4px 0; border-bottom: 1px dashed var(--rule-hair, var(--rule)); }
.rhb-eq-sym { color: var(--ink); min-width: 48px; font-weight: 500; }
.rhb-eq-small { font-size: 12px; margin-top: 10px; cursor: pointer; user-select: none; }
.rhb-eq-small b { font-weight: 500; }
</style>
