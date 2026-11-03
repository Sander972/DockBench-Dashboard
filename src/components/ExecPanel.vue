<script setup lang="ts">
import type { ExecState } from '../store'

defineProps<{ x: ExecState }>()
const codeCls = (n: number | null) => (n == null ? 'code-wait' : n < 300 ? 'code-ok' : 'code-bad')
</script>

<template>
  <div class="exec" aria-live="polite">
    <div class="exec-h num"><span>$ {{ x.cmd }}</span><span :class="x.exitCode == null ? 'code-wait' : x.exitCode === 0 ? 'code-ok' : 'code-bad'">{{ x.exitCode == null ? 'running' : 'exit ' + x.exitCode }}</span></div>
    <ol class="trace num">
      <li v-for="(k, i) in x.calls" :key="i"><span>{{ k.method }}</span><span class="p">{{ k.path }}</span><span :class="codeCls(k.status)">{{ k.status ?? '…' }}</span></li>
    </ol>
    <pre v-if="x.output" class="term">{{ x.output }}</pre>
    <p v-if="x.msg" class="fine" :class="{ 's-bad': x.exitCode }">{{ x.msg }}</p>
  </div>
</template>
