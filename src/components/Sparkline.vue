<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Pt } from '../lib/usage'

// x is time from `from` to `to`, newest on the right edge, so a short history fills in from the right; two points further apart than two steps are a gap (the collector was down), not a line
const props = withDefaults(defineProps<{ points: Pt[]; from: number; to: number; max: number; step?: number }>(), { step: 10_000 })
const emit = defineEmits<{ hover: [index: number | null] }>()

const W = 480 // wide and flat, so the host panel stays short
const x = (t: number) => (props.to > props.from ? ((t - props.from) / (props.to - props.from)) * W : W)
const y = (v: number) => 36 - Math.min(1, Math.max(0, props.max > 0 ? v / props.max : 0)) * 32
const segs = computed(() => {
  const out: [number, number][][] = []
  props.points.forEach((p, i) => {
    if (!i || p.t - props.points[i - 1].t > 2 * props.step) out.push([])
    out[out.length - 1].push([x(p.t), y(p.v)])
  })
  return out
})
const line = (s: [number, number][]) => s.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('')
const d = computed(() => segs.value.map(line).join(''))
const area = computed(() => segs.value.map((s) => line(s) + `L${s[s.length - 1][0].toFixed(1)} 38L${s[0][0].toFixed(1)} 38Z`).join(''))
const end = computed(() => segs.value.at(-1)?.at(-1))
const hover = ref<number | null>(null)

function move(e: PointerEvent) {
  if (!props.points.length) return
  const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
  const t = props.from + ((e.clientX - r.left) / r.width) * (props.to - props.from)
  let i = 0
  props.points.forEach((p, k) => { if (Math.abs(p.t - t) < Math.abs(props.points[i].t - t)) i = k })
  if (i !== hover.value) emit('hover', (hover.value = i))
}
function leave() {
  hover.value = null
  emit('hover', null)
}
</script>

<template>
  <svg class="spark" :viewBox="`0 0 ${W} 40`" role="img" :aria-label="`${points.length} points`" @pointerdown="move" @pointermove="move" @pointerleave="leave">
    <line class="grid" x1="0" :x2="W" y1="20" y2="20" />
    <line class="base" x1="0" :x2="W" y1="38.5" y2="38.5" />
    <template v-if="end">
      <path class="area" :d="area" />
      <path class="ln" :d="d" />
      <line v-if="hover !== null && points[hover]" class="xh" :x1="x(points[hover].t)" :x2="x(points[hover].t)" y1="2" y2="38" />
      <circle class="end" r="3.2" :cx="Math.min(end[0], W - 3.5)" :cy="end[1]" />
    </template>
  </svg>
</template>
