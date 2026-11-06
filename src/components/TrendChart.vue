<script setup lang="ts">
import { computed, ref } from 'vue'
import { useNow } from '../composables/useNow'
import { ago, gib, since, toGiB } from '../lib/format'

// CPU and RAM history of one container on one chart, each line on its own scale (left axis CPU %, right axis RAM GiB), so a container that idles at 1% CPU still shows its shape next to its memory; the current figures sit in the vitals above, so the key shows values only for a hovered sample
const props = defineProps<{ t: number[]; cpu: number[]; mem: number[] }>()
const now = useNow()

// a round axis top just above the highest sample, never below the floor, so a flat idle line does not fill the chart
function top(v: number, floor: number) {
  const x = Math.max(v * 1.15, floor), p = 10 ** Math.floor(Math.log10(x))
  return ([1, 2, 2.5, 5, 10].find(s => s * p >= x) ?? 10) * p
}
const cpuTop = computed(() => top(Math.max(0, ...props.cpu), 1))
const memTop = computed(() => top(toGiB(Math.max(0, ...props.mem)), 0.5))

// 60 fixed slots with the newest sample on the right edge, so a short history fills in from the right instead of stretching
const W = 600, H = 96, STEP = W / 59
const x = (i: number, n: number) => W - (n - 1 - i) * STEP
const y = (v: number, max: number) => H - 2 - Math.min(1, Math.max(0, v / max)) * (H - 8)
const path = (a: number[], max: number) => a.map((v, i) => (i ? 'L' : 'M') + x(i, a.length).toFixed(1) + ' ' + y(v, max).toFixed(1)).join('')
const cpuD = computed(() => path(props.cpu, cpuTop.value))
const memD = computed(() => path(props.mem.map(toGiB), memTop.value))

const hover = ref<number | null>(null)
function move(e: PointerEvent) {
  const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect(), last = props.cpu.length - 1
  hover.value = Math.min(last, Math.max(0, last - Math.round(((r.right - e.clientX) / r.width) * 59)))
}
// legend readout: the hovered sample, or the newest one; polls are not evenly spaced, so the age comes from the sample's own time
const i = computed(() => hover.value ?? props.cpu.length - 1)
const when = computed(() => (i.value < props.cpu.length - 1 ? ago(props.t[i.value], now.value) : 'now'))
const cpuNow = computed(() => props.cpu[i.value] ?? 0)
const memNow = computed(() => props.mem[i.value] ?? 0)
const fmt = (v: number) => String(+v.toPrecision(3))
</script>

<template>
  <div class="trend">
    <div class="trend-key num">
      <span class="k k-cpu">CPU<template v-if="hover !== null"> {{ cpuNow.toFixed(1) }}%</template></span>
      <span class="k k-mem">RAM<template v-if="hover !== null"> {{ gib(toGiB(memNow)) }} GiB</template></span>
      <span class="dim">{{ hover !== null ? when : t.length > 1 ? 'past ' + since(t[0], now) : 'now' }}</span>
    </div>
    <div class="trend-plot">
      <span class="ax ax-l num">{{ fmt(cpuTop) }}%</span>
      <span class="ax ax-r num">{{ fmt(memTop) }} GiB</span>
      <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" role="img" :aria-label="`CPU and RAM, last ${cpu.length} samples`" @pointerdown="move" @pointermove="move" @pointerleave="hover = null">
        <line class="grid" x1="0" :x2="W" :y1="H / 2" :y2="H / 2" />
        <line class="base" x1="0" :x2="W" :y1="H - 0.5" :y2="H - 0.5" />
        <path class="ln mem" :d="memD" />
        <path class="ln cpu" :d="cpuD" />
        <line v-if="hover !== null" class="xh" :x1="x(hover, cpu.length)" :x2="x(hover, cpu.length)" y1="0" :y2="H" />
      </svg>
    </div>
  </div>
</template>
