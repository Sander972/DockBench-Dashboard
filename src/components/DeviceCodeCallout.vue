<script setup lang="ts">
import { ref } from 'vue'
import { toast } from '../store'
import AppIcon from './AppIcon.vue'
import Led from './Led.vue'

const props = defineProps<{ code: string; kind: 'gh' | 'tunnel' }>()
const el = ref<HTMLElement>()

async function copy() {
  try {
    await navigator.clipboard.writeText(props.code)
    toast('Code copied')
  } catch {
    const r = document.createRange()
    r.selectNodeContents(el.value!)
    const s = getSelection()!
    s.removeAllRanges()
    s.addRange(r)
    toast('Code selected, copy it from the selection')
  }
}
</script>

<template>
  <div class="callout warn">
    <h3><Led sev="warn" blink />{{ kind === 'gh' ? 'GitHub CLI is waiting for you' : 'Approve the VS Code tunnel' }}</h3>
    <p>{{ kind === 'gh' ? 'First start without a GITHUB_TOKEN blocks on gh auth login. Clone, mise install and /status all wait for this.' : 'The tunnel has no id yet. Approve it with the GitHub account that should own it; only that account can open the links.' }}</p>
    <ol class="steps">
      <li>Open <a href="https://github.com/login/device" target="_blank" rel="noopener noreferrer">github.com/login/device</a></li>
      <li>Enter this code from the container log</li>
    </ol>
    <div class="devcode"><span ref="el" class="code">{{ code }}</span><button type="button" class="btn" @click="copy"><AppIcon name="copy" /> Copy</button></div>
  </div>
</template>
