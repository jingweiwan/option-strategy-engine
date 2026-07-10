<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { fetchDailyIntel } from '@/api/client'
import { useWatchlist } from '@/composables/useWatchlist'
import { usePositions } from '@/composables/usePositions'
import type { DailyIntelBrief, IntelItem, CrossLink } from '@/types'

const { syms } = useWatchlist()
const { heldSymbols } = usePositions()

function isHeld(sym: string): boolean {
  return heldSymbols.value.includes(sym.toUpperCase())
}

const data = ref<DailyIntelBrief | null>(null)
const error = ref<string | null>(null)
const loading = ref(false)
const filter = ref<'all' | 'news' | 'filing' | 'rating'>('all')

const items = computed(() => {
  if (!data.value) return []
  const filtered = filter.value === 'all'
    ? data.value.topItems
    : data.value.topItems.filter((i) => i.category === filter.value)
  // Sort: held positions first, then by original order
  return [...filtered].sort((a, b) => {
    const aHeld = isHeld(a.sym) ? 0 : 1
    const bHeld = isHeld(b.sym) ? 0 : 1
    return aHeld - bHeld
  })
})

const negCount = computed(() => data.value?.topItems.filter((i) => i.thesisImpact === 'negative').length ?? 0)
const posCount = computed(() => data.value?.topItems.filter((i) => i.thesisImpact === 'positive').length ?? 0)
const monCount = computed(() => data.value?.topItems.filter((i) => i.thesisImpact === 'monitor').length ?? 0)

function impactColor(impact: IntelItem['thesisImpact']): string {
  switch (impact) {
    case 'positive': return 'var(--gain)'
    case 'negative': return 'var(--loss)'
    case 'monitor': return 'var(--accent)'
    default: return 'var(--ink-3)'
  }
}

function impactLabel(impact: IntelItem['thesisImpact']): string {
  switch (impact) {
    case 'positive': return 'Positive'
    case 'negative': return 'Negative'
    case 'monitor': return 'Monitor'
    default: return 'Neutral'
  }
}

function categoryLabel(cat: IntelItem['category']): string {
  switch (cat) {
    case 'filing': return 'SEC Filing'
    case 'rating': return 'Sell-side'
    case 'earnings': return 'Earnings'
    default: return 'News'
  }
}

function strengthColor(s: CrossLink['strength']): string {
  switch (s) {
    case 'High': return 'var(--loss)'
    case 'Medium': return 'var(--accent)'
    default: return 'var(--ink-3)'
  }
}

function freshness(): string {
  if (!data.value?.generatedAt) return ''
  const diff = (Date.now() - new Date(data.value.generatedAt).getTime()) / 60_000
  if (diff < 1) return '刚刚生成'
  if (diff < 60) return `${Math.round(diff)} 分钟前生成`
  return `${Math.floor(diff / 60)} 小时前生成`
}

const FILTER_OPTIONS: { id: typeof filter.value; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'news', label: 'News' },
  { id: 'filing', label: 'SEC Filing' },
  { id: 'rating', label: 'Sell-side' }
]

async function load() {
  loading.value = true
  error.value = null
  try {
    data.value = await fetchDailyIntel([...syms.value])
  } catch (e: any) {
    error.value = e?.message ?? 'failed to load'
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <template v-if="data">
      <!-- Header -->
      <div class="page-head">
        <div>
          <div class="eyebrow" style="margin-bottom: 14px">
            AI SCAN ANALYST
            <span class="ai-chip">AI</span>
          </div>
          <div class="h-title serif">今日情报</div>
          <div class="h-deck">
            扫描 {{ data.scannedDocs }} 篇新闻 · {{ data.scannedFilings }} 份 filing · {{ data.topItems.length }} 条值得关注
          </div>
        </div>
        <div class="h-meta">
          <div>
            {{ data.date }}
            <button class="btn ghost tiny" style="margin-left: 8px" @click="load" :disabled="loading">
              {{ loading ? '扫描中...' : '↻ 重新扫描' }}
            </button>
          </div>
          <div class="freshness mono" style="margin-top: 4px">
            <span class="freshness-dot" />
            {{ freshness() }}
          </div>
        </div>
      </div>

      <!-- Signal summary bar -->
      <div class="signal-bar">
        <div class="signal-pill neg" v-if="negCount > 0">
          <span class="signal-count">{{ negCount }}</span> negative
        </div>
        <div class="signal-pill pos" v-if="posCount > 0">
          <span class="signal-count">{{ posCount }}</span> positive
        </div>
        <div class="signal-pill mon" v-if="monCount > 0">
          <span class="signal-count">{{ monCount }}</span> monitor
        </div>
      </div>

      <!-- Two-column layout: items + cross-links -->
      <div class="intel-grid">
        <!-- Left: Intel items -->
        <div class="intel-main">
          <div class="section-head">
            <div class="eyebrow">情报流</div>
            <div class="tag-row">
              <button
                v-for="opt in FILTER_OPTIONS"
                :key="opt.id"
                @click="filter = opt.id"
                :class="['chip', { solid: filter === opt.id }]"
                style="cursor: pointer"
              >
                {{ opt.label }}
              </button>
            </div>
          </div>

          <div v-if="items.length === 0" class="empty-state mono dim">
            暂无{{ filter === 'all' ? '' : '此类' }}情报
          </div>

          <div v-else class="intel-list">
            <article
              v-for="(it, i) in items"
              :key="i"
              class="intel-card"
              :class="{ unread: it.unread }"
            >
              <!-- Left accent bar -->
              <div class="accent-bar" :style="{ background: impactColor(it.thesisImpact) }" />

              <div class="intel-card-body">
                <div class="intel-card-top">
                  <router-link :to="{ path: '/deep', query: { symbol: it.sym } }" class="intel-sym mono">{{ it.sym }}</router-link>
                  <span v-if="isHeld(it.sym)" class="held-chip">持仓</span>
                  <span class="intel-cat-pill" :class="it.category">{{ categoryLabel(it.category) }}</span>
                  <span class="flex-1" />
                  <span class="intel-time mono">{{ it.time }}</span>
                </div>

                <div class="intel-headline">{{ it.headline }}</div>

                <div class="intel-ai-row">
                  <div class="intel-impact-dot" :style="{ background: impactColor(it.thesisImpact) }" />
                  <div class="intel-ai-text">
                    <span class="ai-label">AI</span> {{ it.tldr }}
                  </div>
                </div>

                <div class="intel-relevance">{{ it.relevance }}</div>

                <div class="intel-card-foot">
                  <span class="impact-badge" :style="{ color: impactColor(it.thesisImpact), background: impactColor(it.thesisImpact) + '18' }">
                    {{ impactLabel(it.thesisImpact) }}
                  </span>
                  <span class="intel-source mono">{{ it.source }}</span>
                </div>
              </div>
            </article>
          </div>
        </div>

        <!-- Right: Cross-company linkage -->
        <aside class="intel-aside">
          <div class="eyebrow" style="margin-bottom: 14px">跨公司联动</div>

          <div v-if="data.crossLinks.length === 0" class="empty-state mono dim" style="padding: 24px 0">
            暂无联动信号
          </div>

          <div v-else class="linkage-list">
            <div v-for="(lk, i) in data.crossLinks" :key="i" class="linkage-card">
              <div class="linkage-head">
                <span class="linkage-from mono">{{ lk.from }}</span>
                <span class="linkage-arrow">→</span>
                <span class="linkage-to mono">{{ lk.to }}</span>
                <span class="flex-1" />
                <span
                  class="strength-pill"
                  :style="{ color: strengthColor(lk.strength), background: strengthColor(lk.strength) + '18' }"
                >
                  {{ lk.strength }}
                </span>
              </div>
              <div class="linkage-title">{{ lk.title }}</div>
              <div class="linkage-body">{{ lk.body }}</div>
            </div>
          </div>

          <!-- Scan stats -->
          <div class="scan-stats">
            <div class="eyebrow" style="margin-bottom: 10px; margin-top: 24px">扫描统计</div>
            <div class="stat-row">
              <span class="stat-label">新闻扫描</span>
              <span class="stat-val mono tnum">{{ data.scannedDocs }}</span>
            </div>
            <div class="stat-row">
              <span class="stat-label">SEC Filing</span>
              <span class="stat-val mono tnum">{{ data.scannedFilings }}</span>
            </div>
            <div class="stat-row">
              <span class="stat-label">生成时间</span>
              <span class="stat-val mono tnum">{{ freshness() }}</span>
            </div>
          </div>
        </aside>
      </div>
    </template>

    <div v-else-if="loading" class="loading-state">
      <div class="scan-anim">
        <div class="scan-ring" />
        <div class="scan-label mono">AI 正在扫描持仓相关信息...</div>
      </div>
    </div>
    <div v-else-if="error" class="error">{{ error }}</div>
  </div>
</template>

<style scoped>
/* AI chip in header */
.ai-chip {
  display: inline-block;
  margin-left: 10px;
  padding: 2px 8px;
  font-size: 9px;
  letter-spacing: 0.1em;
  font-weight: 800;
  background: var(--accent-2, rgba(196, 94, 60, 0.12));
  color: var(--accent);
  border-radius: 3px;
  vertical-align: 2px;
}

.freshness {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10.5px;
  color: var(--ink-3);
}
.freshness-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--gain, #43a047);
  flex-shrink: 0;
}

/* Signal summary bar */
.signal-bar {
  display: flex;
  gap: 8px;
  padding: 16px 0;
  border-top: 1px solid var(--rule);
  border-bottom: 1px solid var(--rule);
}
.signal-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: -0.1px;
}
.signal-pill.neg { background: rgba(229, 57, 53, 0.1); color: var(--loss); }
.signal-pill.pos { background: rgba(67, 160, 71, 0.1); color: var(--gain); }
.signal-pill.mon { background: rgba(196, 94, 60, 0.1); color: var(--accent); }
.signal-count { font-weight: 800; }

/* Two-column grid */
.intel-grid {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 0;
  margin-top: 28px;
}

.intel-main {
  padding-right: 32px;
  border-right: 1px solid var(--rule);
}

.intel-aside {
  padding-left: 32px;
}

.section-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 18px;
}

/* Intel cards */
.intel-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.intel-card {
  position: relative;
  padding: 18px 20px;
  border: 1px solid var(--rule-hair, rgba(0,0,0,0.06));
  border-radius: 0;
  transition: background 0.15s;
}
.intel-card:hover {
  background: var(--paper-2, #faf9f7);
}
.intel-card.unread {
  border-left: none;
}

.accent-bar {
  position: absolute;
  left: 0;
  top: 16px;
  bottom: 16px;
  width: 3px;
  border-radius: 0 2px 2px 0;
}

.intel-card-body {
  padding-left: 8px;
}

.intel-card-top {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.intel-sym {
  font-size: 14px;
  font-weight: 700;
  letter-spacing: -0.2px;
}
.intel-cat-pill {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
}
.intel-cat-pill.filing { background: rgba(255, 152, 0, 0.12); color: #e68a00; }
.intel-cat-pill.news { background: rgba(74, 158, 255, 0.12); color: #4a9eff; }
.intel-cat-pill.rating { background: rgba(167, 139, 250, 0.12); color: #a78bfa; }
.intel-cat-pill.earnings { background: rgba(0, 200, 5, 0.12); color: var(--gain); }

.flex-1 { flex: 1; }

.intel-time {
  font-size: 11px;
  color: var(--ink-4);
}

.intel-headline {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
  letter-spacing: -0.2px;
  margin-bottom: 10px;
  max-width: 56ch;
}

.intel-ai-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 6px;
}
.intel-impact-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-top: 6px;
}
.intel-ai-text {
  font-size: 13px;
  line-height: 1.55;
  color: var(--ink-2);
}
.ai-label {
  font-size: 10px;
  font-weight: 800;
  color: var(--accent);
  letter-spacing: 0.05em;
  margin-right: 2px;
}

.intel-relevance {
  font-size: 12px;
  color: var(--ink-3);
  line-height: 1.5;
  margin-bottom: 10px;
  padding-left: 14px;
}

.intel-card-foot {
  display: flex;
  align-items: center;
  gap: 10px;
}
.impact-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
}
.intel-source {
  font-size: 10px;
  color: var(--ink-4);
}

/* Cross-link cards */
.linkage-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.linkage-card {
  padding: 14px 0;
  border-bottom: 1px solid var(--rule-hair);
}
.linkage-card:last-child {
  border-bottom: none;
}
.linkage-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
.linkage-from,
.linkage-to {
  font-size: 13px;
  font-weight: 700;
}
.linkage-arrow {
  color: var(--ink-4);
  font-size: 12px;
}
.strength-pill {
  padding: 2px 8px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 700;
}
.linkage-title {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
  letter-spacing: -0.15px;
  margin-bottom: 6px;
}
.linkage-body {
  font-size: 12px;
  color: var(--ink-3);
  line-height: 1.55;
}

/* Scan stats */
.stat-row {
  display: flex;
  justify-content: space-between;
  padding: 6px 0;
  border-bottom: 1px solid var(--rule-hair);
  font-size: 12px;
}
.stat-label { color: var(--ink-3); }
.stat-val { color: var(--ink-2); font-weight: 500; }

/* Empty / loading / error states */
.empty-state {
  text-align: center;
  padding: 40px 0;
  font-size: 12px;
}

.loading-state {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 400px;
}
.scan-anim {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}
.scan-ring {
  width: 40px;
  height: 40px;
  border: 2px solid var(--rule);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}
.scan-label {
  font-size: 12px;
  color: var(--ink-3);
}
@keyframes spin {
  to { transform: rotate(360deg); }
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
  .intel-grid {
    grid-template-columns: 1fr;
  }
  .intel-main {
    padding-right: 0;
    border-right: none;
    border-bottom: 1px solid var(--rule);
    padding-bottom: 32px;
    margin-bottom: 32px;
  }
  .intel-aside {
    padding-left: 0;
  }
}

.held-chip {
  font-size: 10px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--accent-soft, rgba(196,255,61,0.15));
  color: var(--accent);
  letter-spacing: 0.02em;
}
</style>
