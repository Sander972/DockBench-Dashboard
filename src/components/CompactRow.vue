<script setup lang="ts">
import { computed } from 'vue'
import type { DevContainer } from '../types'
import { store } from '../store'
import { useCls } from '../lib/format'
import { cpuPct, diskPct, memPct, verdict } from '../lib/verdict'
import Led from './Led.vue'

const props = defineProps<{ c: DevContainer; sel?: boolean }>()
defineEmits<{ select: [] }>()

const v = computed(() => verdict(props.c))
const rest = computed(() => props.c.name.replace(/^dockbench-/, ''))
// CPU and RAM come from the collector: without it they are unknown (null), not 0
const pcts = computed(() => {
  const usage = store.host?.collector !== false
  return [['CPU', usage ? cpuPct(props.c) : null], ['RAM', usage ? memPct(props.c) : null], ['Disk', diskPct(props.c)]] as const
})
const pctText = (p: number | null) => (p === null ? '·' : p.toFixed(0) + '%')
const label = computed(() => `${props.c.name}, ${v.value.word}, ${pcts.value.map(([l, p]) => `${l === 'Disk' ? 'disk' : l} ${p === null ? 'unknown' : pctText(p)}`).join(', ')}`)
</script>

<template>
  <li class="row" :class="{ sel, stale: store.dockerDown }">
    <button type="button" class="hit compact" :data-id="c.id" :aria-current="sel ? 'true' : undefined" :aria-label="label" @click="$emit('select')">
      <Led :sev="v.sev" :blink="v.blink" />
      <span class="rh"><span class="name" :title="c.name">{{ rest }}</span><span v-if="v.sev !== 'ok'" class="state" :class="'s-' + v.sev">{{ v.word }}</span>
        <span class="pcts" aria-hidden="true"><span v-for="[l, p] in pcts" :key="l"><span class="lbl">{{ l }}</span><span class="num" :class="p === null ? '' : useCls(p)">{{ pctText(p) }}</span></span></span></span>
    </button>
  </li>
</template>
