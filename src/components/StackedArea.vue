<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Pt } from '../lib/usage'

// Series stacked bottom to top in the given order over a time span from `from` to `to`, newest on the right; points further apart than two steps are a gap (the collector was down), drawn as nothing. A series missing at a time counts 0 there. Thin surface-colored edges keep neighbouring fills apart.
export interface Series { key: string; label: string; color: string; points: Pt[] }
const props = withDefaults(defineProps<{ series: Series[]; from: number; to: number; max: number; step?: number; label: string }>(), { step: 10_000 })
const emit = defineEmits<{ hover: [at: { t: number; values: Record<string, number> } | null] }>()

const W = 600, H = 120
const x = (t: number) => (props.to > props.from ? ((t - props.from) / (props.to - props.from)) * W : W)
const y = (v: number) => H - 1 - Math.min(1, Math.max(0, props.max > 0 ? v / props.max : 0)) * (H - 4)

// one shared timeline, split where the gap is too long
const times = computed(() => [...new Set(props.series.flatMap(s => s.points.map(p => p.t)))].sort((a, b) => a - b))
const lookup = computed(() => props.series.map(s => new Map(s.points.map(p => [p.t, p.v]))))
const segs = computed(() => {
  const out: number[][] = []
  times.value.forEach((t, i) => {
    if (!i || t - times.value[i - 1] > 2 * props.step) out.push([])
    out[out.length - 1].push(t)
  })
  return out
})
// cumulative tops per series per segment
const paths = computed(() => props.series.map((s, i) => {
  const d = segs.value.map(seg => {
    const below = seg.map(t => lookup.value.slice(0, i).reduce((a, m) => a + (m.get(t) ?? 0), 0))
    const top = seg.map((t, k) => below[k] + (lookup.value[i].get(t) ?? 0))
    const up = seg.map((t, k) => `${k ? 'L' : 'M'}${x(t).toFixed(1)} ${y(top[k]).toFixed(1)}`).join('')
    const down = seg.map((t, k) => `L${x(t).toFixed(1)} ${y(below[k]).toFixed(1)}`).reverse().join('')
    // a lone point still shows as a sliver
    const w = seg.length === 1 ? `L${(x(seg[0]) + 2).toFixed(1)} ${y(top[0]).toFixed(1)}L${(x(seg[0]) + 2).toFixed(1)} ${y(below[0]).toFixed(1)}` : ''
    return up + w + down + 'Z'
  }).join('')
  return { key: s.key, color: s.color, d }
}))

const hover = ref<number | null>(null)
function move(e: PointerEvent) {
  if (!times.value.length) return
  const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
  const t = props.from + ((e.clientX - r.left) / r.width) * (props.to - props.from)
  let best = times.value[0]
  for (const k of times.value) if (Math.abs(k - t) < Math.abs(best - t)) best = k
  if (best === hover.value) return
  hover.value = best
  emit('hover', { t: best, values: Object.fromEntries(props.series.map((s, i) => [s.key, lookup.value[i].get(best) ?? 0])) })
}
function leave() {
  hover.value = null
  emit('hover', null)
}
</script>

<template>
  <svg class="stack" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" role="img" :aria-label="label" @pointerdown="move" @pointermove="move" @pointerleave="leave">
    <line class="grid" x1="0" :x2="W" :y1="H / 2" :y2="H / 2" />
    <path v-for="p in paths" :key="p.key" class="fill" :d="p.d" :style="{ fill: p.color }" />
    <line class="base" x1="0" :x2="W" :y1="H - 0.5" :y2="H - 0.5" />
    <line v-if="hover !== null" class="xh" :x1="x(hover)" :x2="x(hover)" y1="0" :y2="H" />
  </svg>
</template>
