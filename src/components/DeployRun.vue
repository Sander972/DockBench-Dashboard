<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { resetDeploy, store } from '../store'
import Led from './Led.vue'

const router = useRouter()
const d = computed(() => store.draft)
const r = computed(() => store.draft.run!)
// the callout waits until the Docker list call has found the container
const c = computed(() => r.value.id && store.containers.find(x => x.id === r.value.id))
// after an error the call left without a status is the one that failed
const codeCls = (n: number | null) => (n == null ? (r.value.error ? 'code-bad' : 'code-wait') : n < 300 ? 'code-ok' : 'code-bad')

function another() {
  resetDeploy()
  scrollTo(0, 0)
}
</script>

<template>
  <div class="page">
    <div class="page-h"><h1 tabindex="-1">{{ r.error ? 'Could not deploy' : r.id != null ? 'Deployed' : 'Deploying' }} {{ r.name }}</h1><p>{{ d.repo?.fullName }} · token</p></div>
    <div class="plate dsec" aria-live="polite">
      <ol class="trace num"><li v-for="(x, i) in r.calls" :key="i"><span>{{ x.method }}</span><span class="p">{{ x.path }}</span><span :class="codeCls(x.status)">{{ x.status ?? (r.error ? 'failed' : '…') }}</span></li></ol>
      <template v-if="r.error">
        <div class="callout bad"><h3><Led sev="bad" />Deploy failed</h3><p>{{ r.error }}</p></div>
        <div class="btns"><button type="button" class="btn pri" @click="d.run = null">Back to settings</button></div>
      </template>
      <template v-else-if="c">
        <div class="callout warn">
          <h3><Led sev="warn" blink />Starting, one approval needed</h3>
          <p>It clones and installs tools now. Then the VS Code tunnel asks you to approve it once. The code shows on its Bench page.<template v-if="d.installClaude"> Claude Code is signed in from that page too.</template></p>
        </div>
        <div class="btns"><button type="button" class="btn pri" @click="router.push('/bench/' + c.id)">Open on Bench</button><button type="button" class="btn" @click="another">Deploy another</button></div>
      </template>
      <template v-else-if="r.id === ''">
        <p class="fine">Portainer created the stack, but Docker does not list the container yet. It shows up on Bench when it starts.</p>
        <div class="btns"><button type="button" class="btn pri" @click="router.push('/bench')">Open Bench</button><button type="button" class="btn" @click="another">Deploy another</button></div>
      </template>
      <p v-else class="fine">Pulling the image and creating the Portainer stack. The first pull can take a minute.</p>
    </div>
  </div>
</template>
