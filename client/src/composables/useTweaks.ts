import { reactive, watchEffect } from 'vue'

export type Theme = 'light' | 'dark'
export type Mode = 'novice' | 'expert'
export type Accent = 'brick' | 'forest' | 'ink' | 'ocean'

export type Tweaks = {
  theme: Theme
  mode: Mode
  accent: Accent
}

const STORAGE_KEY = 'ose-tweaks'

const ACCENT_PALETTES: Record<Accent, string> = {
  brick: 'oklch(0.58 0.13 35)',
  forest: 'oklch(0.5 0.13 145)',
  ink: '#1a1a1a',
  ocean: 'oklch(0.5 0.13 240)'
}

const DEFAULTS: Tweaks = {
  theme: 'light',
  mode: 'novice',
  accent: 'brick'
}

function load(): Tweaks {
  if (typeof localStorage === 'undefined') return { ...DEFAULTS }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULTS }
  }
}

const tweaks = reactive<Tweaks>(load())

watchEffect(() => {
  if (typeof document !== 'undefined') {
    document.body.dataset.theme = tweaks.theme
    document.body.dataset.mode = tweaks.mode
    document.documentElement.style.setProperty('--accent', ACCENT_PALETTES[tweaks.accent])
  }
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tweaks))
  }
})

export function useTweaks() {
  function set<K extends keyof Tweaks>(key: K, value: Tweaks[K]) {
    tweaks[key] = value
  }
  return { tweaks, set, ACCENT_PALETTES }
}
