<script setup lang="ts">
import { computed, ref } from 'vue'
import { useNow } from '../composables/useNow'
import { ago, gib, toGiB } from '../lib/format'
import type { Pt } from '../lib/usage'

// CPU and RAM history of one container on one chart, each line on its own scale from 0 to its own max (both maxes stacked inside the plot top left, in the line colors), so a container that idles at 1% CPU still shows its shape next to its memory; no legend: the CPU and RAM labels in the vitals above carry the same colors. x is time from `from` to `to`; points further apart than two steps are a gap.
const props = withDefaults(defineProps<{ cpu: Pt[]; mem: Pt[]; from: number; to: number; step?: number }>(), { step: 10_000 })
const now = useNow()

// a round axis top just above the highest point, never below the floor, so a flat idle line does not fill the chart
function top(v: number, floor: number) {
  const x = Math.max(v * 1.15, floor), p = 10 ** Math.floor(Math.log10(x))
  return ([1, 2, 2.5, 5, 10].find(s => s * p >= x) ?? 10) * p
}
const cpuTop = computed(() => top(Math.max(0, ...props.cpu.map(p => p.v)), 1))
const memTop = computed(() => top(toGiB(Math.max(0, ...props.mem.map(p => p.v))), 0.5))

const W = 600, H = 96
const x = (t: number) => (props.to > props.from ? ((t - props.from) / (props.to - props.from)) * W : W)
const y = (v: number, max: number) => H - 2 - Math.min(1, Math.max(0, v / max)) * (H - 8)
const path = (a: Pt[], max: number, f: (v: number) => number = v => v) => a.map((p, i) => (i && p.t - a[i - 1].t <= 2 * props.step ? 'L' : 'M') + x(p.t).toFixed(1) + ' ' + y(f(p.v), max).toFixed(1)).join('')
const cpuD = computed(() => path(props.cpu, cpuTop.value))
const memD = computed(() => path(props.mem, memTop.value, toGiB))

const hover = ref<number | null>(null)
function move(e: PointerEvent) {
  if (!props.cpu.length) return
  const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
  const t = props.from + ((e.clientX - r.left) / r.width) * (props.to - props.from)
  let i = 0
  props.cpu.forEach((p, k) => { if (Math.abs(p.t - t) < Math.abs(props.cpu[i].t - t)) i = k })
  hover.value = i
}
// readout: the hovered point with its own time
const cur = computed(() => (hover.value === null ? null : { cpu: props.cpu[hover.value]?.v ?? 0, mem: props.mem[hover.value]?.v ?? 0, t: props.cpu[hover.value]?.t ?? 0 }))
const fmt = (v: number) => String(+v.toPrecision(3))
</script>

<template>
  <div class="trend">
    <div class="trend-plot">
      <span class="ax ax-l num"><span class="t-cpu">{{ fmt(cpuTop) }}%</span><span class="t-mem">{{ fmt(memTop) }} GiB</span></span>
      <span v-if="cur" class="ax ax-h num">{{ cur.cpu.toFixed(1) }}% · {{ gib(toGiB(cur.mem)) }} GiB · {{ ago(cur.t, now) }}</span>
      <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" role="img" :aria-label="`CPU and RAM, ${cpu.length} points`" @pointerdown="move" @pointermove="move" @pointerleave="hover = null">
        <line class="grid" x1="0" :x2="W" :y1="H / 2" :y2="H / 2" />
        <line class="base" x1="0" :x2="W" :y1="H - 0.5" :y2="H - 0.5" />
        <path class="ln mem" :d="memD" />
        <path class="ln cpu" :d="cpuD" />
        <line v-if="cur" class="xh" :x1="x(cur.t)" :x2="x(cur.t)" y1="0" :y2="H" />
      </svg>
    </div>
  </div>
</template>
