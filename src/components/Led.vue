<script setup lang="ts">
defineProps<{ sev: 'ok' | 'warn' | 'bad' | 'off'; blink?: boolean; size?: number }>()
</script>

<template>
  <span class="led" :class="[sev, { blink }]" :style="size ? { width: `${size}px`, height: `${size}px` } : undefined" aria-hidden="true"></span>
</template>
