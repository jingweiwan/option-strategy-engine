<script setup lang="ts">
import { ref, watch, nextTick, onUnmounted } from 'vue'
import { useWatchlist } from '@/composables/useWatchlist'
import { fetchSymbolSearch, type SymbolSearchHit } from '@/api/client'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const { entries, add, remove, resetDefault, notifyChanged, MAX_SYMBOLS } = useWatchlist()

const inputRef = ref<HTMLInputElement | null>(null)
const draft = ref('')
const hint = ref<string | null>(null)
const suggestions = ref<SymbolSearchHit[]>([])
const searchLoading = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | null = null

const close = () => {
  emit('update:open', false)
  draft.value = ''
  hint.value = null
  suggestions.value = []
  searchLoading.value = false
  if (searchTimer != null) {
    clearTimeout(searchTimer)
    searchTimer = null
  }
}

let escCleanup: (() => void) | null = null

watch(
  () => props.open,
  async (v) => {
    escCleanup?.()
    escCleanup = null
    if (!v) return
    hint.value = null
    suggestions.value = []
    await nextTick()
    inputRef.value?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    escCleanup = () => window.removeEventListener('keydown', onKey)
  }
)

onUnmounted(() => {
  escCleanup?.()
  if (searchTimer != null) clearTimeout(searchTimer)
})

const runSearch = async (q: string) => {
  const t = q.trim()
  if (t.length < 1) {
    suggestions.value = []
    searchLoading.value = false
    return
  }
  searchLoading.value = true
  hint.value = null
  try {
    suggestions.value = await fetchSymbolSearch(t)
    if (suggestions.value.length === 0) {
      hint.value = 'Finnhub 无匹配结果，请换关键词或检查 FINNHUB_API_KEY'
    }
  } catch (e: unknown) {
    suggestions.value = []
    hint.value = (e as Error)?.message ?? '搜索失败'
  } finally {
    searchLoading.value = false
  }
}

watch(
  () => draft.value,
  (v) => {
    if (searchTimer != null) clearTimeout(searchTimer)
    const t = v.trim()
    if (t.length < 1) {
      suggestions.value = []
      return
    }
    searchTimer = setTimeout(() => {
      searchTimer = null
      void runSearch(t)
    }, 320)
  }
)

const pick = (hit: SymbolSearchHit) => {
  const r = add(hit.symbol, hit.description)
  if (r.ok) {
    draft.value = ''
    hint.value = null
    suggestions.value = []
  } else {
    hint.value = r.reason
  }
}

const handleEnter = () => {
  const u = draft.value.trim().toUpperCase()
  if (suggestions.value.length === 1) {
    pick(suggestions.value[0])
    return
  }
  const exact = suggestions.value.find((h) => h.symbol === u)
  if (exact) {
    pick(exact)
    return
  }
  hint.value = '请从下方 Finnhub 结果中点选标的（确保代码在交易所存在）'
}

const handleApply = () => {
  notifyChanged()
  close()
}

const handleReset = async () => {
  await resetDefault()
  hint.value = '已恢复默认自选'
  suggestions.value = []
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="wl-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wl-title"
      @click.self="close"
    >
      <div class="wl-panel" @click.stop>
        <div class="wl-head">
          <h2 id="wl-title" class="wl-title">自选名单</h2>
          <button type="button" class="wl-x" aria-label="关闭" @click="close">×</button>
        </div>
        <p class="wl-sub mono dim">
          通过 Finnhub 搜索点选标的，避免手输错误代码。保存后刷新今日总览（⌘K）。
        </p>

        <ul class="wl-list mono" aria-label="当前自选">
          <li v-for="e in entries" :key="e.sym" class="wl-row">
            <div class="wl-cell">
              <span class="wl-sym">{{ e.sym }}</span>
              <span class="wl-name dim">{{ e.name }}</span>
            </div>
            <button type="button" class="wl-remove" @click="remove(e.sym)">移除</button>
          </li>
        </ul>

        <label class="wl-label mono dim" for="wl-search-input">Finnhub 搜索</label>
        <div class="wl-add">
          <input
            id="wl-search-input"
            ref="inputRef"
            v-model="draft"
            class="wl-input mono"
            type="text"
            maxlength="64"
            placeholder="公司名或代码，如 Microsoft / MSFT"
            aria-label="Finnhub 标的搜索"
            aria-autocomplete="list"
            :aria-busy="searchLoading"
            @keydown.enter.prevent="handleEnter"
          />
        </div>
        <p v-if="searchLoading" class="wl-loading mono dim">搜索中…</p>
        <ul
          v-else-if="suggestions.length > 0"
          class="wl-suggest mono"
          role="listbox"
          aria-label="Finnhub 搜索结果"
        >
          <li
            v-for="h in suggestions"
            :key="h.symbol"
            role="option"
            class="wl-suggest-row"
            tabindex="0"
            :aria-label="`${h.symbol} ${h.description}`"
            @click="pick(h)"
            @keydown.enter.prevent="pick(h)"
            @keydown.space.prevent="pick(h)"
          >
            <span class="wl-suggest-sym">{{ h.symbol }}</span>
            <span class="wl-suggest-desc dim">{{ h.description }}</span>
            <span class="wl-suggest-type dim">{{ h.type }}</span>
          </li>
        </ul>
        <p v-if="hint" class="wl-hint mono">{{ hint }}</p>
        <p class="wl-cap mono dim">最多 {{ MAX_SYMBOLS }} 只 · 需配置服务端 FINNHUB_API_KEY</p>

        <div class="wl-actions">
          <button type="button" class="wl-btn ghost" @click="handleReset">恢复默认</button>
          <button type="button" class="wl-btn primary" @click="handleApply">保存并刷新</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.wl-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2000;
  background: rgba(20, 18, 16, 0.45);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 72px 16px 16px;
}

.wl-panel {
  width: min(460px, 100%);
  background: var(--paper, #faf8f5);
  border: 1px solid var(--ink-2, #d4cfc7);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.12);
  padding: 20px 22px 18px;
}

.wl-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.wl-title {
  margin: 0;
  font-size: 1.1rem;
  font-family: var(--serif, 'Georgia', serif);
}

.wl-x {
  border: none;
  background: transparent;
  font-size: 1.5rem;
  line-height: 1;
  cursor: pointer;
  padding: 4px 8px;
  color: var(--ink-muted, #6a655c);
}

.wl-x:hover {
  color: var(--ink, #1a1814);
}

.wl-sub {
  margin: 10px 0 14px;
  font-size: 0.75rem;
  line-height: 1.45;
}

.wl-list {
  list-style: none;
  margin: 0 0 14px;
  padding: 0;
  max-height: 200px;
  overflow: auto;
  border: 1px solid var(--ink-2, #e8e4dc);
}

.wl-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--ink-2, #eeeae4);
  font-size: 0.85rem;
}

.wl-row:last-child {
  border-bottom: none;
}

.wl-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.wl-sym {
  font-weight: 600;
}

.wl-name {
  font-size: 0.72rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dim {
  opacity: 0.72;
}

.wl-remove {
  flex-shrink: 0;
  border: none;
  background: transparent;
  font-size: 0.75rem;
  cursor: pointer;
  color: var(--accent, #8b2942);
  text-decoration: underline;
}

.wl-label {
  display: block;
  margin: 0 0 6px;
  font-size: 0.7rem;
}

.wl-add {
  margin-bottom: 8px;
}

.wl-input {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid var(--ink-2, #d4cfc7);
  font-size: 0.85rem;
}

.wl-loading {
  margin: 0 0 8px;
  font-size: 0.75rem;
}

.wl-suggest {
  list-style: none;
  margin: 0 0 10px;
  padding: 0;
  max-height: 220px;
  overflow: auto;
  border: 1px solid var(--ink-2, #e0dcd4);
  background: var(--paper-2, #fff);
}

.wl-suggest-row {
  display: grid;
  grid-template-columns: minmax(72px, 88px) 1fr minmax(0, 72px);
  gap: 8px;
  align-items: center;
  padding: 8px 10px;
  border-bottom: 1px solid var(--ink-2, #eeeae4);
  font-size: 0.78rem;
  cursor: pointer;
}

.wl-suggest-row:last-child {
  border-bottom: none;
}

.wl-suggest-row:hover,
.wl-suggest-row:focus {
  outline: none;
  background: var(--paper, #f4f1ec);
}

.wl-suggest-sym {
  font-weight: 600;
}

.wl-suggest-desc {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wl-suggest-type {
  font-size: 0.65rem;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
}

.wl-cap {
  margin: 0 0 14px;
  font-size: 0.7rem;
}

.wl-hint {
  margin: 0 0 8px;
  font-size: 0.75rem;
  color: var(--accent, #8b2942);
}

.wl-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}

.wl-btn {
  padding: 8px 14px;
  font-size: 0.8rem;
  cursor: pointer;
  border: 1px solid var(--ink-2, #d4cfc7);
  background: var(--paper-2, #fff);
}

.wl-btn.primary {
  background: var(--ink, #1a1814);
  color: var(--paper, #faf8f5);
  border-color: var(--ink, #1a1814);
}

.wl-btn.ghost {
  background: transparent;
}
</style>
