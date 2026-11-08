<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { hostUse, store, watchUsage } from '../store'
import { prefs } from '../composables/usePrefs'
import { now } from '../composables/useNow'
import { ago, dur, gib, toGiB } from '../lib/format'
import { hostSeries, span, WINDOW_LABEL } from '../lib/usage'
import Led from './Led.vue'
import Meter from './Meter.vue'
import Sparkline from './Sparkline.vue'

// the graphs read the collector's history, loaded while this panel is mounted
onBeforeUnmount(watchUsage())
const series = computed(() => (store.usage.data ? hostSeries(store.usage.data) : null))
const sp = computed(() => (store.usage.data ? span(store.usage.data) : { from: 0, to: 0 }))
// graph readout: the hovered point, or the newest one, with the point's own time
const hover = ref<{ cpu: number | null; mem: number | null }>({ cpu: null, mem: null })
function read(m: 'cpu' | 'mem') {
  const a = series.value![m], i = hover.value[m] ?? a.length - 1, p = a[i]
  if (!p) return ''
  const when = i < a.length - 1 ? ago(p.t, now.value) : 'now'
  return m === 'cpu' ? `${p.v.toFixed(1)}% · ${when}` : `${gib(toGiB(p.v))} of ${gib(toGiB(h.value!.memTotal))} GiB · ${when}`
}
// no collector: the CPU and RAM meters have nothing to show
const noCollector = computed(() => store.host?.collector === false)

const h = computed(() => store.host)
const pollText = computed(() => store.dockerDown ? (store.lastGoodAt ? `last good poll ${ago(store.lastGoodAt, now.value)}` : 'no good poll yet') : store.lastPollAt ? `polled ${dur((now.value - store.lastPollAt) / 1000)} ago · every ${prefs.poll}s` : `every ${prefs.poll}s`)

const STATES = [['running', 'running'], ['restarting', 'restarting'], ['paused', 'paused'], ['created', 'created'], ['dead', 'dead'], ['exited', 'stopped']] as const
// zero buckets are left out, except stopped
const census = computed(() => STATES.map(([s, l]) => [l, store.containers.filter(c => c.state === s).length] as const).filter(([l, n]) => n || l === 'stopped'))
</script>

<template>
  <section class="rack plate" aria-label="Host">
    <div class="rack-head">
      <div><span class="lbl">Host</span><b>{{ h?.name }}</b> <span v-if="h" class="rack-spec num">{{ h.ncpu }} CPU · {{ toGiB(h.memTotal).toFixed(1) }} GiB · Docker {{ h.dockerVersion }}</span></div>
      <span class="poll"><Led :key="store.lastGoodAt" :sev="store.dockerDown ? 'bad' : store.lastPollAt ? 'ok' : 'off'" :class="{ flash: store.lastGoodAt > 0 }" /><span>{{ pollText }}</span></span>
    </div>
    <div v-if="store.dockerDown" class="down" role="alert">
      <strong>Can't reach Docker through the socket proxy.</strong>
      <span class="fine">Showing values from the last good poll. Actions are paused until it answers. Retrying every {{ prefs.poll }}s.</span>
      <code>{{ store.downError }}</code>
    </div>
    <div v-else class="chans">
      <div class="chan"><span class="lbl">CPU</span><Meter :pct="hostUse?.cpu ?? 0" label="Host CPU" :off="noCollector" /><span class="v num">{{ h && !noCollector ? hostUse!.cpu.toFixed(0) + '%' : '·' }}</span></div>
      <div class="chan"><span class="lbl">RAM</span><Meter :pct="hostUse?.mem ?? 0" label="Host memory" :off="noCollector" /><span class="v num">{{ h && !noCollector ? `${toGiB(h.memUsed).toFixed(1)}/${toGiB(h.memTotal).toFixed(1)}G` : '·' }}</span></div>
      <div class="chan"><span class="lbl">Disk</span><Meter :pct="hostUse?.disk ?? 0" label="Host disk" /><span class="v num">{{ h ? `${toGiB(h.diskUsed).toFixed(0)}/${toGiB(h.diskTotal).toFixed(0)}G` : '·' }}</span></div>
    </div>
    <p v-if="h && !store.dockerDown && noCollector" class="fine collector-down"><Led sev="warn" /> Collector unreachable: no CPU and RAM figures.</p>
    <details v-if="h && !store.dockerDown && series?.cpu.length" class="fold host-graphs" open>
      <summary><span class="fold-t">CPU and RAM graphs</span><span class="fold-s">{{ WINDOW_LABEL[store.usage.data!.window] }}</span></summary>
      <div class="fold-b chs">
        <div class="ch">
          <div class="ch-top"><span class="lbl">CPU</span><span class="ch-foot num">{{ read('cpu') }}</span></div>
          <Sparkline :points="series.cpu" :from="sp.from" :to="sp.to" :step="store.usage.data!.stepMs" :max="100" @hover="i => (hover.cpu = i)" />
        </div>
        <div class="ch">
          <div class="ch-top"><span class="lbl">RAM</span><span class="ch-foot num">{{ read('mem') }}</span></div>
          <Sparkline :points="series.mem" :from="sp.from" :to="sp.to" :step="store.usage.data!.stepMs" :max="h.memTotal" @hover="i => (hover.mem = i)" />
        </div>
      </div>
    </details>
    <div v-if="store.containers.length || !store.dockerDown" class="census"><span><span class="num">devnet</span><span><b>{{ store.loading ? '·' : store.containers.length }}</b> containers</span></span><span v-if="!store.loading"><span v-for="[l, n] in census" :key="l"><b>{{ n }}</b> {{ l }}</span></span></div>
  </section>
</template>
