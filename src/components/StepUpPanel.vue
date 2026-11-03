<script setup lang="ts">
import { onMounted, ref, useId } from 'vue'
import type { Guarded } from '../types'
import AppIcon from './AppIcon.vue'

const props = defineProps<{ action: Guarded; name: string; waiting: boolean; text?: string }>()
const emit = defineEmits<{ confirm: []; cancel: [] }>()

const COPY: Record<Guarded, (n: string) => string> = {
  stop: n => `Stopping ${n} closes its tunnel and disconnects any open VS Code window.`,
  restart: n => `Restarting ${n} drops the tunnel for about 20 seconds, then it reconnects. The tunnel is PID 1, so this is the only way to restart it.`,
  pull: n => `Runs git pull --ff-only in /home/dev/workspace as dev, inside ${n}.`,
  deploy: n => `Creates the Portainer stack ${n} and starts it: a new container with a shell, git and a tunnel on devnet.`,
  update: n => `Pulls the newest image and recreates ${n} from it through its Portainer stack. /home/dev and the workspace stay; the tunnel drops until the new container is up.`,
  remove: n => `Deletes ${n} for good: its Portainer stack, the container, its /home/dev volume with the workspace and its deploy keys on GitHub.`,
}

const hid = useId()
const pk = ref<HTMLButtonElement>()
// a key still held from the hold auto-repeats onto this focused button, so the template ignores repeats (Enter clicks on keydown, Space on keyup)
onMounted(() => pk.value?.focus())
function esc() { if (!props.waiting) emit('cancel') }
</script>

<template>
  <div class="confirm" role="group" :aria-labelledby="hid" @keydown.esc.stop="esc">
    <div><b :id="hid">Confirm it's you</b><p>{{ text ?? COPY[action](name) }}</p></div>
    <div class="btns">
      <button ref="pk" type="button" class="btn pri" :aria-disabled="waiting" @keydown="e => e.repeat && e.preventDefault()" @click="waiting || emit('confirm')"><AppIcon name="key" /> {{ waiting ? 'Waiting for passkey…' : 'Use passkey' }}</button>
      <button type="button" class="btn" :disabled="waiting" @click="emit('cancel')">Cancel</button>
    </div>
    <p class="fine">After this check, nothing asks again for 5 minutes.</p>
  </div>
</template>
