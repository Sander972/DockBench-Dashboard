<script setup lang="ts">
import { computed } from 'vue'
import type { ActivityEvent } from '../types'
import { when } from '../lib/format'
import { now } from '../composables/useNow'
import Led from './Led.vue'

const props = defineProps<{ e: ActivityEvent }>()
const last = computed(() => props.e.calls.map(c => c.status).filter(Boolean).pop())
</script>

<template>
  <li class="ev">
    <span class="ev-t num">{{ when(e.at, now) }}</span>
    <div class="ev-main">
      <Led :sev="e.ok ? 'ok' : 'bad'" :size="7" /><b>{{ e.what }}</b><span>{{ e.target }}</span>
      <span v-if="last" class="codes" :class="e.ok ? 'code-ok' : 'code-bad'">{{ last }}</span>
    </div>
    <div v-if="e.calls.length" class="ev-calls num"><template v-for="(c, i) in e.calls" :key="i"><br v-if="i" />{{ c.method }} {{ c.path }}</template></div>
    <div class="ev-by">{{ e.device ?? e.actor }}<template v-if="e.ip"> · {{ e.ip }}</template><template v-if="e.note"> · {{ e.note }}</template><template v-if="e.ms"> · {{ (e.ms / 1000).toFixed(1) }}s</template></div>
  </li>
</template>
