<script setup lang="ts">
import { computed, ref } from 'vue'
import { sendClaudeCode, startClaudeLogin, store, toast } from '../store'
import AppIcon from './AppIcon.vue'
import Led from './Led.vue'

const props = defineProps<{ id: string }>()
const l = computed(() => store.claudeLogin[props.id])
const code = ref('')
const inputId = computed(() => 'claude-code-' + props.id)

async function copy() {
  try {
    await navigator.clipboard.writeText(l.value!.url)
    toast('Link copied')
  } catch {
    toast('Could not copy, use Open sign-in page')
  }
}

function start() {
  code.value = ''
  startClaudeLogin(props.id)
}
</script>

<template>
  <div class="callout" :class="l?.phase === 'error' ? 'bad' : 'warn'" aria-live="polite">
    <template v-if="!l || l.phase === 'starting'">
      <h3><Led sev="warn" />Claude Code is not signed in</h3>
      <p>Sign it in with your Claude subscription here, no tunnel or shell needed.</p>
      <div class="btns"><button type="button" class="btn pri" :aria-disabled="!!l || undefined" @click="!l && start()">{{ l ? 'Starting…' : 'Sign in with Claude subscription' }}</button></div>
    </template>
    <template v-else-if="l.phase === 'link' || l.phase === 'sending'">
      <h3><Led sev="warn" blink />Sign in to Claude</h3>
      <ol class="steps">
        <li>Open the sign-in page</li>
        <li>Sign in with your Claude account</li>
        <li>Copy the code claude.com shows</li>
        <li>Paste it here</li>
      </ol>
      <div class="btns">
        <a class="btn pri" :href="l.url" target="_blank" rel="noopener noreferrer">Open sign-in page <AppIcon name="ext" /></a>
        <button type="button" class="btn" @click="copy"><AppIcon name="copy" /> Copy link</button>
      </div>
      <form class="field" @submit.prevent="l.phase === 'link' && sendClaudeCode(id, code)">
        <label :for="inputId">Code from claude.com</label>
        <input :id="inputId" v-model="code" class="inp num" autocomplete="off" autocapitalize="off" spellcheck="false" :readonly="l.phase === 'sending'">
        <div class="btns"><button type="submit" class="btn pri" :aria-disabled="!code.trim() || l.phase === 'sending' || undefined">{{ l.phase === 'sending' ? 'Signing in…' : 'Complete sign-in' }}</button></div>
      </form>
    </template>
    <template v-else-if="l.phase === 'done'">
      <h3><Led sev="warn" blink />Signed in, waiting for status</h3>
      <p>The Claude Code row updates on the next poll.</p>
    </template>
    <template v-else>
      <h3><Led sev="bad" />Claude sign-in failed</h3>
      <p>{{ l.msg }}</p>
      <div class="btns"><button type="button" class="btn pri" @click="start">Start again</button></div>
    </template>
  </div>
</template>
