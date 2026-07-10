<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'

type NavItem = { id: string; label: string; no: string; section: string; to: string }

const PAGES: NavItem[] = [
  { id: 'dashboard', label: '今日总览', no: '01', section: '今日', to: '/' },
  { id: 'recommend', label: '策略推荐', no: '02', section: '今日', to: '/recommend' },
  { id: 'sell-put', label: 'Sell Put', no: '03', section: '今日', to: '/sell-put' },
  { id: 'intel', label: 'AI 情报', no: '04', section: '研究', to: '/intel' },
  { id: 'deep', label: 'OCIFQ 深度', no: '05', section: '研究', to: '/deep' },
  { id: 'ticker', label: '标的 · Greeks', no: '06', section: '研究', to: '/ticker' },
  { id: 'positions', label: '持仓监控', no: '07', section: '组合', to: '/positions' },
  { id: 'performance', label: 'Performance', no: '08', section: '组合', to: '/performance' }
]

const route = useRoute()
const sections = ['今日', '研究', '组合']
const grouped = computed(() =>
  sections.map((sec) => ({ sec, items: PAGES.filter((p) => p.section === sec) }))
)

function isActive(to: string): boolean {
  if (to === '/') return route.path === '/'
  // /strategy detail page highlights "策略推荐" nav item
  if (to === '/recommend' && route.path === '/strategy') return true
  return route.path === to || route.path.startsWith(to + '/')
}

// Live ET clock — updates every 10s
const etTime = ref('')
let clockTimer: ReturnType<typeof setInterval> | null = null

function updateEtClock() {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(now)
  const h = parts.find((p) => p.type === 'hour')?.value ?? '00'
  const m = parts.find((p) => p.type === 'minute')?.value ?? '00'
  etTime.value = `${h}:${m} ET`
}

onMounted(() => {
  updateEtClock()
  clockTimer = setInterval(updateEtClock, 10_000)
})

onUnmounted(() => {
  if (clockTimer) clearInterval(clockTimer)
})
</script>

<template>
  <aside class="sidebar">
    <div class="brand">
      <span class="mark">OSE<em>.</em></span>
      <span class="vol">v2.4</span>
    </div>

    <nav class="nav">
      <template v-for="g in grouped" :key="g.sec">
        <div class="sect-label">{{ g.sec }}</div>
        <router-link
          v-for="p in g.items"
          :key="p.id"
          :to="p.to"
          :class="{ active: isActive(p.to) }"
        >
          <span>{{ p.label }}</span>
          <span class="num">{{ p.no }}</span>
        </router-link>
      </template>
    </nav>

    <div class="foot">
      <div class="row"><span><span class="dot" />引擎在线</span><span>{{ etTime }}</span></div>
      <div class="row"><span>5,000 路径</span><span>seed 42</span></div>
      <div class="row"><span>BSM · MC · VaR</span><span>r 4.5%</span></div>
    </div>
  </aside>
</template>
