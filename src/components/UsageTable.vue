<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Utilization } from '../types'
import { gib, toGiB } from '../lib/format'
import { topByName } from '../lib/usage'
import Sparkline from './Sparkline.vue'

// one row per container name (and the host group), already sorted; a row expands to the process names the history kept for it, each with its CPU over the window
export interface UsageRow { key: string; label: string; ids: string[]; dockbench: boolean; color: string; cur: number; avg: number; peak: number; mem: number }
const props = defineProps<{ rows: UsageRow[]; u: Utilization; from: number; to: number }>()

const open = ref(new Set<string>())
function toggle(k: string) {
  const s = new Set(open.value)
  if (!s.delete(k)) s.add(k)
  open.value = s
}
const pct = (v: number) => (v < 10 ? v.toFixed(1) : v.toFixed(0)) + '%'
const ram = (v: number) => gib(toGiB(v)) + ' GiB'
// the process rows of every open row, computed once per answer instead of once per use in the template
const procs = computed(() => new Map(props.rows.filter(r => open.value.has(r.key)).map(r => [r.key, topByName(props.u, r.ids)])))
</script>

<template>
  <table class="utab num">
    <thead>
      <tr><th scope="col" class="c-name">Container</th><th scope="col">CPU now</th><th scope="col">Average</th><th scope="col" class="c-peak">Peak</th><th scope="col">RAM now</th></tr>
    </thead>
    <tbody>
      <template v-for="r in rows" :key="r.key">
        <tr :class="{ open: open.has(r.key) }">
          <th scope="row" class="c-name">
            <button type="button" class="ux" :aria-expanded="open.has(r.key)" @click="toggle(r.key)">
              <span class="sw" :style="{ background: r.color }" aria-hidden="true" /><span class="nm">{{ r.label }}</span><span v-if="r.dockbench" class="tag">dockbench</span>
            </button>
          </th>
          <td>{{ pct(r.cur) }}</td><td>{{ pct(r.avg) }}</td><td class="c-peak">{{ pct(r.peak) }}</td><td>{{ ram(r.mem) }}</td>
        </tr>
        <template v-if="open.has(r.key)">
          <tr v-for="p in procs.get(r.key)" :key="r.key + '/' + p.comm" class="sub">
            <th scope="row" class="c-name"><span class="pc">{{ p.comm }}</span><span class="pids">{{ p.pids.length ? 'pid ' + p.pids.slice(0, 4).join(' ') + (p.pids.length > 4 ? ` +${p.pids.length - 4}` : '') : 'not running' }}</span><Sparkline :points="p.series" :from="from" :to="to" :step="u.stepMs" :max="Math.max(1, ...p.series.map(s => s.v))" /></th>
            <td>{{ pct(p.cur) }}</td><td>{{ pct(p.avg) }}</td><td class="c-peak">{{ pct(Math.max(0, ...p.series.map(s => s.v))) }}</td><td>{{ ram(p.rss) }}</td>
          </tr>
          <tr v-if="!procs.get(r.key)?.length" class="sub"><td colspan="5" class="fine">No process names kept for this window.</td></tr>
        </template>
      </template>
    </tbody>
  </table>
</template>
