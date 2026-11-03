<script setup lang="ts">
import { computed } from 'vue'
import { pickRepo, store } from '../store'
import { now } from '../composables/useNow'
import { ago, ms } from '../lib/format'

// newest push first, already deployed last
const list = computed(() => {
  const q = store.draft.q.trim().toLowerCase()
  return (store.repos ?? [])
    .filter(r => !q || r.fullName.toLowerCase().includes(q) || (r.description || '').toLowerCase().includes(q))
    .sort((a, b) => +!!a.deployedAs - +!!b.deployedAs || ms(b.pushedAt) - ms(a.pushedAt))
})
</script>

<template>
  <section class="plate dsec" aria-labelledby="d1">
    <div class="sec-h"><h2 class="lbl" id="d1">1 · Repository</h2><span class="src-note">GitHub · GET /user/repos</span></div>
    <label class="sr" for="repoQ">Search repositories</label><input id="repoQ" v-model="store.draft.q" class="search" type="search" placeholder="Search your repositories" autocomplete="off" spellcheck="false">
    <ul id="repoList" class="repos" aria-label="Repositories">
      <template v-if="!store.repos">
        <li v-for="i in 5" :key="i"><div class="repo" aria-hidden="true"><span class="sk" :style="{ width: 45 + ((i - 1) * 13) % 35 + '%', height: '14px' }"></span><span class="sk" style="width:48px"></span><span class="repo-m"><span class="sk" style="display:block;width:55%"></span></span></div></li>
      </template>
      <li v-else-if="!list.length" class="fine" style="padding:14px">No repository matches "{{ store.draft.q }}". Only repos the DockBench GitHub App is installed on show up.</li>
      <template v-else><li v-for="r in list" :key="r.fullName">
        <button type="button" class="repo" :aria-pressed="store.draft.repo?.fullName === r.fullName" :disabled="!!r.deployedAs" @click="pickRepo(r)">
          <span class="repo-n"><span class="dim">{{ r.fullName.split('/')[0] }}/</span>{{ r.fullName.split('/')[1] }}</span><span class="repo-tag">{{ r.private ? 'Private' : 'Public' }}</span>
          <span v-if="r.description" class="repo-d">{{ r.description }}</span>
          <span class="repo-m">{{ r.deployedAs ? `Already deployed as ${r.deployedAs}` : [r.language, r.defaultBranch, 'pushed ' + ago(r.pushedAt, now)].filter(Boolean).join(' · ') }}</span>
        </button>
      </li></template>
    </ul>
  </section>
</template>
