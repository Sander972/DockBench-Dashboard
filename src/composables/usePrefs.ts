import { reactive, watch } from 'vue'
import type { Prefs } from '../types'
import { onAccent } from '../lib/format'

const KEY = 'dockbench.prefs'
const DEFAULTS: Prefs = { theme: 'system', accent: '#f0c22b', poll: 5, compact: false, notify: false }

function load(): Partial<Prefs> { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {} } catch { return {} } }

export const prefs = reactive<Prefs>({ ...DEFAULTS, ...load() })

export function applyPrefs() {
  const r = document.documentElement
  if (prefs.theme === 'system') r.removeAttribute('data-theme')
  else r.setAttribute('data-theme', prefs.theme)
  r.style.setProperty('--accent', prefs.accent)
  r.style.setProperty('--on-accent', onAccent(prefs.accent))
}

watch(prefs, () => {
  applyPrefs()
  try { localStorage.setItem(KEY, JSON.stringify(prefs)) } catch { /* storage blocked */ }
}, { deep: true })
applyPrefs()

export function cycleTheme() {
  prefs.theme = ({ system: 'light', light: 'dark', dark: 'system' } as const)[prefs.theme]
  return prefs.theme
}

export const usePrefs = () => prefs
