<script setup lang="ts">
import { computed, ref } from 'vue'
import { hostUse, store } from '../store'
import { prefs } from '../composables/usePrefs'
import { now } from '../composables/useNow'
import { ago, dur, gib, toGiB } from '../lib/format'
import Led from './Led.vue'
import Meter from './Meter.vue'
import Sparkline from './Sparkline.vue'

// graph readout: the hovered sample, or the newest one; the age comes from the sample's own time, polls are not evenly spaced
const hover = ref<{ cpu: number | null; mem: number | null }>({ cpu: null, mem: null })
function read(m: 'cpu' | 'mem') {
  const hh = store.hostHistory, a = hh[m], i = hover.value[m] ?? a.length - 1, x = a[i] ?? 0
  const when = i < a.length - 1 ? ago(hh.t[i], now.value) : 'now'
  return m === 'cpu' ? `${x.toFixed(1)}% · ${when}` : `${gib(toGiB(x))} of ${gib(toGiB(h.value!.memTotal))} GiB · ${when}`
}

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
      <div class="chan"><span class="lbl">CPU</span><Meter :pct="hostUse?.cpu ?? 0" label="Host CPU" /><span class="v num">{{ h ? hostUse!.cpu.toFixed(0) + '%' : '·' }}</span></div>
      <div class="chan"><span class="lbl">RAM</span><Meter :pct="hostUse?.mem ?? 0" label="Host memory" /><span class="v num">{{ h ? `${toGiB(h.memUsed).toFixed(1)}/${toGiB(h.memTotal).toFixed(1)}G` : '·' }}</span></div>
      <div class="chan"><span class="lbl">Disk</span><Meter :pct="hostUse?.disk ?? 0" label="Host disk" /><span class="v num">{{ h ? `${toGiB(h.diskUsed).toFixed(0)}/${toGiB(h.diskTotal).toFixed(0)}G` : '·' }}</span></div>
    </div>
    <details v-if="h && !store.dockerDown && store.hostHistory.t.length" class="fold host-graphs" open>
      <summary><span class="fold-t">CPU and RAM graphs</span><span class="fold-s">Last {{ store.hostHistory.t.length }} samples</span></summary>
      <div class="fold-b chs">
        <div class="ch">
          <div class="ch-top"><span class="lbl">CPU</span><span class="ch-foot num">{{ read('cpu') }}</span></div>
          <Sparkline :samples="store.hostHistory.cpu" :max="100" @hover="i => (hover.cpu = i)" />
        </div>
        <div class="ch">
          <div class="ch-top"><span class="lbl">RAM</span><span class="ch-foot num">{{ read('mem') }}</span></div>
          <Sparkline :samples="store.hostHistory.mem" :max="h.memTotal" @hover="i => (hover.mem = i)" />
        </div>
      </div>
    </details>
    <div v-if="store.containers.length || !store.dockerDown" class="census"><span><span class="num">devnet</span><span><b>{{ store.loading ? '·' : store.containers.length }}</b> containers</span></span><span v-if="!store.loading"><span v-for="[l, n] in census" :key="l"><b>{{ n }}</b> {{ l }}</span></span></div>
  </section>
</template>
