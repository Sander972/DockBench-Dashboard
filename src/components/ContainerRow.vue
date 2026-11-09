<script setup lang="ts">
import { computed } from 'vue'
import type { DevContainer } from '../types'
import { store } from '../store'
import { now } from '../composables/useNow'
import { ago, gitParts, short, toGiB } from '../lib/format'
import { cpuPct, diskBytes, diskPct, memPct, verdict } from '../lib/verdict'
import Led from './Led.vue'
import Meter from './Meter.vue'

const props = defineProps<{ c: DevContainer; sel?: boolean }>()
defineEmits<{ select: [] }>()

const v = computed(() => verdict(props.c))
const run = computed(() => props.c.state === 'running')
const rest = computed(() => props.c.name.replace(/^dockbench-/, ''))
// CPU and RAM come from the collector: without it they are unknown, not 0
const usage = computed(() => run.value && store.host?.collector !== false)
const cpuV = computed(() => usage.value ? cpuPct(props.c).toFixed(0) + '%' : '·')
const memV = computed(() => usage.value ? short(toGiB(props.c.memUsed)) : '·')
const diskV = computed(() => short(toGiB(diskBytes(props.c))))
const ci = computed(() => store.ci[props.c.name])
</script>

<template>
  <li class="row" :class="{ sel, stale: store.dockerDown, off: c.state === 'exited' }">
    <button type="button" class="hit" :data-id="c.id" :aria-current="sel ? 'true' : undefined" @click="$emit('select')">
      <Led :sev="v.sev" :blink="v.blink" />
      <span class="rh"><span class="name" :title="c.name">{{ rest }}</span><span class="state" :class="'s-' + v.sev">{{ v.word }}</span><span v-if="c.imageUpdate" class="state s-warn">· update</span><span v-if="ci && ci.state !== 'success' && ci.state !== 'none'" class="state" :class="ci.state === 'running' ? 's-warn' : 's-bad'">· CI {{ ci.state === 'running' ? 'running' : 'failing' }}</span></span>
      <span class="meta">
        <template v-if="c.state === 'exited'">stopped {{ c.finishedAt ? ago(c.finishedAt, now) : '' }} · exit <span class="num">{{ c.exitCode }}</span></template>
        <template v-else-if="c.state === 'restarting'">{{ c.lastError ? 'clone failing' : 'restarting' }} · <span class="num">{{ c.restartCount }}</span> restarts</template>
        <template v-else-if="c.statusError === 'starting'">{{ c.deviceCode ? `${c.deviceCode.kind === 'gh' ? 'gh' : 'code tunnel'} is waiting for a device code` : '/status not answering yet' }}</template>
        <template v-else-if="c.statusError === 'dead'">/status silent {{ c.statusFetchedAt ? ago(c.statusFetchedAt, now) : '' }}</template>
        <template v-else-if="c.status"><template v-for="(p, i) in gitParts(c.status)" :key="i">{{ i ? ' · ' : '' }}<span v-if="p.num" class="num">{{ p.text }}</span><template v-else>{{ p.text }}</template></template></template>
        <template v-else>{{ c.state }}</template>
      </span>
      <span class="mms">
        <span class="mm"><span class="lbl">CPU</span><span class="num">{{ cpuV }}</span><Meter :pct="cpuPct(c)" :n="10" :label="`CPU ${cpuV}`" :off="!usage" /></span>
        <span class="mm"><span class="lbl">RAM</span><span class="num">{{ memV }}</span><Meter :pct="memPct(c)" :n="10" :label="`RAM ${memV}`" :off="!usage" /></span>
        <span class="mm"><span class="lbl">Disk</span><span class="num">{{ diskV }}</span><Meter :pct="diskPct(c)" :n="10" :label="`Disk ${diskV} of 20G budget`" /></span>
      </span>
    </button>
  </li>
</template>
