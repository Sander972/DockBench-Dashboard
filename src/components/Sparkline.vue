<script setup lang="ts">
import { computed, ref } from 'vue'

const props = defineProps<{ samples: number[]; max: number }>()
const emit = defineEmits<{ hover: [index: number | null] }>()

// 60 fixed slots with the newest sample on the right edge, so a short history fills in from the right instead of stretching
const STEP = 240 / 59
const x = (i: number) => 240 - (props.samples.length - 1 - i) * STEP
const pts = computed(() => props.samples.map((v, i) => [x(i), 36 - Math.min(1, Math.max(0, props.max > 0 ? v / props.max : 0)) * 32]))
const d = computed(() => pts.value.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(''))
const end = computed(() => pts.value[pts.value.length - 1])
const hover = ref<number | null>(null)

function move(e: PointerEvent) {
  const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect(), last = props.samples.length - 1
  const i = Math.min(last, Math.max(0, last - Math.round(((r.right - e.clientX) / r.width) * 59)))
  if (i !== hover.value) emit('hover', (hover.value = i))
}
function leave() {
  hover.value = null
  emit('hover', null)
}
</script>

<template>
  <svg class="spark" viewBox="0 0 240 40" role="img" aria-label="Last 60 samples" @pointerdown="move" @pointermove="move" @pointerleave="leave">
    <line class="grid" x1="0" x2="240" y1="20" y2="20" />
    <line class="base" x1="0" x2="240" y1="38.5" y2="38.5" />
    <template v-if="end">
      <path class="area" :d="d + `L240 38L${pts[0][0].toFixed(1)} 38Z`" />
      <path class="ln" :d="d" />
      <line v-if="hover !== null" class="xh" :x1="x(hover)" :x2="x(hover)" y1="2" y2="38" />
      <circle class="end" r="3.2" :cx="end[0] - 3.5" :cy="end[1]" />
    </template>
  </svg>
</template>
