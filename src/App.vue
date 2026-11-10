<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { attentionCount, ciFailCount, hostUse, store, toast, updatesCount } from './store'
import { cycleTheme, prefs } from './composables/usePrefs'
import { useCls } from './lib/format'
import { narrow } from './router'
import { haptic } from './lib/haptics'
import AppIcon from './components/AppIcon.vue'
import AppToast from './components/AppToast.vue'

const route = useRoute(), router = useRouter()

const VIEWS = [
  { to: 'bench', label: 'Bench', icon: 'bench' },
  { to: 'usage', label: 'Usage', icon: 'usage' },
  { to: 'actions', label: 'Actions', icon: 'ci' },
  { to: 'deploy', label: 'Deploy', icon: 'plus' },
  { to: 'activity', label: 'Activity', icon: 'activity' },
  { to: 'telegram', label: 'Telegram', icon: 'send' },
  { to: 'settings', label: 'Settings', icon: 'sliders' },
] as const

// coming back to Bench reopens the container that was open
let lastBench = '/bench'
watch(() => route.fullPath, () => { if (route.name === 'bench') lastBench = route.fullPath })
function go(to: string) {
  if (to === route.name) return
  haptic()
  router.push(to === 'bench' ? lastBench : '/' + to)
}

// Bench counts containers that need attention, Actions the dev containers whose CI fails, Settings the newer dashboard or bot images waiting to be installed
const badge = (to: string) => (to === 'bench' ? attentionCount.value : to === 'actions' ? ciFailCount.value : to === 'settings' ? updatesCount.value : 0)
const badgeLabel = (to: string) => (to === 'bench' ? `${attentionCount.value} need attention` : to === 'actions' ? `${ciFailCount.value} failing` : `${updatesCount.value} update${updatesCount.value > 1 ? 's' : ''} to install`)

const sys = computed(() => {
  const u = hostUse.value
  return [['CPU', u?.cpu], ['RAM', u?.mem], ['Disk', u?.disk]] as const
})

const themeIcon = computed(() => ({ system: 'auto', light: 'sun', dark: 'moon' } as const)[prefs.theme])
function switchTheme() { haptic(); toast(`Theme: ${cycleTheme()}`) }

// session gone (sign out or a 401): back to the sign-in plate; signed in on the plate: into the app
watch(() => store.session, s => {
  if (!s && route.name !== 'sign-in') router.replace('/sign-in')
  else if (s && route.name === 'sign-in') router.replace('/bench')
})

// Esc goes back from the detail on phone
function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (route.name === 'bench' && route.params.id && narrow()) router.push('/bench')
}
document.addEventListener('keydown', onKey)
onBeforeUnmount(() => document.removeEventListener('keydown', onKey))
</script>

<template>
  <template v-if="store.session && route.name !== 'sign-in'">
    <header class="top">
      <div class="brand">
        <span class="key" aria-hidden="true"></span>
        <span class="word">DockBench</span>
        <span class="host num">{{ store.host?.name }}</span>
      </div>
      <nav class="tabs-top" aria-label="Sections">
        <button v-for="v in VIEWS" :key="v.to" type="button" :aria-current="route.name === v.to ? 'page' : undefined" @click="go(v.to)">{{ v.label }}<span v-if="badge(v.to)" class="badge" :class="{ warn: v.to === 'settings' }" :aria-label="badgeLabel(v.to)">{{ badge(v.to) }}</span></button>
      </nav>
      <div class="sys" role="group" aria-label="Host usage">
        <span v-for="[l, p] in sys" :key="l"><span class="lbl">{{ l }}</span><span class="num" :class="p != null && useCls(p)">{{ p != null ? p.toFixed(0) + '%' : '·' }}</span></span>
      </div>
      <button type="button" class="ibtn" :aria-label="`Theme: ${prefs.theme}. Switch theme`" :title="`Theme: ${prefs.theme}`" @click="switchTheme"><AppIcon :name="themeIcon" /></button>
    </header>
    <main><RouterView /></main>
    <nav class="tabbar" aria-label="Sections">
      <button v-for="v in VIEWS" :key="v.to" type="button" :aria-current="route.name === v.to ? 'page' : undefined" @click="go(v.to)">
        <AppIcon :name="v.icon" />{{ v.label }}
        <span v-if="badge(v.to)" class="badge" :class="{ warn: v.to === 'settings' }" :aria-label="badgeLabel(v.to)">{{ badge(v.to) }}</span>
      </button>
    </nav>
  </template>
  <RouterView v-else-if="route.name === 'sign-in'" />
  <AppToast />
</template>
