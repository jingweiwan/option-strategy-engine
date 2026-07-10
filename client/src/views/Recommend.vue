<script setup lang="ts">
import { reactive, ref, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { fetchLiveStrategies, fetchExpirations } from '@/api/client'
import { STRAT_CN } from '@/utils/constants'
import type {
  StrategyResult,
  LiveMarketState,
  StrategyType,
  View,
  VolExpect,
  RiskPref
} from '@/types'

const route = useRoute()
const router = useRouter()

const form = reactive<{
  symbol: string
  expiration: string
  view: View
  volExpect: VolExpect
  riskPref: RiskPref
  simulations: number
  seed: number
}>({
  symbol: ((route.query.sym as string) ?? 'AAPL').toUpperCase(),
  expiration: '',
  view: (['bullish', 'bearish', 'neutral', 'neutral-vol'].includes(route.query.view as string)
    ? route.query.view as View
    : 'bullish'),
  volExpect: (['low', 'mid', 'high'].includes(route.query.vol as string)
    ? route.query.vol as VolExpect
    : 'mid'),
  riskPref: 'defined',
  simulations: 5000,
  seed: 42
})

const expirations = ref<string[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const state = ref<LiveMarketState | null>(null)
const results = ref<StrategyResult[]>([])
const skipped = ref<{ strategy: StrategyType; reason: string }[]>([])
const lastLoadedSymbol = ref('')
let symbolDebounce: number | undefined
const TICKER_PATTERN = /^[A-Z0-9.-]{1,6}$/

// --- Auto-tune volExpect from real IV Rank when arriving from Deep Analysis ---
const fromDeep = route.query.from === 'deep'
const autoVolApplied = ref(false)
const autoVolHint = ref<string | null>(null)

/**
 * volExpect in this engine encodes IV richness, not a realized-vol forecast:
 * 'high' favors premium-selling structures (condor/strangle/credit spreads),
 * 'low' favors buying (straddle/debit spreads). So it maps monotonically from
 * IV Rank — high IVR → sell premium, low IVR → buy.
 */
function volExpectFromIvRank(ivRank: number): VolExpect {
  if (ivRank >= 70) return 'high'
  if (ivRank <= 30) return 'low'
  return 'mid'
}

async function loadExpirations(symbol: string) {
  const sym = symbol.trim().toUpperCase()
  if (sym === lastLoadedSymbol.value) return
  if (!sym || !TICKER_PATTERN.test(sym)) return
  lastLoadedSymbol.value = sym
  loading.value = true
  error.value = null
  try {
    const exps = await fetchExpirations(sym)
    expirations.value = exps
    if (exps.length > 0) {
      const today = Date.now()
      const ideal = exps.find((e) => {
        const dte = (new Date(e).getTime() - today) / 86400000
        return dte >= 21
      })
      form.expiration = ideal ?? exps[0]
    }
  } catch (e: any) {
    error.value = e?.message ?? 'failed to load expirations'
    lastLoadedSymbol.value = ''
  } finally {
    loading.value = false
  }
}

watch(
  () => form.symbol,
  (s) => {
    window.clearTimeout(symbolDebounce)
    symbolDebounce = window.setTimeout(() => loadExpirations(s), 700)
  }
)

onMounted(async () => {
  await loadExpirations(form.symbol)
  // Coming from Deep Analysis: run immediately so the user sees strategies
  // without a manual click (and so volExpect auto-tunes to the real IV Rank).
  if (fromDeep && form.expiration) {
    runEngine()
  }
})

async function runEngine() {
  if (!form.expiration) {
    error.value = '请先输入 symbol 并选择 expiration'
    return
  }
  loading.value = true
  error.value = null
  try {
    const out = await fetchLiveStrategies({
      symbol: form.symbol.toUpperCase(),
      expiration: form.expiration,
      view: form.view,
      volExpect: form.volExpect,
      riskPref: form.riskPref,
      simulations: form.simulations,
      seed: form.seed
    })
    state.value = out.state
    results.value = out.results
    skipped.value = out.skipped

    // First run from a Deep Analysis handoff: align volExpect to the real IV
    // Rank we just learned, then re-run once if it changed.
    if (fromDeep && !autoVolApplied.value && out.state.ivRank != null) {
      autoVolApplied.value = true
      const rec = volExpectFromIvRank(out.state.ivRank)
      if (rec !== form.volExpect) {
        const label = rec === 'low' ? '低' : rec === 'high' ? '高' : '中'
        autoVolHint.value =
          `已按当前 IVR ${out.state.ivRank.toFixed(0)} 自动设为「${label}波动」` +
          (rec === 'high' ? '——IV 偏贵，卖方结构占优' : rec === 'low' ? '——IV 偏便宜，买方结构占优' : '')
        form.volExpect = rec
        await runEngine()
        return
      }
    }
  } catch (e: any) {
    error.value = e?.message ?? 'request failed'
  } finally {
    loading.value = false
  }
}

const top3 = computed(() => results.value.filter((r) => r.tier !== 'reference').slice(0, 3))
const others = computed(() => results.value.filter((r) => r.tier === 'reference'))
const showOthers = ref(false)


const VIEW_OPTIONS: { id: View; l: string; sub: string }[] = [
  { id: 'bullish', l: '↑ 看涨', sub: '股价温和上涨' },
  { id: 'bearish', l: '↓ 看跌', sub: '股价温和下跌' },
  { id: 'neutral', l: '↔ 中性', sub: '震荡 / 横盘' },
  { id: 'neutral-vol', l: '⇅ 买波动', sub: '不分方向，等大波动' }
]

const VOL_OPTIONS: { id: VolExpect; l: string }[] = [
  { id: 'low', l: '低' },
  { id: 'mid', l: '中' },
  { id: 'high', l: '高' }
]

const RISK_OPTIONS: { id: RiskPref; l: string }[] = [
  { id: 'defined', l: '限定风险' },
  { id: 'any', l: '不限' }
]

const VIEW_LABEL: Record<View, string> = {
  bullish: '看涨',
  bearish: '看跌',
  neutral: '中性',
  'neutral-vol': '买波动'
}

function fmt(n: number, d = 2) {
  if (!Number.isFinite(n)) return '∞'
  return n.toFixed(d)
}
function fmtSigned(n: number, d = 2) {
  if (!Number.isFinite(n)) return n > 0 ? '∞' : '−∞'
  return (n >= 0 ? '+' : '') + n.toFixed(d)
}

function viewDetail(s: StrategyResult) {
  router.push({
    path: '/strategy',
    query: { sym: form.symbol, exp: form.expiration, id: s.strategy }
  })
}

function clIcon(status: string): string {
  return status === 'pass' ? '✓' : status === 'warn' ? '⚠' : status === 'fail' ? '✗' : '·'
}

/** Badge shown when the historical track-record calibration moved this pick. */
function calibChip(c?: number): { txt: string; cls: string } | null {
  if (c == null) return null
  if (c === 0) return { txt: '✕ 历史劣绩 · 已禁用', cls: 'cal-dn' }
  if (c >= 1.08) return { txt: `↑ 历史占优 ${c.toFixed(2)}×`, cls: 'cal-up' }
  if (c <= 0.92) return { txt: `↓ 历史走弱 ${c.toFixed(2)}×`, cls: 'cal-dn' }
  return null
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <div class="eyebrow" style="margin-bottom: 14px">推荐引擎 · 观点输入</div>
        <div class="h-title serif">
          你怎么 <em style="font-style: italic; color: var(--accent)">看</em>？
        </div>
        <div class="h-deck">
          告诉引擎你怎么想——方向、波动率预期、风险偏好。它会从 5 个常用结构里、按你的观点 + 当前市场数据匹配出最佳方案。
        </div>
      </div>
      <div class="h-meta">
        <div v-if="state">{{ state.symbol }} · {{ state.expiration }}</div>
        <div v-if="state">IV {{ (state.iv * 100).toFixed(1) }}% · IVR {{ state.ivRank.toFixed(0) }}</div>
        <div v-if="state?.earningsInWindow" class="earn-flag">⚠ 财报 {{ state.earningsDate }} 在到期前 · 已计入跳空风险</div>
        <div>5,000 路径 · seed 42</div>
      </div>
    </div>

    <section class="control-bar">
      <div class="ctrl">
        <div class="label">标的</div>
        <input
          class="mono"
          type="text"
          v-model="form.symbol"
          style="text-transform: uppercase; width: 110px"
          placeholder="AAPL"
        />
      </div>
      <div class="ctrl">
        <div class="label">到期日</div>
        <select
          class="mono"
          v-model="form.expiration"
          :disabled="expirations.length === 0"
        >
          <option v-if="expirations.length === 0" value="">
            {{ loading ? '加载中…' : '无可用' }}
          </option>
          <option v-for="e in expirations" :key="e" :value="e">{{ e }}</option>
        </select>
      </div>

      <div class="ctrl wide">
        <div class="label">方向观点</div>
        <div class="seg-group">
          <button
            v-for="opt in VIEW_OPTIONS"
            :key="opt.id"
            :class="['seg', { on: form.view === opt.id }]"
            @click="form.view = opt.id"
            :title="opt.sub"
          >{{ opt.l }}</button>
        </div>
      </div>

      <div class="ctrl">
        <div class="label">波动预期</div>
        <div class="seg-group">
          <button
            v-for="opt in VOL_OPTIONS"
            :key="opt.id"
            :class="['seg', { on: form.volExpect === opt.id }]"
            @click="form.volExpect = opt.id"
          >{{ opt.l }}</button>
        </div>
      </div>

      <div class="ctrl">
        <div class="label">风险偏好</div>
        <div class="seg-group">
          <button
            v-for="opt in RISK_OPTIONS"
            :key="opt.id"
            :class="['seg', { on: form.riskPref === opt.id }]"
            @click="form.riskPref = opt.id"
          >{{ opt.l }}</button>
        </div>
      </div>

      <button class="btn primary" @click="runEngine" :disabled="loading || !form.expiration">
        {{ loading ? '运行中…' : '↻ 运行引擎' }}
      </button>
    </section>

    <section v-if="error" class="error">⚠ {{ error }}</section>

    <section v-if="autoVolHint" class="auto-hint">↻ {{ autoVolHint }}</section>

    <!-- Engine commentary -->
    <div v-if="state && results.length" class="commentary">
      <div class="commentary-text">
        <div class="eyebrow" style="margin-bottom: 8px">为什么是这些 · 引擎说明</div>
        <p class="serif" style="font-size: 22px; line-height: 1.45; font-weight: 500; letter-spacing: -0.01em; max-width: 62ch; margin: 0; color: var(--ink-2)">
          在 <em style="font-style: italic">{{ VIEW_LABEL[form.view] }}</em> 观点 +
          <em style="font-style: italic">{{ form.volExpect === 'low' ? '低' : form.volExpect === 'mid' ? '中' : '高' }}</em> IV 预期下，
          引擎从 5 个结构里挑出与你方向匹配、风险结构符合"{{ form.riskPref === 'defined' ? '限定风险' : '不限风险' }}"的前 3 名。其余仅供对比。
        </p>
      </div>
      <div>
        <div class="eyebrow" style="margin-bottom: 10px">已识别输入</div>
        <div class="recap mono">
          <div><span>方向</span><b>{{ VIEW_LABEL[form.view] }}</b></div>
          <div><span>波动率</span><b>{{ form.volExpect === 'low' ? '低' : form.volExpect === 'mid' ? '中' : '高' }} IV</b></div>
          <div><span>风险</span><b>{{ form.riskPref === 'defined' ? '限定' : '不限' }}</b></div>
          <div><span>策略池</span><b>5 种</b></div>
          <div><span>定价模型</span><b>BSM · 5k MC</b></div>
        </div>
      </div>
    </div>

    <!-- Top 3 -->
    <div v-if="top3.length" class="rows">
      <div class="rows-head">
        <span class="eyebrow">前 3 名 · 与你的观点匹配</span>
      </div>
      <div
        v-for="(s, i) in top3"
        :key="s.strategy"
        class="strat-row"
      >
        <div class="strat-row-head">
          <span class="rank-pill mono">#{{ i + 1 }}</span>
          <div class="strat-row-title">
            <div class="serif title-line">
              {{ STRAT_CN[s.strategy] }}
              <span class="title-en mono">{{ s.strategy }}</span>
            </div>
            <div class="title-deck">{{ s.rationale }}</div>
          </div>
          <div class="row-meta">
            <span
              v-if="calibChip(s.calibration)"
              :class="['chip', calibChip(s.calibration)!.cls]"
              title="基于历史回测胜率，对该结构 × 环境的评分做了校准"
            >{{ calibChip(s.calibration)!.txt }}</span>
            <span :class="['chip', s.netPremium > 0 ? 'gain' : 'info']">
              {{ s.netPremium > 0 ? '收 CREDIT' : '付 DEBIT' }} {{ fmt(Math.abs(s.netPremium)) }}
            </span>
            <button class="btn tiny ghost" @click="viewDetail(s)">查看详情 →</button>
          </div>
        </div>

        <div class="strat-row-stats">
          <div class="stat">
            <div class="stat-l mono">POP</div>
            <div class="stat-v mono tnum">{{ fmt(s.metrics.probabilityProfit * 100, 1) }}%</div>
          </div>
          <div class="stat">
            <div class="stat-l mono">EV</div>
            <div class="stat-v mono tnum">{{ fmtSigned(s.metrics.ev) }}</div>
          </div>
          <div class="stat">
            <div class="stat-l mono">Std</div>
            <div class="stat-v mono tnum">{{ fmt(s.metrics.stdDev) }}</div>
          </div>
          <div class="stat">
            <div class="stat-l mono">VaR 95</div>
            <div class="stat-v mono tnum dn">{{ fmt(s.metrics.var95) }}</div>
          </div>
          <div class="stat">
            <div class="stat-l mono">CVaR 95</div>
            <div class="stat-v mono tnum dn">{{ fmt(s.metrics.cvar95) }}</div>
          </div>
          <div class="stat">
            <div class="stat-l mono">Max P/L</div>
            <div class="stat-v mono tnum">
              {{ s.metrics.unboundedProfit ? '∞' : fmt(s.metrics.theoMaxProfit) }} /
              {{ s.metrics.unboundedLoss ? '−∞' : fmt(s.metrics.theoMaxLoss) }}
            </div>
          </div>
          <div class="stat">
            <div class="stat-l mono">Δ</div>
            <div class="stat-v mono tnum">{{ fmtSigned(s.netGreeks.delta, 2) }}</div>
          </div>
          <div class="stat">
            <div class="stat-l mono">Θ/d</div>
            <div class="stat-v mono tnum">{{ fmtSigned(s.netGreeks.theta, 2) }}</div>
          </div>
        </div>

        <!-- Pre-trade checklist -->
        <div v-if="s.checklist" class="checklist">
          <div class="cl-head">
            <span class="cl-title">开仓前体检 · {{ s.checklist.sellerSide ? '卖方' : '买方' }}</span>
            <span class="cl-summary mono">
              <span class="cl-pass">✓{{ s.checklist.passCount }}</span>
              <span v-if="s.checklist.warnCount" class="cl-warn">⚠{{ s.checklist.warnCount }}</span>
              <span v-if="s.checklist.failCount" class="cl-fail">✗{{ s.checklist.failCount }}</span>
              <span class="cl-source">靠 <b>{{ s.checklist.profitSource }}</b> 赚钱</span>
            </span>
          </div>
          <div class="cl-items">
            <div v-for="it in s.checklist.items" :key="it.id" class="cl-item" :class="'st-' + it.status">
              <span class="cl-icon">{{ clIcon(it.status) }}</span>
              <span class="cl-label">{{ it.label }}</span>
              <span class="cl-detail">{{ it.detail }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Others (reference) -->
    <div v-if="others.length" class="rows-head">
      <span class="eyebrow">其他策略 · 仅供对比</span>
      <button class="btn ghost tiny" @click="showOthers = !showOthers">
        {{ showOthers ? '收起' : `展开 ${others.length} 个` }}
      </button>
    </div>
    <div v-if="showOthers" class="rows reference">
      <div v-for="s in others" :key="'r-' + s.strategy" class="strat-row">
        <div class="strat-row-head">
          <span class="rank-pill mono ref">REF</span>
          <div class="strat-row-title">
            <div class="serif title-line">
              {{ STRAT_CN[s.strategy] }}
              <span class="title-en mono">{{ s.strategy }}</span>
            </div>
            <div class="title-deck">{{ s.rationale }}</div>
          </div>
          <div class="row-meta">
            <span
              v-if="calibChip(s.calibration)"
              :class="['chip', calibChip(s.calibration)!.cls]"
              title="基于历史回测胜率，对该结构 × 环境的评分做了校准"
            >{{ calibChip(s.calibration)!.txt }}</span>
            <span :class="['chip', s.netPremium > 0 ? 'gain' : 'info']">
              {{ s.netPremium > 0 ? '收 CREDIT' : '付 DEBIT' }} {{ fmt(Math.abs(s.netPremium)) }}
            </span>
            <button class="btn tiny ghost" @click="viewDetail(s)">详情 →</button>
          </div>
        </div>
        <div class="strat-row-stats">
          <div class="stat">
            <div class="stat-l mono">POP</div>
            <div class="stat-v mono tnum">{{ fmt(s.metrics.probabilityProfit * 100, 1) }}%</div>
          </div>
          <div class="stat">
            <div class="stat-l mono">EV</div>
            <div class="stat-v mono tnum">{{ fmtSigned(s.metrics.ev) }}</div>
          </div>
          <div class="stat">
            <div class="stat-l mono">VaR 95</div>
            <div class="stat-v mono tnum dn">{{ fmt(s.metrics.var95) }}</div>
          </div>
          <div class="stat">
            <div class="stat-l mono">CVaR 95</div>
            <div class="stat-v mono tnum dn">{{ fmt(s.metrics.cvar95) }}</div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="!results.length && !error && !loading" class="placeholder">
      <div class="imgslot" style="height: 200px">
        点击 ↻ 运行引擎 → 引擎会根据你的观点匹配出最优 3 个策略
      </div>
    </div>
  </div>
</template>

<style scoped>
.control-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 18px;
  padding: 14px 0 18px;
  border-top: 1px solid var(--rule);
  border-bottom: 1px solid var(--rule);
  margin-bottom: 22px;
}
.ctrl { display: flex; flex-direction: column; gap: 6px; }
.ctrl.wide { flex: 1; min-width: 280px; }
.ctrl input {
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--rule-soft);
  padding: 4px 0;
  font-size: 14px;
  color: var(--ink);
  outline: 0;
}
.ctrl input:focus { border-bottom-color: var(--accent); }
.ctrl select {
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--rule-soft);
  padding: 4px 0;
  font-family: var(--mono);
  font-size: 13px;
  color: var(--ink);
  outline: 0;
  width: 130px;
}
.control-bar .btn { margin-left: auto; }

.seg-group {
  display: flex;
  border: 1px solid var(--rule-soft);
}
.seg {
  background: transparent;
  border: 0;
  padding: 7px 12px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-3);
  cursor: pointer;
  border-right: 1px solid var(--rule-soft);
  white-space: nowrap;
}
.seg:last-child { border-right: 0; }
.seg:hover { color: var(--ink); }
.seg.on {
  background: var(--ink);
  color: var(--paper);
}

.error {
  border: 1px solid var(--loss);
  color: var(--loss);
  background: var(--loss-wash);
  padding: 10px 14px;
  font-family: var(--mono);
  font-size: 12px;
  margin-bottom: 18px;
}

.auto-hint {
  border: 1px solid var(--accent);
  color: var(--accent);
  background: var(--tint-1);
  padding: 10px 14px;
  font-family: var(--mono);
  font-size: 12px;
  margin-bottom: 18px;
}

.earn-flag {
  color: var(--loss);
  font-weight: 600;
}

.commentary {
  display: grid;
  grid-template-columns: 1fr 320px;
  gap: 32px;
  padding: 26px 0 28px;
  border-top: 1px solid var(--rule);
  border-bottom: 1px solid var(--rule);
  margin-bottom: 32px;
}
.recap {
  font-size: 11px;
  line-height: 1.9;
  color: var(--ink-2);
}
.recap > div {
  display: grid;
  grid-template-columns: 70px 1fr;
}
.recap span {
  color: var(--ink-3);
  letter-spacing: 0.04em;
}
.recap b {
  color: var(--ink);
  font-weight: 500;
}

.rows-head {
  display: flex;
  justify-content: space-between;
  align-items: end;
  margin: 16px 0 0;
  padding: 16px 0 4px;
  border-top: 1px solid var(--rule);
}
.rows .strat-row:last-child { border-bottom: 0; }
.strat-row {
  border-bottom: 1px solid var(--rule);
  padding: 22px 0;
}
.strat-row-head {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 18px;
  align-items: baseline;
  margin-bottom: 14px;
}
.rank-pill {
  background: var(--ink);
  color: var(--paper);
  font-size: 11px;
  letter-spacing: 0.05em;
  padding: 3px 8px;
  align-self: start;
  margin-top: 4px;
}
.rank-pill.ref {
  background: transparent;
  color: var(--ink-3);
  border: 1px solid var(--rule-soft);
}
.title-line {
  font-size: 22px;
  font-weight: 500;
  letter-spacing: -0.01em;
}
.title-en {
  color: var(--ink-3);
  font-size: 11px;
  letter-spacing: 0.04em;
  margin-left: 10px;
}
.title-deck {
  font-size: 12.5px;
  color: var(--ink-3);
  margin-top: 4px;
}
.row-meta {
  display: flex;
  align-items: center;
  gap: 10px;
}
.strat-row-stats {
  display: grid;
  grid-template-columns: repeat(8, minmax(0, 1fr));
  gap: 16px 24px;
}
.stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.stat-l {
  font-size: 9.5px;
  letter-spacing: 0.1em;
  color: var(--ink-3);
  text-transform: uppercase;
}
.stat-v {
  font-size: 14px;
  color: var(--ink);
}
.stat-v.dn { color: var(--loss); }

.reference { opacity: 0.92; }

/* ===== pre-trade checklist ===== */
.checklist {
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid var(--rule-hair);
}
.cl-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.cl-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--ink-2);
}
.cl-summary {
  font-size: 11px;
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.cl-pass { color: var(--gain); font-weight: 700; }
.cl-warn { color: #c98a00; font-weight: 700; }
.cl-fail { color: var(--loss); font-weight: 700; }
.cl-source { color: var(--ink-3); }
.cl-source b { color: var(--ink); font-weight: 600; }
.cl-items {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 3px 24px;
}
@media (max-width: 1100px) { .cl-items { grid-template-columns: 1fr; } }
.cl-item {
  display: grid;
  grid-template-columns: 14px 52px 1fr;
  gap: 6px;
  align-items: baseline;
  font-size: 11.5px;
  padding: 2px 0;
}
.cl-icon { text-align: center; font-weight: 700; }
.cl-label { color: var(--ink-3); }
.cl-detail { color: var(--ink-2); line-height: 1.4; }
.st-pass .cl-icon { color: var(--gain); }
.st-warn .cl-icon { color: #c98a00; }
.st-fail .cl-icon { color: var(--loss); }
.st-na { opacity: 0.5; }
.st-na .cl-icon { color: var(--ink-4); }

.chip.cal-up, .chip.cal-dn {
  font-family: var(--mono);
  font-size: 10px;
  padding: 3px 7px;
  border: 1px solid;
  white-space: nowrap;
}
.chip.cal-up { color: var(--gain); border-color: var(--gain); }
.chip.cal-dn { color: var(--loss); border-color: var(--loss); }

.placeholder {
  margin-top: 32px;
}

@media (max-width: 1100px) {
  .commentary { grid-template-columns: 1fr; }
  .strat-row-head { grid-template-columns: 1fr; }
  .row-meta { justify-content: flex-start; }
  .strat-row-stats { grid-template-columns: repeat(4, 1fr); }
}
</style>
