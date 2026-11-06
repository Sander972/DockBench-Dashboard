<script setup lang="ts">
import { computed } from 'vue'
import type { RepoActions } from '../types'
import { actionsUrl, runSev, runWord } from '../lib/actions'
import { useNow } from '../composables/useNow'
import { ago, since } from '../lib/format'
import AppIcon from './AppIcon.vue'
import Led from './Led.vue'

// GitHub Actions of one repo: what runs now, the newest run of each workflow, the last success and failure. Shared by the Actions page and a dev container's detail.
const props = defineProps<{ a: RepoActions; noLink?: boolean }>()
const now = useNow()
const going = computed(() => new Set(props.a.running.map(r => r.id)))
const done = computed(() => props.a.latest.filter(r => !going.value.has(r.id)))
</script>

<template>
  <div class="ci">
    <p v-if="a.error" class="fine s-bad">GitHub did not answer: {{ a.error }}. Showing the last runs it sent.</p>
    <ul v-if="a.running.length || done.length" class="ci-runs">
      <li v-for="r in a.running" :key="r.id">
        <Led sev="warn" blink :size="8" />
        <a :href="r.url" target="_blank" rel="noopener"><b>{{ r.workflow }}</b></a>
        <span class="state s-warn">{{ runWord(r) }} {{ since(r.startedAt, now) }}</span>
        <span class="ci-sub"><span class="num">{{ r.branch ?? '·' }} · {{ r.sha }}</span> {{ r.title }}</span>
      </li>
      <li v-for="r in done" :key="r.id">
        <Led :sev="runSev(r)" :size="8" />
        <a :href="r.url" target="_blank" rel="noopener"><b>{{ r.workflow }}</b></a>
        <span class="state" :class="'s-' + runSev(r)">{{ runWord(r) }} {{ ago(r.updatedAt, now) }}</span>
        <span class="ci-sub"><span class="num">{{ r.branch ?? '·' }} · {{ r.sha }}</span> {{ r.title }}</span>
      </li>
    </ul>
    <p v-else class="fine">No workflow runs: this repo has no GitHub Actions, or they never ran.</p>
    <p v-if="a.lastSuccess || a.lastFailure" class="fine">
      <template v-if="a.lastSuccess">Last success <a :href="a.lastSuccess.url" target="_blank" rel="noopener">{{ a.lastSuccess.workflow }} {{ ago(a.lastSuccess.updatedAt, now) }}</a></template>
      <template v-if="a.lastSuccess && a.lastFailure"> · </template>
      <template v-if="a.lastFailure">last failure <a :href="a.lastFailure.url" target="_blank" rel="noopener">{{ a.lastFailure.workflow }} {{ ago(a.lastFailure.updatedAt, now) }}</a></template>
      <template v-else> · no failure in the last 30 runs</template>
    </p>
    <a v-if="!noLink" class="btn sm" :href="actionsUrl(a.repo)" target="_blank" rel="noopener">All runs on GitHub <AppIcon name="ext" /></a>
  </div>
</template>
