<script setup lang="ts">
import { ref, watch } from 'vue'
import { store } from '../store'

// keep the last text while the toast fades out
const text = ref('')
watch(() => store.toastMsg, m => { if (m) text.value = m })
</script>

<template>
  <div class="toast" :class="{ show: !!store.toastMsg }" role="status" aria-live="polite">{{ text }}</div>
</template>
