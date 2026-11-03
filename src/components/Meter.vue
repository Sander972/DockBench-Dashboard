<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{ pct: number; n?: number; label: string; size?: 'lg'; off?: boolean }>(), { n: 20 })

// Handoff 6.2: lit = round(pct / 100 * n), at least 1 when pct > 0.5.
const lit = computed(() => (props.pct > 0.5 ? Math.max(1, Math.round((props.pct / 100) * props.n)) : 0))
const zone = (i: number) => ((i + 1) / props.n > 0.9 ? 'c' : (i + 1) / props.n > 0.7 ? 'w' : '')
</script>

<template>
  <span class="meter" :class="[size, { off }]" :style="{ '--n': n }" role="meter" :aria-label="label" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="Math.min(100, Math.max(0, Math.round(pct)))" :aria-valuetext="Math.round(pct) + '%'">
    <i v-for="i in n" :key="i" :class="[zone(i - 1), { on: i - 1 < lit }]"></i>
  </span>
</template>
