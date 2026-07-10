<script setup lang="ts">
import { ref } from 'vue'
import { useTweaks, type Theme, type Mode, type Accent } from '@/composables/useTweaks'

const { tweaks, set, ACCENT_PALETTES } = useTweaks()
const open = ref(false)

const themes: Theme[] = ['light', 'dark']
const modes: Mode[] = ['novice', 'expert']
const accents: Accent[] = ['brick', 'forest', 'ink', 'ocean']
</script>

<template>
  <div class="tweaks-root">
    <button class="tweaks-fab" @click="open = !open" :aria-expanded="open" title="Tweaks">
      <span class="dot" :style="{ background: ACCENT_PALETTES[tweaks.accent] }" />
      <span class="lbl">Tweaks</span>
    </button>

    <aside v-if="open" class="tweaks-panel">
      <header>
        <span class="eyebrow">Tweaks</span>
        <button class="x" @click="open = false">×</button>
      </header>

      <section>
        <div class="label">主题</div>
        <div class="row">
          <button
            v-for="th in themes"
            :key="th"
            :class="['seg', { on: tweaks.theme === th }]"
            @click="set('theme', th)"
          >{{ th }}</button>
        </div>
      </section>

      <section>
        <div class="label">模式</div>
        <div class="row">
          <button
            v-for="m in modes"
            :key="m"
            :class="['seg', { on: tweaks.mode === m }]"
            @click="set('mode', m)"
          >{{ m }}</button>
        </div>
      </section>

      <section>
        <div class="label">主色</div>
        <div class="row">
          <button
            v-for="a in accents"
            :key="a"
            :class="['swatch', { on: tweaks.accent === a }]"
            :style="{ background: ACCENT_PALETTES[a] }"
            @click="set('accent', a)"
            :title="a"
          />
        </div>
      </section>
    </aside>
  </div>
</template>

<style scoped>
.tweaks-root {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 50;
}
.tweaks-fab {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border: 1px solid var(--rule);
  background: var(--paper);
  color: var(--ink);
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.04em;
  cursor: pointer;
}
.tweaks-fab .dot {
  display: inline-block;
  width: 10px; height: 10px;
}
.tweaks-fab:hover { background: var(--paper-2); }

.tweaks-panel {
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  width: 240px;
  background: var(--paper);
  border: 1px solid var(--rule);
  padding: 14px 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  box-shadow: 0 18px 32px -16px rgba(0, 0, 0, 0.18);
}
.tweaks-panel header {
  display: flex; justify-content: space-between; align-items: baseline;
  border-bottom: 1px solid var(--rule-hair);
  padding-bottom: 10px;
}
.tweaks-panel .x {
  background: transparent; border: 0; cursor: pointer;
  font-size: 18px; line-height: 1; color: var(--ink-3);
}
.tweaks-panel section .label { margin-bottom: 6px; }
.tweaks-panel .row { display: flex; gap: 6px; flex-wrap: wrap; }

.seg {
  flex: 1;
  padding: 6px 8px;
  border: 1px solid var(--rule-soft);
  background: var(--paper);
  color: var(--ink-2);
  font-family: var(--mono);
  font-size: 11px;
  text-transform: lowercase;
  cursor: pointer;
}
.seg.on { background: var(--ink); color: var(--paper); border-color: var(--ink); }

.swatch {
  width: 28px; height: 28px;
  border: 1px solid var(--rule-soft);
  cursor: pointer;
}
.swatch.on { outline: 2px solid var(--ink); outline-offset: 2px; }
</style>
