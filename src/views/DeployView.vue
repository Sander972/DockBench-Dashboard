<script setup lang="ts">
import { nextTick, watch } from 'vue'
import { loadRepos, store } from '../store'
import RepoPicker from '../components/RepoPicker.vue'
import DeployForm from '../components/DeployForm.vue'
import DeployRun from '../components/DeployRun.vue'

loadRepos()
// the screen swaps between form and run: move focus to the new heading, unless the passkey panel took it
watch(() => !!store.draft.run, () => nextTick(() => { if (!store.confirm) document.querySelector<HTMLElement>('main h1')?.focus() }))
</script>

<template>
  <DeployRun v-if="store.draft.run" />
  <div v-else class="page page-wide">
    <div class="page-h"><h1 tabindex="-1">Deploy</h1><p>Start a dev container from a repository your GitHub account can reach.</p></div>
    <div class="deploy">
      <RepoPicker />
      <DeployForm />
    </div>
  </div>
</template>
