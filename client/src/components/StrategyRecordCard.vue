<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { fetchRhStrategyPnl } from '@/api/client'
import type { RhStrategyPnl } from '@/types'

const data = ref<RhStrategyPnl | null>(null)
const loading = ref(true)

onMounted(async () => {
  try {
    data.value = await fetchRhStrategyPnl()
  } catch { /* card hides itself */ }
  finally { loading.value = false }
})

const usd = (n: number) => (n >= 0 ? '+' : '−') + Math.abs(Math.round(n)).toLocaleString('en-US')
const cls = (n: number) => (n >= 0 ? 'gain' : 'loss')
const monthLabel = (m: string) => m.slice(5) + '月'

/** UNH-style concentration: top single name as % of the wheel's true P&L. */
const concentrationPct = computed(() => {
  const c = data.value?.concentration
  return c ? Math.round(c.shareOfWheelTrue * 100) : null
})
</script>

<template>
  <section v-if="data" class="src-card">
    <div class="eyebrow">实盘战绩 · 按策略拆解(RH 真实成交 {{ data.windowFrom.slice(5) }} → {{ data.windowTo.slice(5) }})</div>

    <table class="src-table mono">
      <thead>
        <tr>
          <th class="src-name">策略</th>
          <th v-for="m in data.months" :key="m">{{ monthLabel(m) }}</th>
          <th>合计</th>
          <th class="dim">单数</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="c in data.classes" :key="c.id">
          <td class="src-name">{{ c.name }}</td>
          <td v-for="m in data.months" :key="m" :class="c.monthly[m] ? cls(c.monthly[m]) : 'dim'">
            {{ c.monthly[m] ? usd(c.monthly[m]) : '·' }}
          </td>
          <td :class="cls(c.total)"><b>{{ usd(c.total) }}</b></td>
          <td class="dim">{{ c.orders }}</td>
        </tr>
      </tbody>
    </table>

    <!-- 轮子的真相:期权腿 + 被行权持股 -->
    <div class="src-wheel">
      <div class="src-wheel-line">
        <span class="dim">轮子真实盈亏 = 期权腿 {{ usd(data.classes.find(c => c.id === 'wheel')?.total ?? 0) }}
          + 被行权持股平仓 {{ usd(data.wheelStockTotal) }} =</span>
        <b class="mono" :class="cls(data.wheelTrueTotal)">{{ usd(data.wheelTrueTotal) }}</b>
      </div>
      <div class="src-wheel-legs mono">
        <span v-for="l in data.wheelStockLegs" :key="l.sym" :class="cls(l.pnl)">{{ l.sym }} {{ usd(l.pnl) }}</span>
      </div>
      <div v-if="concentrationPct != null && concentrationPct > 60" class="src-warn">
        ⚠ 单名集中:{{ data.concentration.topSym }} 一只票占轮子真实盈亏 {{ concentrationPct }}%
        —— 剥掉它轮子是{{ data.wheelTrueTotal - data.concentration.topPnl >= 0 ? '微利' : '亏的' }}。这是选股红利,不是策略 edge,别被一把大赢骗。
      </div>
    </div>

    <div class="src-notes dim">
      <div v-for="(n, i) in data.notes" :key="i">· {{ n }}</div>
      <div>· 数据来自 RH 成交记录,在 Claude 里说"刷新策略战绩"更新</div>
    </div>
  </section>
</template>

<style scoped>
.gain { color: var(--gain); }
.loss { color: var(--loss); }
.dim { color: var(--ink-3); }

.src-card { border: 1px solid var(--rule); border-radius: 4px; padding: 20px 24px; margin-bottom: 24px; }
.src-card .eyebrow { margin-bottom: 16px; }

.src-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.src-table th {
  text-align: right; font-weight: 400; color: var(--ink-3); font-size: 11px;
  letter-spacing: 0.06em; padding: 4px 10px; border-bottom: 1px solid var(--rule);
}
.src-table td { text-align: right; padding: 7px 10px; border-bottom: 1px solid var(--rule-hair, var(--rule)); }
.src-table .src-name { text-align: left; color: var(--ink); }
.src-table tbody tr:last-child td { border-bottom: none; }

.src-wheel { margin-top: 14px; padding: 12px 14px; background: var(--paper-3); border-radius: 4px; }
.src-wheel-line { font-size: 13px; color: var(--ink); }
.src-wheel-legs { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 8px; font-size: 12px; }
.src-warn { margin-top: 10px; font-size: 12.5px; line-height: 1.5; color: var(--loss); }

.src-notes { margin-top: 12px; font-size: 11.5px; line-height: 1.6; }
</style>
