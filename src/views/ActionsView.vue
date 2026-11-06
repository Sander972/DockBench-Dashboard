<script lang="ts">
import { ref } from 'vue'
import type { CiFilter, CiSort } from '../lib/actions'

// kept across tab switches, like Bench's search
const q = ref('')
const filter = ref<CiFilter>('all')
const sort = ref<CiSort>('recent')
const open = ref(new Set<string>())
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { loadActions, store } from '../store'
import { counts, filterRepos, REPO_SEV, REPO_WORD, runSev, runWord } from '../lib/actions'
import { useNow } from '../composables/useNow'
import { ago, since } from '../lib/format'
import CiRuns from '../components/CiRuns.vue'
import Led from '../components/Led.vue'

const now = useNow()
const router = useRouter()
const list = computed(() => store.actions ?? [])
const rows = computed(() => filterRepos(list.value, q.value, filter.value, sort.value))
const n = computed(() => counts(list.value))
const FILTERS = [['all', 'All'], ['running', 'Running'], ['failure', 'Failing'], ['success', 'Passing'], ['none', 'No CI']] as const
const SORTS = [['recent', 'Latest activity'], ['status', 'Status first'], ['failure', 'Latest failure'], ['name', 'Name']] as const
const container = (name: string | null) => (name ? store.containers.find(c => c.name === name) : undefined)

function toggle(repo: string) {
  const s = new Set(open.value)
  if (!s.delete(repo)) s.add(repo)
  open.value = s
}

// GitHub answers 304 for unchanged run lists, so polling every 30 s costs no rate limit
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  loadActions()
  timer = setInterval(() => { if (!document.hidden) loadActions() }, 30_000)
})
onBeforeUnmount(() => clearInterval(timer))
</script>

<template>
  <div class="page">
    <div class="page-h"><h1>Actions</h1><p>GitHub Actions of your repositories: what is running, whether the default branch passes, the last success and failure. Refreshed every 30 seconds.</p></div>

    <div class="list-tools">
      <label class="sr" for="aq">Search repositories</label><input id="aq" v-model="q" class="search" type="search" placeholder="Search repo, container, workflow, branch, commit" autocomplete="off" spellcheck="false">
      <label class="sort"><span class="sr">Sort by</span><select v-model="sort"><option v-for="[v, l] in SORTS" :key="v" :value="v">{{ l }}</option></select></label>
    </div>
    <div class="seg ci-seg" role="radiogroup" aria-label="Show">
      <label v-for="[v, l] in FILTERS" :key="v"><input v-model="filter" type="radio" name="cif" :value="v"><span>{{ l }} <b class="num">{{ n[v] }}</b></span></label>
    </div>

    <p v-if="store.actionsError" class="callout bad">{{ store.actionsError }}</p>
    <ul v-if="!store.actions" class="list plate" aria-busy="true" aria-label="Loading repositories">
      <li v-for="i in 6" :key="i" class="row"><div class="hit" aria-hidden="true"><span class="led" style="opacity:.4"></span><span class="rh"><span class="sk" :style="{ width: 40 + (i * 13) % 40 + '%', height: '14px' }"></span></span></div></li>
    </ul>
    <div v-else-if="!rows.length" class="plate empty"><h3>{{ list.length ? 'No repository matches' : 'No repositories' }}</h3><p class="fine">{{ list.length ? 'Search looks at repo names, dev containers, workflows, branches and commit titles.' : 'The signed-in GitHub account sees no repository.' }}</p><button v-if="q || filter !== 'all'" type="button" class="btn" @click="q = ''; filter = 'all'">Show all</button></div>
    <ul v-else class="list plate">
      <li v-for="a in rows" :key="a.repo" class="row ci-row">
        <button type="button" class="hit" :aria-expanded="open.has(a.repo)" @click="toggle(a.repo)">
          <Led :sev="REPO_SEV[a.state]" :blink="a.state === 'running'" />
          <span class="rh"><span class="name"><span class="pre">{{ a.repo.split('/')[0] }}/</span>{{ a.repo.split('/')[1] }}</span><span class="state" :class="'s-' + REPO_SEV[a.state]">{{ REPO_WORD[a.state] }}</span></span>
          <span class="meta">
            <template v-if="a.running.length"><template v-for="(r, i) in a.running" :key="r.id">{{ i ? ' · ' : '' }}{{ r.workflow }} {{ runWord(r) }} {{ since(r.startedAt, now) }}</template></template>
            <template v-else-if="a.latest.length"><template v-for="(r, i) in a.latest" :key="r.id">{{ i ? ' · ' : '' }}<span :class="runSev(r) !== 'ok' && 's-' + runSev(r)">{{ r.workflow }} {{ runWord(r) }}</span> {{ ago(r.updatedAt, now) }}</template></template>
            <template v-else>no workflow runs</template>
          </span>
          <span class="meta2">
            <span v-if="a.deployedAs" class="tag">{{ a.deployedAs }}</span>
            <span v-if="a.lastSuccess">last passed {{ ago(a.lastSuccess.updatedAt, now) }}</span>
            <span v-if="a.lastFailure" class="s-bad">last failed {{ ago(a.lastFailure.updatedAt, now) }}</span>
            <span v-if="a.private === false" class="s-off">public</span>
          </span>
        </button>
        <div v-if="open.has(a.repo)" class="ci-detail">
          <CiRuns :a="a" />
          <button v-if="container(a.deployedAs)" type="button" class="btn sm" @click="router.push('/bench/' + container(a.deployedAs)!.id)">Open {{ a.deployedAs }} on Bench</button>
        </div>
      </li>
    </ul>
  </div>
</template>
