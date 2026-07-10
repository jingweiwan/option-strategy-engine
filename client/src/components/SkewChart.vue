<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch, computed } from 'vue'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import {
  GridComponent,
  TooltipComponent,
  MarkLineComponent,
  LegendComponent
} from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import { useTweaks } from '@/composables/useTweaks'
import type { OptionContract } from '@/types'

echarts.use([
  LineChart,
  GridComponent,
  TooltipComponent,
  MarkLineComponent,
  LegendComponent,
  SVGRenderer
])

const props = defineProps<{
  chain: OptionContract[]
  spot: number
}>()

const chartEl = ref<HTMLDivElement | null>(null)
let chart: echarts.ECharts | null = null
const { tweaks } = useTweaks()

function cssVar(name: string): string {
  if (typeof window === 'undefined') return ''
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

const series = computed(() => {
  const calls: [number, number][] = []
  const puts: [number, number][] = []
  for (const c of props.chain) {
    if (!c.iv || c.iv <= 0) continue
    if (c.optionType === 'call') calls.push([c.strike, c.iv * 100])
    else puts.push([c.strike, c.iv * 100])
  }
  calls.sort((a, b) => a[0] - b[0])
  puts.sort((a, b) => a[0] - b[0])
  return { calls, puts }
})

function buildOption() {
  const { calls, puts } = series.value
  const ink = cssVar('--ink') || '#1a1a1a'
  const ink3 = cssVar('--ink-3') || '#6e6a60'
  const ruleSoft = cssVar('--rule-soft') || '#c9c2b1'
  const ruleHair = cssVar('--rule-hair') || '#ddd6c4'
  const accent = cssVar('--accent') || 'oklch(0.58 0.13 35)'
  const gain = cssVar('--gain') || 'oklch(0.55 0.13 145)'
  const loss = cssVar('--loss') || 'oklch(0.55 0.16 25)'

  return {
    animation: false,
    backgroundColor: 'transparent',
    textStyle: { fontFamily: 'JetBrains Mono, ui-monospace, monospace' },
    grid: { top: 24, left: 50, right: 24, bottom: 36 },
    legend: {
      data: ['Calls IV', 'Puts IV'],
      right: 12,
      top: 0,
      textStyle: { color: ink3, fontSize: 10, fontFamily: 'JetBrains Mono' },
      itemWidth: 14,
      itemHeight: 8
    },
    tooltip: {
      trigger: 'axis',
      transitionDuration: 0,
      axisPointer: { type: 'cross', animation: false, label: { backgroundColor: ink } },
      backgroundColor: cssVar('--paper') || '#faf8f3',
      borderColor: ruleSoft,
      textStyle: { color: ink, fontFamily: 'JetBrains Mono, monospace' },
      formatter: (params: any) => {
        if (!Array.isArray(params)) return ''
        const lines = params.map((p: any) => {
          const k = p.data[0]
          const iv = p.data[1]
          return `<div>${p.marker} ${p.seriesName}: ${iv.toFixed(1)}% @ $${k}</div>`
        })
        return `<div style="font-size:11px;font-family:JetBrains Mono">${lines.join('')}</div>`
      }
    },
    xAxis: {
      type: 'value',
      name: 'Strike',
      nameLocation: 'middle',
      nameGap: 24,
      nameTextStyle: { color: ink3, fontSize: 10 },
      axisLine: { lineStyle: { color: ruleSoft } },
      axisTick: { lineStyle: { color: ruleSoft } },
      axisLabel: { formatter: (v: number) => v.toFixed(0), color: ink3, fontSize: 10 },
      splitLine: { show: false }
    },
    yAxis: {
      type: 'value',
      name: 'IV %',
      nameLocation: 'middle',
      nameGap: 36,
      nameTextStyle: { color: ink3, fontSize: 10 },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { formatter: (v: number) => v.toFixed(0), color: ink3, fontSize: 10 },
      splitLine: { lineStyle: { color: ruleHair } }
    },
    series: [
      {
        name: 'Calls IV',
        type: 'line',
        data: calls,
        showSymbol: false,
        smooth: true,
        lineStyle: { width: 1.5, color: gain },
        markLine: {
          symbol: 'none',
          data: [
            {
              xAxis: props.spot,
              lineStyle: { color: ink, width: 1.2, type: 'solid' as const },
              label: {
                formatter: `Spot ${props.spot.toFixed(0)}`,
                position: 'insideEndTop',
                fontSize: 9,
                color: ink,
                fontWeight: 600,
                fontFamily: 'JetBrains Mono'
              }
            }
          ]
        }
      },
      {
        name: 'Puts IV',
        type: 'line',
        data: puts,
        showSymbol: false,
        smooth: true,
        lineStyle: { width: 1.5, color: loss }
      }
    ]
  }
}

let rafId: number | null = null
function render() {
  if (!chart) return
  if (rafId !== null) cancelAnimationFrame(rafId)
  rafId = requestAnimationFrame(() => {
    chart?.setOption(buildOption(), { notMerge: true, lazyUpdate: false, silent: true })
    rafId = null
  })
}

onMounted(() => {
  if (chartEl.value) {
    chart = echarts.init(chartEl.value, undefined, { renderer: 'svg' })
    render()
    window.addEventListener('resize', resize)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', resize)
  chart?.dispose()
  chart = null
})

function resize() {
  chart?.resize()
}

watch(() => [props.chain, props.spot], render, { deep: true })
watch(() => [tweaks.theme, tweaks.accent], render)
</script>

<template>
  <div ref="chartEl" class="skew-chart" />
</template>

<style scoped>
.skew-chart {
  width: 100%;
  height: 240px;
}
</style>
