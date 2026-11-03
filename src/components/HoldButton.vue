<script setup lang="ts">
import { useHold } from '../composables/useHold'

const props = defineProps<{ danger?: boolean; disabled?: boolean }>()
const emit = defineEmits<{ confirm: []; early: [] }>()
const { holding, handlers } = useHold(() => emit('confirm'), () => emit('early'), () => !!props.disabled)
</script>

<template>
  <!-- aria-disabled, not disabled: a busy button keeps keyboard focus (handoff 5.4) -->
  <button type="button" class="btn hold" :class="{ danger, holding }" :aria-disabled="disabled || undefined" v-on="handlers">
    <slot />
  </button>
</template>
