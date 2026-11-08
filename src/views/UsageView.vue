<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { setUsageWindow, store, watchUsage } from '../store'
import { now } from '../composables/useNow'
import { clock, dur, gib, toGiB } from '../lib/format'
import { byName, containerSeries, HOST, hostSeries, span, summarize, WINDOW_LABEL, type Pt } from '../lib/usage'
import type { UsageWindow } from '../types'
import Led from '../components/Led.vue'
import StackedArea, { type Series } from '../components/StackedArea.vue'
import UsageTable, { type UsageRow } from '../components/UsageTable.vue'

onBeforeUnmount(watchUsage({ top: true }))
const d = computed(() => store.usage.data)
const sp = computed(() => (d.value ? span(d.value) : { from: 0, to: 0 }))
const WINDOWS: UsageWindow[] = ['1h', '6h', '24h']
const age = computed(() => (d.value ? dur(Math.max(0, now.value - d.value.at) / 1000) : ''))

// up to 8 container names get a color, in name order so a refresh that reorders them by average does not repaint them; the rest fold into Other; the host group (outside every container) is neutral
const COLORED = 8
const OTHER = '__other'
const rows = computed<UsageRow[]>(() => {
  const u = d.value
  if (!u) return []
  const named = [...byName(u)].map(([name, g]) => ({ key: name, label: name.replace(/^dockbench-/, ''), ids: g.ids, dockbench: g.dockbench, ...summarize(u, g.ids) }))
  const colored = new Set([...named].sort((a, b) => b.avg - a.avg).slice(0, COLORED).map(r => r.key))
  const order = [...colored].sort()
  const out = named.map(r => ({ ...r, color: colored.has(r.key) ? `var(--series-${order.indexOf(r.key) + 1})` : 'var(--series-other)' }))
  out.push({ key: HOST, label: 'host, outside containers', ids: [HOST], dockbench: false, color: 'var(--series-host)', ...summarize(u, [HOST]) })
  return out.sort((a, b) => b.avg - a.avg)
})

// the legend toggles a series off in both charts
const hidden = ref(new Set<string>())
function toggle(k: string) {
  const s = new Set(hidden.value)
  if (!s.delete(k)) s.add(k)
  hidden.value = s
}
const legend = computed(() => {
  const r = rows.value
  const items = r.filter(x => x.color !== 'var(--series-other)').map(x => ({ key: x.key, label: x.label, color: x.color }))
  if (r.some(x => x.color === 'var(--series-other)')) items.push({ key: OTHER, label: 'Other', color: 'var(--series-other)' })
  return items.sort((a, b) => (a.key === HOST ? -1 : b.key === HOST ? 1 : a.key === OTHER ? 1 : b.key === OTHER ? -1 : a.label.localeCompare(b.label)))
})

function sumPts(list: Pt[][]): Pt[] {
  const m = new Map<number, number>()
  for (const pts of list) for (const p of pts) m.set(p.t, (m.get(p.t) ?? 0) + p.v)
  return [...m].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }))
}
// stacked bottom to top: the host group, the colored names in legend order, Other
function stack(m: 'cpu' | 'mem'): Series[] {
  const u = d.value
  if (!u) return []
  const r = rows.value
  return legend.value.filter(l => !hidden.value.has(l.key)).map(l => {
    const ids = l.key === OTHER ? r.filter(x => x.color === 'var(--series-other)').map(x => x.ids) : [r.find(x => x.key === l.key)!.ids]
    return { key: l.key, label: l.label, color: l.color, points: sumPts(ids.map(i => containerSeries(u, i)[m])) }
  })
}
const cpuStack = computed(() => stack('cpu'))
const memStack = computed(() => stack('mem'))
const memMax = computed(() => store.host?.memTotal || Math.max(1, ...(d.value?.points.map(p => p.host.memUsed) ?? [])))

// host block: CPU as steal plus the rest of the busy time, RAM on its own
const host = computed(() => (d.value ? hostSeries(d.value) : null))
const hostCpu = computed<Series[]>(() => {
  const h = host.value
  if (!h) return []
  return [
    { key: 'steal', label: 'Steal', color: 'var(--u-steal)', points: h.steal },
    { key: 'busy', label: 'CPU', color: 'var(--u-cpu)', points: h.cpu.map((p, i) => ({ t: p.t, v: Math.max(0, p.v - (h.steal[i]?.v ?? 0)) })) },
  ]
})
const hostMem = computed<Series[]>(() => (host.value ? [{ key: 'mem', label: 'RAM', color: 'var(--t-mem)', points: host.value.mem }] : []))

type Hover = { t: number; values: Record<string, number> } | null
const hHover = ref<Hover>(null), mHover = ref<Hover>(null), cHover = ref<Hover>(null), rHover = ref<Hover>(null)
const pct = (v: number) => (v < 10 ? v.toFixed(1) : v.toFixed(0)) + '%'
const ram = (v: number) => gib(toGiB(v)) + ' GiB'
const ncpu = computed(() => store.host?.ncpu ?? 1)
const cores = (p: number) => `${((p / 100) * ncpu.value).toFixed(1)} of ${ncpu.value} cores`
const pointAt = (t: number) => d.value?.points.find(p => p.t === t)
const hostRead = computed(() => {
  const x = hHover.value
  if (x) {
    const p = pointAt(x.t)
    return `${clock(x.t)} · ${pct((x.values.busy ?? 0) + (x.values.steal ?? 0))} · steal ${pct(x.values.steal ?? 0)} · load ${p?.host.load1.toFixed(2) ?? '·'}`
  }
  const h = store.host
  return h?.collector ? `now ${pct(h.cpuPct)} · ${cores(h.cpuPct)} · steal ${pct(h.stealPct)} · load ${h.load1.toFixed(2)} · pressure ${pct(h.psiCpuSome10)}` : ''
})
const memRead = computed(() => (mHover.value ? `${clock(mHover.value.t)} · ${ram(mHover.value.values.mem ?? 0)}` : store.host?.collector ? `now ${ram(store.host.memUsed)} of ${ram(store.host.memTotal)}` : ''))
// the breakdown readout lists the biggest four at the hovered time
function top(x: Hover, f: (v: number) => string) {
  if (!x) return []
  return legend.value.map(l => ({ ...l, v: x.values[l.key] ?? 0 })).filter(l => l.v > 0).sort((a, b) => b.v - a.v).slice(0, 4).map(l => ({ ...l, text: f(l.v) }))
}
const cRead = computed(() => top(cHover.value, pct))
const rRead = computed(() => top(rHover.value, ram))
</script>

<template>
  <div class="page usage">
    <div class="page-h"><h1>Usage</h1><p>Who used the host's CPU and RAM, per container and per process, sampled every 2 s by the collector and kept for a day. CPU is a share of the whole host.</p></div>
    <div class="u-head">
      <div class="seg" role="radiogroup" aria-label="Window">
        <label v-for="w in WINDOWS" :key="w"><input type="radio" name="usage-window" :value="w" :checked="store.usage.window === w" @change="setUsageWindow(w)"><span>{{ w }}</span></label>
      </div>
      <span v-if="d" class="fine num">{{ WINDOW_LABEL[d.window] }} · sampled {{ age }} ago</span>
      <span v-else-if="!store.usage.error" class="fine">Loading…</span>
    </div>
    <div v-if="store.usage.error" class="callout bad" role="alert"><h3><Led sev="bad" />Collector unreachable</h3><p>The dashboard could not read the collector ({{ store.usage.error }}). The graphs come back once it answers; the rest of the dashboard keeps working.</p></div>

    <template v-if="d">
      <section class="plate u-sec u-host" aria-label="Host">
        <h2>Host</h2>
        <div class="u-charts">
          <div class="u-ch">
            <div class="u-ch-top"><span class="lbl">CPU</span><span class="u-key"><span class="sw" style="background:var(--u-cpu)" />busy <span class="sw" style="background:var(--u-steal)" />steal</span><span class="fine num">{{ hostRead }}</span></div>
            <StackedArea :series="hostCpu" :from="sp.from" :to="sp.to" :max="100" :step="d.stepMs" label="Host CPU over the window" @hover="x => (hHover = x)" />
          </div>
          <div class="u-ch">
            <div class="u-ch-top"><span class="lbl">RAM</span><span class="fine num">{{ memRead }}</span></div>
            <StackedArea :series="hostMem" :from="sp.from" :to="sp.to" :max="memMax" :step="d.stepMs" label="Host memory over the window" @hover="x => (mHover = x)" />
          </div>
        </div>
      </section>

      <section class="plate u-sec" aria-label="Per container">
        <h2>Per container</h2>
        <div class="u-legend" role="group" aria-label="Series">
          <button v-for="l in legend" :key="l.key" type="button" :aria-pressed="!hidden.has(l.key)" @click="toggle(l.key)"><span class="sw" :style="{ background: l.color }" />{{ l.label }}</button>
        </div>
        <div class="u-charts">
          <div class="u-ch">
            <div class="u-ch-top"><span class="lbl">CPU</span><span class="fine num u-read"><template v-if="cHover">{{ clock(cHover.t) }}<span v-for="r in cRead" :key="r.key"><span class="sw" :style="{ background: r.color }" />{{ r.label }} {{ r.text }}</span></template><template v-else>stacked share of the host</template></span></div>
            <StackedArea :series="cpuStack" :from="sp.from" :to="sp.to" :max="100" :step="d.stepMs" label="CPU per container over the window" @hover="x => (cHover = x)" />
          </div>
          <div class="u-ch">
            <div class="u-ch-top"><span class="lbl">RAM</span><span class="fine num u-read"><template v-if="rHover">{{ clock(rHover.t) }}<span v-for="r in rRead" :key="r.key"><span class="sw" :style="{ background: r.color }" />{{ r.label }} {{ r.text }}</span></template><template v-else>stacked, of {{ ram(memMax) }}</template></span></div>
            <StackedArea :series="memStack" :from="sp.from" :to="sp.to" :max="memMax" :step="d.stepMs" label="Memory per container over the window" @hover="x => (rHover = x)" />
          </div>
        </div>
      </section>

      <section class="plate u-sec" aria-label="Table">
        <h2>By average CPU</h2>
        <p class="fine">Open a row for its processes by name: the top 3 by CPU and the top 3 by memory of every 10 s, summed over the container's processes of that name.</p>
        <UsageTable :rows="rows" :u="d" :from="sp.from" :to="sp.to" />
      </section>
    </template>
  </div>
</template>
