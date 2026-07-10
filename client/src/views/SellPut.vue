<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { fetchSellPutScan } from '@/api/client'
import { useWatchlist } from '@/composables/useWatchlist'
import type { SellPutCandidate, SellPutScanResult } from '@/types'

const { syms } = useWatchlist()

const data = ref<SellPutScanResult | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

// Filters
const minIvr = ref(0)
const minPop = ref(50)
const maxDelta = ref(0.35)
const sortBy = ref<'score' | 'rocAnnualized' | 'pop' | 'ivr' | 'ev'>('score')
const expandedSym = ref<string | null>(null)

const filtered = computed(() => {
  if (!data.value) return []
  return data.value.candidates
    .filter((c) => c.ivr >= minIvr.value)
    .filter((c) => c.pop * 100 >= minPop.value)
    .filter((c) => c.delta <= maxDelta.value)
    .sort((a, b) => {
      if (sortBy.value === 'score') return b.score - a.score
      if (sortBy.value === 'rocAnnualized') return b.rocAnnualized - a.rocAnnualized
      if (sortBy.value === 'pop') return b.pop - a.pop
      if (sortBy.value === 'ivr') return b.ivr - a.ivr
      if (sortBy.value === 'ev') return b.ev - a.ev
      return 0
    })
})

const stats = computed(() => {
  if (!data.value) return null
  const cs = data.value.candidates
  if (cs.length === 0) return null
  const avgIvr = cs.reduce((s, c) => s + c.ivr, 0) / cs.length
  const avgPop = cs.reduce((s, c) => s + c.pop, 0) / cs.length
  const topScore = Math.max(...cs.map((c) => c.score))
  return { total: cs.length, avgIvr: avgIvr.toFixed(0), avgPop: (avgPop * 100).toFixed(0), topScore: topScore.toFixed(2) }
})

function fmtPct(n: number, d = 1) {
  return (n * 100).toFixed(d) + '%'
}
function fmtDollar(n: number) {
  return '$' + n.toFixed(2)
}
function fmtSigned(n: number, d = 2) {
  return (n >= 0 ? '+' : '') + n.toFixed(d)
}

function regimeLabel(r: string) {
  if (r === 'sell') return '卖方'
  if (r === 'buy') return '买方'
  return '中性'
}

function regimeClass(r: string) {
  if (r === 'sell') return 'regime-sell'
  if (r === 'buy') return 'regime-buy'
  return 'regime-mid'
}

function scoreColor(score: number): string {
  if (score >= 0.7) return 'var(--gain)'
  if (score >= 0.4) return 'var(--warn)'
  return 'var(--ink-3)'
}

function toggleExpand(sym: string) {
  expandedSym.value = expandedSym.value === sym ? null : sym
}

async function load() {
  loading.value = true
  error.value = null
  try {
    data.value = await fetchSellPutScan(syms.value)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <!-- Header -->
    <header class="page-header">
      <div>
        <h1 class="serif">Sell Put 扫描器</h1>
        <p class="subtitle">TastyTrade 风格 · 跨标的 × 多到期日 × Delta 梯度</p>
      </div>
      <button class="refresh-btn mono" :disabled="loading" @click="load">
        {{ loading ? '扫描中…' : '刷新' }}
      </button>
    </header>

    <!-- Stats bar -->
    <div v-if="stats" class="stats-bar">
      <div class="stat-item">
        <span class="stat-label mono">候选数</span>
        <span class="stat-value serif tnum">{{ stats.total }}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label mono">Avg IVR</span>
        <span class="stat-value serif tnum">{{ stats.avgIvr }}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label mono">Avg POP</span>
        <span class="stat-value serif tnum">{{ stats.avgPop }}%</span>
      </div>
      <div class="stat-item">
        <span class="stat-label mono">Top Score</span>
        <span class="stat-value serif tnum">{{ stats.topScore }}</span>
      </div>
    </div>

    <!-- Filters -->
    <div class="filters">
      <label class="filter-group">
        <span class="filter-label mono">Min IVR</span>
        <input v-model.number="minIvr" type="range" min="0" max="80" step="5" />
        <span class="filter-val mono tnum">{{ minIvr }}</span>
      </label>
      <label class="filter-group">
        <span class="filter-label mono">Min POP</span>
        <input v-model.number="minPop" type="range" min="40" max="90" step="5" />
        <span class="filter-val mono tnum">{{ minPop }}%</span>
      </label>
      <label class="filter-group">
        <span class="filter-label mono">Max Delta</span>
        <input v-model.number="maxDelta" type="range" min="0.1" max="0.4" step="0.05" />
        <span class="filter-val mono tnum">{{ maxDelta.toFixed(2) }}</span>
      </label>
      <label class="filter-group">
        <span class="filter-label mono">排序</span>
        <select v-model="sortBy" class="mono">
          <option value="score">综合评分</option>
          <option value="rocAnnualized">年化 ROC</option>
          <option value="pop">POP</option>
          <option value="ivr">IVR</option>
          <option value="ev">EV</option>
        </select>
      </label>
    </div>

    <!-- Results table -->
    <div v-if="filtered.length > 0" class="table-wrap">
      <table class="sp-table">
        <thead>
          <tr>
            <th class="mono">标的</th>
            <th class="mono">到期</th>
            <th class="mono r">行权价</th>
            <th class="mono r">权利金</th>
            <th class="mono r">Delta</th>
            <th class="mono r">IVR</th>
            <th class="mono r">IV-RV</th>
            <th class="mono r">POP</th>
            <th class="mono r">年化ROC</th>
            <th class="mono r">EV</th>
            <th class="mono r">评分</th>
            <th class="mono">Regime</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="c in filtered" :key="c.optionSymbol">
            <tr class="candidate-row" @click="toggleExpand(c.optionSymbol)">
              <td>
                <span class="sym serif">{{ c.sym }}</span>
                <span class="spot-price mono tnum">{{ fmtDollar(c.spot) }}</span>
              </td>
              <td class="mono tnum">{{ c.expiration }} <span class="dte-tag">{{ c.dte }}d</span></td>
              <td class="mono tnum r">{{ fmtDollar(c.strike) }}</td>
              <td class="mono tnum r premium-cell">{{ fmtDollar(c.premium) }}</td>
              <td class="mono tnum r">{{ c.delta.toFixed(2) }}</td>
              <td class="mono tnum r" :style="{ color: c.ivr >= 50 ? 'var(--gain)' : 'var(--ink-3)' }">
                {{ c.ivr.toFixed(0) }}
              </td>
              <td class="mono tnum r">
                <template v-if="c.ivRvGap != null">
                  <span :style="{ color: c.ivRvGap > 0 ? 'var(--gain)' : 'var(--loss)' }">
                    {{ fmtSigned(c.ivRvGap, 1) }}pp
                  </span>
                </template>
                <span v-else class="dim">—</span>
              </td>
              <td class="mono tnum r" :style="{ color: c.pop >= 0.7 ? 'var(--gain)' : 'var(--ink-2)' }">
                {{ fmtPct(c.pop, 0) }}
              </td>
              <td class="mono tnum r" :style="{ fontWeight: 600 }">
                {{ fmtPct(c.rocAnnualized, 1) }}
              </td>
              <td class="mono tnum r" :style="{ color: c.ev >= 0 ? 'var(--gain)' : 'var(--loss)' }">
                {{ fmtSigned(c.ev) }}
              </td>
              <td class="mono tnum r">
                <span class="score-pill" :style="{ background: scoreColor(c.score) }">
                  {{ c.score.toFixed(2) }}
                </span>
              </td>
              <td>
                <span class="regime-tag mono" :class="regimeClass(c.regime)">{{ regimeLabel(c.regime) }}</span>
              </td>
            </tr>
            <!-- Expanded detail row -->
            <tr v-if="expandedSym === c.optionSymbol" class="detail-row">
              <td colspan="12">
                <div class="detail-grid">
                  <div class="detail-section">
                    <h4 class="mono">合约详情</h4>
                    <div class="detail-item">
                      <span class="dl mono">合约:</span>
                      <span class="dv mono tnum">{{ c.optionSymbol }}</span>
                    </div>
                    <div class="detail-item">
                      <span class="dl mono">盈亏平衡:</span>
                      <span class="dv mono tnum">{{ fmtDollar(c.breakeven) }}</span>
                    </div>
                    <div class="detail-item">
                      <span class="dl mono">OTM%:</span>
                      <span class="dv mono tnum">{{ c.otmPct.toFixed(1) }}%</span>
                    </div>
                    <div class="detail-item">
                      <span class="dl mono">买入力 (CSP):</span>
                      <span class="dv mono tnum">{{ fmtDollar(c.buyingPower / 100) }}/股</span>
                    </div>
                    <div class="detail-item">
                      <span class="dl mono">Bid-Ask:</span>
                      <span class="dv mono tnum">{{ fmtDollar(c.bidAskSpread) }}</span>
                    </div>
                    <div class="detail-item">
                      <span class="dl mono">OI:</span>
                      <span class="dv mono tnum">{{ c.openInterest.toLocaleString() }}</span>
                    </div>
                  </div>
                  <div class="detail-section">
                    <h4 class="mono">Greeks</h4>
                    <div class="detail-item">
                      <span class="dl mono">Delta:</span>
                      <span class="dv mono tnum">{{ c.greeks.delta.toFixed(3) }}</span>
                    </div>
                    <div class="detail-item">
                      <span class="dl mono">Gamma:</span>
                      <span class="dv mono tnum">{{ c.greeks.gamma.toFixed(4) }}</span>
                    </div>
                    <div class="detail-item">
                      <span class="dl mono">Theta (仓位):</span>
                      <span class="dv mono tnum" :style="{ color: -c.greeks.theta >= 0 ? 'var(--gain)' : 'var(--loss)' }">{{ (-c.greeks.theta).toFixed(3) }}</span>
                    </div>
                    <div class="detail-item">
                      <span class="dl mono">Vega:</span>
                      <span class="dv mono tnum">{{ c.greeks.vega.toFixed(3) }}</span>
                    </div>
                  </div>
                  <div class="detail-section">
                    <h4 class="mono">波动率</h4>
                    <div class="detail-item">
                      <span class="dl mono">Put IV:</span>
                      <span class="dv mono tnum">{{ fmtPct(c.iv) }}</span>
                    </div>
                    <div class="detail-item">
                      <span class="dl mono">ATM IV:</span>
                      <span class="dv mono tnum">{{ fmtPct(c.atmIv) }}</span>
                    </div>
                    <div class="detail-item">
                      <span class="dl mono">RV:</span>
                      <span class="dv mono tnum">{{ c.rv != null ? fmtPct(c.rv) : '—' }}</span>
                    </div>
                  </div>
                  <div class="detail-section">
                    <h4 class="mono">评分拆解</h4>
                    <div class="score-bars">
                      <div v-for="(val, key) in c.scoreBreakdown" :key="key" class="score-bar-row">
                        <span class="sb-label mono">{{ key.replace('Score', '') }}</span>
                        <div class="sb-track">
                          <div class="sb-fill" :style="{ width: (val * 100) + '%' }" />
                        </div>
                        <span class="sb-val mono tnum">{{ val.toFixed(2) }}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <!-- Empty / loading / error states -->
    <div v-else-if="loading" class="loading mono">扫描中…正在分析 {{ syms.length }} 个标的的期权链</div>
    <div v-else-if="error" class="error">{{ error }}</div>
    <div v-else-if="data && filtered.length === 0" class="empty mono">
      没有符合筛选条件的候选。尝试放宽 IVR / POP / Delta 限制。
    </div>

    <!-- Skipped symbols -->
    <div v-if="data?.skipped?.length" class="skipped mono">
      跳过: {{ data.skipped.map((s) => s.sym).join(', ') }}
    </div>

    <!-- Methodology -->
    <details class="methodology">
      <summary class="mono">评分方法 (TastyTrade Style)</summary>
      <div class="meth-content">
        <p><b>IV Rank (20%)</b> — 历史波动率百分位。IVR 越高，期权定价越贵，卖方 edge 越大。</p>
        <p><b>IV-RV Gap (25%)</b> — 隐含波动率与已实现波动率的差值。正值 = 期权溢价 = 卖方核心优势。</p>
        <p><b>POP (20%)</b> — 蒙特卡洛模拟的盈利概率。基于 RV 混合 sigma 模拟。</p>
        <p><b>ROC (15%)</b> — 年化资本回报率 (权利金 / 行权价)。衡量资金效率。</p>
        <p><b>流动性 (10%)</b> — Bid-Ask 价差和 Open Interest。流动性差的合约滑点大。</p>
        <p><b>DTE (10%)</b> — 到期时间。30-45 天是 theta 衰减加速的甜蜜区间。</p>
      </div>
    </details>
  </div>
</template>

<style scoped>
.page {
  padding: 40px;
  max-width: var(--max);
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 24px;
}
.page-header h1 {
  font-size: 28px;
  font-weight: 500;
  letter-spacing: -0.02em;
}
.subtitle {
  font-size: 13px;
  color: var(--ink-3);
  margin-top: 4px;
}
.refresh-btn {
  padding: 8px 20px;
  font-size: 12px;
  border: 1px solid var(--rule-soft);
  background: transparent;
  color: var(--ink);
  cursor: pointer;
  letter-spacing: 0.05em;
}
.refresh-btn:hover { background: var(--paper-2); }
.refresh-btn:disabled { opacity: 0.5; cursor: default; }

/* Stats bar */
.stats-bar {
  display: flex;
  gap: 32px;
  padding: 16px 24px;
  background: var(--paper-2);
  border: 1px solid var(--rule-hair);
  margin-bottom: 20px;
}
.stat-item { display: flex; flex-direction: column; gap: 2px; }
.stat-label { font-size: 10px; color: var(--ink-4); letter-spacing: 0.08em; text-transform: uppercase; }
.stat-value { font-size: 20px; font-weight: 500; }

/* Filters */
.filters {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
  margin-bottom: 24px;
  padding: 12px 16px;
  background: var(--paper-2);
  border: 1px solid var(--rule-hair);
}
.filter-group {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.filter-label {
  font-size: 10px;
  color: var(--ink-3);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  min-width: 60px;
}
.filter-val {
  font-size: 12px;
  color: var(--ink-2);
  min-width: 40px;
  text-align: right;
}
input[type="range"] {
  width: 100px;
  accent-color: var(--accent);
}
select {
  padding: 4px 8px;
  border: 1px solid var(--rule-soft);
  background: var(--paper);
  color: var(--ink);
  font-size: 11px;
}

/* Table */
.table-wrap {
  overflow-x: auto;
}
.sp-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.sp-table th {
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-4);
  padding: 8px 10px;
  border-bottom: 2px solid var(--rule);
  text-align: left;
  white-space: nowrap;
}
.sp-table th.r { text-align: right; }
.sp-table td {
  padding: 10px 10px;
  border-bottom: 1px solid var(--rule-hair);
  white-space: nowrap;
}
.sp-table td.r { text-align: right; }

.candidate-row {
  cursor: pointer;
  transition: background 0.15s;
}
.candidate-row:hover {
  background: var(--paper-2);
}

.sym {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.spot-price {
  font-size: 11px;
  color: var(--ink-3);
  margin-left: 6px;
}
.dte-tag {
  font-size: 10px;
  color: var(--ink-4);
  margin-left: 4px;
}
.premium-cell {
  font-weight: 600;
  color: var(--gain);
}

.score-pill {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: 600;
  color: var(--paper);
}

.regime-tag {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 3px;
  font-weight: 600;
}
.regime-sell { background: var(--gain-wash); color: var(--gain); }
.regime-buy { background: var(--loss-wash); color: var(--loss); }
.regime-mid { background: var(--info-wash); color: var(--info); }

.dim { color: var(--ink-4); }

/* Detail row */
.detail-row td {
  background: var(--paper-2);
  padding: 16px 20px !important;
}
.detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 24px;
}
.detail-section h4 {
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-4);
  margin-bottom: 8px;
}
.detail-item {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  padding: 2px 0;
}
.dl { color: var(--ink-3); }
.dv { color: var(--ink); }

/* Score breakdown bars */
.score-bars { display: flex; flex-direction: column; gap: 4px; }
.score-bar-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}
.sb-label {
  width: 60px;
  color: var(--ink-3);
  text-transform: capitalize;
}
.sb-track {
  flex: 1;
  height: 6px;
  background: var(--paper-3);
  border-radius: 3px;
  overflow: hidden;
}
.sb-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 3px;
  transition: width 0.3s;
}
.sb-val {
  width: 35px;
  text-align: right;
  color: var(--ink-2);
}

/* States */
.loading, .error, .empty {
  padding: 60px 0;
  text-align: center;
  color: var(--ink-3);
}
.error { color: var(--loss); }
.skipped {
  margin-top: 12px;
  font-size: 11px;
  color: var(--ink-4);
}

/* Methodology */
.methodology {
  margin-top: 32px;
  border: 1px solid var(--rule-hair);
}
.methodology summary {
  padding: 12px 16px;
  cursor: pointer;
  font-size: 11px;
  color: var(--ink-3);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.meth-content {
  padding: 0 16px 16px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--ink-2);
}
.meth-content p {
  margin: 6px 0;
}
</style>
