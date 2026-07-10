<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import StrategyRecordCard from '@/components/StrategyRecordCard.vue'
import { fetchPerformance, hydrateOutcomes } from '@/api/client'
import type { PerformanceData, GroupStats, RecentSnapshot } from '@/types'
import { STRAT_CN } from '@/utils/constants'

const data = ref<PerformanceData | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const hydrating = ref(false)
const hydrateMsg = ref<string | null>(null)

async function load() {
  loading.value = true
  error.value = null
  try {
    data.value = await fetchPerformance()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

async function doHydrate() {
  hydrating.value = true
  hydrateMsg.value = null
  try {
    const r = await hydrateOutcomes({ horizonDays: 5, maxUpdates: 100 })
    hydrateMsg.value = `已更新 ${r.updated} 条，${r.pendingWithinHorizon} 条未满观察期`
    if (r.updated > 0) await load()
  } catch (e) {
    hydrateMsg.value = `错误: ${(e as Error).message}`
  } finally {
    hydrating.value = false
  }
}

onMounted(load)

// Helpers
function pct(v: number | null): string {
  if (v == null) return '—'
  return (v * 100).toFixed(1) + '%'
}
function dollar(v: number | null, d = 2): string {
  if (v == null) return '—'
  const sign = v >= 0 ? '+' : ''
  return sign + '$' + v.toFixed(d)
}
function dollarAbs(v: number, d = 0): string {
  return '$' + Math.abs(v).toFixed(d)
}
function stratLabel(id: string): string {
  return (STRAT_CN as Record<string, string>)[id] ?? id
}
function regimeLabel(r: string): string {
  if (r === 'sell') return 'Sell (高 IVR)'
  if (r === 'buy') return 'Buy (低 IVR)'
  return 'Mid (中性)'
}
function pnlClass(v: number | null): string {
  if (v == null) return ''
  return v > 0 ? 'up' : v < 0 ? 'dn' : ''
}

// Verdict: what's actually winning vs losing (enough resolved outcomes to trust).
const MIN_OUTCOME = 5
const verdict = computed(() => {
  if (!data.value) return null
  const elig = data.value.strategies.filter(s => s.withOutcome >= MIN_OUTCOME)
  const winners = elig.filter(s => s.totalPnl > 0).sort((a, b) => b.totalPnl - a.totalPnl).slice(0, 3)
  const losers = elig.filter(s => s.totalPnl < 0).sort((a, b) => a.totalPnl - b.totalPnl).slice(0, 3)
  const worstRegime = [...data.value.regimes]
    .filter(r => r.withOutcome >= MIN_OUTCOME && r.totalPnl < 0)
    .sort((a, b) => a.totalPnl - b.totalPnl)[0] ?? null
  return { winners, losers, worstRegime, hasData: winners.length > 0 || losers.length > 0 }
})

// ---- Parameter experiment (tuner) — plain-language presentation ----
// The engine A/B-tests how far out-of-the-money credit spreads are sold.
const ALL_VARIANTS = ['sd0.25', 'sd0.30', 'sd0.35'] as const
const VARIANT_HUMAN: Record<string, { name: string; hint: string }> = {
  'sd0.25': { name: '保守卖法', hint: '卖得离现价更远:更安全,但收的权利金少' },
  'sd0.30': { name: '标准卖法', hint: '原先的默认参数' },
  'sd0.35': { name: '激进卖法', hint: '卖得离现价更近:权利金多,但更容易被打穿' }
}
function regimeHuman(r: string): string {
  if (r === 'sell') return '高波动环境'
  if (r === 'buy') return '低波动环境'
  return '中性环境'
}

type BucketArm = { variant: string; n: number; score: number; hasData: boolean }
const tunerBuckets = computed(() => {
  const arms = data.value?.tunerArms ?? []
  const byBucket = new Map<string, typeof arms>()
  for (const a of arms) {
    const k = `${a.strategy}|${a.regime}`
    byBucket.set(k, [...(byBucket.get(k) ?? []), a])
  }
  return [...byBucket.entries()].map(([k, list]) => {
    const [strategy, regime] = k.split('|')
    // Show all three options, including ones still waiting for results.
    const full: BucketArm[] = ALL_VARIANTS.map((v) => {
      const hit = list.find((a) => a.variant === v)
      return { variant: v, n: hit?.n ?? 0, score: hit?.score ?? 0, hasData: (hit?.n ?? 0) > 0 }
    })
    const tested = full.filter((a) => a.hasData)
    const best = [...tested].sort((a, b) => b.score - a.score)[0]
    const runnerUp = [...tested].sort((a, b) => b.score - a.score)[1]

    // Plain-language verdict for this bucket
    let status: string
    if (tested.length <= 1) {
      status = '🧪 试验刚开始 — 另外两种卖法在等首批结果(回测约需 5 天)'
    } else if (
      tested.length === full.length &&
      tested.every((a) => a.n >= 15) &&
      best && runnerUp && best.score - runnerUp.score > 0.05
    ) {
      status = `✅ 结论已可信:「${VARIANT_HUMAN[best.variant].name}」在这种环境下最赚钱`
    } else {
      status = `⏳「${VARIANT_HUMAN[best!.variant].name}」暂时领先 — 数据还不够下结论,引擎仍在对比`
    }
    return { strategy, regime, arms: full, bestVariant: best?.variant, status }
  })
})

// Cumulative P&L for sparkline
const cumulativePnl = computed(() => {
  if (!data.value) return []
  let cum = 0
  return data.value.dailyCurve.map(d => {
    cum += d.pnl
    return { date: d.date, cum }
  })
})

// SVG equity curve
const curveViewBox = '0 0 600 120'
const curvePath = computed(() => {
  const pts = cumulativePnl.value
  if (pts.length < 2) return ''
  const vals = pts.map(p => p.cum)
  const mn = Math.min(0, ...vals)
  const mx = Math.max(0, ...vals)
  const range = mx - mn || 1
  const w = 600
  const h = 100
  const pad = 10
  return pts.map((p, i) => {
    const x = (i / (pts.length - 1)) * w
    const y = pad + h - ((p.cum - mn) / range) * h
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
})
const curveZeroY = computed(() => {
  const pts = cumulativePnl.value
  if (pts.length < 2) return 60
  const vals = pts.map(p => p.cum)
  const mn = Math.min(0, ...vals)
  const mx = Math.max(0, ...vals)
  const range = mx - mn || 1
  return 10 + 100 - ((0 - mn) / range) * 100
})
</script>

<template>
  <div class="perf-page">
    <header class="page-head">
      <div>
        <h1 class="page-title">Performance</h1>
        <p class="page-sub">引擎推荐成绩单 — 每日 Dashboard 推荐的回测追踪</p>
      </div>
      <div class="head-actions">
        <button class="btn-hydrate" :disabled="hydrating" @click="doHydrate">
          {{ hydrating ? '计算中…' : '更新 Outcome' }}
        </button>
      </div>
    </header>

    <div v-if="hydrateMsg" class="hydrate-msg">{{ hydrateMsg }}</div>

    <div v-if="loading" class="loading-state">加载中…</div>
    <div v-else-if="error" class="error-state">{{ error }}</div>

    <template v-else-if="data">
      <!-- Overview Cards -->
      <section class="stat-cards">
        <div class="stat-card">
          <div class="stat-n mono">{{ data.totalSnapshots }}</div>
          <div class="stat-l">总推荐数</div>
        </div>
        <div class="stat-card">
          <div class="stat-n mono">{{ data.withOutcome }}</div>
          <div class="stat-l">已回测</div>
        </div>
        <div class="stat-card">
          <div class="stat-n mono" :class="pnlClass(data.overall.winRate)">
            {{ pct(data.overall.winRate) }}
          </div>
          <div class="stat-l">胜率</div>
        </div>
        <div class="stat-card">
          <div class="stat-n mono" :class="pnlClass(data.overall.avgPnl)">
            {{ dollar(data.overall.avgPnl) }}
          </div>
          <div class="stat-l">平均盈亏</div>
        </div>
        <div class="stat-card">
          <div class="stat-n mono" :class="pnlClass(data.overall.totalPnl)">
            {{ dollar(data.overall.totalPnl, 0) }}
          </div>
          <div class="stat-l">累计盈亏</div>
        </div>
        <div class="stat-card">
          <div class="stat-n mono">{{ data.overall.stopHits }}</div>
          <div class="stat-l">触及止损</div>
        </div>
      </section>

      <!-- Verdict: what's working / what's not -->
      <section v-if="verdict?.hasData" class="verdict-card">
        <div class="eyebrow">引擎裁决 · 推荐时据此自动校准权重</div>
        <div class="verdict-grid">
          <div class="verdict-col win">
            <div class="vc-head">✓ 在赚</div>
            <div v-for="s in verdict.winners" :key="s.label" class="vc-row">
              <span class="vc-name">{{ stratLabel(s.label) }}</span>
              <span class="vc-pnl up mono">{{ dollar(s.totalPnl, 0) }}</span>
              <span class="vc-meta mono">{{ pct(s.winRate) }} · {{ s.withOutcome }}单</span>
            </div>
            <div v-if="!verdict.winners.length" class="vc-empty">样本不足</div>
          </div>
          <div class="verdict-col loss">
            <div class="vc-head">✗ 在亏</div>
            <div v-for="s in verdict.losers" :key="s.label" class="vc-row">
              <span class="vc-name">{{ stratLabel(s.label) }}</span>
              <span class="vc-pnl dn mono">{{ dollar(s.totalPnl, 0) }}</span>
              <span class="vc-meta mono">{{ pct(s.winRate) }} · {{ s.withOutcome }}单</span>
            </div>
            <div v-if="!verdict.losers.length" class="vc-empty">样本不足</div>
          </div>
        </div>
        <p class="verdict-note">
          <template v-if="verdict.worstRegime">
            最弱环境:<strong>{{ regimeLabel(verdict.worstRegime.label) }}</strong>
            ({{ pct(verdict.worstRegime.winRate) }} 胜率 · 累计 {{ dollar(verdict.worstRegime.totalPnl, 0) }})。
          </template>
          推荐引擎已对历史亏损的「结构 × 环境」组合自动降权,Dashboard 与策略推荐均生效。
        </p>
      </section>

      <!-- Real-money per-strategy track record (RH) -->
      <StrategyRecordCard />

      <!-- Equity Curve -->
      <section v-if="cumulativePnl.length >= 2" class="section-card">
        <div class="eyebrow">EQUITY CURVE</div>
        <svg :viewBox="curveViewBox" class="equity-svg" preserveAspectRatio="none">
          <line x1="0" :y1="curveZeroY" x2="600" :y2="curveZeroY"
            stroke="var(--rule-soft)" stroke-width="0.5" stroke-dasharray="4,3" />
          <path :d="curvePath" fill="none" stroke="var(--accent)" stroke-width="2" />
        </svg>
        <div class="curve-labels">
          <span class="mono">{{ cumulativePnl[0]?.date }}</span>
          <span class="mono">{{ cumulativePnl[cumulativePnl.length - 1]?.date }}</span>
        </div>
      </section>

      <!-- Strategy Breakdown -->
      <section class="section-card">
        <div class="eyebrow">BY STRATEGY</div>
        <div class="breakdown-table">
          <div class="bt-header">
            <span>策略</span>
            <span>推荐</span>
            <span>已回测</span>
            <span>胜率</span>
            <span>平均盈亏</span>
            <span>累计</span>
            <span>止损</span>
            <span>Avg POP</span>
          </div>
          <div v-for="s in data.strategies" :key="s.label" class="bt-row">
            <span class="bt-label">{{ stratLabel(s.label) }}</span>
            <span class="mono">{{ s.total }}</span>
            <span class="mono">{{ s.withOutcome }}</span>
            <span class="mono" :class="pnlClass(s.winRate)">{{ pct(s.winRate) }}</span>
            <span class="mono" :class="pnlClass(s.avgPnl)">{{ dollar(s.avgPnl) }}</span>
            <span class="mono" :class="pnlClass(s.totalPnl)">{{ dollar(s.totalPnl, 0) }}</span>
            <span class="mono">{{ s.stopHits }}</span>
            <span class="mono">{{ pct(s.avgPop) }}</span>
          </div>
        </div>
      </section>

      <!-- Regime Breakdown -->
      <section class="section-card">
        <div class="eyebrow">BY REGIME</div>
        <div class="breakdown-table regime-table">
          <div class="bt-header">
            <span>Regime</span>
            <span>推荐</span>
            <span>已回测</span>
            <span>胜率</span>
            <span>平均盈亏</span>
            <span>累计</span>
            <span>Avg IVR→EV</span>
          </div>
          <div v-for="r in data.regimes" :key="r.label" class="bt-row">
            <span class="bt-label">{{ regimeLabel(r.label) }}</span>
            <span class="mono">{{ r.total }}</span>
            <span class="mono">{{ r.withOutcome }}</span>
            <span class="mono" :class="pnlClass(r.winRate)">{{ pct(r.winRate) }}</span>
            <span class="mono" :class="pnlClass(r.avgPnl)">{{ dollar(r.avgPnl) }}</span>
            <span class="mono" :class="pnlClass(r.totalPnl)">{{ dollar(r.totalPnl, 0) }}</span>
            <span class="mono">{{ dollar(r.avgEv) }}</span>
          </div>
        </div>
      </section>

      <!-- Symbol Breakdown -->
      <section class="section-card">
        <div class="eyebrow">BY SYMBOL</div>
        <div class="breakdown-table sym-table">
          <div class="bt-header">
            <span>标的</span>
            <span>推荐</span>
            <span>已回测</span>
            <span>胜率</span>
            <span>平均盈亏</span>
            <span>累计</span>
          </div>
          <div v-for="s in data.symbols" :key="s.label" class="bt-row">
            <span class="bt-label mono">{{ s.label }}</span>
            <span class="mono">{{ s.total }}</span>
            <span class="mono">{{ s.withOutcome }}</span>
            <span class="mono" :class="pnlClass(s.winRate)">{{ pct(s.winRate) }}</span>
            <span class="mono" :class="pnlClass(s.avgPnl)">{{ dollar(s.avgPnl) }}</span>
            <span class="mono" :class="pnlClass(s.totalPnl)">{{ dollar(s.totalPnl, 0) }}</span>
          </div>
        </div>
      </section>

      <!-- Parameter experiment (tuner) -->
      <section v-if="tunerBuckets.length" class="section-card">
        <div class="eyebrow">参数实验 · 引擎在自动测试哪种卖法更赚钱</div>
        <div class="tuner-grid">
          <div v-for="b in tunerBuckets" :key="b.strategy + b.regime" class="tuner-bucket">
            <div class="tb-head">
              {{ stratLabel(b.strategy) }}<span class="tb-regime">{{ regimeHuman(b.regime) }}</span>
            </div>
            <div class="tb-status">{{ b.status }}</div>
            <div
              v-for="a in b.arms"
              :key="a.variant"
              class="tb-arm"
              :class="{ lead: a.hasData && a.variant === b.bestVariant, nodata: !a.hasData }"
              :title="VARIANT_HUMAN[a.variant].hint"
            >
              <span class="tb-variant">{{ VARIANT_HUMAN[a.variant].name }}</span>
              <template v-if="a.hasData">
                <span class="tb-bar"><span :style="{ width: (a.score * 100).toFixed(0) + '%' }" /></span>
                <span class="mono tb-score">{{ (a.score * 100).toFixed(0) }}分</span>
                <span class="mono tb-n">已验证{{ a.n }}笔</span>
              </template>
              <template v-else>
                <span class="tb-waiting">等待首批回测结果…</span>
              </template>
            </div>
          </div>
        </div>
        <p class="tuner-note">
          怎么看:引擎每次推荐信用价差时,会在三种卖法里做小规模实验——大部分机会给当前得分最高的,留一小部分试另外两种,防止误判。
          得分(0~100)综合了「赚多少」和「亏多少」,不是单纯胜率;<b>笔数没攒够之前,领先只是暂时的,看到 ✅ 才算结论。</b>
          鼠标悬停每行可看该卖法的具体含义。
        </p>
      </section>

      <!-- Recent History -->
      <section class="section-card">
        <div class="eyebrow">RECENT RECOMMENDATIONS</div>
        <div class="history-scroll">
          <table class="history-table">
            <thead>
              <tr>
                <th>日期</th>
                <th>标的</th>
                <th>策略</th>
                <th>Regime</th>
                <th>IVR</th>
                <th>POP</th>
                <th>P&amp;L</th>
                <th>退出</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in data.recent" :key="r.id">
                <td class="mono">{{ r.etDay }}</td>
                <td class="mono">{{ r.sym }}</td>
                <td>
                  {{ stratLabel(r.strategyId) }}
                  <span v-if="r.variant" class="variant-tag mono" title="调参器选择的参数变体(卖方 delta)">{{ r.variant }}</span>
                </td>
                <td class="mono">{{ r.regime }}</td>
                <td class="mono">{{ Math.round(r.ivr) }}</td>
                <td class="mono">{{ (r.pop * 100).toFixed(0) }}%</td>
                <td class="mono" :class="pnlClass(r.pnl)">
                  {{ r.hasOutcome ? dollar(r.pnl, 0) : '⏳' }}
                </td>
                <td class="mono">
                  <span v-if="!r.hasOutcome" />
                  <span v-else-if="r.exitReason === 'take_profit'" class="exit-tp">止盈</span>
                  <span v-else-if="r.exitReason === 'stop_loss'" class="exit-sl">止损</span>
                  <span v-else-if="r.exitReason === 'expiry'" class="exit-exp">到期</span>
                  <span v-else class="exit-eow">持有中</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Pending notice -->
      <div v-if="data.pendingOutcome > 0" class="pending-notice">
        {{ data.pendingOutcome }} 条推荐尚未满观察期，点击「更新 Outcome」可回测已到期的推荐
      </div>
    </template>
  </div>
</template>

<style scoped>
.perf-page {
  max-width: var(--max);
  margin: 0 auto;
  padding: 32px 40px 60px;
}

.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 28px;
  border-bottom: 2px solid var(--rule);
  padding-bottom: 16px;
}
.page-title {
  font-family: var(--serif);
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0;
}
.page-sub {
  font-family: var(--sans);
  font-size: 13px;
  color: var(--ink-3);
  margin: 4px 0 0;
}
.head-actions { display: flex; gap: 8px; align-items: center; }
.btn-hydrate {
  font-family: var(--mono);
  font-size: 12px;
  padding: 6px 14px;
  border: 1px solid var(--rule-soft);
  border-radius: 4px;
  background: var(--paper-2);
  color: var(--ink-2);
  cursor: pointer;
  transition: all 0.15s;
}
.btn-hydrate:hover:not(:disabled) { background: var(--paper-3); color: var(--ink); }
.btn-hydrate:disabled { opacity: 0.5; cursor: not-allowed; }

.hydrate-msg {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--ink-3);
  background: var(--paper-2);
  padding: 8px 12px;
  border-radius: 4px;
  margin-bottom: 20px;
}

.loading-state, .error-state {
  font-family: var(--sans);
  font-size: 14px;
  color: var(--ink-3);
  padding: 40px 0;
  text-align: center;
}
.error-state { color: var(--loss); }

/* Stat cards */
.stat-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
  margin-bottom: 28px;
}
.stat-card {
  background: var(--paper-2);
  border: 1px solid var(--rule-hair);
  border-radius: 6px;
  padding: 16px;
  text-align: center;
}
.stat-n {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin-bottom: 4px;
}
.stat-l {
  font-size: 11px;
  color: var(--ink-3);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

/* Verdict card */
.verdict-card {
  background: var(--paper);
  border: 1px solid var(--rule-hair);
  border-radius: 6px;
  padding: 20px;
  margin-bottom: 20px;
}
.verdict-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
}
.verdict-col {
  padding-left: 14px;
  border-left: 2px solid var(--rule-soft);
}
.verdict-col.win { border-left-color: var(--gain); }
.verdict-col.loss { border-left-color: var(--loss); }
.vc-head {
  font-family: var(--sans);
  font-size: 13px;
  font-weight: 700;
  margin-bottom: 10px;
}
.verdict-col.win .vc-head { color: var(--gain); }
.verdict-col.loss .vc-head { color: var(--loss); }
.vc-row {
  display: grid;
  grid-template-columns: 1.4fr 0.9fr 1fr;
  gap: 8px;
  align-items: baseline;
  padding: 4px 0;
}
.vc-name { font-size: 13px; color: var(--ink-2); }
.vc-pnl { font-size: 13px; font-weight: 600; text-align: right; }
.vc-meta { font-size: 11px; color: var(--ink-4); text-align: right; }
.vc-empty { font-size: 12px; color: var(--ink-4); font-style: italic; }
.verdict-note {
  font-family: var(--sans);
  font-size: 12px;
  color: var(--ink-3);
  line-height: 1.6;
  margin: 16px 0 0;
  padding-top: 12px;
  border-top: 1px solid var(--rule-hair);
}
.verdict-note strong { color: var(--ink-2); font-weight: 600; }

/* Section cards */
.section-card {
  background: var(--paper);
  border: 1px solid var(--rule-hair);
  border-radius: 6px;
  padding: 20px;
  margin-bottom: 20px;
}
.eyebrow {
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.12em;
  color: var(--ink-4);
  text-transform: uppercase;
  margin-bottom: 14px;
}

/* Equity curve */
.equity-svg {
  width: 100%;
  height: 120px;
  display: block;
}
.curve-labels {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--ink-4);
  margin-top: 4px;
}

/* Breakdown tables */
.breakdown-table { font-size: 13px; }
.bt-header, .bt-row {
  display: grid;
  grid-template-columns: 1.6fr repeat(7, 1fr);
  gap: 4px;
  padding: 6px 0;
  align-items: center;
}
.regime-table .bt-header, .regime-table .bt-row {
  grid-template-columns: 1.6fr repeat(6, 1fr);
}
.sym-table .bt-header, .sym-table .bt-row {
  grid-template-columns: 1fr repeat(5, 1fr);
}
.bt-header {
  font-size: 10px;
  font-weight: 600;
  color: var(--ink-4);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-bottom: 1px solid var(--rule-soft);
  padding-bottom: 8px;
}
.bt-row {
  border-bottom: 1px solid var(--rule-hair);
}
.bt-row:last-child { border-bottom: none; }
.bt-label { font-weight: 500; color: var(--ink-2); }

/* History table */
.history-scroll { overflow-x: auto; }
.history-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.history-table th {
  font-size: 10px;
  font-weight: 600;
  color: var(--ink-4);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid var(--rule-soft);
  white-space: nowrap;
}
.history-table td {
  padding: 5px 8px;
  border-bottom: 1px solid var(--rule-hair);
  white-space: nowrap;
}

/* Color utilities */
.up { color: var(--gain); }
.dn { color: var(--loss); }

/* Tuner arm posteriors */
.tuner-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px 28px;
}
.tb-head {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-2);
  margin-bottom: 6px;
}
.tb-regime {
  font-size: 10px;
  color: var(--ink-4);
  margin-left: 8px;
  padding: 1px 6px;
  border: 1px solid var(--rule-soft);
  border-radius: 8px;
}
.tb-status {
  font-size: 11.5px;
  color: var(--ink-2);
  margin: 2px 0 8px;
  line-height: 1.5;
}
.tb-arm {
  display: grid;
  grid-template-columns: 70px 1fr 40px 70px;
  gap: 8px;
  align-items: center;
  padding: 3px 0;
  font-size: 11px;
}
.tb-arm.lead .tb-variant { color: var(--gain); font-weight: 700; }
.tb-arm.nodata { opacity: 0.55; }
.tb-waiting { grid-column: 2 / -1; font-size: 10.5px; color: var(--ink-4); font-style: italic; }
.tb-variant { color: var(--ink-2); }
.tb-bar {
  position: relative;
  height: 5px;
  background: var(--paper-3);
  border-radius: 2px;
  overflow: hidden;
}
.tb-bar span {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  background: var(--ink-3);
}
.tb-arm.lead .tb-bar span { background: var(--gain); }
.tb-score { text-align: right; color: var(--ink-2); }
.tb-n { text-align: right; color: var(--ink-4); font-size: 10px; }
.tuner-note {
  font-size: 11.5px;
  color: var(--ink-3);
  line-height: 1.6;
  margin: 14px 0 0;
  padding-top: 10px;
  border-top: 1px solid var(--rule-hair);
}

.variant-tag {
  font-size: 9px;
  color: var(--ink-4);
  border: 1px solid var(--rule-soft);
  border-radius: 3px;
  padding: 0 4px;
  margin-left: 6px;
  vertical-align: 1px;
}

/* Exit reason badges */
.exit-tp { color: var(--gain); font-weight: 600; }
.exit-sl { color: var(--loss); font-weight: 600; }
.exit-exp { color: var(--ink-3); }
.exit-eow { color: var(--ink-4); font-style: italic; }

.pending-notice {
  font-family: var(--sans);
  font-size: 12px;
  color: var(--ink-3);
  text-align: center;
  padding: 16px;
  font-style: italic;
}
</style>
