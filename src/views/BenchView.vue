<script lang="ts">
import { ref } from 'vue'
import type { SortKey } from '../lib/verdict'

// kept across tab switches, like the mockup's S.q and S.sort
const q = ref('')
const sort = ref<SortKey>('name')
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, shallowRef, useTemplateRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { loadLogs, store, visibleContainers } from '../store'
import { prefs } from '../composables/usePrefs'
import { narrow } from '../router'
import HostPanel from '../components/HostPanel.vue'
import ContainerRow from '../components/ContainerRow.vue'
import CompactRow from '../components/CompactRow.vue'
import ContainerDetail from '../components/ContainerDetail.vue'
import ActivityEvent from '../components/ActivityEvent.vue'

const route = useRoute(), router = useRouter()
const search = useTemplateRef<HTMLInputElement>('search')

const SORTS = [['attention', 'Attention first'], ['cpu', 'CPU'], ['mem', 'RAM'], ['disk', 'Disk'], ['name', 'Name']] as const

const id = computed(() => route.params.id as string | undefined)
const sel = computed(() => (id.value ? store.containers.find(c => c.id === id.value) : undefined))
const empty = computed(() => !store.loading && !store.containers.length)

// the order changes only with search, sort, compact, the container set or a state change, never on a number update (CPU hot, a CPU sort), so rows stay put under the finger between polls, like the mockup
const order = shallowRef<string[]>([])
const shape = () => store.containers.map(c => `${c.id}:${c.state}:${c.statusError}:${c.pending}:${c.status?.tunnel}`).join()
watch([shape, q, sort, () => prefs.compact], () => {
  order.value = visibleContainers(q.value, sort.value).map(c => c.id)
  // moving a focused row in the DOM blurs it, so give focus back
  const f = document.activeElement as HTMLElement | null
  if (f?.matches('.listpane .hit')) nextTick(() => { if (document.activeElement !== f && f.isConnected) f.focus({ preventScroll: true }) })
}, { immediate: true })
const rows = computed(() => order.value.map(i => store.containers.find(c => c.id === i)!).filter(Boolean))

// wide screens always show a detail: pick the first visible container
function autoSel(force = false) {
  if (store.loading) return
  if (narrow()) { if (id.value && !sel.value) router.replace('/bench'); return }
  if (!force && sel.value) return
  const first = order.value[0]
  if (first && first !== id.value) router.replace('/bench/' + first)
}
watch([id, order, () => store.loading], () => autoSel(), { immediate: true })
const mq = matchMedia('(min-width:760px)'), onMq = () => autoSel()
mq.addEventListener('change', onMq)
onBeforeUnmount(() => mq.removeEventListener('change', onMq))

function onSort() { nextTick(() => autoSel(true)) }

// phone: where the list was when a detail opened, restored on the way back
let listY = 0
function pick(i: string) { if (i !== id.value) { if (!id.value) listY = scrollY; router.push('/bench/' + i) } }

watch(id, (cur, prev) => {
  if (cur) loadLogs(cur)
  if (!narrow()) return
  // phone: the detail replaces the list, so move focus with it; coming back, return it to the row
  nextTick(() => requestAnimationFrame(() => {
    if (cur) {
      const h = document.querySelector<HTMLElement>('.detailpane .d-head h2')
      h?.setAttribute('tabindex', '-1')
      h?.focus({ preventScroll: true })
    } else if (prev) {
      scrollTo(0, listY)
      const row = document.querySelector<HTMLElement>(`.hit[data-id="${prev}"]`)
      row?.focus({ preventScroll: true })
      const r = row?.getBoundingClientRect()
      if (r && (r.top < 0 || r.bottom > innerHeight)) row!.scrollIntoView({ block: 'center' })
    }
  }))
}, { immediate: true })

function clearSearch() { q.value = ''; search.value?.focus() }
</script>

<template>
  <div class="bench" :class="{ 'has-sel': sel }">
    <HostPanel />
    <section class="listpane" aria-label="Dev containers">
      <div class="list-tools">
        <label class="sr" for="q">Search containers</label><input id="q" ref="search" v-model="q" class="search" type="search" placeholder="Search name, repo, branch" autocomplete="off" spellcheck="false">
        <label class="sort"><span class="sr">Sort by</span><select id="sortSel" v-model="sort" @change="onSort"><option v-for="[v, l] in SORTS" :key="v" :value="v">{{ l }}</option></select></label>
      </div>
      <div id="listBody">
        <ul v-if="store.loading" class="list cards" aria-busy="true" aria-label="Loading containers">
          <li v-for="i in 6" :key="i" class="row"><div class="hit" aria-hidden="true">
            <span class="led" style="opacity:.4"></span><span class="rh"><span class="sk" :style="{ width: 50 + (i - 1) * 7 % 30 + '%', height: '14px' }"></span><span class="sk" style="width:52px"></span></span>
            <span class="meta"><span class="sk" :style="{ display: 'block', width: 40 + (i - 1) * 11 % 35 + '%' }"></span></span>
            <span class="mms"><span class="sk"></span><span class="sk"></span><span class="sk"></span></span>
          </div></li>
        </ul>
        <div v-else-if="empty && store.dockerDown" class="plate empty"><h3>Can't load containers</h3><p class="fine">Docker isn't answering yet. The list fills in on the first good poll.</p></div>
        <div v-else-if="empty" class="plate empty"><h3>No dev containers on devnet</h3>
          <p class="fine">Deploy a DockBench stack in Portainer. Anything with the label <code>dockbench=true</code> on <code>devnet</code> shows up here on the next poll, running or stopped.</p></div>
        <ul v-else-if="rows.length" class="list cards">
          <component :is="prefs.compact ? CompactRow : ContainerRow" v-for="c in rows" :key="c.id" :c="c" :sel="c.id === id" @select="pick(c.id)" />
        </ul>
        <div v-else-if="prefs.compact && !q.trim()" class="plate empty"><h3>No running containers</h3><p class="fine">Compact view lists running containers only. Turn it off in Settings to see the rest.</p></div>
        <div v-else class="plate empty"><h3>No containers match "{{ q }}"</h3><p class="fine">Search looks at container names, repos and branches.</p><button type="button" class="btn" @click="clearSearch">Clear search</button></div>
      </div>
    </section>
    <section class="detailpane" aria-label="Container detail">
      <ContainerDetail v-if="sel" :key="sel.id" :id="sel.id" @back="router.push('/bench')" />
      <div v-else class="placeholder plate">{{ empty ? 'Nothing to show yet.' : 'Pick a container to see its detail.' }}</div>
    </section>
    <aside class="feed" aria-label="Recent activity">
      <div class="plate"><div class="feed-h"><h2 class="lbl">Recent activity</h2><button type="button" @click="router.push('/activity')">All</button></div>
        <ul class="evs"><ActivityEvent v-for="(e, i) in store.activity.slice(0, 9)" :key="e.at + i" :e="e" /></ul></div>
    </aside>
  </div>
</template>
