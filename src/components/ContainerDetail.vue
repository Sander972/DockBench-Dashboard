<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onBeforeUpdate, onUpdated, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { applyConfig, cancelStepUp, checkImages, confirmStepUp, containerAction, gitExec, loadClaudeDiff, loadLogs, loadVscode, pullClaudeConfig, refreshLogs, replaceVscode, store, switchClaudeAccount, toast, watchUsage } from '../store'
import { prefs } from '../composables/usePrefs'
import { useNow } from '../composables/useNow'
import { ago, DISK_BUDGET, dur, gib, ms, repoLabel, repoUrl, since, toGiB, useCls } from '../lib/format'
import { cpuPct, diskBytes, diskPct, memPct, verdict } from '../lib/verdict'
import { diffRows } from '../lib/diff'
import { byName, containerSeries, span } from '../lib/usage'
import AppIcon from './AppIcon.vue'
import CiRuns from './CiRuns.vue'
import ClaudeLoginCallout from './ClaudeLoginCallout.vue'
import DeviceCodeCallout from './DeviceCodeCallout.vue'
import ExecPanel from './ExecPanel.vue'
import HoldButton from './HoldButton.vue'
import Led from './Led.vue'
import StepUpPanel from './StepUpPanel.vue'
import TrendChart from './TrendChart.vue'
import { actionsUrl, REPO_SEV, REPO_WORD, type Sev } from '../lib/actions'

const props = defineProps<{ id: string }>()
const emit = defineEmits<{ back: [] }>()
const now = useNow()
const router = useRouter()

// an image update recreates the container under a new id: follow it instead of showing "gone"
watch(() => store.replaced[props.id], n => { if (n) router.replace(`/bench/${n}`) })

const c = computed(() => store.containers.find(x => x.id === props.id))
const v = computed(() => c.value && verdict(c.value))
const st = computed(() => c.value?.status ?? null)
const run = computed(() => c.value?.state === 'running')
const fresh = computed(() => run.value && !!st.value && !c.value!.statusError)
const exec = computed(() => store.execs[props.id])
const busy = computed(() => !!c.value?.pending || store.dockerDown || !!exec.value?.running)
const cf = computed(() => (store.confirm?.target === props.id ? store.confirm : null))
// the Container section's step-up (start, stop, restart, update); pull and remove show theirs in Git and the danger zone
const cCf = computed(() => (cf.value && cf.value.action !== 'pull' && cf.value.action !== 'remove' ? cf.value : null))
// a section collapsed from its header stays collapsed on every container's page, remembered in prefs
const open = (k: string) => !prefs.folded.includes(k)
const fold = (k: string) => { prefs.folded = open(k) ? [...prefs.folded, k] : prefs.folded.filter(x => x !== k) }
// the trend reads the collector's history, loaded while this detail is mounted; by name, so a recreated container keeps its line
onBeforeUnmount(watchUsage())
const hist = computed(() => {
  const d = store.usage.data
  if (!d || !c.value) return null
  const s = containerSeries(d, byName(d).get(c.value.name)?.ids ?? [props.id])
  return s.cpu.length ? { ...s, ...span(d), step: d.stepMs } : null
})
const ncpu = computed(() => store.host?.ncpu ?? 1)
const sh = computed(() => props.id.slice(0, 12))
const hint = computed(() => 'Press and hold about a second to confirm.' + (store.session?.passkeys ? ' Then confirm with your passkey, unless you did in the last 5 minutes.' : ''))

const imageNote = computed(() => {
  const k = c.value!
  if (k.imageUpdate) return 'A newer image was pulled. Updating recreates the container from it; /home/dev and the workspace stay.'
  if (k.imageUpdate === false) return `Newest image, checked ${ago(k.imageCheckedAt!, now.value)}.`
  if (k.image.includes('@')) return 'Pinned by digest, so there is nothing to update to.'
  if (k.state === 'exited') return 'Not checked while the container is stopped.'
  return k.imageCheckedAt ? 'The image pull failed. Try Check for update again.' : 'Not checked yet.'
})
// work that goes with the home volume on Remove, as /status last saw it; without a /status since the server started (stopped), it cannot be ruled out
const lost = computed(() => {
  const s = st.value
  if (!s) return 'any uncommitted or unpushed work (its git state is not known)'
  return [s.dirty ? `${s.dirty} uncommitted file${s.dirty > 1 ? 's' : ''}` : '', s.ahead ? `${s.ahead} unpushed commit${s.ahead > 1 ? 's' : ''}` : ''].filter(Boolean).join(' and ')
})
// Remove asks for the container name typed out; BenchView keys this component by id, so another container starts with an empty field
const rmName = ref('')
const checking = ref(false)
async function check() {
  checking.value = true
  try { await checkImages() } finally { checking.value = false }
}

const tn = computed(() => st.value?.tunnel_name)
const canOpen = computed(() => fresh.value && st.value!.tunnel === 'connected')
const web = computed(() => (tn.value ? `https://vscode.dev/tunnel/${encodeURIComponent(tn.value)}/home/dev/workspace` : '#'))
const desk = computed(() => (tn.value ? `vscode://vscode-remote/tunnel+${encodeURIComponent(tn.value)}/home/dev/workspace` : '#'))
// the repo's own .code-workspace, opened as a multi-root workspace instead of the plain folder: desktop VS Code opens a vscode-remote path with a workspace extension as a workspace (getWindowOpenableFromProtocolUrl); vscode.dev is not known to open one from its URL path, so it gets no such link
const wsf = computed(() => st.value?.workspace_file)
const wsDesk = computed(() => (tn.value && wsf.value ? `${desk.value}/${encodeURIComponent(wsf.value)}` : '#'))
const openReason = computed(() => {
  const k = c.value!
  if (!run.value) return 'Start the container to open it.'
  if (k.statusError === 'starting') return 'Available once the tunnel is up.'
  if (k.statusError === 'dead') return 'Tunnel state unknown while /status is down. The link may still work.'
  if (st.value?.tunnel === 'waiting_for_login') return 'Approve the tunnel first.'
  if (st.value && st.value.tunnel !== 'connected') return 'The tunnel is not connected. Restart the container to reconnect it.'
  return `Opens only for the GitHub account that approved tunnel "${tn.value}".`
})
const showClaude = computed(() => run.value && st.value?.claude_installed !== false && st.value?.claude_logged_in === false)
const switching = computed(() => store.claudeLogin[props.id]?.phase === 'starting')
const sync = computed(() => st.value?.claude_plugin_sync)
const showCode = computed(() => !!c.value?.deviceCode && (c.value.statusError === 'starting' || st.value?.tunnel === 'waiting_for_login'))

// git in three lines: what changed locally, then how it stands against the upstream
const changes = computed(() => {
  const d = st.value?.dirty
  return d === 0 ? 'Clean' : d == null ? 'Changes unknown' : `${d} file${d > 1 ? 's' : ''} changed`
})
const upstream = computed(() => {
  const s = st.value
  if (!s) return ''
  if (s.branch === 'HEAD') return 'no upstream while detached'
  if (s.ahead == null) return 'no upstream branch'
  return `${s.ahead} ahead, ${s.behind} behind`
})

// log lines: device codes marked, errors red, the VS Code banner muted
const lines = computed(() => (store.logs[props.id] ?? []).slice(-100).map(l => ({
  cls: /^(fatal|remote: Repository|Traceback|MemoryError)/.test(l) ? 'err' : /^\*/.test(l) ? 'mute' : '',
  parts: l.split(/([A-Z0-9]{4}-[A-Z0-9]{4})/),
})))
const refreshing = ref(false)
async function refresh() {
  refreshing.value = true
  try { await refreshLogs(props.id) } finally { refreshing.value = false }
}
// the log is a closed row: reading it again when it opens, then every 3 s while Auto-refresh is on; a failed read turns the switch off, so its error toasts once
const logEl = ref<HTMLElement>()
const logOpen = ref(false)
const autoLog = ref(false)
function onLogToggle(e: Event) {
  logOpen.value = (e.currentTarget as HTMLDetailsElement).open
  if (!logOpen.value) return
  nextTick(() => { if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight })
  loadLogs(props.id)
}
let logT: ReturnType<typeof setInterval> | undefined
let logBusy = false
watch(() => logOpen.value && autoLog.value, on => {
  clearInterval(logT)
  if (on) logT = setInterval(async () => {
    if (logBusy || store.dockerDown || document.hidden) return
    logBusy = true
    try { if (!(await loadLogs(props.id))) autoLog.value = false } finally { logBusy = false }
  }, 3000)
})
onBeforeUnmount(() => clearInterval(logT))
// follow the tail like tail -f: stay on the newest line unless scrolled up
let stick = true
watch(lines, () => { const el = logEl.value; if (el) stick = el.scrollHeight - el.scrollTop - el.clientHeight < 8 }, { flush: 'pre' })
watch(lines, () => { if (stick && logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight }, { flush: 'post' })

// configuration: the boxes start from what the container runs with and reset when that changes (a poll brings a new object each time, so compare values)
const cfg = reactive({ installClaude: true, injectClaudeConfig: false, vscodeConfig: true })
watch(() => JSON.stringify(c.value?.config ?? null), () => { if (c.value) Object.assign(cfg, c.value.config) }, { immediate: true })
// the options sit in the Claude and VS Code sections but apply in one recreate: Hold to apply shows in the section with a change, the one changed last when both have one
const claudeChanged = computed(() => !!c.value && (cfg.installClaude !== c.value.config.installClaude || cfg.injectClaudeConfig !== c.value.config.injectClaudeConfig))
const vsChanged = computed(() => !!c.value && cfg.vscodeConfig !== c.value.config.vscodeConfig)
const cfgLast = ref<'claude' | 'vscode'>('claude')
const applyIn = computed(() => (claudeChanged.value && vsChanged.value ? cfgLast.value : claudeChanged.value ? 'claude' : vsChanged.value ? 'vscode' : null))
const applyNote = computed(() => `Applying recreates the container${c.value?.imageUpdate ? ' on the newer image already pulled, like Update does' : ''}; /home/dev and the workspace stay.${claudeChanged.value && vsChanged.value ? ` It also applies the ${applyIn.value === 'claude' ? 'VS Code' : 'Claude'} option you changed.` : ''}`)
const cfgCf = computed(() => (store.confirm?.target === 'config-' + props.id ? store.confirm : null))
const cfgRepo = computed(() => store.session?.claudeConfigRepo ?? '')
const vs = computed(() => store.vscode[props.id])
const vsCf = computed(() => (store.confirm?.target === 'vscode-' + props.id ? store.confirm : null))
const vsGlobal = computed(() => !!store.session?.vscodeSettings)
const ccCf = computed(() => (store.confirm?.target === 'claudecfg-' + props.id ? store.confirm : null))
const cd = computed(() => store.claudeDiff[props.id])
const cdRows = computed(() => diffRows(cd.value?.data?.diff ?? ''))
const cdFiles = computed(() => cdRows.value.filter(r => r.kind === 'file').length)
// one-line summaries of the Claude config (in the Claude header) and of the closed VS Code settings row
const cdSum = computed(() => {
  if (!run.value) return 'Container stopped'
  if (cd.value?.data) return cdFiles.value ? `${cdFiles.value} file${cdFiles.value > 1 ? 's' : ''} changed since ${cd.value.data.commit}` : `Same as ${cd.value.data.commit}`
  return cd.value?.busy ? 'Loading…' : cd.value?.error ? 'Could not read the changes' : 'Not read yet'
})
const vsSum = computed(() => {
  const s = vs.value?.settings
  if (!run.value) return 'Container stopped'
  if (s) return `${s.split('\n').length} lines`
  return vs.value?.busy === 'load' ? 'Loading…' : !vs.value ? 'Not read yet' : s === undefined ? 'Could not read them' : s === '' ? 'Empty file' : 'None'
})
// the status on the right of each section header, warn-tinted when it asks for action; the source of the figures is its tooltip
type Sum = { t: string; sev?: Sev; src: string }
const sums = computed((): Record<string, Sum> => {
  const k = c.value!, s = st.value, a = store.ci[k.name]
  return {
    cl: claudeChanged.value ? { t: 'Options not applied', sev: 'warn', src: 'stack variables' }
      : !s ? { t: 'Unknown until /status answers', src: '/status' }
      : s.claude_installed === false ? { t: 'Not installed', src: '/status' }
      : !s.claude_logged_in ? { t: 'Not signed in', sev: 'warn', src: '/status' }
      : sync.value?.warnings.length ? { t: 'Plugin sync warnings', sev: 'warn', src: '/status' }
      : { t: 'Signed in' + (s.claude_version ? ' · ' + s.claude_version : ''), src: '/status' },
    c: { t: k.imageUpdate ? 'Image update available' : k.imageUpdate === false ? 'Image up to date' : k.image.includes('@') ? 'Image pinned' : 'Image not checked', sev: k.imageUpdate ? 'warn' : undefined, src: 'Docker API · /status' },
    vs: vsChanged.value ? { t: 'Option not applied', sev: 'warn', src: 'stack variable' } : { t: 'Machine settings · ' + vsSum.value, src: 'Machine settings in the container' },
    g: { t: s ? [s.branch === 'HEAD' ? 'detached' : s.branch ?? 'not a git repo', changes.value, s.ahead ? `${s.ahead} ahead` : '', s.behind ? `${s.behind} behind` : ''].filter(Boolean).join(' · ') : '', sev: s?.behind ? 'warn' : undefined, src: fresh.value ? '/status · just now' : 'last answer from /status' },
    ci: { t: a ? REPO_WORD[a.state][0].toUpperCase() + REPO_WORD[a.state].slice(1) : '', sev: a && (a.state === 'running' || a.state === 'failure') ? REPO_SEV[a.state] : undefined, src: a?.repo ?? '' },
  }
})
// read again on every start and once /status answers: the entrypoint seeds the file right after the status server comes up
watch(() => run.value && c.value!.statusError !== 'starting' && `${props.id}|${c.value!.startedAt}`, k => { if (k) loadVscode(props.id) }, { immediate: true })
// the entrypoint downloads the config before the status server starts, so the same moment works
watch(() => run.value && c.value!.config.injectClaudeConfig && c.value!.statusError !== 'starting' && `${props.id}|${c.value!.startedAt}`, k => { if (k) loadClaudeDiff(props.id) }, { immediate: true })

const early = () => toast('Keep holding to confirm')
const root = ref<HTMLElement>()
// 5.4: when a re-render drops focus (Stop replaced by Start), move it to the equivalent control in the same section
let fk: { hold?: string; sec: Element | null } | null = null
onBeforeUpdate(() => {
  const a = document.activeElement as HTMLElement
  fk = root.value?.contains(a) ? { hold: a.closest<HTMLElement>('[data-hold]')?.dataset.hold, sec: a.closest('.sec') } : null
})
onUpdated(() => {
  if (!fk?.sec?.isConnected || root.value?.contains(document.activeElement)) return
  ;(fk.sec.querySelector<HTMLElement>(`button[data-hold="${fk.hold}"]`) ?? fk.sec.querySelector<HTMLElement>('.btns button'))?.focus({ preventScroll: true })
})
</script>

<template>
  <div ref="root" class="d-wrap">
    <button type="button" class="ibtn back" @click="emit('back')"><AppIcon name="back" /><span>All containers</span></button>
    <div v-if="!c || !v" class="placeholder plate">{{ store.loading ? 'Loading…' : 'This container is gone. It may have been removed.' }}</div>
    <template v-else>
      <div class="d-top">
        <div class="d-head">
          <Led :sev="v.sev" :blink="v.blink" />
          <h2 tabindex="-1"><span class="pre">dockbench-</span>{{ c.name.replace(/^dockbench-/, '') }}</h2>
          <div class="d-sub">
            <span class="state" :class="'s-' + v.sev">{{ v.word }}</span>
            <span v-if="!c.startedAt">never started</span>
            <span v-else-if="run">up {{ since(c.startedAt, now) }}</span>
            <span v-else-if="c.state === 'exited'">stopped {{ ago(c.finishedAt ?? c.startedAt, now) }}</span>
            <span v-else><span class="num">{{ c.restartCount }}</span> restarts</span>
          </div>
        </div>
        <div class="open btns">
          <a class="btn sm pri" :href="web" target="_blank" rel="noopener noreferrer" :aria-disabled="canOpen ? undefined : 'true'" :tabindex="canOpen ? undefined : -1">Open in vscode.dev <AppIcon name="ext" /></a>
          <a class="btn sm" :href="desk" :aria-disabled="canOpen ? undefined : 'true'" :tabindex="canOpen ? undefined : -1">VS Code desktop <AppIcon name="ext" /></a>
          <a v-if="wsf" class="btn sm" :href="wsDesk" :aria-disabled="canOpen ? undefined : 'true'" :tabindex="canOpen ? undefined : -1" :title="wsf">Workspace in desktop <AppIcon name="ext" /></a>
        </div>
        <p class="fine d-note">{{ openReason }}</p>
      </div>

      <div v-if="store.dockerDown" class="callout bad"><h3><Led sev="bad" />Docker unreachable</h3><p><template v-if="store.lastGoodAt">Values below are from {{ ago(store.lastGoodAt, now) }}. </template>Actions are paused.</p></div>
      <DeviceCodeCallout v-if="showCode" :code="c.deviceCode!.code" :kind="c.deviceCode!.kind" />
      <div v-else-if="c.statusError === 'starting'" class="callout warn"><h3><Led sev="warn" blink />Starting</h3><p>/status answers after clone, mise install and .devcontainer/setup.sh finish. On a first start this can take minutes. Follow along in the log.</p></div>
      <div v-if="c.statusError === 'dead'" class="callout bad"><h3><Led sev="bad" />Status server stopped answering</h3><p>Silent since {{ c.statusFetchedAt ? ago(c.statusFetchedAt, now) : 'the last poll' }}. The container is still up because the tunnel is PID 1, but nothing restarts the status server. Restart the container to bring it back. Git details below are from the last answer.</p></div>
      <div v-if="c.state === 'restarting'" class="callout bad">
        <h3><Led sev="bad" blink />Clone fails, container restarts in a loop</h3>
        <p v-if="c.lastError">{{ c.lastError }}</p>
        <p>Check REPO_URL in the Portainer stack. The container's deploy key must open this repo, or, when deployed with the gh login, the GitHub account it signed in with must have access. Stopping it ends the loop.</p>
      </div>
      <ClaudeLoginCallout v-if="showClaude" :id="c.id" />

      <div class="plate panel">
        <section class="sec" :aria-labelledby="'r-' + c.id">
          <div class="sec-h"><h3 :id="'r-' + c.id" class="lbl"><button type="button" class="sec-tg" :aria-expanded="open('r')" @click="fold('r')">Resources</button></h3>
            <div class="vitals" :title="`Docker stats · every ${prefs.poll}s`">
              <template v-if="run">
                <div class="vital"><span class="lbl c-cpu">CPU</span><span class="num big" :class="useCls(cpuPct(c))">{{ cpuPct(c).toFixed(1) }}%</span><span class="num v-sub">{{ ((cpuPct(c) / 100) * ncpu).toFixed(1) }}/{{ ncpu }} cores</span></div>
                <div class="vital"><span class="lbl c-mem">RAM</span><span class="num big" :class="useCls(memPct(c))">{{ memPct(c).toFixed(0) }}%</span><span class="num v-sub">{{ gib(toGiB(c.memUsed)) }}/{{ gib(toGiB(c.memLimit)) }} GiB</span></div>
              </template>
              <div class="vital" :title="`Writable layer ${gib(toGiB(c.diskRw))} GiB, /home/dev volume ${gib(toGiB(c.diskVolume))} GiB, budget ${toGiB(DISK_BUDGET)} GiB`"><span class="lbl">Disk</span><span class="num big" :class="useCls(diskPct(c))">{{ diskPct(c).toFixed(0) }}%</span><span class="num v-sub">{{ gib(toGiB(diskBytes(c))) }}/{{ toGiB(DISK_BUDGET) }} GiB</span></div>
            </div>
          </div>
          <template v-if="open('r')">
          <TrendChart v-if="run && hist" :cpu="hist.cpu" :mem="hist.mem" :from="hist.from" :to="hist.to" :step="hist.step" />
          <p v-else-if="run" class="fine">{{ store.usage.error ? 'The collector is not answering, so there is no history.' : store.usage.data ? 'No history for this container yet.' : 'Loading the history…' }}</p>
          <p v-else class="fine">Docker reports no CPU or memory for a {{ c.state === 'exited' ? 'stopped' : c.state }} container.</p>
          </template>
        </section>

        <section class="sec" :aria-labelledby="'cl-' + c.id">
          <div class="sec-h"><h3 :id="'cl-' + c.id" class="lbl"><button type="button" class="sec-tg" :aria-expanded="open('cl')" @click="fold('cl')">Claude</button></h3><span class="sec-st" :class="sums.cl.sev && 's-' + sums.cl.sev" :title="sums.cl.src">{{ sums.cl.t }}<template v-if="c.config.injectClaudeConfig"> · Config: {{ cdSum }}</template></span>
            <div v-if="c.config.injectClaudeConfig && !ccCf" class="btns tight">
              <button type="button" class="btn sm" :aria-disabled="!run || !!cd?.busy || undefined" title="Compare ~/.claude in the container with your config repo" @click="run && !cd?.busy && loadClaudeDiff(c.id, true)"><AppIcon name="refresh" /> Check</button>
              <HoldButton data-hold="claudecfg" class="sm" :disabled="!run || busy" @confirm="pullClaudeConfig(c.id)" @early="early">{{ c.pending === 'claudeConfig' ? 'Downloading…' : 'Hold to re-download' }}</HoldButton>
            </div>
          </div>
          <StepUpPanel v-if="c.config.injectClaudeConfig && ccCf" data-hold="claudecfg" action="update" :name="c.name" text="Downloads your Claude config repo again over ~/.claude in the container, edits made there to its files included." :waiting="ccCf.waiting" @confirm="confirmStepUp" @cancel="cancelStepUp" />
          <template v-if="open('cl')">
          <dl v-if="st" class="facts">
            <dt>Claude Code</dt>
            <dd>{{ st.claude_installed === false ? 'Not installed' : st.claude_logged_in ? 'Credentials present' : 'Not signed in' }}<span v-if="st.claude_installed !== false && st.claude_version" class="num"> · {{ st.claude_version }}</span>
              <button v-if="run && st.claude_installed !== false && st.claude_logged_in" type="button" class="btn sm inl" :aria-disabled="switching || undefined" :title="'Sign Claude Code out of ' + c.name + ' and start a new sign-in'" @click="!switching && switchClaudeAccount(c.id)">{{ switching ? 'Signing out…' : 'Switch account' }}</button>
            </dd>
            <template v-if="st.claude_plugins && st.claude_installed !== false">
              <dt>Plugins</dt>
              <dd><span v-if="Object.keys(st.claude_plugins).length" class="tags"><span v-for="(ver, k) in st.claude_plugins" :key="k" class="tag" :title="k">{{ k.split('@')[0] }}{{ ver ? ' ' + ver.slice(0, 12) : '' }}</span></span><span v-else class="dim">None installed</span>
                <template v-if="sync"><br><span v-if="sync.state === 'running'" class="fine">Installing and updating, started {{ ago(sync.at, now) }}</span><span v-else-if="sync.warnings.length" class="fine s-warn">Last sync {{ ago(sync.at, now) }}: {{ sync.warnings.join('; ') }}</span><span v-else class="fine">Synced with settings.json {{ ago(sync.at, now) }}</span></template>
              </dd>
            </template>
          </dl>
          <div class="checks">
            <label class="check"><input v-model="cfg.installClaude" type="checkbox" :disabled="busy" @change="cfgLast = 'claude'"><span>Install Claude Code</span><small>Installed on the next start and updated on every restart, with its VS Code extension.</small></label>
            <label class="check"><input v-model="cfg.injectClaudeConfig" type="checkbox" :disabled="busy || (!cfgRepo && !c.config.injectClaudeConfig)" @change="cfgLast = 'claude'"><span>Inject my Claude config</span>
              <small v-if="cfgRepo || c.config.injectClaudeConfig">Checks out {{ cfgRepo || 'the config repo' }} over <code>~/.claude</code> on every start, through a read-only deploy key. Turning it off removes that key.</small>
              <small v-else>Set your <code>~/.claude</code> repo in <RouterLink to="/settings">Settings</RouterLink> first.</small>
            </label>
          </div>
          <template v-if="applyIn === 'claude'">
            <StepUpPanel v-if="cfgCf" data-hold="config" action="update" :name="c.name" :text="`Recreates ${c.name} from its Portainer stack with the new options${c.imageUpdate ? ', on the newer image already pulled' : ''}. /home/dev and the workspace stay; the tunnel drops until the new container is up.`" :waiting="cfgCf.waiting" @confirm="confirmStepUp" @cancel="cancelStepUp" />
            <div v-else class="act">
              <div class="btns tight"><HoldButton data-hold="config" class="sm" :disabled="busy" :aria-describedby="'hold-hint-' + c.id" @confirm="applyConfig(c.id, { ...cfg })" @early="early">{{ c.pending === 'config' ? 'Applying…' : 'Hold to apply and recreate' }}</HoldButton></div>
              <p class="fine">{{ applyNote }}</p>
            </div>
          </template>
          <div v-if="c.config.injectClaudeConfig" class="cc">
            <p class="fine">{{ run ? 'Re-download fetches ' + (cfgRepo || 'the config repo') + ' now and overwrites the files it tracks in ~/.claude, edits made in the container included. Credentials, history and other files stay. No restart; start a new Claude session to pick it up.' : 'Start the container to check or re-download its Claude config.' }}</p>
            <template v-if="run && cd?.data">
              <p v-if="cd.data.truncated" class="fine">Too long to show in full, the rest is cut.</p>
              <pre v-if="cdRows.length" class="term diff" tabindex="0" aria-label="Changes to the Claude config"><span v-for="(r, i) in cdRows" :key="i" :class="'d-' + r.kind">{{ r.text }}
</span></pre>
            </template>
            <p v-else-if="run" class="fine">{{ cd?.busy ? 'Loading the changes…' : cd?.error ? `Could not read the changes: ${cd.error}` : 'Read once the container answers /status. Press Check to read them now.' }}</p>
          </div>
          </template>
        </section>

        <section class="sec" :aria-labelledby="'c-' + c.id">
          <div class="sec-h"><h3 :id="'c-' + c.id" class="lbl"><button type="button" class="sec-tg" :aria-expanded="open('c')" @click="fold('c')">Container</button></h3><span class="sec-st" :class="sums.c.sev && 's-' + sums.c.sev" :title="sums.c.src">{{ sums.c.t }}</span>
            <div v-if="!cCf" class="btns tight">
              <HoldButton v-if="run || c.state === 'restarting'" data-hold="stop" class="sm" danger :disabled="busy" :aria-describedby="'hold-hint-' + c.id" @confirm="containerAction(c.id, 'stop')" @early="early">Hold to stop</HoldButton>
              <button v-else type="button" class="btn sm pri" :aria-disabled="busy || undefined" @click="busy || containerAction(c.id, 'start')">Start</button>
              <HoldButton data-hold="update" class="sm" :disabled="busy" :aria-describedby="'hold-hint-' + c.id" @confirm="containerAction(c.id, 'update')" @early="early">{{ c.pending === 'update' ? 'Updating…' : 'Hold to update' }}</HoldButton>
            </div>
          </div>
          <StepUpPanel v-if="cCf" :data-hold="cCf.action" :action="cCf.action" :name="c.name" :waiting="cCf.waiting" @confirm="confirmStepUp" @cancel="cancelStepUp" />
          <template v-if="open('c')">
          <dl class="facts">
            <dt>State</dt><dd><span class="num">{{ c.state }}{{ c.state === 'exited' ? ` · exit ${c.exitCode}` : '' }}</span> · <span class="num">{{ c.restartCount }}</span> restart{{ c.restartCount === 1 ? '' : 's' }}</dd>
            <dt>Started</dt><dd class="num">{{ c.startedAt ? new Date(c.startedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : 'never started' }}</dd>
            <dt>ID</dt><dd class="num">{{ sh }} · devnet · proxy</dd>
            <dt>Image</dt><dd><span class="num">{{ c.image }}</span><br><span class="fine" :class="{ 's-warn': c.imageUpdate }">{{ imageNote }}</span></dd>
            <template v-if="st">
              <dt>Tools</dt><dd><span v-if="Object.keys(st.mise).length" class="tags"><span v-for="(ver, k) in st.mise" :key="k" class="tag">{{ k }} {{ ver }}</span></span><span v-else class="dim">No .mise.toml</span></dd>
              <dt>Status server</dt>
              <dd><template v-if="fresh"><span title="Starts after setup, so it trails the container">up {{ dur(st.uptime_seconds + (now - ms(c.statusFetchedAt ?? now)) / 1000) }}</span></template><span v-else class="s-bad">not answering</span></dd>
            </template>
          </dl>
          <div v-if="!cCf" class="btns tight">
            <HoldButton v-if="run" data-hold="restart" class="sm" :disabled="busy" :aria-describedby="'hold-hint-' + c.id" @confirm="containerAction(c.id, 'restart')" @early="early"><AppIcon name="refresh" /> Hold to restart</HoldButton>
            <button type="button" class="btn sm" :aria-disabled="checking || store.dockerDown || undefined" @click="checking || store.dockerDown || check()">{{ checking ? 'Checking…' : 'Check for update' }}</button>
          </div>
          <p :id="'hold-hint-' + c.id" class="fine">{{ hint }}</p>
          </template>
        </section>

        <section class="sec" :aria-labelledby="'vs-' + c.id">
          <div class="sec-h"><h3 :id="'vs-' + c.id" class="lbl"><button type="button" class="sec-tg" :aria-expanded="open('vs')" @click="fold('vs')">VS Code settings</button></h3><span class="sec-st" :class="sums.vs.sev && 's-' + sums.vs.sev" :title="sums.vs.src">{{ sums.vs.t }}</span></div>
          <template v-if="open('vs')">
          <div class="checks">
            <label class="check"><input v-model="cfg.vscodeConfig" type="checkbox" :disabled="busy" @change="cfgLast = 'vscode'"><span>Apply my VS Code settings</span><small>Written only when the home volume has no VS Code Machine settings yet. To change them now, use Replace below.</small></label>
          </div>
          <template v-if="applyIn === 'vscode'">
            <StepUpPanel v-if="cfgCf" data-hold="config" action="update" :name="c.name" :text="`Recreates ${c.name} from its Portainer stack with the new options${c.imageUpdate ? ', on the newer image already pulled' : ''}. /home/dev and the workspace stay; the tunnel drops until the new container is up.`" :waiting="cfgCf.waiting" @confirm="confirmStepUp" @cancel="cancelStepUp" />
            <div v-else class="act">
              <div class="btns tight"><HoldButton data-hold="config" class="sm" :disabled="busy" :aria-describedby="'hold-hint-' + c.id" @confirm="applyConfig(c.id, { ...cfg })" @early="early">{{ c.pending === 'config' ? 'Applying…' : 'Hold to apply and recreate' }}</HoldButton></div>
              <p class="fine">{{ applyNote }}</p>
            </div>
          </template>
          <div class="folds">
            <details class="fold">
              <summary><span class="fold-t">Machine settings in the container</span><span class="fold-s">{{ vsSum }}</span></summary>
              <div class="fold-b">
                <pre v-if="vs?.settings" class="term" tabindex="0" aria-label="VS Code Machine settings">{{ vs.settings }}</pre>
                <p v-else class="fine">{{ !run ? 'Start the container to read them.' : vs?.busy === 'load' ? 'Loading…' : !vs ? 'Read once the container answers /status. Press Reload to read them now.' : vs.settings === undefined ? 'Could not read them. Press Reload to try again.' : vs.settings === '' ? 'The file is empty. VS Code uses only your own settings here.' : 'None. VS Code uses only your own settings here.' }}</p>
                <StepUpPanel v-if="vsCf" data-hold="vscode" action="update" :name="c.name" text="Overwrites the VS Code Machine settings in the container with yours, edits made in the container included." :waiting="vsCf.waiting" @confirm="confirmStepUp" @cancel="cancelStepUp" />
                <div v-else class="btns tight">
                  <button type="button" class="btn sm" :aria-disabled="!run || !!vs?.busy || undefined" @click="run && !vs?.busy && loadVscode(c.id, true)"><AppIcon name="refresh" /> Reload</button>
                  <HoldButton data-hold="vscode" class="sm" :disabled="!run || busy || !!vs?.busy || !vsGlobal" @confirm="replaceVscode(c.id)" @early="early">{{ vs?.busy === 'replace' || c.pending === 'vscode' ? 'Replacing…' : 'Hold to replace with my settings' }}</HoldButton>
                </div>
                <p class="fine">{{ vsGlobal ? 'Overwrites ~/.vscode-server/data/Machine/settings.json with your VS Code settings from Settings, edits made in the container included. No restart; reload the VS Code window if it does not pick them up.' : 'Set your VS Code settings in Settings first.' }}</p>
              </div>
            </details>
          </div>
          </template>
        </section>

        <div v-if="st || store.ci[c.name]" class="duo">
          <section v-if="st" class="sec" :aria-labelledby="'g-' + c.id">
            <div class="sec-h"><h3 :id="'g-' + c.id" class="lbl"><button type="button" class="sec-tg" :aria-expanded="open('g')" @click="fold('g')">Git</button></h3><span class="sec-st" :class="sums.g.sev && 's-' + sums.g.sev" :title="sums.g.src">{{ sums.g.t }}</span></div>
            <template v-if="open('g')">
            <div class="lines">
              <p><a v-if="st.repo" :href="repoUrl(st.repo)!" target="_blank" rel="noopener noreferrer">{{ repoLabel(st.repo) }}</a><span v-else class="dim">REPO_URL is not set</span> · <span class="num">{{ st.branch === 'HEAD' ? 'detached HEAD' : st.branch ?? 'Not a git repo' }}</span></p>
              <p>{{ changes }} · {{ upstream }}<span v-if="st.ahead != null" class="dim"> · {{ c.lastFetchAt ? `fetched ${ago(c.lastFetchAt, now)}` : 'as of the last fetch' }}</span></p>
              <p v-if="st.last_commit"><span class="num">{{ st.last_commit.sha }}</span> {{ st.last_commit.message }} <span class="dim">· {{ ago(st.last_commit.date, now) }}</span></p>
              <p v-else class="dim">No commits</p>
            </div>
            <StepUpPanel v-if="cf?.action === 'pull'" data-hold="pull" action="pull" :name="c.name" :waiting="cf.waiting" @confirm="confirmStepUp" @cancel="cancelStepUp" />
            <div v-else class="btns tight">
              <button type="button" class="btn sm" :aria-disabled="!fresh || busy || undefined" @click="fresh && !busy && gitExec(c.id, 'fetch')">{{ exec?.running && exec.kind === 'fetch' ? 'Fetching…' : 'Fetch' }}</button>
              <HoldButton data-hold="pull" class="sm" :disabled="!fresh || busy" :aria-describedby="'hold-hint-' + c.id" @confirm="gitExec(c.id, 'pull')" @early="early">{{ exec?.running && exec.kind === 'pull' ? 'Pulling…' : 'Hold to pull' }}</HoldButton>
            </div>
            <ExecPanel v-if="exec" :x="exec" />
            </template>
          </section>

          <section v-if="store.ci[c.name]" class="sec" :aria-labelledby="'ci-' + c.id">
            <div class="sec-h ci-h"><h3 :id="'ci-' + c.id" class="lbl"><button type="button" class="sec-tg" :aria-expanded="open('ci')" @click="fold('ci')"><span>CI<span class="ci-long"> · GitHub Actions</span></span></button></h3><span class="sec-st" :class="sums.ci.sev && 's-' + sums.ci.sev" :title="sums.ci.src">{{ sums.ci.t }}</span><a class="src-note" :href="actionsUrl(store.ci[c.name].repo)" target="_blank" rel="noopener" :title="'All runs of ' + store.ci[c.name].repo + ' on GitHub'">All runs <AppIcon name="ext" /></a></div>
            <template v-if="open('ci')">
            <CiRuns :a="store.ci[c.name]" no-link />
            </template>
          </section>
        </div>

        <section class="sec">
          <details class="fold" @toggle="onLogToggle">
            <summary><span class="lbl">Log</span><span class="sec-st">Last 100 lines{{ logOpen && autoLog ? ' · every 3s' : '' }}</span></summary>
            <div class="fold-b">
              <div class="act">
                <label class="tgl"><input v-model="autoLog" type="checkbox" role="switch"><span>Auto-refresh every 3s</span></label>
                <button type="button" class="btn sm" :aria-disabled="store.dockerDown || refreshing || undefined" @click="store.dockerDown || refreshing || refresh()"><AppIcon name="refresh" /> Refresh</button>
              </div>
              <pre ref="logEl" class="term log" tabindex="0" aria-label="Container log"><template v-for="(l, i) in lines" :key="i"><span :class="l.cls"><template v-for="(p, j) in l.parts" :key="j"><mark v-if="j % 2">{{ p }}</mark><template v-else>{{ p }}</template></template></span>{{ i < lines.length - 1 ? '\n' : '' }}</template></pre>
            </div>
          </details>
        </section>

        <section class="sec">
          <details class="fold danger">
            <summary><span class="lbl">Danger zone</span><span class="sec-st">Purge the container, its /home/dev volume and deploy keys</span></summary>
            <div class="fold-b">
              <StepUpPanel v-if="cf?.action === 'remove'" data-hold="remove" action="remove" :name="c.name" :waiting="cf.waiting" @confirm="confirmStepUp" @cancel="cancelStepUp" />
              <template v-else>
                <div class="field"><label :for="'rm-' + c.id">Type <code>{{ c.name }}</code> to purge it</label><input :id="'rm-' + c.id" v-model="rmName" class="inp num" autocomplete="off" autocapitalize="none" spellcheck="false" :disabled="busy" :aria-describedby="'rm-note-' + c.id"></div>
                <div class="btns tight">
                  <HoldButton data-hold="remove" class="sm" danger :disabled="busy || rmName.trim() !== c.name" :aria-describedby="'rm-note-' + c.id + ' hold-hint-' + c.id" @confirm="containerAction(c.id, 'remove')" @early="early">{{ c.pending === 'remove' ? 'Purging…' : 'Hold to purge container' }}</HoldButton>
                </div>
              </template>
              <p :id="'rm-note-' + c.id" class="fine" :class="{ 's-warn': lost }">Purge deletes the Portainer stack, the container, its /home/dev volume with the workspace{{ lost ? `, including ${lost}` : '' }}, and its deploy keys on GitHub. It cannot be undone.</p>
            </div>
          </details>
        </section>
      </div>
    </template>
  </div>
</template>
