<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { usePositions, type Position } from '@/composables/usePositions'
import RhBook from '@/components/RhBook.vue'
import { useThesisDrift } from '@/composables/useThesisDrift'
import { fetchTicker } from '@/api/client'
import type { StrategyType } from '@/types'
import { STRAT_CN } from '@/utils/constants'

const router = useRouter()
const { positions, heldSymbols, aggregate, remove, update, openCost, pnl } = usePositions()
const { driftAlerts } = useThesisDrift()

/** Drift alerts only for symbols we actually hold */
const heldDriftAlerts = computed(() =>
  driftAlerts.value.filter((a) => heldSymbols.value.includes(a.symbol))
)

function goDeep(sym: string) {
  router.push({ path: '/deep', query: { symbol: sym } })
}

function fmt(n: number, d = 2) {
  if (!Number.isFinite(n)) return '∞'
  return n.toFixed(d)
}
function fmtSigned(n: number, d = 2) {
  if (!Number.isFinite(n)) return n > 0 ? '∞' : '−∞'
  return (n >= 0 ? '+' : '') + n.toFixed(d)
}
function dollar(n: number, d = 0) {
  return (n >= 0 ? '+$' : '−$') + Math.abs(n).toFixed(d)
}
function dteFor(exp: string) {
  const ms = new Date(exp).getTime() - Date.now()
  return Math.max(0, Math.round(ms / 86400000))
}
function timeAgo(ts: number) {
  const d = Math.round((Date.now() - ts) / 86400000)
  if (d === 0) return '今日开仓'
  if (d === 1) return '昨日开仓'
  return `${d} 天前开仓`
}

const refreshing = ref(false)
const refreshError = ref<string | null>(null)

async function refreshMarks() {
  if (positions.value.length === 0) return
  refreshing.value = true
  refreshError.value = null
  try {
    // Group positions by symbol+expiration to minimize API calls
    const groups = new Map<string, Position[]>()
    for (const p of positions.value) {
      const key = `${p.symbol}|${p.expiration}`
      const list = groups.get(key) ?? []
      list.push(p)
      groups.set(key, list)
    }

    for (const [key, list] of groups) {
      const [symbol, expiration] = key.split('|')
      try {
        const t = await fetchTicker(symbol, expiration)
        for (const p of list) {
          // Re-mark each leg from chain, recompute net premium
          let markPrem = 0
          let allMatched = true
          for (const leg of p.legs) {
            const match = t.chain.find(
              (c) =>
                c.optionType === leg.type &&
                c.strike === leg.strike &&
                c.expiration === expiration
            )
            if (!match) {
              allMatched = false
              break
            }
            const sign = leg.action === 'buy' ? -1 : 1
            markPrem += sign * match.mid * leg.quantity
          }
          if (allMatched) {
            update(p.id, {
              lastMarkPremium: markPrem,
              lastMarkAt: Date.now()
            })
          }
        }
      } catch (e: any) {
        refreshError.value = `${symbol} ${expiration}: ${e?.message ?? 'failed'}`
      }
    }
  } finally {
    refreshing.value = false
  }
}

function viewDetail(p: Position) {
  router.push({
    path: '/strategy',
    query: { sym: p.symbol, exp: p.expiration, id: p.strategy }
  })
}

function clearAll() {
  if (!confirm('确定清空所有持仓？')) return
  for (const p of [...positions.value]) remove(p.id)
}
</script>

<template>
  <div class="page">
    <RhBook />

    <div class="page-head">
      <div>
        <div class="eyebrow" style="margin-bottom: 14px">组合 · 在仓持仓</div>
        <div class="h-title serif">
          <template v-if="positions.length === 0">
            还没有 <em style="font-style: italic; color: var(--accent)">持仓</em>。
          </template>
          <template v-else>
            今天你
            <em
              :style="{
                fontStyle: 'italic',
                color: aggregate.totalPnl >= 0 ? 'var(--gain)' : 'var(--loss)'
              }"
            >
              {{ aggregate.totalPnl >= 0 ? '领先' : '落后' }}
            </em>
            <span class="tnum">${{ fmt(Math.abs(aggregate.totalPnl), 0) }}</span>。
          </template>
        </div>
        <div class="h-deck">
          <template v-if="positions.length === 0">
            从「策略详情」页底部点击"+ 加入持仓监控"，将策略保存到组合追踪。当前页面仅作本地存储，不会真实下单。
          </template>
          <template v-else>
            引擎正在监控 {{ positions.length }} 个开仓结构。下面给出聚合 Greeks、各仓位状态。点击"刷新行情"按当前 chain mid 重新计算 P&amp;L。
          </template>
        </div>
      </div>
      <div class="h-meta" v-if="positions.length">
        <div>{{ positions.length }} 个在仓</div>
        <div style="margin-top: 6px">
          已用资金 <b>${{ fmt(aggregate.totalCost, 0) }}</b>
        </div>
        <div>
          <button
            class="btn ghost tiny"
            style="margin-top: 8px"
            @click="refreshMarks"
            :disabled="refreshing"
          >
            {{ refreshing ? '刷新中…' : '↻ 刷新行情' }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="refreshError" class="error mono">⚠ 部分刷新失败 · {{ refreshError }}</div>

    <!-- Thesis drift alerts for held positions -->
    <div v-if="heldDriftAlerts.length > 0" class="drift-banner">
      <div class="drift-banner-head">
        <span class="eyebrow">THESIS DRIFT · 持仓标的评分变动</span>
      </div>
      <div class="drift-alerts">
        <div
          v-for="alert in heldDriftAlerts"
          :key="alert.symbol"
          class="drift-alert"
          :class="{ neg: alert.totalDelta < 0 }"
          @click="goDeep(alert.symbol)"
        >
          <span class="drift-alert-sym mono">{{ alert.symbol }}</span>
          <span
            class="drift-alert-delta mono"
            :style="{ color: alert.totalDelta > 0 ? 'var(--gain)' : 'var(--loss)' }"
          >
            {{ alert.totalDelta > 0 ? '+' : '' }}{{ alert.totalDelta }} pts
          </span>
          <span class="drift-alert-vs mono">vs {{ alert.previousDate }}</span>
          <span class="drift-alert-cta">查看 →</span>
        </div>
      </div>
    </div>

    <!-- Aggregate stats -->
    <div v-if="positions.length" class="agg-grid">
      <div class="agg-cell">
        <div class="l">未平仓盈亏</div>
        <div :class="['v', 'mono', aggregate.totalPnl >= 0 ? 'up' : 'dn']">
          {{ dollar(aggregate.totalPnl, 0) }}
        </div>
        <div class="sub">
          {{ aggregate.totalCost > 0
            ? ((aggregate.totalPnl / aggregate.totalCost) * 100).toFixed(1)
            : '0.0' }}% vs 成本
        </div>
      </div>
      <div class="agg-cell">
        <div class="l">资金占用</div>
        <div class="v mono">${{ fmt(aggregate.totalCost, 0) }}</div>
        <div class="sub">覆盖 {{ positions.length }} 个仓位</div>
      </div>
      <div class="agg-cell">
        <div class="l">净 Delta</div>
        <div class="v mono">{{ fmtSigned(aggregate.netDelta * 100, 0) }}</div>
        <div class="sub">等效股数</div>
      </div>
      <div class="agg-cell">
        <div class="l">净 Theta</div>
        <div :class="['v', 'mono', aggregate.netTheta >= 0 ? 'up' : 'dn']">
          {{ fmtSigned(aggregate.netTheta * 100, 2) }}
        </div>
        <div class="sub">$ / 天</div>
      </div>
      <div class="agg-cell">
        <div class="l">净 Vega</div>
        <div class="v mono">{{ fmtSigned(aggregate.netVega * 100, 2) }}</div>
        <div class="sub">$ / 1% IV</div>
      </div>
    </div>

    <!-- Positions list -->
    <section v-if="positions.length" class="positions">
      <div class="positions-head">
        <span class="eyebrow">持仓明细</span>
        <button class="btn ghost tiny" @click="clearAll">清空全部</button>
      </div>

      <div class="position-row" v-for="(p, i) in positions" :key="p.id">
        <div class="row-grid">
          <div class="row-no mono">{{ String(i + 1).padStart(2, '0') }}</div>

          <div class="row-title">
            <div class="title-line">
              <span class="serif sym">{{ p.symbol }}</span>
              <span class="serif strat">{{ STRAT_CN[p.strategy] }}</span>
            </div>
            <div class="row-sub mono">
              到期 {{ p.expiration }} · {{ dteFor(p.expiration) }}d · ×{{ p.contracts }} ·
              {{ timeAgo(p.openedAt) }}
            </div>
          </div>

          <div class="mini">
            <div class="mini-l mono">盈亏</div>
            <div :class="['mini-v', 'mono', 'tnum', pnl(p) >= 0 ? 'up' : 'dn']">
              {{ dollar(pnl(p), 0) }}
            </div>
            <div class="mini-sub mono">
              <template v-if="p.lastMarkAt">已刷新</template>
              <template v-else>未刷新</template>
            </div>
          </div>

          <div class="mini">
            <div class="mini-l mono">成本</div>
            <div class="mini-v mono tnum">
              {{ openCost(p) >= 0 ? '−$' : '+$' }}{{ fmt(Math.abs(openCost(p)), 0) }}
            </div>
            <div class="mini-sub mono">
              {{ p.netPremium > 0 ? 'credit' : 'debit' }}
            </div>
          </div>

          <div class="mini">
            <div class="mini-l mono">Δ / Θ</div>
            <div class="mini-v mono tnum">{{ fmtSigned(p.netGreeks.delta * p.contracts * 100, 0) }}</div>
            <div class="mini-sub mono">{{ fmtSigned(p.netGreeks.theta * p.contracts * 100, 2) }}/d</div>
          </div>

          <div class="row-actions">
            <button class="btn ghost tiny" @click="viewDetail(p)">详情 →</button>
            <button class="btn tiny" @click="remove(p.id)">移除</button>
          </div>
        </div>
      </div>
    </section>

    <div v-else class="empty">
      <div class="imgslot" style="height: 200px; max-width: 600px">
        点击下方按钮去策略推荐页 · 把策略加入监控后会出现在这里
      </div>
      <div style="margin-top: 14px">
        <button class="btn primary" @click="router.push('/recommend')">→ 去策略推荐</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.error {
  border: 1px solid var(--loss);
  color: var(--loss);
  background: var(--loss-wash);
  padding: 10px 14px;
  font-size: 12px;
  margin-bottom: 16px;
}

/* Aggregate KPI strip */
.agg-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  border: 1px solid var(--rule);
  margin-bottom: 32px;
}
.agg-cell {
  padding: 18px 20px;
  border-right: 1px solid var(--rule);
}
.agg-cell:last-child { border-right: 0; }
.agg-cell .l {
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-3);
  margin-bottom: 8px;
}
.agg-cell .v {
  font-size: 26px;
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1;
}
.agg-cell .v.up { color: var(--gain); }
.agg-cell .v.dn { color: var(--loss); }
.agg-cell .sub {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--ink-3);
  margin-top: 6px;
}

/* Position list */
.positions-head {
  display: flex;
  justify-content: space-between;
  align-items: end;
  margin-bottom: 12px;
  border-top: 1px solid var(--rule);
  padding-top: 18px;
}
.position-row {
  border-bottom: 1px solid var(--rule);
}
.row-grid {
  display: grid;
  grid-template-columns: 30px 1fr 110px 110px 110px 160px;
  align-items: center;
  gap: 18px;
  padding: 18px 4px;
}
.row-no {
  font-size: 10px;
  color: var(--ink-4);
}
.row-title { }
.title-line {
  display: flex;
  align-items: baseline;
  gap: 12px;
}
.title-line .sym {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.title-line .strat {
  color: var(--ink-2);
  font-size: 14px;
}
.row-sub {
  font-size: 10.5px;
  color: var(--ink-3);
  margin-top: 4px;
}

.mini {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.mini-l {
  font-size: 9.5px;
  letter-spacing: 0.1em;
  color: var(--ink-3);
  text-transform: uppercase;
}
.mini-v {
  font-size: 14px;
  color: var(--ink);
  font-weight: 500;
}
.mini-v.up { color: var(--gain); }
.mini-v.dn { color: var(--loss); }
.mini-sub {
  font-size: 10px;
  color: var(--ink-3);
}

.row-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.empty {
  margin-top: 32px;
  display: flex;
  flex-direction: column;
  align-items: center;
}

@media (max-width: 1100px) {
  .agg-grid { grid-template-columns: repeat(2, 1fr); }
  .row-grid { grid-template-columns: 1fr; }
}

/* --- Thesis drift alerts --- */
.drift-banner {
  margin: 16px 0 20px;
  padding: 14px 18px;
  border-radius: 10px;
  border: 1px solid var(--rule);
  background: var(--paper);
}
.drift-banner-head { margin-bottom: 10px; }
.drift-alerts { display: flex; gap: 10px; flex-wrap: wrap; }
.drift-alert {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid var(--rule);
  cursor: pointer;
  transition: border-color 0.15s;
}
.drift-alert:hover { border-color: var(--accent); }
.drift-alert.neg { border-color: var(--loss); background: var(--loss-wash, rgba(239,68,68,0.04)); }
.drift-alert-sym { font-size: 13px; font-weight: 800; color: var(--ink); }
.drift-alert-delta { font-size: 14px; font-weight: 800; }
.drift-alert-vs { font-size: 10px; color: var(--ink-3); }
.drift-alert-cta { font-size: 11px; color: var(--accent); font-weight: 600; margin-left: 4px; }
</style>
