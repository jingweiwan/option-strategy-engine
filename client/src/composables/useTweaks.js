import { reactive, watchEffect } from 'vue';
const STORAGE_KEY = 'ose-tweaks';
const ACCENT_PALETTES = {
    brick: 'oklch(0.58 0.13 35)',
    forest: 'oklch(0.5 0.13 145)',
    ink: '#1a1a1a',
    ocean: 'oklch(0.5 0.13 240)'
};
const DEFAULTS = {
    theme: 'light',
    mode: 'novice',
    accent: 'brick'
};
function load() {
    if (typeof localStorage === 'undefined')
        return { ...DEFAULTS };
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw)
            return { ...DEFAULTS };
        return { ...DEFAULTS, ...JSON.parse(raw) };
    }
    catch {
        return { ...DEFAULTS };
    }
}
const tweaks = reactive(load());
watchEffect(() => {
    if (typeof document !== 'undefined') {
        document.body.dataset.theme = tweaks.theme;
        document.body.dataset.mode = tweaks.mode;
        document.documentElement.style.setProperty('--accent', ACCENT_PALETTES[tweaks.accent]);
    }
    if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(tweaks));
    }
});
export function useTweaks() {
    function set(key, value) {
        tweaks[key] = value;
    }
    return { tweaks, set, ACCENT_PALETTES };
}
