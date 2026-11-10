<script setup lang="ts">
import { computed, ref } from 'vue'
import type { DeviceSession, SystemImage } from '../types'
import { checkSystem, loadDevices, loadRepos, loadSystem, revokeDevice, setClaudeConfig, setSessionLimits, setVscodeSettings, signOut, signOutEverywhere, store, systemUpdate, toast } from '../store'
import { prefs } from '../composables/usePrefs'
import { now } from '../composables/useNow'
import { ago, contrastNote } from '../lib/format'
import { canNotify, enableNotify } from '../lib/notify'
import HoldButton from '../components/HoldButton.vue'
import Led from '../components/Led.vue'

const presets = [['#f0c22b', 'Key yellow'], ['#2f5bd3', 'Cobalt'], ['#138a8a', 'Teal'], ['#8e6fd8', 'Lilac']] as const
const isPreset = computed(() => presets.some(p => p[0] === prefs.accent))
// the switch asks for the browser permission on the tap that turns it on
const notifyDenied = ref(canNotify() && Notification.permission === 'denied')
async function switchNotify(e: Event) {
  const box = e.target as HTMLInputElement
  if (!box.checked) { prefs.notify = false; return }
  const on = await enableNotify()
  notifyDenied.value = !on && Notification.permission !== 'granted'
  box.checked = on
  if (on) toast('Notifications on')
  else if (!notifyDenied.value) toast('The service worker is not running yet: reload the page, then switch this on again')
}

loadDevices()
loadRepos() // suggestions for the config repo: the server can add a deploy key only to repos the account administers

const cfgRepo = ref(store.session?.claudeConfigRepo ?? '')
const cfgBad = computed(() => !!cfgRepo.value.trim() && !/^[\w.-]+\/[\w.-]+$/.test(cfgRepo.value.trim()))
const cfgSaving = ref(false)
async function saveCfg() {
  cfgSaving.value = true
  if (await setClaudeConfig(cfgRepo.value.trim())) cfgRepo.value = store.session?.claudeConfigRepo ?? ''
  cfgSaving.value = false
}
// mirrors MAX_VSCODE_SETTINGS in server/routes.ts
const VS_MAX = 20_000
const vsText = ref(store.session?.vscodeSettings ?? '')
const vsBad = computed(() => vsText.value.trim().length > VS_MAX)
const vsSaving = ref(false)
async function saveVs() {
  vsSaving.value = true
  if (await setVscodeSettings(vsText.value.trim())) vsText.value = store.session?.vscodeSettings ?? ''
  vsSaving.value = false
}
loadSystem()

/* ---------- devices ---------- */

// v-model.number leaves '' in an emptied field
const maxDevices = ref<number | ''>(store.session?.maxDevices ?? 5)
const idleDays = ref<number | ''>(store.session?.idleDays ?? 2)
const whole = (v: number | '', max: number) => Number.isInteger(v) && +v >= 1 && +v <= max
const limitsBad = computed(() => !whole(maxDevices.value, 20) || !whole(idleDays.value, 30))
const limitsSame = computed(() => maxDevices.value === store.session?.maxDevices && idleDays.value === store.session?.idleDays)
const limitsSaving = ref(false)
async function saveLimits() {
  limitsSaving.value = true
  await setSessionLimits(+maxDevices.value, +idleDays.value) // limitsBad keeps '' from getting here
  limitsSaving.value = false
}
const deviceLine = (d: DeviceSession) => `${d.ip || 'unknown address'} · seen ${ago(d.lastSeenAt, now.value)} · since ${ago(d.createdAt, now.value).replace(' ago', '')}`

/* ---------- updates ---------- */

// the collector runs in the dashboard's stack, so its row installs through the dashboard update
const images = computed(() => store.system ? ([['dashboard', 'Dashboard', store.system.dashboard], ['collector', 'Usage collector', store.system.collector], ['telegram', 'Telegram bot', store.system.telegram]] as const) : [])
type Which = 'dashboard' | 'collector' | 'telegram'
const updates = (which: Which) => (which === 'collector' ? 'dashboard' : which)
function imageNote(which: Which, r: SystemImage) {
  if (!r.deployed) return { dashboard: 'Not running as container dockbench-dashboard, so it cannot update itself here (local dev?).', collector: 'Not deployed. Add the collector service of docker/compose.yml to the dashboard stack in Portainer.', telegram: 'Not deployed. Deploy it from the Telegram page.' }[which]
  if (r.imageUpdate) return which === 'collector' ? 'A newer image was pulled. Installing updates it with the dashboard.' : 'A newer image was pulled. Installing it recreates the container.'
  if (r.checkError) return `The last pull failed: ${r.checkError}`
  if (r.imageUpdate === false) return `Newest image, checked ${ago(r.imageCheckedAt!, now.value)}.`
  if (r.image?.includes('@')) return 'Pinned by digest, so there is nothing to update to.'
  return 'Not checked yet.'
}
function holdLabel(which: Which, r: SystemImage) {
  const w = updates(which)
  if (store.sys.busy === w || (w === 'dashboard' && store.sys.restarting)) return w === 'dashboard' ? 'Restarting…' : 'Updating…'
  return r.imageUpdate ? 'Hold to install and restart' : 'Hold to pull and restart'
}
const holdOff = (which: Which, r: SystemImage) => !r.deployed || (which === 'collector' && !store.system?.dashboard.deployed) || !!store.sys.busy || store.sys.restarting || store.dockerDown
// after an error the call left without a status is the one that failed
const codeCls = (n: number | null) => (n == null ? (store.sys.error ? 'code-bad' : 'code-wait') : n < 300 ? 'code-ok' : 'code-bad')
const early = () => toast('Keep holding to confirm')
</script>

<template>
  <div class="page">
    <div class="page-h"><h1>Settings</h1><p>Look and polling are saved in this browser only. Devices, the Claude config repo and the VS Code settings are saved on the dashboard server.</p></div>
    <div class="set-cols">
    <div class="plate">
      <fieldset class="set"><legend id="updT">Updates</legend>
        <p class="fine">The server pulls the dashboard, collector and bot images through Portainer every 30 minutes; a newer one shows here, ready to install. Dev container images update from each container on Bench.</p>
        <p v-if="!store.system" class="fine">Loading…</p>
        <ul v-else class="pk-list">
          <li v-for="[which, label, r] in images" :key="which">
            <span><Led :sev="r.imageUpdate ? 'warn' : r.checkError ? 'bad' : r.deployed ? 'ok' : 'off'" /> {{ label }}<small class="num">{{ r.image ?? '·' }}</small><small :class="{ 's-warn': r.imageUpdate, 's-bad': !r.imageUpdate && r.checkError }">{{ imageNote(which, r) }}</small></span>
            <HoldButton :data-hold="'update-' + which" :disabled="holdOff(which, r)" @confirm="systemUpdate(updates(which))" @early="early">{{ holdLabel(which, r) }}</HoldButton>
          </li>
        </ul>
        <div class="btns"><button type="button" class="btn" :aria-disabled="!!store.sys.busy || store.sys.restarting || store.dockerDown || undefined" @click="checkSystem">{{ store.sys.busy === 'check' ? 'Checking…' : 'Check for updates' }}</button></div>
        <div aria-live="polite">
          <div v-if="store.sys.restarting" class="callout warn"><h3><Led sev="warn" />Restarting the dashboard</h3><p>It is being recreated on the new image. This page reloads by itself when the new server answers.</p></div>
          <ol v-if="store.sys.calls.length" class="trace num"><li v-for="(x, i) in store.sys.calls" :key="i"><span>{{ x.method }}</span><span class="p">{{ x.path }}</span><span :class="codeCls(x.status)">{{ x.status ?? (store.sys.error ? 'failed' : '…') }}</span></li></ol>
          <div v-if="store.sys.error" class="callout bad"><h3><Led sev="bad" />Update failed</h3><p>{{ store.sys.error }}</p></div>
        </div>
        <p class="fine">Press and hold about a second to confirm. Installing pulls the image again first, so it also works before a check.</p>
      </fieldset>
    </div>
    <div class="plate">
      <fieldset class="set"><legend>Theme</legend>
        <div class="seg">
          <label v-for="[v, l] in [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']] as const" :key="v"><input v-model="prefs.theme" type="radio" name="theme" :value="v"><span>{{ l }}</span></label>
        </div>
      </fieldset>
      <fieldset class="set"><legend>Accent</legend>
        <div class="swatches">
          <label v-for="[hex, l] in presets" :key="hex" class="sw" :style="{ '--c': hex }" :title="l"><input v-model="prefs.accent" type="radio" name="accent" :value="hex" :aria-label="l"><span></span></label>
          <label class="custom"><input type="color" :value="prefs.accent" aria-label="Custom accent" @input="prefs.accent = ($event.target as HTMLInputElement).value">{{ isPreset ? 'Custom' : 'Custom ' + prefs.accent }}</label>
        </div>
        <p class="contrast">{{ contrastNote(prefs.accent) }}</p>
        <p class="fine">The accent marks controls and selection only. Status colors stay fixed so they always mean the same thing.</p>
      </fieldset>
      <fieldset class="set"><legend>Bench</legend>
        <label class="check"><input v-model="prefs.compact" type="checkbox"><span>Compact view</span><small>List only running containers, each with its CPU, RAM and disk percentage.</small></label>
      </fieldset>
      <fieldset class="set"><legend>Poll every</legend>
        <div class="seg">
          <label v-for="v in [2, 5, 15] as const" :key="v"><input v-model="prefs.poll" type="radio" name="poll" :value="v"><span>{{ v }} s</span></label>
        </div>
        <p class="fine">Used while the live feed is not connected (it pushes a snapshot every 2 s). Each poll is one Docker list call plus one stats call per running container in parallel. /status is never asked twice at once.</p>
      </fieldset>
      <fieldset v-if="canNotify()" class="set"><legend>Notifications</legend>
        <label class="check"><input type="checkbox" :checked="prefs.notify" @change="switchNotify"><span>System notifications</span><small>While the dashboard is in the background: a container that turns bad, a finished CI run, the end of a deploy or update. It keeps polling in the background while this is on, for as long as the browser lets it run.</small></label>
        <p v-if="notifyDenied" class="fine">The browser blocks notifications for this site. Allow them in its site settings, then switch this on again.</p>
      </fieldset>
    </div>
    <div class="plate">
      <fieldset class="set"><legend>Devices</legend>
        <p class="fine">Every browser signed in right now. A device stays signed in while it keeps using the dashboard and is signed out after the idle days below, or 30 days after it signed in, or when a newer device pushes it past the cap.</p>
        <ul v-if="store.devices?.length" class="pk-list">
          <li v-for="d in store.devices" :key="d.id">
            <span>{{ d.device }}<template v-if="d.current"> (this device)</template><small>{{ deviceLine(d) }}</small></span>
            <button type="button" class="btn sm" @click="revokeDevice(d)">Sign out</button>
          </li>
        </ul>
        <p v-else-if="store.devices" class="fine">No device is signed in, which cannot be: reload the page.</p>
        <form style="display:grid;gap:8px" @submit.prevent="saveLimits">
          <label for="maxDev">Devices kept signed in (1 to 20, default 5)</label>
          <input id="maxDev" v-model.number="maxDevices" class="inp num" type="number" min="1" max="20" step="1" inputmode="numeric">
          <label for="idleDays">Days a device may stay unused (1 to 30, default 2)</label>
          <input id="idleDays" v-model.number="idleDays" class="inp num" type="number" min="1" max="30" step="1" inputmode="numeric">
          <div class="btns"><button type="submit" class="btn" :disabled="limitsSaving || limitsBad || limitsSame">{{ limitsSaving ? 'Saving…' : 'Save' }}</button></div>
        </form>
        <div class="btns"><button type="button" class="btn" @click="signOutEverywhere">Sign out everywhere</button></div>
      </fieldset>
    </div>
    <div class="plate">
      <fieldset class="set"><legend>Claude config repo</legend>
        <p class="fine">The GitHub repo that holds your <code>~/.claude</code> (skills, agents, hooks, settings). Deploys with "Inject my Claude config" check it out over <code>~/.claude</code> on every start, through a read-only deploy key the dashboard adds to it. Containers already running keep the repo they were deployed with.</p>
        <form style="display:grid;gap:8px" @submit.prevent="saveCfg">
          <label for="cfgRepo">Repository (owner/name), empty for none</label>
          <input id="cfgRepo" v-model="cfgRepo" class="inp" list="cfgRepos" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="owner/claude-config" aria-describedby="cfgRepoMsg" :aria-invalid="cfgBad">
          <datalist id="cfgRepos"><option v-for="r in store.repos ?? []" :key="r.fullName" :value="r.fullName" /></datalist>
          <p id="cfgRepoMsg" class="fine" :class="{ 'bad-msg': cfgBad }">{{ cfgBad ? 'Use owner/name, not a URL.' : 'Needs admin rights on the repo. Keep it free of secrets: every container can read it.' }}</p>
          <div class="btns"><button type="submit" class="btn" :disabled="cfgSaving || cfgBad || cfgRepo.trim() === (store.session?.claudeConfigRepo ?? '')">{{ cfgSaving ? 'Saving…' : 'Save' }}</button></div>
        </form>
      </fieldset>
      <fieldset class="set"><legend>VS Code settings</legend>
        <p class="fine">A <code>settings.json</code> (theme, fonts, anything else) for your dev containers, shown in their "Remote [Tunnel]" settings tab. Deploys with "Apply my VS Code settings" write it once, on the first start. Containers already running keep theirs until you press Replace on their page. Empty uses the image's own <code>vscode/settings.json</code>.</p>
        <form style="display:grid;gap:8px" @submit.prevent="saveVs">
          <label for="vsSettings">settings.json, comments allowed</label>
          <textarea id="vsSettings" v-model="vsText" class="inp" rows="10" spellcheck="false" autocapitalize="none" :placeholder="'{\n  &quot;workbench.colorTheme&quot;: &quot;Default Dark Modern&quot;\n}'" aria-describedby="vsMsg" :aria-invalid="vsBad"></textarea>
          <p id="vsMsg" class="fine" :class="{ 'bad-msg': vsBad }">{{ vsBad ? `At most ${VS_MAX} characters.` : 'A theme that is not built into VS Code also needs its extension in the image (vscode/extensions.txt).' }}</p>
          <div class="btns"><button type="submit" class="btn" :disabled="vsSaving || vsBad || vsText.trim() === (store.session?.vscodeSettings ?? '')">{{ vsSaving ? 'Saving…' : 'Save' }}</button></div>
        </form>
      </fieldset>
    </div>
    <div class="plate"><div class="set"><span class="set-t">Signed in as {{ store.session?.user }}</span><div class="btns"><button type="button" class="btn" @click="signOut">Sign out</button></div></div></div>
    </div>
  </div>
</template>
