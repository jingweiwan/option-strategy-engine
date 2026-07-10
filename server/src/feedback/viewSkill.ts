/**
 * View-skill gate — how much the AI's directional view is ALLOWED to tilt
 * strategy selection, expressed as a weight in [0,1] per view type that the
 * view has to EARN from its realized track record.
 *
 * The AI view is a technicals-momentum call. The P1 scorecard measured it on
 * recorded outcomes and found the directional views have no proven cross-regime
 * skill: `bullish` was anti-predictive (~−2.6% forward return over 10 trading
 * days, 25% hit), and `bearish`'s high hit rate is confounded by a single
 * down-market sample — you can't tell skill from "everything fell". So both
 * directional views start at weight 0 (no tilt) and only earn influence once
 * they beat chance across a full up/down cycle. `neutral` / `neutral-vol` are
 * range/vol calls, not directional predictions, and were not indicted → full
 * weight.
 *
 * The weight scales the *designed* view multiplier toward 1 (no effect):
 *   effective = 1 + weight · (designed − 1)
 * weight 0 → 1 (view ignored); weight 1 → the full designed tilt (e.g. 1.6/0.5).
 *
 * `data/view-skill.json` (optional) overrides the defaults per view, so an
 * offline recompute can turn the dial as multi-regime evidence accumulates —
 * no code change needed. Until that file exists the honest defaults below hold.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { View } from '../engine/index.js'

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'view-skill.json')

const VIEWS: View[] = ['bullish', 'bearish', 'neutral', 'neutral-vol']

// Honest current setting from the scorecard (see header). Directional views
// unproven → 0; non-directional vol/range calls → full weight.
const DEFAULT: Record<View, number> = {
  bullish: 0,
  bearish: 0,
  neutral: 1,
  'neutral-vol': 1
}

export type ViewSkillTable = Map<View, number>

/** Load per-view weight overrides from data/view-skill.json (defaults if absent). */
export function loadViewSkill(): ViewSkillTable {
  const t: ViewSkillTable = new Map()
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, unknown>
    for (const v of VIEWS) {
      if (typeof raw[v] === 'number') t.set(v, Math.max(0, Math.min(1, raw[v] as number)))
    }
  } catch { /* no override file → defaults */ }
  return t
}

export function viewWeight(view: View | undefined, table?: ViewSkillTable): number {
  if (!view) return 0
  const w = table?.get(view) ?? DEFAULT[view] ?? 0
  return Math.max(0, Math.min(1, w))
}

/** Scale a designed view multiplier by the view's earned skill weight. */
export function scaleByViewSkill(designed: number, view: View | undefined, table?: ViewSkillTable): number {
  const w = viewWeight(view, table)
  if (w === 0) return 1
  return 1 + w * (designed - 1)
}
