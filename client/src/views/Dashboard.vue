<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { fetchDashboard, fetchAiDashboardNarrative } from '@/api/client'
import { useWatchlist } from '@/composables/useWatchlist'
import { usePositions } from '@/composables/usePositions'
import { useThesisDrift } from '@/composables/useThesisDrift'
import { useEtMarketClock } from '@/composables/useEtMarketClock'
import BookRiskCard from '@/components/BookRiskCard.vue'
import type { DashboardData, DashboardNarrative, Opp, OppTag } from '@/types'

const router = useRouter()
const { syms } = useWatchlist()
const { heldSymbols } = usePositions()
const { driftAlerts } = useThesisDrift()
const { session } = useEtMarketClock()

/** True outside US regular trading hours — live quotes are limited/stale then. */
const marketClosed = computed(() => !!session.value && session.value !== '开盘中')

function isHeldSym(sym: string): boolean {
  return heldSymbols.value.includes(sym.toUpperCase())
}

function goDeep(sym: string) {
  router.push({ path: '/deep', query: { symbol: sym } })
}

const data = ref<DashboardData | null>(null)
const error = ref<string | null>(null)
const loading = ref(false)
const oppFilter = ref<OppTag | 'all'>('all')

const narrative = ref<DashboardNarrative | null>(null)
const aiLoading = ref(false)
const aiError = ref<string | null>(null)

/** IVR at/above this is "rich enough" to auto-recommend selling premium. */
const IVR_FLOOR = 30

// 'reference' near-misses (IVR below the floor) are shown separately and never
// counted as recommendations; older cached opps without boardTier read as qualified.
const boardOpps = computed(() =>
  !data.value ? [] : data.value.opps.filter((o) => (o.boardTier ?? 'qualified') === 'qualified')
)
const referenceOpps = computed(() =>
  !data.value ? [] : data.value.opps.filter((o) => o.boardTier === 'reference')
)

const opps = computed(() =>
  boardOpps.value.filter((o) => oppFilter.value === 'all' || o.tag === oppFilter.value)
)

/** Honest reason the qualified board is empty, inferred from the watchlist snapshot. */
const emptyReason = computed(() => {
  const t = data.value?.tickers ?? []
  const withIvr = t.filter((x) => x.ivr != null)
  const lowShare = withIvr.length
    ? withIvr.filter((x) => (x.ivr ?? 0) < IVR_FLOOR).length / withIvr.length
    : 1
  return lowShare >= 0.5
    ? `IVR 普遍偏低 — 多数标的低于 ${IVR_FLOOR} 达标线,卖波动溢价不足`
    : '无达标卖波动机会 — 或临近财报、或波动率不够贵'
})

/** Strip all HTML tags except <em>. Prevents XSS from AI-generated narrative. */
function sanitizeHeroHtml(html: string): string {
  return html.replace(/<\/?(?!em\b)[a-z][^>]*>/gi, '')
}

const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六']
const editionDay = computed(() => {
  const d = new Date()
  return `周${WEEKDAY_CN[d.getDay()]}刊`
})

const FILTER_OPTIONS: { id: OppTag | 'all'; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: '财报', label: '财报' },
  { id: '高 IV', label: '高 IV' },
  { id: '事件', label: '事件' }
]

const moodTone = computed(() => {
  if (!data.value) return '中性'
  const i = data.value.mood.index
  if (i == null) return '不可用'
  if (i >= 75) return '极度贪婪'
  if (i >= 55) return '偏贪婪'
  if (i >= 45) return '中性'
  if (i >= 25) return '偏恐慌'
  return '极度恐慌'
})

function fmtSigned(n: number, d = 2) {
  return (n >= 0 ? '+' : '') + n.toFixed(d)
}

/** Format expiration date: '2026-06-13' → '06/13' */
function fmtExp(exp: string): string {
  if (!exp) return '—'
  const parts = exp.split('-')
  if (parts.length === 3) return `${parts[1]}/${parts[2]}`
  return exp
}

function goStrategy(o: Opp) {
  router.push({
    path: '/strategy',
    query: { sym: o.sym, exp: o.expiration, id: o.strategyId }
  })
}

function goTicker(sym: string) {
  router.push({ path: '/ticker', query: { sym } })
}

function openPalette() {
  window.dispatchEvent(new Event('ose:open-palette'))
}

/** Minutes since the dashboard snapshot was built on the server. */
const staleMinutes = ref<number | null>(null)
let staleTimer: ReturnType<typeof setInterval> | null = null

function updateStaleness() {
  if (!data.value?.fetchedAt) { staleMinutes.value = null; return }
  const diff = (Date.now() - new Date(data.value.fetchedAt).getTime()) / 60_000
  staleMinutes.value = Math.max(0, Math.round(diff))
}

function startStaleTimer() {
  stopStaleTimer()
  updateStaleness()
  staleTimer = setInterval(updateStaleness, 30_000) // update every 30s
}

function stopStaleTimer() {
  if (staleTimer) { clearInterval(staleTimer); staleTimer = null }
}

const freshnessText = computed(() => {
  const m = staleMinutes.value
  if (m == null) return ''
  if (m < 1) return '刚刚更新'
  if (m < 60) return `${m} 分钟前更新`
  const h = Math.floor(m / 60)
  return `${h} 小时${m % 60 > 0 ? ' ' + (m % 60) + ' 分钟' : ''}前更新`
})

const isStale = computed(() => (staleMinutes.value ?? 0) > 30)

async function load() {
  loading.value = true
  error.value = null
  try {
    data.value = await fetchDashboard([...syms.value])
  } catch (e: any) {
    error.value = e?.message ?? 'failed to load'
  } finally {
    loading.value = false
  }
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null
const handleWatchlistChanged = () => {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => load(), 600)
}

async function loadNarrative() {
  if (!data.value) return
  aiLoading.value = true
  aiError.value = null
  try {
    const m = data.value.market
    const validIvrs = data.value.tickers.filter((t) => t.ivr != null).map((t) => t.ivr!)
    const ivrMedian = (() => {
      if (validIvrs.length === 0) return 0
      const sorted = [...validIvrs].sort((a, b) => a - b)
      const mid = Math.floor(sorted.length / 2)
      return Math.round(
        sorted.length % 2 === 0
          ? (sorted[mid - 1] + sorted[mid]) / 2
          : sorted[mid]
      )
    })()
    narrative.value = await fetchAiDashboardNarrative({
      asof: m.asof,
      spy: m.spy,
      vixy: m.vixy,
      ivRankMedian: ivrMedian,
      fearGreed: m.fearGreed ?? undefined,
      earningsToday: m.earningsToday,
      fedDays: m.fedDays,
      // Only feed AI tickers with all live data available — don't pollute the
      // narrative with nulls or synthetic zeros.
      watchlistTickers: data.value.tickers.flatMap((t) =>
        t.chg == null || t.iv == null || t.ivr == null || t.em == null
          ? []
          : [{ sym: t.sym, iv: t.iv, ivr: t.ivr, em: t.em, chg: t.chg }]
      ),
      // Ground the narrative in what actually cleared the gates.
      board: {
        qualifiedCount: boardOpps.value.length,
        emptyReason: boardOpps.value.length === 0 ? emptyReason.value : undefined,
        setups: boardOpps.value.slice(0, 4).map((o) => ({ sym: o.sym, strategy: o.strategy }))
      }
    })
  } catch (e: any) {
    aiError.value = e?.message ?? 'AI 暂不可用'
  } finally {
    aiLoading.value = false
  }
}

onMounted(() => {
  load()
  window.addEventListener('ose:watchlist-changed', handleWatchlistChanged)
})

onUnmounted(() => {
  window.removeEventListener('ose:watchlist-changed', handleWatchlistChanged)
  if (debounceTimer) clearTimeout(debounceTimer)
  stopStaleTimer()
})

// Trigger AI narrative + staleness timer once dashboard data arrives
watch(data, (v) => {
  if (v) {
    loadNarrative()
    startStaleTimer()
  }
})
</script>

<template>
  <div class="page">
    <template v-if="data">
      <!-- Market session banner (outside RTH, live quotes are limited) -->
      <div v-if="marketClosed" class="market-banner mono">
        <span class="mb-dot" />
        美股{{ session }} · 实时行情有限，下列数值为最近可得（多为上一交易日收盘）
      </div>

      <!-- Page head -->
      <div class="page-head">
        <div>
          <div class="eyebrow" style="margin-bottom: 14px">
            VOL. XII · NO. 127 · {{ editionDay }}
            <span v-if="aiLoading" class="ai-tag mono">AI 生成中…</span>
            <span v-else-if="narrative" class="ai-tag mono">AI 实时</span>
            <span v-else-if="aiError" class="ai-tag mono dim">AI 离线</span>
          </div>
          <div class="h-title serif">
            <template v-if="narrative">
              <span v-html="sanitizeHeroHtml(narrative.heroLine1)" class="hero-line" /><br />
              <span v-html="sanitizeHeroHtml(narrative.heroLine2)" class="hero-line" />
            </template>
            <template v-else-if="aiLoading">
              <span class="skeleton skeleton-h1" />
              <br />
              <span class="skeleton skeleton-h1 short" />
            </template>
            <template v-else-if="aiError">
              <span class="dim">叙事不可用</span>
            </template>
          </div>
          <div class="h-deck">
            <template v-if="narrative">{{ narrative.deck }}</template>
            <template v-else-if="aiLoading">
              <span class="skeleton skeleton-line" />
              <br />
              <span class="skeleton skeleton-line short" />
            </template>
            <template v-else-if="aiError">
              <span class="dim">{{ aiError }}</span>
            </template>
          </div>
        </div>
        <div class="h-meta">
          <div>
            {{ data.market.asof }}
            <button class="btn ghost tiny" style="margin-left: 8px" @click="load" :disabled="loading">
              {{ loading ? '刷新中…' : '↻ 刷新' }}
            </button>
          </div>
          <div class="freshness mono" :class="{ stale: isStale }" v-if="freshnessText">
            <span class="freshness-dot" :class="{ stale: isStale }" />
            {{ freshnessText }}
            <span v-if="isStale" class="freshness-warn">· 数据可能过期</span>
          </div>
          <div style="margin-top: 6px">
            SPY <b>{{ data.market.spy.v.toFixed(2) }}</b>
            <span :class="data.market.spy.chg >= 0 ? 'up' : 'dn'">&nbsp;{{ fmtSigned(data.market.spy.chg) }}%</span>
          </div>
          <div>
            VIXY <b>{{ data.market.vixy.v.toFixed(2) }}</b>
            <span :class="data.market.vixy.chg >= 0 ? 'up' : 'dn'">&nbsp;{{ fmtSigned(data.market.vixy.chg) }}%</span>
          </div>
        </div>
      </div>

      <!-- Mood + Engine view -->
      <div class="hero">
        <div class="hero-mood">
          <div class="eyebrow" style="margin-bottom: 18px">市场情绪 · 今日</div>

          <div class="mood-num">
            <div class="num">
              <template v-if="data.mood.index != null">{{ data.mood.index }}</template>
              <span v-else class="dim">—</span>
            </div>
            <div>
              <div class="mood-label serif">{{ moodTone }}</div>
              <div class="mood-sub" v-if="data.mood.index != null">CNN Fear & Greed</div>
              <div class="mood-sub dim" v-else>CNN feed 不可用</div>
            </div>
          </div>

          <div class="mood-bar" v-if="data.mood.index != null">
            <div class="mood-bar-grad" />
            <div class="mood-marker" :style="{ left: data.mood.index + '%' }" />
            <div class="mood-arrow" :style="{ left: data.mood.index + '%' }" />
          </div>
          <div class="mood-scale mono">
            <span>极度恐慌</span>
            <span>恐慌</span>
            <span>中性</span>
            <span>贪婪</span>
            <span>极度贪婪</span>
          </div>

          <hr class="rule-hair" style="margin: 22px 0 14px" />

          <div class="label" style="margin-bottom: 10px">
            是什么把指针推到这里
            <span v-if="aiLoading" class="ai-tag mono inline">AI</span>
          </div>
          <div class="factors">
            <template v-if="narrative">
              <div v-for="(f, i) in narrative.factors" :key="i" class="factor">
                <span
                  class="factor-dot"
                  :style="{
                    background:
                      f.tone === 'gain'
                        ? 'var(--gain)'
                        : f.tone === 'accent'
                        ? 'var(--accent)'
                        : 'var(--ink-3)'
                  }"
                />
                <div>
                  <div class="factor-label">{{ f.label }}</div>
                  <div class="factor-detail">{{ f.detail }}</div>
                </div>
              </div>
            </template>
            <template v-else-if="aiLoading">
              <div v-for="i in 3" :key="i" class="factor">
                <span class="factor-dot skeleton-dot" />
                <div style="flex: 1">
                  <div class="skeleton skeleton-line short" />
                  <div class="skeleton skeleton-line" style="margin-top: 6px" />
                </div>
              </div>
            </template>
            <div v-else-if="aiError" class="dim mono" style="font-size: 11px">
              {{ aiError }}
            </div>
          </div>
        </div>

        <div class="hero-engine">
          <div class="eyebrow" style="margin-bottom: 12px">
            引擎判断 · 今日
            <span v-if="aiLoading" class="ai-tag mono inline">AI</span>
          </div>
          <p class="engine-prose serif">
            <template v-if="narrative">{{ narrative.enginePose }}</template>
            <template v-else-if="aiLoading">
              <span class="skeleton skeleton-line" />
              <br />
              <span class="skeleton skeleton-line" />
              <br />
              <span class="skeleton skeleton-line short" />
            </template>
            <template v-else-if="aiError">
              <span class="dim">引擎判断不可用：{{ aiError }}</span>
            </template>
          </p>
          <div class="bucket-grid">
            <div v-for="(b, i) in data.engine.buckets" :key="i" class="bucket">
              <div class="bucket-v serif tnum">{{ b.value }}</div>
              <div class="label" style="margin-top: 4px">{{ b.label }}</div>
              <div class="bucket-hint mono">{{ b.hint }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Thesis drift alerts -->
      <section v-if="driftAlerts.length > 0" class="drift-section">
        <div class="eyebrow" style="margin-bottom: 12px">THESIS DRIFT · 持仓标的评分变动</div>
        <div class="drift-alerts">
          <div
            v-for="alert in driftAlerts"
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
              {{ alert.totalDelta > 0 ? '+' : '' }}{{ alert.totalDelta }}
            </span>
            <span class="drift-alert-vs mono">vs {{ alert.previousDate }}</span>
          </div>
        </div>
      </section>

      <!-- Book-level risk of the whole recommended board -->
      <BookRiskCard v-if="data.bookRisk && data.bookRisk.positions > 0" :risk="data.bookRisk" :real="data.realBook" />

      <!-- Today's opportunities -->
      <section class="opps-section">
        <div class="opps-head">
          <div>
            <div class="eyebrow">第二节</div>
            <div class="section-title serif">今日机会</div>
          </div>
          <div class="tag-row">
            <button
              v-for="opt in FILTER_OPTIONS"
              :key="opt.id"
              @click="oppFilter = opt.id"
              :class="['chip', { solid: oppFilter === opt.id }]"
              style="cursor: pointer"
            >
              {{ opt.label }}
            </button>
          </div>
        </div>

        <div v-if="opps.length > 0" class="opps-grid" :class="{ solo: opps.length === 1 }">
          <article
            v-for="(o, i) in opps"
            :key="o.sym + i"
            class="opp"
            :class="{
              rt: i % 2 === 1,
              bt: i >= opps.length - (opps.length % 2 === 0 ? 2 : 1),
              full: opps.length % 2 === 1 && i === opps.length - 1
            }"
            @click="goStrategy(o)"
            @keydown.enter="goStrategy(o)"
            tabindex="0"
            role="link"
          >
            <header class="opp-head">
              <div class="opp-head-left">
                <span class="opp-no mono">№ {{ String(i + 1).padStart(2, '0') }}</span>
                <span class="opp-sym serif">{{ o.sym }}</span>
                <span class="chip">{{ o.tag }}</span>
                <span v-if="isHeldSym(o.sym)" class="held-chip">已持仓</span>
                <span v-if="o.lowConviction" class="lowconv-chip" title="买方 regime(RV>IV):引擎的 edge 在卖波动,此环境无已证明优势">⚠ 低信心</span>
              </div>
              <span class="opp-edge mono">edge {{ o.edge }}</span>
            </header>

            <div class="opp-strategy serif">
              {{ o.strategy }}
              <span v-if="o.aiView" class="ai-view-badge" :class="'view-' + o.aiView">
                {{ { bullish: '看涨', bearish: '看跌', neutral: '中性', 'neutral-vol': '看波动' }[o.aiView] ?? o.aiView }}
              </span>
            </div>
            <div class="opp-thesis serif">{{ o.thesis }}</div>

            <!-- Legs & key levels -->
            <div v-if="o.legs && o.legs.length" class="opp-legs mono">
              <div class="opp-legs-row" v-for="(leg, li) in o.legs" :key="li">
                <span class="leg-action" :class="leg.action">{{ leg.action === 'buy' ? '买' : '卖' }}</span>
                <span class="leg-type">{{ leg.type === 'call' ? 'Call' : 'Put' }}</span>
                <span class="leg-strike tnum">${{ leg.strike }}</span>
                <span class="leg-premium tnum dim">@ ${{ leg.premium.toFixed(2) }}</span>
              </div>
              <div class="opp-levels">
                <span v-if="o.netPremium != null" class="level-item">
                  {{ o.netPremium >= 0 ? '净收' : '净付' }}
                  <b class="tnum">${{ Math.abs(o.netPremium).toFixed(2) }}</b>
                </span>
                <span v-if="o.maxProfit != null" class="level-item">
                  最大盈利
                  <b class="tnum">${{ o.maxProfit.toFixed(2) }}</b>
                </span>
                <span v-if="o.maxLoss != null" class="level-item">
                  最大亏损
                  <b class="tnum loss-text">${{ Math.abs(o.maxLoss).toFixed(2) }}</b>
                </span>
                <span v-if="o.breakevens && o.breakevens.length" class="level-item">
                  盈亏平衡
                  <b class="tnum" v-for="(be, bi) in o.breakevens" :key="bi">
                    {{ bi > 0 ? ' / ' : '' }}${{ be.toFixed(1) }}
                  </b>
                </span>
              </div>
            </div>

            <p class="opp-why">{{ o.why }}</p>

            <div v-if="o.analysis" class="opp-analysis">
              <div class="opp-analysis-label mono">分析师观点</div>
              <p class="opp-analysis-text">{{ o.analysis }}</p>
            </div>

            <div class="opp-stats">
              <div class="stat">
                <div class="stat-l mono">现价</div>
                <div class="stat-v serif tnum">${{ o.spot?.toFixed(2) ?? '—' }}</div>
              </div>
              <div class="stat">
                <div class="stat-l mono">到期日</div>
                <div class="stat-v serif tnum">{{ fmtExp(o.expiration) }}</div>
                <div class="stat-sub mono">{{ o.dte }}d</div>
              </div>
              <div class="stat">
                <div class="stat-l mono">POP</div>
                <div class="stat-v serif tnum">{{ o.pop }}%</div>
              </div>
              <div class="stat">
                <div class="stat-l mono">EV</div>
                <div class="stat-v serif tnum">{{ fmtSigned(o.ev) }}</div>
              </div>
              <div class="stat">
                <div class="stat-l mono">IVR</div>
                <div class="stat-v serif tnum">{{ o.ivr }}</div>
              </div>
            </div>

            <div v-if="o.management" class="opp-mgmt">
              <div class="opp-mgmt-label mono">交易管理</div>
              <div class="opp-mgmt-rules">
                <span class="mgmt-item" v-if="o.management.profitTarget != null">
                  止盈 <b class="tnum">${{ o.management.profitTarget.toFixed(2) }}</b>
                </span>
                <span class="mgmt-item" v-else>
                  止盈 <b class="tnum">扛到期</b>
                </span>
                <span class="mgmt-item">
                  止损 <b class="tnum loss-text">${{ o.management.stopLoss.toFixed(2) }}</b>
                </span>
                <span class="mgmt-item" v-if="o.management.rollDte != null">
                  移仓 <b class="tnum">≤{{ o.management.rollDte }}d</b>
                </span>
              </div>
              <p class="opp-mgmt-note">{{ o.management.note }}</p>
            </div>
          </article>
        </div>

        <!-- Honest stand-aside when nothing clears the bar (not filler) -->
        <div
          v-else-if="boardOpps.length === 0 && data.tickers.length > 0"
          class="opps-standby"
        >
          <div class="standby-title serif">今日无达标卖波动机会</div>
          <div class="standby-sub mono">{{ emptyReason }} · 建议空仓等待</div>
        </div>
        <div v-else class="opps-empty mono dim">
          {{ boardOpps.length > 0 ? '当前筛选无结果' : 'AI 机会分析尚未就绪，刷新页面重试' }}
        </div>

        <!-- 参考位:未达标的近似候选,明确不建议开仓 -->
        <div v-if="referenceOpps.length" class="opps-reference">
          <div class="ref-banner mono">
            参考位 · 未达标 · 仅供参考,不建议开仓
            <span class="dim">离达标线最近的几个,IVR 未及 {{ IVR_FLOOR }}</span>
          </div>
          <div class="ref-list">
            <div
              v-for="(o, i) in referenceOpps"
              :key="'ref' + i"
              class="ref-row"
              @click="goStrategy(o)"
              @keydown.enter="goStrategy(o)"
              tabindex="0"
              role="link"
            >
              <span class="ref-sym serif">{{ o.sym }}</span>
              <span class="ref-strat mono">{{ o.strategy }}</span>
              <span class="ref-ivr mono">
                IVR {{ o.ivr }} <span class="loss-text">&lt; {{ IVR_FLOOR }}</span>
              </span>
              <span class="ref-dte mono dim">{{ o.dte }}d</span>
              <span class="ref-thesis mono dim">{{ o.thesis }}</span>
            </div>
          </div>
        </div>
      </section>

      <!-- Watchlist -->
      <section class="watchlist-section">
        <div class="opps-head">
          <div>
            <div class="eyebrow">第三节</div>
            <div class="section-title serif" style="font-size: 28px">自选名单 · IV 全景</div>
          </div>
          <button class="btn ghost tiny" @click="openPalette">+ 添加标的</button>
        </div>
        <table class="watchlist">
          <thead>
            <tr>
              <th style="text-align: left">标的</th>
              <th style="text-align: right">最新</th>
              <th style="text-align: right">涨跌</th>
              <th style="text-align: right">IV</th>
              <th style="text-align: right">IVR</th>
              <th style="text-align: right">隐含波动 ±$</th>
              <th style="text-align: right">财报</th>
              <th style="text-align: left">引擎备注</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in data.tickers" :key="t.sym" @click="goTicker(t.sym)" @keydown.enter="goTicker(t.sym)" tabindex="0" role="link">
              <td class="sym-cell">
                <span class="sym">{{ t.sym }}</span>
                <span class="sym-name">{{ t.name }}</span>
              </td>
              <td class="tnum mono" style="text-align: right">
                <template v-if="t.px != null">{{ t.px.toFixed(2) }}</template>
                <span v-else class="dim">—</span>
              </td>
              <td
                class="tnum mono"
                :class="t.chg == null ? 'dim' : t.chg >= 0 ? 'up' : 'dn'"
                style="text-align: right"
              >
                <template v-if="t.chg != null">{{ fmtSigned(t.chg) }}%</template>
                <template v-else>—</template>
              </td>
              <td class="tnum mono" style="text-align: right">
                <template v-if="t.iv != null">{{ (t.iv * 100).toFixed(1) }}</template>
                <span v-else class="dim">—</span>
              </td>
              <td style="text-align: right">
                <span v-if="t.ivr != null" class="ivr-cell">
                  <span class="tnum mono">{{ t.ivr }}</span>
                  <span v-if="t.ivrSource === 'rv-fallback'" class="ivr-src" title="RV-based fallback (accumulating IV history)">rv</span>
                  <span class="ivr-bar">
                    <span :style="{ width: t.ivr + '%', background: t.ivr > 60 ? 'var(--accent)' : 'var(--ink-3)' }" />
                  </span>
                </span>
                <span v-else class="dim">—</span>
              </td>
              <td class="tnum mono" style="text-align: right">
                <template v-if="t.em != null">±{{ t.em.toFixed(1) }}</template>
                <span v-else class="dim">—</span>
              </td>
              <td class="tnum mono" style="text-align: right; color: var(--ink-3)">{{ t.earn }}</td>
              <td class="note-cell">{{ t.note }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>

    <div v-else-if="loading" class="loading mono">加载中…</div>
    <div v-else-if="error" class="error">⚠ {{ error }}</div>
  </div>
</template>

<style scoped>
/* Market session banner */
.market-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--ink-3);
  background: var(--paper-2);
  border: 1px solid var(--rule-hair);
  border-radius: 4px;
  padding: 8px 12px;
  margin-bottom: 18px;
}
.market-banner .mb-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ink-4);
  flex-shrink: 0;
}

.acc-em {
  font-style: italic;
  color: var(--accent);
}
.ital {
  font-style: italic;
}
.h-meta b { color: var(--ink) !important; font-weight: 500; }

/* Freshness indicator */
.freshness {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10.5px;
  color: var(--ink-3);
  margin-top: 4px;
}
.freshness.stale {
  color: var(--loss, #e53935);
}
.freshness-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--gain, #43a047);
  flex-shrink: 0;
}
.freshness-dot.stale {
  background: var(--loss, #e53935);
  animation: pulse-dot 1.5s ease-in-out infinite;
}
.freshness-warn {
  font-weight: 600;
}
@keyframes pulse-dot {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

/* "—" placeholders for unavailable live values */
.dim { color: var(--ink-4); }

/* AI-loading skeleton blocks (no seed data, no fallback prose) */
.skeleton {
  display: inline-block;
  background: linear-gradient(
    90deg,
    var(--paper-2) 0%,
    var(--paper-3) 50%,
    var(--paper-2) 100%
  );
  background-size: 200% 100%;
  animation: shimmer 1.6s linear infinite;
  border-radius: 2px;
}
.skeleton-line {
  height: 1em;
  width: 100%;
  vertical-align: middle;
}
.skeleton-line.short {
  width: 60%;
}
.skeleton-h1 {
  height: 0.85em;
  width: 80%;
}
.skeleton-h1.short {
  width: 55%;
}
.skeleton-dot {
  background: var(--paper-3);
  animation: shimmer 1.6s linear infinite;
}
@keyframes shimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

.ai-tag {
  display: inline-block;
  margin-left: 10px;
  padding: 1px 7px;
  font-size: 9px;
  letter-spacing: 0.08em;
  background: var(--accent-2);
  color: var(--accent);
  font-weight: 600;
  vertical-align: 2px;
}
.ai-tag.dim {
  background: var(--paper-3);
  color: var(--ink-4);
}
.ai-tag.inline { vertical-align: 1px; padding: 0 6px; }

.hero-line :deep(em) {
  font-style: italic;
  color: var(--accent);
}

/* ===== hero (mood + engine) ===== */
.hero {
  display: grid;
  grid-template-columns: 1.1fr 2fr;
  gap: 0;
  border-top: 1px solid var(--rule);
  border-bottom: 1px solid var(--rule);
}
.hero-mood {
  padding: 26px 28px 22px;
  border-right: 1px solid var(--rule);
}
.hero-engine {
  padding: 26px 36px 22px;
}

/* mood block */
.mood-num {
  display: flex;
  align-items: baseline;
  gap: 14px;
}
.mood-num .num {
  font-family: var(--serif);
  font-size: 72px;
  line-height: 0.9;
  font-weight: 600;
  letter-spacing: -0.03em;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}
.mood-label {
  font-size: 20px;
  font-weight: 600;
  color: var(--accent);
}
.mood-sub {
  font-size: 11px;
  color: var(--ink-3);
  margin-top: 2px;
}

.mood-bar {
  position: relative;
  height: 10px;
  margin-top: 22px;
}
.mood-bar-grad {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    oklch(0.55 0.18 25) 0%,
    oklch(0.78 0.10 75) 35%,
    oklch(0.85 0.04 90) 50%,
    oklch(0.75 0.10 145) 70%,
    oklch(0.55 0.16 145) 100%
  );
}
.mood-marker {
  position: absolute;
  top: -6px;
  bottom: -6px;
  width: 2px;
  background: var(--ink);
  transform: translateX(-1px);
}
.mood-arrow {
  position: absolute;
  top: -12px;
  transform: translateX(-50%);
  width: 0;
  height: 0;
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
  border-top: 6px solid var(--ink);
}
.mood-scale {
  display: flex;
  justify-content: space-between;
  font-size: 9.5px;
  color: var(--ink-3);
  margin-top: 8px;
  letter-spacing: 0.04em;
}

.factors {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.factor {
  display: grid;
  grid-template-columns: 8px 1fr;
  gap: 10px;
  align-items: baseline;
}
.factor-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-top: 5px;
}
.factor-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--ink);
}
.factor-detail {
  font-size: 11px;
  color: var(--ink-3);
  margin-top: 1px;
}

/* engine block */
.engine-prose {
  font-size: 22px;
  line-height: 1.45;
  font-weight: 500;
  letter-spacing: -0.01em;
  max-width: 62ch;
  margin: 0;
  color: var(--ink-2);
}
.bucket-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  margin-top: 22px;
  border-top: 1px solid var(--rule-hair);
}
.bucket {
  padding: 14px 16px 0;
  border-right: 1px solid var(--rule-hair);
}
.bucket:last-child { border-right: 0; }
.bucket-v {
  font-size: 30px;
  font-weight: 600;
  line-height: 1;
}
.bucket-hint {
  font-size: 10px;
  color: var(--ink-3);
  margin-top: 2px;
}

/* ===== opps ===== */
.opps-section { margin-top: 44px; }
.opps-empty {
  padding: 48px 0;
  text-align: center;
  font-size: 12px;
  border-top: 1px solid var(--rule);
}

/* Honest stand-aside (nothing cleared the bar) */
.opps-standby {
  padding: 44px 0 40px;
  text-align: center;
  border-top: 1px solid var(--rule);
}
.standby-title {
  font-size: 24px;
  font-weight: 500;
  color: var(--ink);
}
.standby-sub {
  margin-top: 10px;
  font-size: 12.5px;
  color: var(--ink-3);
}

/* 参考位 — sub-threshold, explicitly not a recommendation */
.opps-reference {
  margin-top: 26px;
  border-top: 1px dashed var(--rule);
  padding-top: 16px;
}
.ref-banner {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  align-items: baseline;
  font-size: 11px;
  letter-spacing: 0.06em;
  color: var(--loss);
  margin-bottom: 10px;
}
.ref-banner .dim { letter-spacing: 0; }
.ref-list { display: flex; flex-direction: column; }
.ref-row {
  display: grid;
  grid-template-columns: 64px 96px 120px 48px 1fr;
  align-items: baseline;
  gap: 12px;
  padding: 9px 4px;
  border-bottom: 1px dashed var(--rule-hair);
  cursor: pointer;
  opacity: 0.72;
  transition: opacity 0.15s, background 0.15s;
}
.ref-row:hover { opacity: 1; background: var(--paper-2); }
.ref-sym { font-size: 15px; font-weight: 500; color: var(--ink); }
.ref-strat { font-size: 12.5px; color: var(--ink-2); }
.ref-ivr { font-size: 12px; color: var(--ink-2); }
.ref-dte { font-size: 11.5px; }
.ref-thesis { font-size: 12px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.opps-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 18px;
}
.section-title {
  font-size: 36px;
  font-weight: 500;
  letter-spacing: -0.02em;
  margin-top: 4px;
}
.opps-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  border-top: 1px solid var(--rule);
}
.opp {
  padding: 26px 28px 24px;
  border-right: 1px solid var(--rule);
  border-bottom: 1px solid var(--rule);
  cursor: pointer;
  transition: background 0.15s;
}
.opp.rt { border-right: 0; }
.opp.bt { border-bottom: 0; }
/* A lone trailing card fills the row instead of leaving an empty half. */
.opps-grid.solo { grid-template-columns: 1fr; }
.opp.full { grid-column: 1 / -1; border-right: 0; }
.opp:hover { background: var(--paper-2); }

.opp-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 12px;
}
.opp-head-left {
  display: flex;
  align-items: baseline;
  gap: 12px;
}
.opp-no {
  font-size: 10px;
  color: var(--ink-4);
}
.opp-sym {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.opp-edge {
  font-size: 11px;
  color: var(--accent);
  font-weight: 600;
}
.opp-strategy {
  font-size: 24px;
  line-height: 1.2;
  font-weight: 500;
  letter-spacing: -0.01em;
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.ai-view-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 10px;
  letter-spacing: 0.02em;
  white-space: nowrap;
  font-family: var(--font-mono);
}
.view-bullish {
  background: rgba(0, 200, 83, 0.12);
  color: #00c853;
}
.view-bearish {
  background: rgba(255, 82, 82, 0.12);
  color: #ff5252;
}
.view-neutral {
  background: rgba(255, 193, 7, 0.12);
  color: #ffc107;
}
.view-neutral-vol {
  background: rgba(156, 39, 176, 0.12);
  color: #ab47bc;
}
.opp-thesis {
  color: var(--ink-2);
  margin-top: 6px;
  font-size: 14px;
}
/* legs & levels */
.opp-legs {
  margin-top: 12px;
  padding: 10px 12px;
  background: var(--paper-2, #faf9f7);
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.7;
}
.opp-legs-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.leg-action {
  font-weight: 700;
  font-size: 11px;
  width: 18px;
  text-align: center;
}
.leg-action.buy { color: var(--gain, #43a047); }
.leg-action.sell { color: var(--loss, #e53935); }
.leg-type {
  color: var(--ink-2);
  width: 28px;
}
.leg-strike {
  font-weight: 600;
  color: var(--ink);
}
.leg-premium {
  margin-left: 4px;
  font-size: 11px;
}
.opp-levels {
  display: flex;
  gap: 16px;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--rule-hair);
  font-size: 11px;
  color: var(--ink-3);
}
.level-item b {
  color: var(--ink);
  font-weight: 600;
  margin-left: 3px;
}
.level-item b.loss-text {
  color: var(--loss, #e53935);
}

.opp-why {
  font-size: 13px;
  line-height: 1.6;
  color: var(--ink-2);
  margin: 14px 0 0;
  max-width: 52ch;
  text-wrap: pretty;
}
.opp-analysis {
  margin-top: 14px;
  padding: 12px 14px;
  background: var(--paper-2, #faf9f7);
  border-radius: 6px;
  border-left: 3px solid var(--accent, #c45a3c);
}
.opp-analysis-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--accent, #c45a3c);
  margin-bottom: 6px;
}
.opp-analysis-text {
  font-size: 13px;
  line-height: 1.7;
  color: var(--ink-1);
  margin: 0;
  text-wrap: pretty;
}
.opp-stats {
  display: flex;
  gap: 20px;
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid var(--rule-hair);
  flex-wrap: wrap;
}
.stat-l {
  font-size: 9.5px;
  letter-spacing: 0.1em;
  color: var(--ink-3);
}
.stat-v {
  font-size: 18px;
  font-weight: 500;
  margin-top: 2px;
}
.stat-sub {
  font-size: 10px;
  color: var(--ink-3);
  margin-top: 1px;
}

.opp-mgmt {
  margin-top: 14px;
  padding: 10px 14px;
  background: var(--paper-2, #faf9f7);
  border-radius: 6px;
  border-left: 3px solid var(--ink-3, #9a958c);
}
.opp-mgmt-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--ink-3);
  margin-bottom: 8px;
}
.opp-mgmt-rules {
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--ink-3);
}
.mgmt-item b {
  color: var(--ink);
  font-weight: 600;
  margin-left: 4px;
}
.mgmt-item b.loss-text {
  color: var(--loss, #e53935);
}
.opp-mgmt-note {
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--ink-2);
  margin: 8px 0 0;
  text-wrap: pretty;
}

/* ===== watchlist ===== */
.watchlist-section { margin-top: 56px; }
.watchlist {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--mono);
  font-size: 12px;
}
.watchlist thead tr {
  border-top: 1px solid var(--rule);
  border-bottom: 1px solid var(--rule);
}
.watchlist th {
  padding: 9px 10px;
  font-weight: 500;
  color: var(--ink-3);
  font-size: 10.5px;
  letter-spacing: 0.06em;
}
.watchlist tbody tr {
  cursor: pointer;
  border-bottom: 1px solid var(--rule-hair);
}
.watchlist tbody tr:hover { background: var(--paper-2); }
.watchlist td {
  padding: 11px 10px;
}
.sym-cell .sym {
  font-family: var(--sans);
  font-weight: 500;
  font-size: 13.5px;
}
.sym-cell .sym-name {
  color: var(--ink-3);
  font-weight: 400;
  font-size: 11px;
  margin-left: 8px;
}
.ivr-cell {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.ivr-src {
  font-family: var(--mono);
  font-size: 8px;
  letter-spacing: 0.05em;
  color: var(--ink-4);
  text-transform: uppercase;
  opacity: 0.7;
}
.ivr-bar {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 4px;
  background: var(--paper-3);
}
.ivr-bar span {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
}
.note-cell {
  color: var(--ink-2);
  font-family: var(--sans);
  font-size: 12px;
}

/* loading / error */
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

@media (max-width: 1100px) {
  .hero { grid-template-columns: 1fr; }
  .hero-mood { border-right: 0; border-bottom: 1px solid var(--rule); }
  .opps-grid { grid-template-columns: 1fr; }
  .opp { border-right: 0; }
}

/* ===== held chip ===== */
.held-chip {
  font-size: 10px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--accent-soft, rgba(196,255,61,0.15));
  color: var(--accent);
  letter-spacing: 0.02em;
}
.lowconv-chip {
  font-size: 10px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--loss-wash);
  color: var(--loss);
  letter-spacing: 0.02em;
  cursor: help;
}

/* ===== drift alerts ===== */
.drift-section {
  margin-top: 32px;
  padding: 18px 0;
  border-top: 1px solid var(--rule);
}
.drift-alerts {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.drift-alert {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid var(--rule);
  background: var(--paper);
  cursor: pointer;
  transition: border-color 0.15s;
}
.drift-alert:hover { border-color: var(--accent); }
.drift-alert.neg { border-color: var(--loss); background: var(--loss-wash, rgba(239,68,68,0.04)); }
.drift-alert-sym { font-size: 13px; font-weight: 800; color: var(--ink); }
.drift-alert-delta { font-size: 14px; font-weight: 800; }
.drift-alert-vs { font-size: 10px; color: var(--ink-3); }
</style>
