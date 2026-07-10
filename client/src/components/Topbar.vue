<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { useEtMarketClock } from '@/composables/useEtMarketClock'
import WatchlistCommand from '@/components/WatchlistCommand.vue'

const route = useRoute()
const label = computed(() => (route.meta?.title as string) ?? '今日总览')
const { time, date, session } = useEtMarketClock()

const paletteOpen = ref(false)

const handleGlobalKeydown = (e: KeyboardEvent) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    paletteOpen.value = !paletteOpen.value
  }
}

const handleOpenPalette = () => {
  paletteOpen.value = true
}

onMounted(() => {
  window.addEventListener('keydown', handleGlobalKeydown)
  window.addEventListener('ose:open-palette', handleOpenPalette)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleGlobalKeydown)
  window.removeEventListener('ose:open-palette', handleOpenPalette)
})
</script>

<template>
  <div class="topbar">
    <div class="crumbs">OSE / <b>{{ label }}</b></div>
    <div class="search-pill" role="search" @click="handleOpenPalette">
      <span style="opacity: 0.5">⌕</span>
      <input
        readonly
        placeholder="自选 · Finnhub 搜索 · ⌘K"
        aria-label="打开自选名单，Finnhub 搜索标的（快捷键 Command K）"
        @focus="handleOpenPalette"
        @click.prevent="handleOpenPalette"
      />
      <span class="kbd">⌘ K</span>
    </div>
    <div class="clock" aria-live="polite" :title="'America/New_York，不含美股假日历'">
      <b>NYC</b> {{ time }} · {{ session }} · {{ date }}
    </div>
    <WatchlistCommand v-model:open="paletteOpen" />
  </div>
</template>
