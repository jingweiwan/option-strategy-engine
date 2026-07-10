<script setup lang="ts">
defineProps<{ text: string; align?: 'left' | 'right' | 'center' }>()
</script>

<template>
  <span class="help-tip" tabindex="0" :data-align="align ?? 'center'">
    <span class="icon">ⓘ</span>
    <span class="bubble">{{ text }}</span>
  </span>
</template>

<style scoped>
.help-tip {
  position: relative;
  display: inline-block;
  margin-left: 4px;
  vertical-align: 1px;
  cursor: help;
  outline: none;
}
.icon {
  font-size: 11px;
  color: var(--ink-3);
  opacity: 0.55;
  transition: opacity 0.15s, color 0.15s;
}
.help-tip:hover .icon,
.help-tip:focus .icon {
  color: var(--accent);
  opacity: 1;
}
.bubble {
  position: absolute;
  bottom: calc(100% + 8px);
  background: var(--ink);
  color: var(--paper);
  padding: 10px 14px;
  font-size: 11.5px;
  font-family: var(--sans);
  font-weight: 400;
  line-height: 1.6;
  width: 260px;
  letter-spacing: 0;
  text-transform: none;
  white-space: normal;
  text-align: left;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.15s;
  z-index: 100;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
}
.help-tip[data-align='center'] .bubble {
  left: 50%;
  transform: translateX(-50%);
}
.help-tip[data-align='left'] .bubble {
  left: -8px;
}
.help-tip[data-align='right'] .bubble {
  right: -8px;
}
.bubble::after {
  content: '';
  position: absolute;
  top: 100%;
  border: 5px solid transparent;
  border-top-color: var(--ink);
}
.help-tip[data-align='center'] .bubble::after {
  left: 50%;
  transform: translateX(-50%);
}
.help-tip[data-align='left'] .bubble::after {
  left: 16px;
}
.help-tip[data-align='right'] .bubble::after {
  right: 16px;
}
.help-tip:hover .bubble,
.help-tip:focus .bubble {
  opacity: 1;
}
</style>
