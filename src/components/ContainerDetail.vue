<script setup lang="ts">
import { computed, onBeforeUnmount, onBeforeUpdate, onUpdated, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { applyConfig, cancelStepUp, checkImages, confirmStepUp, containerAction, gitExec, loadClaudeDiff, loadVscode, pullClaudeConfig, refreshLogs, replaceVscode, store, switchClaudeAccount, toast, watchUsage } from '../store'
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
import { actionsUrl } from '../lib/actions'

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

// configuration: the boxes start from what the container runs with and reset when that changes (a poll brings a new object each time, so compare values)
const cfg = reactive({ installClaude: true, injectClaudeConfig: false, vscodeConfig: true })
watch(() => JSON.stringify(c.value?.config ?? null), () => { if (c.value) Object.assign(cfg, c.value.config) }, { immediate: true })
const cfgChanged = computed(() => !!c.value && (Object.keys(cfg) as (keyof typeof cfg)[]).some(k => cfg[k] !== c.value!.config[k]))
const cfgCf = computed(() => (store.confirm?.target === 'config-' + props.id ? store.confirm : null))
const cfgRepo = computed(() => store.session?.claudeConfigRepo ?? '')
const vs = computed(() => store.vscode[props.id])
const vsCf = computed(() => (store.confirm?.target === 'vscode-' + props.id ? store.confirm : null))
const vsGlobal = computed(() => !!store.session?.vscodeSettings)
const ccCf = computed(() => (store.confirm?.target === 'claudecfg-' + props.id ? store.confirm : null))
const cd = computed(() => store.claudeDiff[props.id])
const cdRows = computed(() => diffRows(cd.value?.data?.diff ?? ''))
const cdFiles = computed(() => cdRows.value.filter(r => r.kind === 'file').length)
// one-line summaries for the closed Claude config and VS Code settings rows
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
            <span v-if="run">up {{ since(c.startedAt, now) }}</span>
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
        <p>Check REPO_URL in the Portainer stack, or give the token access to this repo. Stopping it ends the loop.</p>
      </div>
      <ClaudeLoginCallout v-if="showClaude" :id="c.id" />

      <div class="plate panel">
        <section class="sec" :aria-labelledby="'r-' + c.id">
          <div class="sec-h"><h3 :id="'r-' + c.id" class="lbl">Resources</h3><span class="src-note">Docker stats · every {{ prefs.poll }}s</span></div>
          <div class="vitals">
            <template v-if="run">
              <div class="vital"><span class="lbl c-cpu">CPU</span><span class="num big" :class="useCls(cpuPct(c))">{{ cpuPct(c).toFixed(1) }}%</span><span class="num v-sub">{{ ((cpuPct(c) / 100) * ncpu).toFixed(1) }}/{{ ncpu }} cores</span></div>
              <div class="vital"><span class="lbl c-mem">RAM</span><span class="num big" :class="useCls(memPct(c))">{{ memPct(c).toFixed(0) }}%</span><span class="num v-sub">{{ gib(toGiB(c.memUsed)) }}/{{ gib(toGiB(c.memLimit)) }} GiB</span></div>
            </template>
            <div class="vital" :title="`Writable layer ${gib(toGiB(c.diskRw))} GiB, /home/dev volume ${gib(toGiB(c.diskVolume))} GiB, budget ${toGiB(DISK_BUDGET)} GiB`"><span class="lbl">Disk</span><span class="num big" :class="useCls(diskPct(c))">{{ diskPct(c).toFixed(0) }}%</span><span class="num v-sub">{{ gib(toGiB(diskBytes(c))) }}/{{ toGiB(DISK_BUDGET) }} GiB</span></div>
          </div>
          <TrendChart v-if="run && hist" :cpu="hist.cpu" :mem="hist.mem" :from="hist.from" :to="hist.to" :step="hist.step" />
          <p v-else class="fine">Docker reports no CPU or memory for a {{ c.state === 'exited' ? 'stopped' : c.state }} container.</p>
        </section>

        <div v-if="st || store.ci[c.name]" class="duo">
          <section v-if="st" class="sec" :aria-labelledby="'g-' + c.id">
            <div class="sec-h"><h3 :id="'g-' + c.id" class="lbl">Git</h3><span class="src-note">{{ fresh ? '/status · just now' : 'last answer from /status' }}</span></div>
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
          </section>

          <section v-if="store.ci[c.name]" class="sec" :aria-labelledby="'ci-' + c.id">
            <div class="sec-h ci-h"><h3 :id="'ci-' + c.id" class="lbl">CI<span class="ci-long"> · GitHub Actions</span></h3><span class="src-note">{{ store.ci[c.name].repo }}</span><a class="btn sm" :href="actionsUrl(store.ci[c.name].repo)" target="_blank" rel="noopener">All runs on GitHub <AppIcon name="ext" /></a></div>
            <CiRuns :a="store.ci[c.name]" no-link />
          </section>
        </div>

        <div class="duo">
          <section v-if="st" class="sec" :aria-labelledby="'e-' + c.id">
            <div class="sec-h"><h3 :id="'e-' + c.id" class="lbl">Environment</h3><span class="src-note">/status</span></div>
            <dl class="facts">
              <dt>Tools</dt><dd><span v-if="Object.keys(st.mise).length" class="tags"><span v-for="(ver, k) in st.mise" :key="k" class="tag">{{ k }} {{ ver }}</span></span><span v-else class="dim">No .mise.toml</span></dd>
              <dt>Claude Code</dt>
              <dd>{{ st.claude_installed === false ? 'Not installed' : st.claude_logged_in ? 'Credentials present' : 'Not signed in' }}<span v-if="st.claude_installed !== false && st.claude_version" class="num"> · {{ st.claude_version }}</span>
                <button v-if="run && st.claude_installed !== false && st.claude_logged_in" type="button" class="btn sm inl" :aria-disabled="switching || undefined" :title="'Sign Claude Code out of ' + c.name + ' and start a new sign-in'" @click="!switching && switchClaudeAccount(c.id)">{{ switching ? 'Signing out…' : 'Switch account' }}</button>
              </dd>
              <template v-if="st.claude_plugins && st.claude_installed !== false">
                <dt>Claude plugins</dt>
                <dd><span v-if="Object.keys(st.claude_plugins).length" class="tags"><span v-for="(ver, k) in st.claude_plugins" :key="k" class="tag" :title="k">{{ k.split('@')[0] }}{{ ver ? ' ' + ver.slice(0, 12) : '' }}</span></span><span v-else class="dim">None installed</span>
                  <template v-if="sync"><br><span v-if="sync.state === 'running'" class="fine">Installing and updating, started {{ ago(sync.at, now) }}</span><span v-else-if="sync.warnings.length" class="fine s-warn">Last sync {{ ago(sync.at, now) }}: {{ sync.warnings.join('; ') }}</span><span v-else class="fine">Synced with settings.json {{ ago(sync.at, now) }}</span></template>
                </dd>
              </template>
              <dt>Status server</dt>
              <dd><template v-if="fresh"><span title="Starts after setup, so it trails the container">up {{ dur(st.uptime_seconds + (now - ms(c.statusFetchedAt ?? now)) / 1000) }}</span></template><span v-else class="s-bad">not answering</span></dd>
            </dl>
          </section>

          <section class="sec" :aria-labelledby="'c-' + c.id">
            <div class="sec-h"><h3 :id="'c-' + c.id" class="lbl">Container</h3><span class="src-note">Docker API</span></div>
            <dl class="facts">
              <dt>State</dt><dd><span class="num">{{ c.state }}{{ c.state === 'exited' ? ` · exit ${c.exitCode}` : '' }}</span> · <span class="num">{{ c.restartCount }}</span> restart{{ c.restartCount === 1 ? '' : 's' }}</dd>
              <dt>Started</dt><dd class="num">{{ new Date(c.startedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) }}</dd>
              <dt>ID</dt><dd class="num">{{ sh }} · devnet · proxy</dd>
              <dt>Image</dt><dd><span class="num">{{ c.image }}</span><br><span class="fine" :class="{ 's-warn': c.imageUpdate }">{{ imageNote }}</span></dd>
            </dl>
            <StepUpPanel v-if="cf && cf.action !== 'pull' && cf.action !== 'remove'" :data-hold="cf.action" :action="cf.action" :name="c.name" :waiting="cf.waiting" @confirm="confirmStepUp" @cancel="cancelStepUp" />
            <div v-else class="btns tight">
              <template v-if="run || c.state === 'restarting'">
                <HoldButton v-if="run" data-hold="restart" class="sm" :disabled="busy" :aria-describedby="'hold-hint-' + c.id" @confirm="containerAction(c.id, 'restart')" @early="early"><AppIcon name="refresh" /> Hold to restart</HoldButton>
                <HoldButton data-hold="stop" class="sm" danger :disabled="busy" :aria-describedby="'hold-hint-' + c.id" @confirm="containerAction(c.id, 'stop')" @early="early">Hold to stop</HoldButton>
              </template>
              <button v-else type="button" class="btn sm pri" :aria-disabled="busy || undefined" @click="busy || containerAction(c.id, 'start')">Start</button>
              <button type="button" class="btn sm" :aria-disabled="checking || store.dockerDown || undefined" @click="checking || store.dockerDown || check()">{{ checking ? 'Checking…' : 'Check for update' }}</button>
              <HoldButton data-hold="update" class="sm" :disabled="busy" :aria-describedby="'hold-hint-' + c.id" @confirm="containerAction(c.id, 'update')" @early="early">{{ c.pending === 'update' ? 'Updating…' : c.imageUpdate ? 'Hold to update' : 'Hold to pull and restart' }}</HoldButton>
            </div>
            <p :id="'hold-hint-' + c.id" class="fine">{{ hint }}</p>
          </section>
        </div>

        <section class="sec" :aria-labelledby="'cfg-' + c.id">
          <div class="sec-h"><h3 :id="'cfg-' + c.id" class="lbl">Configuration</h3><span class="src-note">stack variables</span></div>
          <div class="checks">
            <label class="check"><input v-model="cfg.installClaude" type="checkbox" :disabled="busy"><span>Install Claude Code</span><small>Installed on the next start and updated on every restart, with its VS Code extension.</small></label>
            <label class="check"><input v-model="cfg.injectClaudeConfig" type="checkbox" :disabled="busy || (!cfgRepo && !c.config.injectClaudeConfig)"><span>Inject my Claude config</span>
              <small v-if="cfgRepo || c.config.injectClaudeConfig">Checks out {{ cfgRepo || 'the config repo' }} over <code>~/.claude</code> on every start, through a read-only deploy key. Turning it off removes that key.</small>
              <small v-else>Set your <code>~/.claude</code> repo in <RouterLink to="/settings">Settings</RouterLink> first.</small>
            </label>
            <label class="check"><input v-model="cfg.vscodeConfig" type="checkbox" :disabled="busy"><span>Apply my VS Code settings</span><small>Written only when the home volume has no VS Code Machine settings yet. To change them now, use Replace below.</small></label>
          </div>
          <StepUpPanel v-if="cfgCf" data-hold="config" action="update" :name="c.name" :text="`Recreates ${c.name} from its Portainer stack with the new options${c.imageUpdate ? ', on the newer image already pulled' : ''}. /home/dev and the workspace stay; the tunnel drops until the new container is up.`" :waiting="cfgCf.waiting" @confirm="confirmStepUp" @cancel="cancelStepUp" />
          <div v-else class="act">
            <div class="btns tight"><HoldButton data-hold="config" class="sm" :disabled="busy || !cfgChanged" :aria-describedby="'hold-hint-' + c.id" @confirm="applyConfig(c.id, { ...cfg })" @early="early">{{ c.pending === 'config' ? 'Applying…' : 'Hold to apply and recreate' }}</HoldButton></div>
            <p class="fine">{{ cfgChanged ? `Applying recreates the container${c.imageUpdate ? ' on the newer image already pulled, like Update does' : ''}; /home/dev and the workspace stay.` : 'Change an option to apply it.' }}</p>
          </div>

          <div class="folds">
            <details v-if="c.config.injectClaudeConfig" class="fold">
              <summary><span class="fold-t">Claude config in the container</span><span class="fold-s">{{ cdSum }}</span></summary>
              <div class="fold-b">
                <template v-if="run && cd?.data">
                  <p v-if="cd.data.truncated" class="fine">Too long to show in full, the rest is cut.</p>
                  <pre v-if="cdRows.length" class="term diff" tabindex="0" aria-label="Changes to the Claude config"><span v-for="(r, i) in cdRows" :key="i" :class="'d-' + r.kind">{{ r.text }}
</span></pre>
                </template>
                <p v-else class="fine">{{ !run ? 'Start the container to see what changed in its Claude config.' : cd?.busy ? 'Loading the changes…' : cd?.error ? `Could not read the changes: ${cd.error}` : 'Read once the container answers /status. Press Reload to read them now.' }}</p>
                <StepUpPanel v-if="ccCf" data-hold="claudecfg" action="update" :name="c.name" text="Downloads your Claude config repo again over ~/.claude in the container, edits made there to its files included." :waiting="ccCf.waiting" @confirm="confirmStepUp" @cancel="cancelStepUp" />
                <div v-else class="btns tight">
                  <button type="button" class="btn sm" :aria-disabled="!run || !!cd?.busy || undefined" @click="run && !cd?.busy && loadClaudeDiff(c.id, true)"><AppIcon name="refresh" /> Reload</button>
                  <HoldButton data-hold="claudecfg" class="sm" :disabled="!run || busy" @confirm="pullClaudeConfig(c.id)" @early="early">{{ c.pending === 'claudeConfig' ? 'Downloading…' : 'Hold to re-download my Claude config' }}</HoldButton>
                </div>
                <p class="fine">{{ run ? 'Fetches ' + (cfgRepo || 'the config repo') + ' now and overwrites the files it tracks in ~/.claude, edits made in the container included. Credentials, history and other files stay. No restart; start a new Claude session to pick it up.' : 'Start the container to download it.' }}</p>
              </div>
            </details>

            <details class="fold">
              <summary><span class="fold-t">VS Code settings in the container</span><span class="fold-s">{{ vsSum }}</span></summary>
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
        </section>

        <section class="sec" :aria-labelledby="'l-' + c.id">
          <div class="sec-h"><h3 :id="'l-' + c.id" class="lbl">Log · last 100 lines</h3><button type="button" class="btn sm" :aria-disabled="store.dockerDown || refreshing || undefined" @click="store.dockerDown || refreshing || refresh()"><AppIcon name="refresh" /> Refresh</button></div>
          <pre class="term log" tabindex="0" aria-label="Container log"><template v-for="(l, i) in lines" :key="i"><span :class="l.cls"><template v-for="(p, j) in l.parts" :key="j"><mark v-if="j % 2">{{ p }}</mark><template v-else>{{ p }}</template></template></span>{{ i < lines.length - 1 ? '\n' : '' }}</template></pre>
        </section>

        <section class="sec">
          <details class="fold danger">
            <summary><span class="fold-t">Danger zone</span><span class="fold-s">Purge the container, its /home/dev volume and deploy keys</span></summary>
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

        <section class="sec">
          <details class="src">
            <summary>Where these numbers come from</summary>
            <ul>
              <li><code>GET /containers/json?all=true&amp;filters={"label":["dockbench=true"]}</code><br>state, every {{ prefs.poll }}s</li>
              <li><code>GET /containers/{{ sh }}/json</code><br>started at, restart count, image</li>
              <li><code>GET http://dockbench-collector:9100/metrics</code><br>CPU and memory from the collector's cgroup sample, one call per tick for every container</li>
              <li><code>GET /system/df</code><br>writable layer and /home/dev volume size, at most once a minute</li>
              <li><code>GET http://{{ c.name }}:8080/status</code><br>git, tunnel, tools. Inside devnet only. One request at a time; a poll waits up to 2s for it, then shows the last answer.</li>
              <li><code>GET /containers/{{ sh }}/logs?stdout=true&amp;stderr=true&amp;tail=100</code><br>log, on open and on Refresh; device codes and the fatal line while starting or in a restart loop</li>
              <li><code>POST /images/create?fromImage={{ c.image }}</code> through Portainer<br>pulls the newest image with Portainer's registry credentials, every 30 minutes or on Check for update; a different image id than the container's means an update</li>
            </ul>
          </details>
        </section>
      </div>
    </template>
  </div>
</template>
