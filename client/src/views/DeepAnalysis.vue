<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useDeepAnalysisStore } from '@/composables/useDeepAnalysisStore'
import { useThesisDrift } from '@/composables/useThesisDrift'
import { usePositions } from '@/composables/usePositions'
import type { DeepAnalysis, OcifqDimension, ThesisItem, CallTone, View } from '@/types'

const route = useRoute()
const router = useRouter()
const store = useDeepAnalysisStore()
const drift = useThesisDrift()
const { heldSymbols } = usePositions()

const routeSymbol = computed(() => (route.query.symbol as string)?.toUpperCase() ?? '')
const searchInput = ref('')

// Derived from store
const { data, loading, error, recentSymbols } = store

// Thesis drift for current symbol
const currentDrift = computed(() => {
  if (!data.value) return null
  return drift.getDrift(data.value.symbol, data.value)
})

// Is this a held position?
const isHeld = computed(() =>
  data.value ? heldSymbols.value.includes(data.value.symbol) : false
)

/** Map OCIFQ view → Recommend engine view */
function ocifqViewToEngineView(view: DeepAnalysis['view']): View {
  switch (view) {
    case 'bullish': return 'bullish'
    case 'bearish': return 'bearish'
    default: return 'neutral'
  }
}

function goRecommend() {
  if (!data.value) return
  const view = ocifqViewToEngineView(data.value.view)
  // Don't guess volExpect from fundamental score — it has nothing to do with
  // IV richness. The Recommend page derives it from the real IV Rank once the
  // option chain is loaded (from=deep triggers that auto-tuning).
  router.push({
    path: '/recommend',
    query: { sym: data.value.symbol, view, from: 'deep' }
  })
}

function dimensionColor(signal: OcifqDimension['signal']): string {
  switch (signal) {
    case 'bullish': return 'var(--gain)'
    case 'bearish': return 'var(--loss)'
    default: return 'var(--ink-3)'
  }
}

function scoreColor(score: number): string {
  if (score >= 7) return 'var(--gain)'
  if (score >= 5) return 'var(--accent)'
  return 'var(--loss)'
}

function totalGrade(total: number): { label: string; color: string } {
  if (total >= 80) return { label: 'A', color: 'var(--gain)' }
  if (total >= 65) return { label: 'B', color: 'var(--gain)' }
  if (total >= 50) return { label: 'C', color: 'var(--accent)' }
  if (total >= 35) return { label: 'D', color: 'var(--loss)' }
  return { label: 'F', color: 'var(--loss)' }
}

function thesisStatusConfig(status: ThesisItem['status']) {
  switch (status) {
    case 'validated': return { label: 'Validated', icon: '✓', color: 'var(--gain)', bg: 'var(--gain-soft)' }
    case 'challenged': return { label: 'Challenged', icon: '⚠', color: 'var(--loss)', bg: 'var(--loss-soft)' }
    default: return { label: 'No change', icon: '—', color: 'var(--ink-3)', bg: 'var(--tint-1)' }
  }
}

function viewLabel(view: DeepAnalysis['view']): string {
  switch (view) {
    case 'bullish': return '↑ Bullish'
    case 'bearish': return '↓ Bearish'
    default: return '↔ Neutral'
  }
}

function viewColor(view: DeepAnalysis['view']): string {
  switch (view) {
    case 'bullish': return 'var(--gain)'
    case 'bearish': return 'var(--loss)'
    default: return 'var(--ink-3)'
  }
}

// Highlight tone words in quotes
function highlightToneWords(quote: string, callTone: CallTone): string {
  // Escape HTML first
  let html = quote.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  // Collect all words to highlight
  const confWords = (callTone.confidenceWords ?? []).map(w => w.word)
  const hedgeWords = (callTone.hedgeWords ?? []).map(w => w.word)

  // Build a single regex for each category, match word stems
  if (hedgeWords.length > 0) {
    const pattern = hedgeWords.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
    html = html.replace(new RegExp(`\\b((?:${pattern})\\w*)\\b`, 'gi'),
      '<mark class="hl-hedge">$1</mark>')
  }
  if (confWords.length > 0) {
    const pattern = confWords.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
    html = html.replace(new RegExp(`\\b((?:${pattern})\\w*)\\b`, 'gi'),
      '<mark class="hl-conf">$1</mark>')
  }

  return html
}

// Radar chart helpers
const RADAR_KEYS = ['O', 'C', 'I', 'F', 'Q'] as const
const radarDims = computed(() => {
  if (!data.value) return []
  return RADAR_KEYS.map(k => data.value!.dimensions.find(d => d.key === k) ?? { key: k, score: 0, maxScore: 10 })
})

/** Get (x, y) for a radar vertex. Index 0 = top (O), clockwise. */
function radarPoint(index: number, value: number): [number, number] {
  const angle = (Math.PI * 2 * index) / 5 - Math.PI / 2
  const r = (value / 10) * 72 // max radius = 72px within 200x200 viewBox
  return [100 + r * Math.cos(angle), 100 + r * Math.sin(angle)]
}

function radarGrid(level: number): string {
  return Array.from({ length: 5 }, (_, i) => radarPoint(i, level).join(',')).join(' ')
}

const radarData = computed(() => {
  if (!radarDims.value.length) return ''
  return radarDims.value.map((d, i) => radarPoint(i, d.score).join(',')).join(' ')
})

function radarLabelPos(index: number): [number, number] {
  const [x, y] = radarPoint(index, 11.8)
  return [x, y - 4]
}

function radarScorePos(index: number): [number, number] {
  const [x, y] = radarPoint(index, 11.8)
  return [x, y + 10]
}

function radarAnchor(index: number): string {
  if (index === 0) return 'middle'
  if (index === 1 || index === 2) return 'start'
  return 'end'
}

// CallTone helpers
function guidanceToneLabel(tone?: string): string {
  switch (tone) {
    case 'raise': return 'Raise ↑'
    case 'maintain': return 'Maintain →'
    case 'lower': return 'Lower ↓'
    default: return 'N/A'
  }
}
function guidanceToneClass(tone?: string): string {
  if (tone === 'raise') return 'up'
  if (tone === 'lower') return 'dn'
  return ''
}
function toneShiftLabel(shift?: string): string {
  switch (shift) {
    case 'improving': return '转好 ↑'
    case 'stable': return '稳定 →'
    case 'deteriorating': return '转弱 ↓'
    default: return '未知'
  }
}
function toneShiftClass(shift?: string): string {
  if (shift === 'improving') return 'up'
  if (shift === 'deteriorating') return 'dn'
  return ''
}

function freshness(): string {
  if (!data.value?.generatedAt) return ''
  const diff = (Date.now() - new Date(data.value.generatedAt).getTime()) / 60_000
  if (diff < 1) return '刚刚生成'
  if (diff < 60) return `${Math.round(diff)} 分钟前生成`
  return `${Math.floor(diff / 60)} 小时前生成`
}

function goSymbol() {
  const s = searchInput.value.trim().toUpperCase()
  if (!s) return
  searchInput.value = ''
  router.push({ path: '/deep', query: { symbol: s } })
}

function pickRecent(sym: string) {
  router.push({ path: '/deep', query: { symbol: sym } })
}

onMounted(() => { if (routeSymbol.value) store.load(routeSymbol.value) })
watch(routeSymbol, (s) => { if (s) store.load(s) })
</script>

<template>
  <div class="page">
    <!-- Search bar when no symbol -->
    <div v-if="!routeSymbol" class="empty-state">
      <div class="eyebrow" style="margin-bottom: 14px">
        OCIFQ DEEP ANALYSIS
        <span class="ai-chip">AI</span>
      </div>
      <div class="h-title serif" style="margin-bottom: 8px">深度基本面分析</div>
      <div class="h-deck" style="margin-bottom: 24px">
        输入标的代码，生成五维 OCIFQ 评分
      </div>
      <form class="search-form" @submit.prevent="goSymbol">
        <input
          v-model="searchInput"
          class="search-input"
          placeholder="输入代码，如 AMD"
          autofocus
        />
        <button class="btn accent" type="submit" :disabled="!searchInput.trim()">分析</button>
      </form>

      <!-- Recent analyses -->
      <div v-if="recentSymbols.length > 0" class="recent-section">
        <div class="eyebrow" style="margin-bottom: 12px; justify-content: center">最近分析</div>
        <div class="recent-grid">
          <button
            v-for="r in recentSymbols"
            :key="r.symbol"
            class="recent-card"
            @click="pickRecent(r.symbol)"
          >
            <div class="recent-top">
              <span class="recent-sym mono">{{ r.symbol }}</span>
              <span class="recent-score mono" :style="{ color: totalGrade(r.total).color }">
                {{ r.total }}
                <span class="recent-grade">{{ totalGrade(r.total).label }}</span>
              </span>
            </div>
            <div class="recent-name">{{ r.name }}</div>
            <div class="recent-view" :style="{ color: viewColor(r.view) }">{{ viewLabel(r.view) }}</div>
          </button>
        </div>
      </div>
    </div>

    <!-- Loading -->
    <div v-else-if="loading" class="loading-state">
      <div class="loading-ring" />
      <div class="loading-text">
        正在分析 <strong>{{ routeSymbol }}</strong> ...
        <div class="loading-sub">收集财务数据 · 分析师评级 · 新闻 · AI 评分</div>
      </div>
    </div>

    <!-- Error -->
    <div v-else-if="error" class="error-state">
      <div class="error-icon">!</div>
      <div class="error-msg">{{ error }}</div>
      <button class="btn ghost tiny" @click="store.load(routeSymbol, true)">重试</button>
    </div>

    <!-- Data -->
    <template v-else-if="data">
      <!-- Header -->
      <div class="page-head">
        <div>
          <div class="eyebrow" style="margin-bottom: 14px">
            OCIFQ DEEP ANALYSIS
            <span class="ai-chip">AI</span>
          </div>
          <div class="head-row">
            <div class="h-title serif">{{ data.symbol }}</div>
            <span class="h-name">{{ data.name }}</span>
            <span
              class="view-pill"
              :style="{ color: viewColor(data.view), borderColor: viewColor(data.view) }"
            >
              {{ viewLabel(data.view) }}
              <span class="mono" style="opacity:.7; margin-left:4px">{{ data.viewConfidence }}%</span>
            </span>
            <span v-if="isHeld" class="held-badge">已持仓</span>
          </div>
          <div class="h-deck">
            {{ data.industry }}
            <template v-if="data.marketCap"> · ${{ (data.marketCap / 1000).toFixed(1) }}B</template>
            <template v-if="data.peers.length"> · Peers: {{ data.peers.slice(0, 5).join(', ') }}</template>
          </div>
        </div>
        <div class="h-meta">
          <form class="search-form compact" @submit.prevent="goSymbol">
            <input v-model="searchInput" class="search-input small" placeholder="换一个..." />
            <button class="btn ghost tiny" type="submit">Go</button>
          </form>
          <div style="display: flex; align-items: center; gap: 8px; justify-content: flex-end; margin-top: 6px">
            <div class="freshness mono">
              <span class="freshness-dot" />
              {{ freshness() }}
            </div>
            <button class="btn ghost tiny" @click="store.load(routeSymbol, true)" :disabled="loading">
              {{ loading ? '...' : '↻' }}
            </button>
          </div>
          <!-- Quick switch to recent -->
          <div v-if="recentSymbols.length > 1" class="recent-pills">
            <button
              v-for="r in recentSymbols.filter(x => x.symbol !== routeSymbol)"
              :key="r.symbol"
              class="recent-pill"
              @click="pickRecent(r.symbol)"
            >
              {{ r.symbol }}
              <span class="mono" style="opacity:.6; margin-left: 2px">{{ r.total }}</span>
            </button>
          </div>
        </div>
      </div>

      <!-- Score overview card -->
      <div class="score-hero">
        <div class="score-radar-wrap">
          <svg viewBox="0 0 200 200" class="radar-svg">
            <!-- Grid rings -->
            <polygon v-for="level in [2, 4, 6, 8, 10]" :key="'grid-'+level"
              :points="radarGrid(level)" class="radar-grid" />
            <!-- Axis lines -->
            <line v-for="(_, i) in 5" :key="'axis-'+i"
              x1="100" y1="100"
              :x2="radarPoint(i, 10)[0]" :y2="radarPoint(i, 10)[1]"
              class="radar-axis" />
            <!-- Data polygon -->
            <polygon :points="radarData" class="radar-fill" :style="{ '--radar-color': totalGrade(data.scores.total).color }" />
            <polygon :points="radarData" class="radar-stroke" :style="{ '--radar-color': totalGrade(data.scores.total).color }" />
            <!-- Dimension labels + scores at vertices -->
            <template v-for="(d, i) in radarDims" :key="'label-'+i">
              <text :x="radarLabelPos(i)[0]" :y="radarLabelPos(i)[1]"
                class="radar-label" :text-anchor="radarAnchor(i)">
                {{ d.key }}
              </text>
              <text :x="radarScorePos(i)[0]" :y="radarScorePos(i)[1]"
                class="radar-score-label" :text-anchor="radarAnchor(i)"
                :fill="scoreColor(d.score)">
                {{ d.score }}
              </text>
            </template>
            <!-- Center total -->
            <text x="100" y="96" class="radar-total">{{ data.scores.total }}</text>
            <text x="100" y="112" class="radar-total-label">TOTAL</text>
          </svg>
        </div>
        <div class="score-bars">
          <div
            v-for="d in data.dimensions"
            :key="d.key"
            class="score-bar-row"
          >
            <span class="bar-key mono">{{ d.key }}</span>
            <span class="bar-label">{{ d.label }}</span>
            <div class="bar-track">
              <div
                class="bar-fill"
                :style="{ width: (d.score / d.maxScore * 100) + '%', background: scoreColor(d.score) }"
              />
            </div>
            <span class="bar-score mono" :style="{ color: scoreColor(d.score) }">{{ d.score }}</span>
          </div>
        </div>
      </div>

      <!-- Two-column layout -->
      <div class="deep-grid">
        <!-- Left: dimensions detail -->
        <div class="deep-main">
          <div class="section-head">
            <div class="eyebrow">五维详解</div>
          </div>

          <div
            v-for="dim in data.dimensions"
            :key="dim.key"
            class="dim-card"
          >
            <div class="dim-header">
              <span class="dim-key mono" :style="{ color: dimensionColor(dim.signal) }">{{ dim.key }}</span>
              <span class="dim-title">{{ dim.label }}</span>
              <span class="dim-score mono" :style="{ color: scoreColor(dim.score) }">{{ dim.score }}/{{ dim.maxScore }}</span>
              <span class="dim-signal-pill" :style="{ color: dimensionColor(dim.signal), borderColor: dimensionColor(dim.signal) }">
                {{ dim.signal }}
              </span>
            </div>
            <div class="dim-reasoning">{{ dim.reasoning }}</div>
            <div class="dim-evidence" v-if="dim.evidence.length">
              <div v-for="(ev, i) in dim.evidence" :key="i" class="evidence-item">
                <span class="ev-bullet" :style="{ background: dimensionColor(dim.signal) }" />
                {{ ev }}
              </div>
            </div>
          </div>

          <!-- Option implication -->
          <div class="impl-card">
            <div class="eyebrow" style="margin-bottom: 8px">期权策略启示</div>
            <div class="impl-text">{{ data.optionImplication }}</div>
          </div>

          <!-- CTA: Go build a strategy -->
          <div class="cta-card">
            <div class="cta-left">
              <div class="cta-title">基于此分析建仓</div>
              <div class="cta-sub">
                AI 判断 <strong :style="{ color: viewColor(data.view) }">{{ viewLabel(data.view) }}</strong>
                · 信心 {{ data.viewConfidence }}%
                — 直接跳到策略推荐引擎
              </div>
            </div>
            <button class="btn accent cta-btn" @click="goRecommend">
              选策略 →
            </button>
          </div>
        </div>

        <!-- Right: thesis tracker + summary -->
        <div class="deep-side">
          <!-- Summary card -->
          <div class="summary-card">
            <div class="eyebrow" style="margin-bottom: 8px">
              AI 总结
              <span class="ai-chip" style="margin-left: 6px">AI</span>
            </div>
            <div class="summary-text">{{ data.summary }}</div>
          </div>

          <!-- Thesis drift alert -->
          <div v-if="currentDrift && currentDrift.significant" class="drift-card" :class="{ 'drift-neg': currentDrift.totalDelta !== null && currentDrift.totalDelta < 0 }">
            <div class="drift-header">
              <span class="drift-icon">{{ currentDrift.totalDelta !== null && currentDrift.totalDelta < 0 ? '↘' : '↗' }}</span>
              <span class="drift-title">Thesis Drift</span>
            </div>
            <div class="drift-label mono">
              {{ currentDrift.label }}
              <span class="drift-date">vs {{ currentDrift.previous?.date }}</span>
            </div>
            <div v-if="currentDrift.dimensionDeltas.length" class="drift-dims">
              <span
                v-for="dd in currentDrift.dimensionDeltas"
                :key="dd.key"
                class="drift-dim mono"
                :style="{ color: dd.delta > 0 ? 'var(--gain)' : 'var(--loss)' }"
              >
                {{ dd.key }} {{ dd.delta > 0 ? '+' : '' }}{{ dd.delta }}
              </span>
            </div>
          </div>

          <!-- Thesis tracker -->
          <div class="section-head">
            <div class="eyebrow">Thesis Tracker</div>
          </div>
          <div
            v-if="data.quarterContext?.lag && data.quarterContext.message"
            class="quarter-lag-banner"
            role="status"
          >
            {{ data.quarterContext.message }}
            <span class="quarter-lag-detail mono">
              FMP {{ data.quarterContext.fmpLatest ?? '—' }}
              · Transcript {{ data.quarterContext.transcriptLatest ?? '—' }}
            </span>
          </div>
          <div class="thesis-list">
            <div
              v-for="t in data.thesisItems"
              :key="t.id"
              class="thesis-card"
            >
              <div class="thesis-header">
                <span class="thesis-num mono">#{{ t.id }}</span>
                <span class="thesis-text">{{ t.text }}</span>
              </div>
              <div class="thesis-status-row">
                <span
                  class="thesis-pill"
                  :style="{
                    color: thesisStatusConfig(t.status).color,
                    background: thesisStatusConfig(t.status).bg
                  }"
                >
                  {{ thesisStatusConfig(t.status).icon }} {{ thesisStatusConfig(t.status).label }}
                </span>
                <span class="thesis-date">{{ t.date }}</span>
                <span v-if="t.referenceQuarter" class="thesis-ref-q mono">{{ t.referenceQuarter }}</span>
              </div>
              <div class="thesis-delta">{{ t.delta }}</div>
              <div v-if="t.invalidation" class="thesis-invalidation">
                <span class="thesis-inv-label">证伪条件</span>
                <span class="thesis-inv-text">{{ t.invalidation }}</span>
              </div>
            </div>
          </div>

          <!-- Data stats -->
          <div class="stats-card">
            <div class="eyebrow" style="margin-bottom: 8px">数据来源</div>
            <div class="stat-row"><span>新闻扫描</span><span class="mono">{{ data.dataStats.newsCount }} 篇</span></div>
            <div class="stat-row"><span>季报数据</span><span class="mono">{{ data.dataStats.earningsQuarters }} 季度</span></div>
            <div class="stat-row"><span>财报明细</span><span class="mono">{{ data.dataStats.fmpIncomeQuarters ?? 0 }} 季度</span></div>
            <div class="stat-row"><span>Transcript</span><span class="mono">{{ data.dataStats.transcriptQuarters ?? 0 }} 季度</span></div>
            <div v-if="data.quarterContext?.fmpLatest" class="stat-row">
              <span>FMP 最新季</span><span class="mono">{{ data.quarterContext.fmpLatest }}</span>
            </div>
            <div v-if="data.quarterContext?.transcriptLatest" class="stat-row">
              <span>电话会最新季</span><span class="mono">{{ data.quarterContext.transcriptLatest }}</span>
            </div>
            <div class="stat-row"><span>Peers</span><span class="mono">{{ data.dataStats.peersCount }} 家</span></div>
          </div>
        </div>
      </div>

      <!-- CALL TONE — full width below the scorecard/thesis grid -->
      <section v-if="data.callTone?.available" class="calltone-section">
        <div class="eyebrow" style="margin-bottom: 14px">
          CALL TONE · {{ data.callTone.quarter }}
        </div>
        <div class="ct-grid">
          <div class="ct-col-meta">
            <!-- Confidence gauge -->
            <div class="ct-gauge">
              <div class="ct-gauge-label">管理层信心</div>
              <div class="ct-gauge-bar">
                <div
                  class="ct-gauge-fill"
                  :style="{
                    width: (data.callTone.confidenceScore ?? 50) + '%',
                    background: (data.callTone.confidenceScore ?? 50) >= 60
                      ? 'var(--gain)' : (data.callTone.confidenceScore ?? 50) <= 40
                      ? 'var(--loss)' : 'var(--ink-3)'
                  }"
                />
              </div>
              <div class="ct-gauge-val mono">{{ data.callTone.confidenceScore }}/100</div>
            </div>

            <!-- Word counts -->
            <div class="ct-words">
              <div class="ct-word-chip gain">
                <span class="ct-word-n mono">{{ data.callTone.confidenceWordCount }}</span>
                <span class="ct-word-l">信心词</span>
              </div>
              <div class="ct-word-chip loss">
                <span class="ct-word-n mono">{{ data.callTone.hedgeWordCount }}</span>
                <span class="ct-word-l">对冲词</span>
              </div>
            </div>
            <!-- Confidence word tags -->
            <div v-if="data.callTone.confidenceWords?.length" class="ct-word-tags">
              <span
                v-for="w in data.callTone.confidenceWords"
                :key="'c-'+w.word"
                class="ct-tag ct-tag-gain"
              >{{ w.word }}<span class="ct-tag-count mono">×{{ w.count }}</span></span>
            </div>
            <!-- Hedge word tags -->
            <div v-if="data.callTone.hedgeWords?.length" class="ct-word-tags">
              <span
                v-for="w in data.callTone.hedgeWords"
                :key="'h-'+w.word"
                class="ct-tag ct-tag-loss"
              >{{ w.word }}<span class="ct-tag-count mono">×{{ w.count }}</span></span>
            </div>

            <!-- Guidance + Shift -->
            <div class="ct-meta">
              <div class="ct-meta-item">
                <span class="ct-meta-l">Guidance</span>
                <span class="ct-meta-v mono" :class="guidanceToneClass(data.callTone.guidanceTone)">
                  {{ guidanceToneLabel(data.callTone.guidanceTone) }}
                </span>
              </div>
              <div class="ct-meta-item">
                <span class="ct-meta-l">语气变化</span>
                <span class="ct-meta-v mono" :class="toneShiftClass(data.callTone.toneShift)">
                  {{ toneShiftLabel(data.callTone.toneShift) }}
                </span>
              </div>
            </div>
          </div>

          <div class="ct-col-quotes">
            <!-- Confidence key quotes -->
            <div v-if="data.callTone.confidenceQuotes?.length" class="ct-quotes">
              <div class="ct-quotes-label gain">📈 信心关键句</div>
              <div class="ct-quote" v-for="(q, i) in data.callTone.confidenceQuotes" :key="'cq-'+i">
                <span class="ct-quote-mark">"</span>
                <span class="ct-quote-text">{{ q }}</span>
              </div>
            </div>
            <!-- Hedge key quotes -->
            <div v-if="data.callTone.hedgeQuotes?.length" class="ct-quotes">
              <div class="ct-quotes-label loss">⚠️ 对冲关键句</div>
              <div class="ct-quote" v-for="(q, i) in data.callTone.hedgeQuotes" :key="'hq-'+i">
                <span class="ct-quote-mark">"</span>
                <span class="ct-quote-text">{{ q }}</span>
              </div>
            </div>
            <!-- Summary -->
            <div v-if="data.callTone.summary" class="ct-summary">
              {{ data.callTone.summary }}
            </div>
          </div>
        </div>
      </section>
      <section v-else class="calltone-section calltone-hint">
        <div class="eyebrow" style="margin-bottom: 6px">CALL TONE</div>
        <div class="ct-hint-text">
          无 Earnings Call Transcript 数据。升级 FMP Starter 后自动激活管理层语气分析。
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.page {
  padding: 32px 40px 64px;
  max-width: 1200px;
  margin: 0 auto;
}

/* --- Header --- */
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 28px;
}
.eyebrow {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--ink-3);
  text-transform: uppercase;
  display: flex;
  align-items: center;
  gap: 8px;
}
.ai-chip {
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.06em;
  padding: 2px 7px;
  border-radius: 4px;
  background: var(--accent-soft);
  color: var(--accent);
}
.h-title {
  font-size: 34px;
  font-weight: 800;
  letter-spacing: -0.5px;
  color: var(--ink-1);
  line-height: 1.1;
}
.serif { font-family: 'Georgia', serif; }
.head-row {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
}
.h-name {
  font-size: 16px;
  color: var(--ink-2);
  font-weight: 500;
}
.view-pill {
  font-size: 12px;
  font-weight: 700;
  padding: 3px 10px;
  border-radius: 6px;
  border: 1px solid;
}
.h-deck {
  font-size: 14px;
  color: var(--ink-3);
  margin-top: 6px;
  line-height: 1.5;
}
.h-meta {
  text-align: right;
  flex-shrink: 0;
}
.mono { font-variant-numeric: tabular-nums; font-family: 'SF Mono', 'Fira Code', monospace; }

/* --- Search --- */
.search-form { display: flex; gap: 8px; align-items: center; }
.search-form.compact { justify-content: flex-end; }
.search-input {
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid var(--rule);
  background: var(--bg-2);
  color: var(--ink-1);
  font-size: 15px;
  width: 220px;
  outline: none;
}
.search-input.small { width: 120px; font-size: 13px; padding: 6px 10px; }
.search-input:focus { border-color: var(--accent); }

/* --- Score hero --- */
.score-hero {
  display: flex;
  gap: 36px;
  align-items: center;
  padding: 24px 28px;
  border-radius: 14px;
  background: var(--bg-2);
  border: 1px solid var(--rule);
  margin-bottom: 28px;
}
.score-radar-wrap {
  flex-shrink: 0;
  width: 170px;
  height: 170px;
}
.radar-svg { width: 100%; height: 100%; }
.radar-grid {
  fill: none;
  stroke: var(--rule);
  stroke-width: 0.8;
}
.radar-axis {
  stroke: var(--rule);
  stroke-width: 0.5;
  stroke-dasharray: 2 2;
}
.radar-fill {
  fill: var(--radar-color);
  opacity: 0.15;
}
.radar-stroke {
  fill: none;
  stroke: var(--radar-color);
  stroke-width: 2;
  stroke-linejoin: round;
}
.radar-label {
  font-size: 11px;
  font-weight: 800;
  fill: var(--ink-2);
  font-family: 'SF Mono', 'Fira Code', monospace;
}
.radar-score-label {
  font-size: 10px;
  font-weight: 700;
  font-family: 'SF Mono', 'Fira Code', monospace;
}
.radar-total {
  font-size: 28px;
  font-weight: 800;
  fill: var(--ink-1);
  text-anchor: middle;
  font-family: 'SF Mono', 'Fira Code', monospace;
}
.radar-total-label {
  font-size: 8px;
  font-weight: 700;
  fill: var(--ink-3);
  text-anchor: middle;
  letter-spacing: 0.08em;
}
.score-bars { flex: 1; display: flex; flex-direction: column; gap: 10px; }
.score-bar-row { display: flex; align-items: center; gap: 10px; }
.bar-key { font-size: 14px; font-weight: 800; width: 18px; color: var(--ink-2); }
.bar-label { font-size: 13px; color: var(--ink-2); width: 120px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar-track { flex: 1; height: 8px; border-radius: 4px; background: var(--rule); overflow: hidden; }
.bar-fill { height: 100%; border-radius: 4px; transition: width 0.5s ease; }
.bar-score { font-size: 14px; font-weight: 700; width: 24px; text-align: right; }

/* --- Grid layout --- */
.deep-grid {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 24px;
}
@media (max-width: 1000px) {
  .deep-grid { grid-template-columns: 1fr; }
}

.section-head {
  margin-bottom: 14px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--rule);
}

/* --- Dimension cards --- */
.dim-card {
  padding: 18px 20px;
  border-radius: 12px;
  background: var(--bg-2);
  border: 1px solid var(--rule);
  margin-bottom: 14px;
}
.dim-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.dim-key { font-size: 18px; font-weight: 900; }
.dim-title { font-size: 15px; font-weight: 700; color: var(--ink-1); flex: 1; }
.dim-score { font-size: 16px; font-weight: 800; }
.dim-signal-pill {
  font-size: 11px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 5px;
  border: 1px solid;
  text-transform: capitalize;
}
.dim-reasoning { font-size: 14px; color: var(--ink-2); line-height: 1.6; margin-bottom: 10px; }
.dim-evidence { display: flex; flex-direction: column; gap: 6px; }
.evidence-item {
  font-size: 13px;
  color: var(--ink-2);
  display: flex;
  align-items: baseline;
  gap: 8px;
  line-height: 1.45;
}
.ev-bullet { width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; margin-top: 6px; }

/* --- Implication card --- */
.impl-card {
  padding: 18px 20px;
  border-radius: 12px;
  background: var(--accent-soft);
  border: 1px solid var(--accent);
  margin-top: 8px;
}
.impl-text { font-size: 14px; color: var(--ink-1); line-height: 1.6; }

/* --- Summary card --- */
.summary-card {
  padding: 18px 20px;
  border-radius: 12px;
  background: var(--bg-2);
  border: 1px solid var(--rule);
  margin-bottom: 20px;
}
.summary-text { font-size: 14px; color: var(--ink-1); line-height: 1.65; }

/* --- Thesis cards --- */
.thesis-list { display: flex; flex-direction: column; gap: 10px; margin-bottom: 20px; }
.thesis-card {
  padding: 14px 16px;
  border-radius: 10px;
  background: var(--bg-2);
  border: 1px solid var(--rule);
}
.thesis-header {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 6px;
}
.thesis-num { font-size: 12px; font-weight: 700; color: var(--ink-3); }
.thesis-text { font-size: 14px; font-weight: 600; color: var(--ink-1); line-height: 1.35; }
.thesis-status-row { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
.thesis-pill {
  font-size: 11px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 5px;
}
.thesis-date { font-size: 11px; color: var(--ink-3); }
.thesis-ref-q {
  font-size: 10px;
  font-weight: 600;
  color: var(--ink-2);
  padding: 1px 6px;
  background: var(--ink-5, #eee);
  border-radius: 3px;
}
.quarter-lag-banner {
  margin-bottom: 12px;
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--loss);
  background: var(--loss-soft);
  border-left: 3px solid var(--loss);
}
.quarter-lag-detail {
  display: block;
  margin-top: 4px;
  font-size: 11px;
  color: var(--ink-3);
}
.thesis-delta { font-size: 13px; color: var(--ink-3); line-height: 1.45; }
.thesis-invalidation {
  margin-top: 8px;
  padding: 7px 10px;
  border-left: 2px solid var(--loss);
  background: var(--loss-soft, var(--tint-1));
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.thesis-inv-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--loss);
}
.thesis-inv-text { font-size: 12px; color: var(--ink-2); line-height: 1.4; }

/* --- Stats card --- */
.stats-card {
  padding: 16px 18px;
  border-radius: 10px;
  background: var(--bg-2);
  border: 1px solid var(--rule);
}
.stat-row {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  color: var(--ink-2);
  padding: 5px 0;
  border-bottom: 1px solid var(--rule);
}
.stat-row:last-child { border-bottom: none; }

/* --- CallTone (full-width section below the grid) --- */
.calltone-section {
  margin-top: 28px;
  padding: 20px 22px;
  border-radius: 10px;
  background: var(--bg-2);
  border: 1px solid var(--rule);
}
.ct-grid {
  display: grid;
  grid-template-columns: minmax(240px, 1fr) 2fr;
  gap: 32px;
  align-items: start;
}
@media (max-width: 900px) {
  .ct-grid { grid-template-columns: 1fr; gap: 18px; }
}

/* --- CallTone card --- */
.calltone-card {
  padding: 16px 18px;
  border-radius: 10px;
  background: var(--bg-2);
  border: 1px solid var(--rule);
  margin-bottom: 16px;
}
.calltone-hint {
  padding: 14px 18px;
  border-radius: 10px;
  border: 1px dashed var(--rule);
  margin-bottom: 16px;
}
.ct-hint-text {
  font-size: 12px;
  color: var(--ink-4);
  line-height: 1.5;
}

.ct-gauge { margin-bottom: 14px; }
.ct-gauge-label { font-size: 11px; color: var(--ink-3); margin-bottom: 6px; }
.ct-gauge-bar {
  height: 6px;
  border-radius: 3px;
  background: var(--paper-3);
  position: relative;
  overflow: hidden;
}
.ct-gauge-fill {
  position: absolute; left: 0; top: 0; bottom: 0;
  border-radius: 3px;
  transition: width 0.4s ease;
}
.ct-gauge-val { font-size: 12px; color: var(--ink-2); margin-top: 4px; }

.ct-words {
  display: flex; gap: 10px; margin-bottom: 14px;
}
.ct-word-chip {
  flex: 1;
  display: flex; align-items: baseline; gap: 6px;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--rule);
}
.ct-word-chip.gain { background: var(--gain-wash, rgba(34,197,94,0.04)); }
.ct-word-chip.loss { background: var(--loss-wash, rgba(239,68,68,0.04)); }
.ct-word-n { font-size: 20px; font-weight: 700; }
.ct-word-chip.gain .ct-word-n { color: var(--gain); }
.ct-word-chip.loss .ct-word-n { color: var(--loss); }
.ct-word-l { font-size: 11px; color: var(--ink-3); }

.ct-word-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}
.ct-tag {
  font-size: 11px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 4px;
  white-space: nowrap;
}
.ct-tag-count {
  font-size: 10px;
  opacity: 0.7;
  margin-left: 3px;
}
.hl-conf {
  background: rgba(34,197,94,0.15);
  color: var(--gain);
  padding: 0 2px;
  border-radius: 2px;
  font-style: normal;
}
.hl-hedge {
  background: rgba(239,68,68,0.15);
  color: var(--loss);
  padding: 0 2px;
  border-radius: 2px;
  font-style: normal;
}
.ct-tag-gain {
  color: var(--gain);
  background: var(--gain-wash, rgba(34,197,94,0.08));
  border: 1px solid var(--gain-soft, rgba(34,197,94,0.2));
}
.ct-tag-loss {
  color: var(--loss);
  background: var(--loss-wash, rgba(239,68,68,0.08));
  border: 1px solid var(--loss-soft, rgba(239,68,68,0.2));
}

.ct-meta {
  display: flex; gap: 16px; margin-bottom: 14px;
}
.ct-meta-item { display: flex; align-items: center; gap: 6px; }
.ct-meta-l { font-size: 11px; color: var(--ink-3); }
.ct-meta-v { font-size: 13px; font-weight: 600; }
.ct-meta-v.up { color: var(--gain); }
.ct-meta-v.dn { color: var(--loss); }

.ct-quotes { margin-bottom: 14px; }
.ct-quotes-label {
  font-size: 11px; font-weight: 600; margin-bottom: 4px;
  letter-spacing: 0.02em;
}
.ct-quotes-label.gain { color: var(--gain); }
.ct-quotes-label.loss { color: var(--loss); }
.ct-quote {
  display: flex; gap: 2px;
  padding: 6px 0;
  border-bottom: 1px solid var(--rule);
  font-size: 12px;
  color: var(--ink-2);
  line-height: 1.5;
}
.ct-quote:last-child { border-bottom: none; }
.ct-quote-mark {
  font-size: 20px; font-weight: 700;
  color: var(--accent); line-height: 1;
  flex-shrink: 0;
}
.ct-quote-text { font-style: italic; }

.ct-summary {
  font-size: 12px; color: var(--ink-2); line-height: 1.5;
  padding-top: 8px;
  border-top: 1px solid var(--rule);
}

/* --- States --- */
.empty-state {
  text-align: center;
  padding-top: 80px;
}
.empty-state .search-form { justify-content: center; margin-top: 24px; }

.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
  padding-top: 120px;
}
.loading-ring {
  width: 48px;
  height: 48px;
  border: 3px solid var(--rule);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.loading-text { font-size: 15px; color: var(--ink-2); text-align: center; }
.loading-sub { font-size: 12px; color: var(--ink-3); margin-top: 4px; }

.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding-top: 120px;
}
.error-icon {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--loss-soft);
  color: var(--loss);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  font-weight: 800;
}
.error-msg { font-size: 14px; color: var(--loss); }

/* --- Freshness --- */
.freshness { font-size: 11px; color: var(--ink-3); display: flex; align-items: center; gap: 6px; }
.freshness-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--gain);
  display: inline-block;
}

/* --- Shared btn --- */
.btn {
  padding: 8px 16px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  border: none;
}
.btn.accent { background: var(--accent); color: var(--bg-1); }
.btn.ghost { background: transparent; border: 1px solid var(--rule); color: var(--ink-2); }
.btn.tiny { font-size: 12px; padding: 4px 10px; }
.btn:disabled { opacity: 0.4; cursor: default; }

/* --- Recent analyses (empty state) --- */
.recent-section {
  margin-top: 48px;
}
.recent-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 10px;
  max-width: 640px;
  margin: 0 auto;
}
.recent-card {
  background: var(--bg-2);
  border: 1px solid var(--rule);
  border-radius: 10px;
  padding: 14px 16px;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s;
}
.recent-card:hover { border-color: var(--accent); }
.recent-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}
.recent-sym { font-size: 15px; font-weight: 800; color: var(--ink-1); }
.recent-score { font-size: 16px; font-weight: 800; }
.recent-grade { font-size: 11px; font-weight: 700; margin-left: 2px; opacity: .7; }
.recent-name { font-size: 12px; color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.recent-view { font-size: 11px; font-weight: 700; margin-top: 4px; }

/* --- Recent pills (header quick-switch) --- */
.recent-pills {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
  margin-top: 8px;
  flex-wrap: wrap;
}
.recent-pill {
  font-size: 11px;
  font-weight: 700;
  padding: 3px 8px;
  border-radius: 5px;
  background: var(--bg-2);
  border: 1px solid var(--rule);
  color: var(--ink-2);
  cursor: pointer;
  transition: border-color 0.15s;
}
.recent-pill:hover { border-color: var(--accent); color: var(--accent); }

/* --- CTA card --- */
.cta-card {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 18px 22px;
  border-radius: 12px;
  background: linear-gradient(135deg, var(--accent-soft) 0%, transparent 100%);
  border: 1px solid var(--accent);
  margin-top: 16px;
}
.cta-left { flex: 1; }
.cta-title { font-size: 16px; font-weight: 700; color: var(--ink-1); margin-bottom: 4px; }
.cta-sub { font-size: 13px; color: var(--ink-2); line-height: 1.45; }
.cta-btn { white-space: nowrap; padding: 10px 22px; font-size: 15px; }

/* --- Held badge --- */
.held-badge {
  font-size: 11px;
  font-weight: 700;
  padding: 3px 8px;
  border-radius: 5px;
  background: var(--accent-soft);
  color: var(--accent);
  letter-spacing: 0.02em;
}

/* --- Drift card --- */
.drift-card {
  padding: 14px 16px;
  border-radius: 10px;
  background: var(--gain-soft, rgba(34, 197, 94, 0.08));
  border: 1px solid var(--gain);
  margin-bottom: 16px;
}
.drift-card.drift-neg {
  background: var(--loss-soft, rgba(239, 68, 68, 0.08));
  border-color: var(--loss);
}
.drift-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.drift-icon { font-size: 18px; }
.drift-card.drift-neg .drift-icon { color: var(--loss); }
.drift-title { font-size: 13px; font-weight: 700; color: var(--ink-1); }
.drift-label { font-size: 14px; font-weight: 700; color: var(--ink-1); }
.drift-date { font-size: 11px; color: var(--ink-3); font-weight: 500; margin-left: 6px; }
.drift-dims { display: flex; gap: 10px; margin-top: 6px; flex-wrap: wrap; }
.drift-dim { font-size: 12px; font-weight: 700; }
</style>
