import { computed, reactive, watch } from 'vue'
import type { ActivityEvent, ApiCall, ConfigDiff, ContainerAction, ContainerConfig, DevContainer, DeviceSession, ExecResult, GitKind, GithubRepo, Guarded, HostUsage, PasskeyInfo, Pending, RepoActions, Session, SystemStatus, TelegramClaim, TelegramStatus, UsageWindow, Utilization } from './types'
import { api, SignedOut, StepUpRequired } from './api'
import { feedStale, openLive, sessionGone, staleSnapshot, type Live } from './api/live'
import { prefs } from './composables/usePrefs'
import { compare, needsAttention, verdict, type SortKey } from './lib/verdict'
import { notify, notifyOn } from './lib/notify'
import { haptic } from './lib/haptics'
import { painted } from './lib/paint'
import { DEFAULT_IMAGE, deployErrors, slug, type DeployDraft } from './lib/deploy'
import { gitMsg } from './lib/format'
import { finishedRuns, runWord } from './lib/actions'
import { hostPcts, usageLands } from './lib/usage'

export interface Confirm { target: string; action: Guarded; waiting: boolean } // target is a container id or 'deploy'
export interface ExecState extends ExecResult { kind: GitKind; running: boolean; msg: string }
export interface ClaudeLogin { phase: 'starting' | 'link' | 'sending' | 'done' | 'error'; url: string; msg: string }
// check: msg is from the session check on load, not from a sign-in attempt
export interface SignIn { busy: 'github' | 'passkey' | null; msg: string; denied: string | null; check?: boolean }
export interface DeployRun { name: string; calls: ApiCall[]; id: string | null; error: string | null }
export interface Draft extends DeployDraft { run: DeployRun | null }

export type TgOp = 'deploy' | 'claim' | 'update'
// loadError: GET /api/telegram is failing (the page says so instead of judging the last answer), cleared by the next answer; receivedAt: browser time the last answer arrived
const newTg = () => ({ token: '', gid: '', busy: null as TgOp | null, calls: [] as ApiCall[], error: '', claim: null as TelegramClaim | null, loadError: '', receivedAt: 0 })

// the Updates panel in Settings: the running action, its trace, and the wait for the dashboard to come back after updating itself
export type SysOp = 'check' | 'dashboard' | 'telegram'
const newSys = () => ({ busy: null as SysOp | null, restarting: false, calls: [] as ApiCall[], error: '' })

// Claude Code is installed by default; the config is injected by default once a config repo is set in Settings
const newDraft = (user = '', email = user && `${user}@users.noreply.github.com`, configRepo = ''): Draft => ({ q: '', repo: null, project: '', gitName: user, gitEmail: email, auth: 'token', token: '', image: DEFAULT_IMAGE, installClaude: true, injectClaudeConfig: !!configRepo, setupRerun: false, vscodeConfig: true, ghLogin: false, run: null })

export const store = reactive({
  ready: false, // session checked once
  session: null as Session | null,
  signedOut: false, // sign-in heading says "Signed out"
  signin: { busy: null, msg: '', denied: null } as SignIn,
  confirm: null as Confirm | null,
  stepUpUntil: 0,
  passkeys: null as PasskeyInfo[] | null,
  devices: null as DeviceSession[] | null, // Settings: every signed-in device
  // old container id to the new one after an image update recreated it, so an open detail can follow
  replaced: {} as Record<string, string>,
  host: null as HostUsage | null,
  containers: [] as DevContainer[],
  loading: true, // first container load
  lastPollAt: 0,
  lastGoodAt: 0,
  live: 'off' as 'off' | 'connecting' | 'on', // the SSE feed: on means snapshots arrive and the timer polls skip
  dockerDown: false,
  downError: '', // the failing call, for the error well
  // the collector's history for every graph: loaded while a graph is mounted (watchers), every 10 s
  usage: newUsage(),
  logs: {} as Record<string, string[] | undefined>,
  execs: {} as Record<string, ExecState | undefined>,
  pending: {} as Record<string, Pending | undefined>,
  activity: [] as ActivityEvent[],
  repos: null as GithubRepo[] | null,
  draft: newDraft(),
  telegram: null as TelegramStatus | null,
  // the Telegram page: form fields, the running action and its trace, the claim link once asked for
  tg: newTg(),
  system: null as SystemStatus | null,
  // GitHub Actions: every repo for the Actions page (null until loaded), and per dev container name for Bench
  actions: null as RepoActions[] | null,
  actionsError: '',
  ci: {} as Record<string, RepoActions>,
  sys: newSys(),
  // per container id: its VS Code Machine settings (null when it has none, undefined until loaded) and the call in flight
  vscode: {} as Record<string, { settings?: string | null; busy: 'load' | 'replace' | null } | undefined>,
  // per container id: what its ~/.claude changed since the config commit (undefined until loaded or when the read failed, with the reason in error) and whether a read is in flight
  claudeDiff: {} as Record<string, { data?: ConfigDiff; error?: string; busy: boolean } | undefined>,
  // per container id: the Claude Code sign-in in progress, so leaving the page keeps the link
  claudeLogin: {} as Record<string, ClaudeLogin | undefined>,
  toastMsg: '',
})

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const errText = (e: unknown) => (e instanceof Error ? (e.name === 'NotAllowedError' ? 'The passkey check was cancelled or timed out. Try again.' : e.message) : String(e))
const find = (id: string) => store.containers.find(c => c.id === id)

let toastT: ReturnType<typeof setTimeout> | undefined
function newUsage() {
  return { window: '1h' as UsageWindow, data: null as Utilization | null, error: null as string | null, at: 0, watchers: 0, topWatchers: 0 }
}

export function toast(msg: string, ms = 3200) {
  if (!store.session) return // an action that lands after sign-out must not toast on the sign-in plate
  notify(msg, 'toast') // a long action that ends while the dashboard is in the background
  store.toastMsg = msg
  clearTimeout(toastT)
  toastT = setTimeout(() => { store.toastMsg = '' }, ms)
}

function fail(e: unknown) {
  if (e instanceof SignedOut) expire()
  else { haptic('error'); toast(errText(e)) }
}

/* ---------- derived ---------- */

export const attentionCount = computed(() => store.containers.filter(needsAttention).length)

// dev containers whose repo's CI fails on the default branch, for the badge on Actions
export const ciFailCount = computed(() => Object.values(store.ci).filter(a => a.state === 'failure').length)

// newer dashboard, collector or bot images pulled and not installed yet, for the badge on Settings; the collector installs with the dashboard, so the two count as one update
export const updatesCount = computed(() => [store.system?.dashboard?.imageUpdate || store.system?.collector?.imageUpdate, store.system?.telegram?.imageUpdate].filter(Boolean).length)

export const hostUse = computed(() => (store.host ? hostPcts(store.host) : null))

// Bench list: compact shows running only; search matches name, repo and branch
export function visibleContainers(q: string, sort: SortKey) {
  q = q.trim().toLowerCase()
  return store.containers
    .filter(c => (!prefs.compact || c.state === 'running') && (!q || [c.name, c.repo, c.status?.repo, c.status?.branch].some(v => v && v.toLowerCase().includes(q))))
    .sort(compare[sort])
}

export const draftErrors = computed(() => deployErrors(store.draft, store.containers.map(c => c.name)))

/* ---------- session ---------- */

// The last session seen, so a reload paints the app at once and checks the cookie behind it. It holds no credential (the cookie is httpOnly); a 401 on the check or any poll signs out as before.
const SESSION_KEY = 'dockbench.session'
function cachedSession(): Session | null { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null') } catch { return null } }
function rememberSession(s: Session | null) { try { if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s)); else localStorage.removeItem(SESSION_KEY) } catch { /* storage blocked */ } }

let initP: Promise<void> | undefined
export function init() {
  return (initP ??= (async () => {
    const cached = !store.ready && cachedSession()
    if (cached) {
      store.session = cached
      store.ready = true
      painted().then(checkSession)
      return
    }
    await checkSession()
  })())
}

async function checkSession() {
  const optimistic = !!store.session
  // a 401 already resolves null; fetch throws a TypeError only when nothing answered. A failed check is retried on the next navigation.
  try {
    const s = await api.getSession()
    rememberSession(s)
    if (!s && optimistic) return expire()
    store.session = s
  } catch (e) {
    // painted from the cache: keep it, the polls show what is unreachable
    if (!optimistic) {
      initP = undefined
      store.session = null
      store.signin = { busy: null, msg: e instanceof TypeError ? 'The dashboard server did not answer. Is it running?' : `Could not check the session (${errText(e)}).`, denied: null, check: true }
    }
  }
  store.ready = true
  if (store.session) afterSignIn()
}

function afterSignIn() {
  const s = store.session!
  store.stepUpUntil = s.stepUpUntil ?? 0
  store.signedOut = false
  store.signin = { busy: null, msg: '', denied: null }
  store.draft = newDraft(s.user, s.email, s.claudeConfigRepo)
  store.loading = true
  poll()
  loadActivity()
  startPolling()
}

// leaves the page for GitHub; the OAuth callback brings the browser back
export function signInGithub() {
  if (store.signin.busy) return
  store.signin = { busy: 'github', msg: '', denied: null }
  api.signInGithub()
}

// the server sets the session cookie; a full load then fetches the new session, like after the 2FA code
export async function signInPasskey() {
  if (store.signin.busy) return
  store.signin = { busy: 'passkey', msg: '', denied: null }
  try {
    await api.signInPasskey()
    location.assign('/bench')
  } catch (e) {
    store.signin = { busy: null, msg: errText(e), denied: null }
  }
}

// the OAuth callback sends a non-allowlisted account back to /sign-in?error=denied&login=x; SignInView words the message from denied
export function showDenied(login: string) {
  store.signin = { busy: null, msg: '', denied: login }
}

function expire() {
  closeLive()
  stopPolling()
  rememberSession(null)
  store.session = null
  store.signedOut = true
  store.confirm = null
  store.stepUpUntil = 0
  store.passkeys = null
  store.devices = null
  store.replaced = {}
  store.toastMsg = ''
  store.containers = []
  store.host = null
  store.loading = true
  stopUsage()
  store.usage = newUsage()
  store.logs = {}
  store.execs = {}
  store.pending = {}
  store.vscode = {}
  store.claudeDiff = {}
  store.claudeLogin = {}
  for (const k in wantCfg) delete wantCfg[k]
  store.activity = []
  store.repos = null
  store.draft = newDraft()
  store.telegram = null
  store.tg = newTg()
  store.system = null
  store.sys = newSys()
  store.actions = null
  store.actionsError = ''
  store.ci = {}
  ciRunning.clear()
}

export async function signOut() {
  try { await api.signOut() } catch { /* the session ends locally either way */ }
  expire()
}

/* ---------- polling ---------- */

function merge(list: DevContainer[]) {
  for (const fresh of list) {
    const id = fresh.id, cur = find(id)
    fresh.pending = store.pending[id] ?? fresh.pending
    if (!cur) {
      store.containers.push(fresh)
      continue
    }
    const changed = cur.state !== fresh.state || cur.statusError !== fresh.statusError || cur.restartCount !== fresh.restartCount
    const wasBad = verdict(cur).sev === 'bad'
    Object.assign(cur, fresh)
    // /status now sees the credentials after a sign-in: the callout is gone, so its state goes too. Only `done`: /status is cached and can still say "signed in" just after a switch-account logout, which must not wipe the new link (or `starting`)
    if (fresh.status?.claude_logged_in && store.claudeLogin[id]?.phase === 'done') delete store.claudeLogin[id]
    const v = verdict(cur) // a pending container is never bad, it reads as warn
    if (!wasBad && v.sev === 'bad') notify(`${cur.name}: ${v.word}`, `bad-${id}`, `/bench/${id}`)
    if (changed && store.logs[id]) loadLogs(id)
  }
  const ids = new Set(list.map(c => c.id))
  const gone = store.containers.filter(c => !ids.has(c.id))
  if (!gone.length) return
  for (const { id } of gone) { delete store.logs[id]; delete store.execs[id]; delete store.claudeLogin[id] }
  store.containers = store.containers.filter(c => ids.has(c.id))
}

function setHost(host: HostUsage) {
  store.dockerDown = !host.reachable
  store.downError = host.reachable ? '' : 'GET /api/host · reachable: false, the Docker socket did not answer'
  store.lastPollAt = Date.now()
  // an unreachable answer from the server carries zeros, so the last good values stay
  if (host.reachable) {
    store.host = host
    store.lastGoodAt = Date.parse(host.polledAt)
  }
  return host
}

// a hidden dashboard stops polling, unless system notifications are on: then it keeps watching for as long as the browser lets a background page run
const asleep = () => document.hidden && !notifyOn()

let liveConn: Live | null = null
// host.polledAt (server clock) of the last forced poll: every ticker snapshot built before it is dropped until one built after it arrives and clears it; a reconnect clears it too, so a server clock stepping back drops the feed at most until the watchdog reopens it. snapAt: host.polledAt of the last snapshot merged while a poll runs, so a poll's container list that a newer snapshot overtook is not merged over it
let forcedAt = 0, snapAt = 0
// opens the feed; snapshots go through the same merge as a poll. closed = the server refused the reconnect: a 401 signs out, anything else (the server restarting behind the proxy) leaves the feed off and the next timer tick reconnects, never checkSession(), whose afterSignIn would reconnect at once in a loop and reset the deploy draft
export function connectLive() {
  if (liveConn || !store.session || asleep()) return
  store.live = 'connecting'
  forcedAt = 0
  liveConn = openLive({
    snapshot: ({ host, containers }) => { if (staleSnapshot(host.polledAt, forcedAt)) return; forcedAt = 0; snapAt = Date.parse(host.polledAt); setHost(host); merge(containers); store.loading = false; store.live = 'on' },
    down: error => { store.dockerDown = true; store.downError = error; store.lastPollAt = Date.now(); store.loading = false; store.live = 'on' },
    connecting: () => { store.live = 'connecting' },
    signedOut: () => expire(),
    closed: async () => { closeLive(); if (await sessionGone(api.getSession)) expire() },
  })
}
export function closeLive() {
  liveConn?.close()
  liveConn = null
  store.live = 'off'
}

let inFlight: Promise<void> | null = null, again = false
// one poll at a time; a poll asked for while one runs happens right after it
export function poll(opts: { force?: boolean } = {}): Promise<void> {
  if (inFlight) { again = true; return inFlight }
  // the feed carries the data; only an action that wants the state now (force) fetches while it is on
  if (!opts.force && store.live === 'on') return Promise.resolve()
  if (!store.session || asleep()) return Promise.resolve()
  inFlight = (async () => {
    try {
      // the host panel fills in as soon as /api/host answers, the container list can take longer; a snapshot built after this poll's host that landed meanwhile is newer than both
      snapAt = 0
      let hostAt = 0
      const [host, list] = await Promise.allSettled([api.getHost().then(h => { hostAt = Date.parse(h.polledAt); if (opts.force) forcedAt = hostAt; return snapAt > hostAt ? h : setHost(h) }), api.getContainers()])
      if (host.status === 'fulfilled' && list.status === 'fulfilled') { if (snapAt <= hostAt) merge(list.value) }
      else {
        const errs = [host, list].flatMap(r => (r.status === 'rejected' ? [r.reason] : []))
        if (errs.some(e => e instanceof SignedOut)) expire()
        // Docker down: /api/containers fails too, but setHost already named the real cause
        else if (host.status === 'rejected' || host.value.reachable) { store.dockerDown = true; store.downError = errText(errs[0]); store.lastPollAt = Date.now() }
      }
    } finally {
      store.loading = false
      inFlight = null
    }
    if (again) { again = false; await poll({ force: true }) }
  })()
  return inFlight
}

let timer: ReturnType<typeof setInterval> | undefined, sysTimer: ReturnType<typeof setInterval> | undefined, ciTimer: ReturnType<typeof setInterval> | undefined
export function startPolling() {
  stopPolling()
  // the watchdog: a feed that is on but silent for three intervals (half-open socket after sleep, a wedged ticker) is reopened, since timer polls skip while it is on
  timer = setInterval(() => {
    if (store.live === 'on' && feedStale(store.lastPollAt, Date.now())) closeLive()
    if (store.live === 'off') connectLive()
    poll()
  }, prefs.poll * 1000)
  connectLive()
  // the server pulls the two images every 30 minutes on its own; this only picks the answer up for the Settings badge
  loadSystem()
  sysTimer = setInterval(() => { if (!document.hidden) loadSystem() }, 5 * 60_000)
  // CI of the dev containers' repos, so a finished run (a new version deployed) toasts wherever the dashboard is open
  loadCi()
  ciTimer = setInterval(() => { if (!asleep()) loadCi() }, 30_000)
}
export function stopPolling() {
  clearInterval(timer)
  clearInterval(sysTimer)
  clearInterval(ciTimer)
  timer = sysTimer = ciTimer = undefined
}
watch(() => prefs.poll, () => { if (timer) startPolling() })
// hidden without notifications on: the feed closes (the timer poll already returns at once while asleep); back in front: reconnect and fetch now
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (asleep()) closeLive() }
  else if (timer) { connectLive(); poll() }
})

/* ---------- reads ---------- */

export async function loadActivity() {
  try { store.activity = await api.getActivity() } catch (e) { fail(e) }
}

export async function loadLogs(id: string) {
  try { store.logs[id] = await api.getLogs(id) } catch (e) { fail(e) }
}

export async function refreshLogs(id: string) {
  if (paused()) return
  await loadLogs(id)
  toast('Log refreshed')
}

let reposP: Promise<void> | null = null
// keeps the current list while reloading; force after a deploy changes deployedAs
export function loadRepos(force = false) {
  if ((store.repos && !force) || reposP) return reposP ?? Promise.resolve()
  return (reposP = api.getRepos().then(r => { store.repos = r }, fail).finally(() => { reposP = null }))
}


/* ---------- writes ---------- */

function paused() {
  if (store.dockerDown) toast('Docker is unreachable. Actions are paused until it answers.')
  return store.dockerDown
}

// the server asks for a passkey only once one is registered, and only for the actions switched on in Settings
const needsStep = (a: Guarded) => !!store.session && store.session.passkeys > 0 && store.session.stepUp[a]

// true when the inline passkey panel took over instead
function guard(target: string, action: Guarded) {
  if (!needsStep(action) || Date.now() <= store.stepUpUntil) return false
  store.confirm = { target, action, waiting: false }
  return true
}

// the server refused: the window closed in between (or another tab signed in again)
function askAgain(target: string, action: Guarded) {
  store.stepUpUntil = 0
  store.confirm = { target, action, waiting: false }
}

export function containerAction(id: string, action: ContainerAction) {
  if (paused() || (action !== 'start' && guard(id, action))) return
  return runAction(id, action)
}

async function runAction(id: string, a: ContainerAction) {
  const c = find(id)
  if (!c || store.pending[id]) return
  const name = c.name
  store.pending[id] = a
  c.pending = a
  let r: Awaited<ReturnType<typeof api.containerAction>>
  try {
    r = await api.containerAction(id, a)
  } catch (e) {
    delete store.pending[id]
    c.pending = null
    if (e instanceof StepUpRequired && a !== 'start') askAgain(id, a)
    else fail(e)
    if (a === 'update' || a === 'remove') loadActivity()
    return
  }
  // an update recreated the container under a new id: the old row disappears on this poll and an open detail follows the new one
  if (r.id && r.id !== id) store.replaced[id] = r.id
  // pending stays until the poll has merged the new state, so the old verdict never flashes back
  await poll({ force: true })
  delete store.pending[id]
  const cur = r.id || id
  const n = find(cur)
  if (n) n.pending = null
  // the container and its log are gone, so there is nothing to settle
  if (a === 'remove') {
    const v = r.volumes ?? 0, k = r.keys ?? 0
    const what = [v ? (v > 1 ? `its ${v} volumes` : 'its volume') : '', k ? (k > 1 ? `its ${k} deploy keys` : 'its deploy key') : ''].filter(Boolean).join(' and ')
    const done = `Removed ${name}${what ? `, ${what}` : ''}`
    if (r.warning) toast(`${done}, but: ${r.warning}`, 15_000)
    else toast(done)
    loadActivity()
    return
  }
  toast(a === 'stop' ? `Stopped ${name}`
    : a === 'update' ? (r.upToDate ? `${name} already runs the newest image, restarted it` : `Updated ${name} to the newest image. Waiting for /status`)
    : n?.state === 'restarting' ? `${name} restarted, clone still failing`
    : `${a === 'start' ? 'Started' : 'Restarted'} ${name}. Waiting for /status`)
  await settle(cur)
}

// after a start or a recreate: the activity and the open log, then starting until /status answers: poll faster for a while, merge() reloads the log when it flips
async function settle(id: string) {
  loadActivity()
  if (store.logs[id]) loadLogs(id)
  for (let i = 0; i < 20 && find(id)?.statusError === 'starting' && store.session; i++) { await sleep(1500); await poll({ force: true }) }
}

// asks the registry now instead of waiting for the server's 30-minute refresh
export async function checkImages() {
  if (paused()) return
  try {
    const r = await api.checkImages()
    const failed = r.filter(x => x.error)
    await poll({ force: true })
    const n = store.containers.filter(c => c.imageUpdate).length
    toast(failed.length ? `Could not pull the image: ${failed[0].error}` : n ? `${n} container${n > 1 ? 's' : ''} can update to a newer image` : 'Every container runs the newest image')
  } catch (e) { fail(e) }
}

export function gitExec(id: string, kind: GitKind) {
  if (paused() || (kind === 'pull' && guard(id, 'pull'))) return
  return runGit(id, kind)
}

async function runGit(id: string, kind: GitKind) {
  const c = find(id)
  if (!c || store.execs[id]?.running) return
  const name = c.name, cmd = kind === 'fetch' ? 'git fetch' : 'git pull --ff-only'
  store.execs[id] = { kind, cmd, running: true, exitCode: null, output: '', calls: [], msg: '' }
  try {
    const r = await api.gitExec(id, kind)
    store.execs[id] = { ...r, msg: r.msg || gitMsg(kind, r, c.status), kind, running: false }
    toast(r.exitCode ? `${kind === 'fetch' ? 'Fetch' : 'Pull'} failed in ${name}` : `${kind === 'fetch' ? 'Fetched' : 'Pulled'} ${name}`)
  } catch (e) {
    store.execs[id] = undefined
    if (e instanceof StepUpRequired && kind === 'pull') askAgain(id, 'pull')
    else fail(e)
    return
  }
  poll({ force: true })
  loadActivity()
}

export async function confirmStepUp() {
  const cf = store.confirm
  if (!cf || cf.waiting) return
  cf.waiting = true
  try {
    store.stepUpUntil = await api.stepUp()
  } catch (e) {
    cf.waiting = false
    fail(e)
    return
  }
  store.confirm = null
  if (cf.target.startsWith('telegram-')) runTelegram(cf.target.slice(9) as TgOp)
  else if (cf.target.startsWith('system-')) runSystemUpdate(cf.target.slice(7) as 'dashboard' | 'telegram')
  else if (cf.target.startsWith('config-')) runConfig(cf.target.slice(7))
  else if (cf.target.startsWith('vscode-')) runReplaceVscode(cf.target.slice(7))
  else if (cf.target.startsWith('claudecfg-')) runPullClaudeConfig(cf.target.slice(10))
  else if (cf.action === 'deploy') deploy() // re-validates: the form stays editable while the panel is open
  else if (cf.action === 'pull') runGit(cf.target, 'pull')
  else runAction(cf.target, cf.action)
}

export function cancelStepUp() {
  if (store.confirm && !store.confirm.waiting) store.confirm = null
}

/* ---------- passkeys and step-up settings ---------- */

// Settings changes that weaken the guard need a fresh passkey check; the browser prompt is started from the click itself, then the change runs
export async function unlock() {
  try {
    store.stepUpUntil = await api.stepUp()
    toast('Confirmed. Changes are open for 5 minutes.')
  } catch (e) { fail(e) }
}

async function refreshSession() {
  const s = await api.getSession()
  if (s) store.session = s
}

export async function loadPasskeys() {
  try { store.passkeys = await api.listPasskeys() } catch (e) { fail(e) }
}

// code: the authenticator code, only for the first passkey; resolves true when added
export async function addPasskey(name: string, code?: string) {
  try {
    await api.addPasskey(name, code)
  } catch (e) {
    if (e instanceof StepUpRequired) { store.stepUpUntil = 0; toast('Confirm with an existing passkey first.') }
    else fail(e)
    return false
  }
  toast(`Added passkey ${name}`)
  await Promise.all([loadPasskeys(), refreshSession(), loadActivity()])
  return true
}

export async function removePasskey(p: PasskeyInfo) {
  try {
    await api.removePasskey(p.id)
  } catch (e) {
    if (e instanceof StepUpRequired) { store.stepUpUntil = 0; toast('Confirm with a passkey first.') }
    else fail(e)
    return
  }
  toast(`Removed passkey ${p.name}`)
  await Promise.all([loadPasskeys(), refreshSession(), loadActivity()])
}

export async function setStepUp(action: Guarded, on: boolean) {
  const s = store.session
  if (!s) return
  try {
    s.stepUp = await api.setStepUp({ [action]: on })
  } catch (e) {
    if (e instanceof StepUpRequired) { store.stepUpUntil = 0; toast('Confirm with a passkey before turning a check off.') }
    else fail(e)
  }
}

export async function loadDevices() {
  try { store.devices = await api.listSessions() } catch (e) { fail(e) }
}

export async function revokeDevice(d: DeviceSession) {
  try { await api.revokeSession(d.id) } catch (e) { fail(e); return }
  if (d.current) return expire()
  toast(`Signed out ${d.device}`)
  await Promise.all([loadDevices(), loadActivity()])
}

// resolves true when saved; the list is reloaded because a lower cap signs devices out at once
export async function setSessionLimits(maxDevices: number, idleDays: number) {
  const s = store.session
  if (!s) return false
  try {
    Object.assign(s, await api.setSessionLimits({ maxDevices, idleDays }))
    rememberSession(s)
  } catch (e) { fail(e); return false }
  toast('Device limits saved')
  await Promise.all([loadDevices(), loadActivity()])
  return true
}

export async function signOutEverywhere() {
  try { await api.signOut(true) } catch { /* the session ends locally either way */ }
  expire()
}

// '' stops injecting. The deploy form follows: a newly set repo turns injection on, a cleared one off.
export async function setClaudeConfig(repo: string) {
  const s = store.session
  if (!s) return false
  try {
    const was = s.claudeConfigRepo
    s.claudeConfigRepo = (await api.setClaudeConfig(repo)).claudeConfigRepo
    if (!s.claudeConfigRepo || !was) store.draft.injectClaudeConfig = !!s.claudeConfigRepo
    toast(s.claudeConfigRepo ? `Claude config repo set to ${s.claudeConfigRepo}` : 'Claude config repo cleared')
    return true
  } catch (e) { fail(e); return false }
}

// '' means the image's own settings. Containers already deployed keep theirs until Replace.
export async function setVscodeSettings(text: string) {
  const s = store.session
  if (!s) return false
  try {
    s.vscodeSettings = (await api.setVscodeSettings(text)).vscodeSettings
    toast(s.vscodeSettings ? 'VS Code settings saved' : 'VS Code settings cleared, new containers get the image default')
    loadActivity()
    return true
  } catch (e) { fail(e); return false }
}

/* ---------- container configuration ---------- */

// the options asked for while the passkey panel is open
const wantCfg: Record<string, ContainerConfig> = {}

// recreates the container through its stack, so it is guarded like an image update
export function applyConfig(id: string, cfg: ContainerConfig) {
  wantCfg[id] = cfg
  if (paused() || guard('config-' + id, 'update')) return
  return runConfig(id)
}

async function runConfig(id: string) {
  const c = find(id), cfg = wantCfg[id]
  if (!c || !cfg || store.pending[id]) return
  const name = c.name
  store.pending[id] = 'config'
  c.pending = 'config'
  let r: Awaited<ReturnType<typeof api.applyConfig>>
  try {
    r = await api.applyConfig(id, cfg)
  } catch (e) {
    delete store.pending[id]
    c.pending = null
    // the options stay for the retry after the passkey
    if (e instanceof StepUpRequired) askAgain('config-' + id, 'update')
    else { fail(e); delete wantCfg[id] }
    loadActivity()
    return
  }
  delete wantCfg[id]
  if (r.id && r.id !== id) store.replaced[id] = r.id
  // pending stays until the poll has merged the new state, like runAction
  await poll({ force: true })
  delete store.pending[id]
  const cur = r.id || id
  const n = find(cur)
  if (n) n.pending = null
  // no id: compose had not recreated it within the server's 10 s wait; a key left on GitHub needs a hand, so it stays up long enough to read (also in Activity)
  if (r.warning) toast(`${r.id ? 'Recreated' : 'Saved the configuration of'} ${name}, but: ${r.warning}`, 15_000)
  else toast(r.id ? `Recreated ${name} with the new configuration. Waiting for /status` : `Saved the configuration of ${name}, but its new container has not shown up yet. Check it in a moment.`)
  await settle(cur)
}

// read back through store: ??= hands out the raw object, whose writes Vue does not see
const vscodeOf = (id: string) => (store.vscode[id] ??= { busy: null }, store.vscode[id]!)

// manual: Reload was pressed; the automatic read on each start fails without a toast, the page already says it could not read them
export async function loadVscode(id: string, manual = false) {
  const v = vscodeOf(id)
  if (v.busy) return
  v.busy = 'load'
  // a failed read clears the old text, so the page says it could not read them
  try { v.settings = (await api.getVscode(id)).settings } catch (e) { v.settings = undefined; if (manual || e instanceof SignedOut) fail(e) }
  v.busy = null
}

// overwrites edits made in the container, so it is guarded like an image update
export function replaceVscode(id: string) {
  if (vscodeOf(id).busy || paused() || guard('vscode-' + id, 'update')) return
  return runReplaceVscode(id)
}

async function runReplaceVscode(id: string) {
  const v = vscodeOf(id)
  if (v.busy) return
  v.busy = 'replace'
  try {
    v.settings = (await api.replaceVscode(id)).settings
    toast(`Replaced the VS Code settings in ${find(id)?.name ?? 'the container'}`)
  } catch (e) {
    if (e instanceof StepUpRequired) askAgain('vscode-' + id, 'update')
    else fail(e)
  }
  v.busy = null
  // a poll during the exec merged the server's `vscode` pending; clear it now instead of at the next poll
  poll({ force: true })
  loadActivity()
}

const claudeDiffOf = (id: string) => (store.claudeDiff[id] ??= { busy: false }, store.claudeDiff[id]!)

// manual: Reload was pressed; the automatic read on each start fails without a toast, the page shows the reason
export async function loadClaudeDiff(id: string, manual = false) {
  const d = claudeDiffOf(id)
  if (d.busy) return
  d.busy = true
  try { d.data = await api.getClaudeConfigDiff(id); d.error = undefined } catch (e) { d.data = undefined; d.error = errText(e); if (manual || e instanceof SignedOut) fail(e) }
  d.busy = false
}

// overwrites edits made to ~/.claude in the container, so it is guarded like an image update; the server's `claudeConfig` pending drives the button
export function pullClaudeConfig(id: string) {
  if (store.pending[id] || paused() || guard('claudecfg-' + id, 'update')) return
  return runPullClaudeConfig(id)
}

async function runPullClaudeConfig(id: string) {
  const c = find(id)
  if (!c || store.pending[id]) return
  store.pending[id] = c.pending = 'claudeConfig'
  try {
    const { commit } = await api.pullClaudeConfig(id)
    toast(`Downloaded the Claude config into ${c.name}${commit ? ` (${commit})` : ''}`)
    loadClaudeDiff(id)
  } catch (e) {
    if (e instanceof StepUpRequired) askAgain('claudecfg-' + id, 'update')
    else fail(e)
  }
  delete store.pending[id]
  c.pending = null
  poll({ force: true })
  loadActivity()
}

/* ---------- Claude Code sign-in ---------- */

// a new start also replaces an attempt still waiting in the container, with a new link
export async function startClaudeLogin(id: string) {
  const cur = store.claudeLogin[id]
  if (cur?.phase === 'starting' || cur?.phase === 'sending') return
  store.claudeLogin[id] = { phase: 'starting', url: '', msg: '' }
  try {
    store.claudeLogin[id] = { phase: 'link', url: (await api.startClaudeLogin(id)).url, msg: '' }
  } catch (e) {
    if (e instanceof SignedOut) return fail(e)
    store.claudeLogin[id] = { phase: 'error', url: '', msg: errText(e) }
  }
  loadActivity()
}

// sign out, then start a fresh sign-in so another account can be used: the callout appears once a poll sees the credentials gone, already holding the new link
export async function switchClaudeAccount(id: string) {
  const cur = store.claudeLogin[id]
  if (cur?.phase === 'starting' || cur?.phase === 'sending') return
  store.claudeLogin[id] = { phase: 'starting', url: '', msg: '' }
  try {
    await api.claudeLogout(id)
  } catch (e) {
    delete store.claudeLogin[id]
    loadActivity()
    return fail(e)
  }
  toast('Claude signed out')
  await poll({ force: true })
  delete store.claudeLogin[id]
  await startClaudeLogin(id)
}

export async function sendClaudeCode(id: string, code: string) {
  const l = store.claudeLogin[id]
  if (l?.phase !== 'link' || !code.trim()) return
  l.phase = 'sending'
  try {
    await api.sendClaudeCode(id, code.trim())
    store.claudeLogin[id] = { phase: 'done', url: '', msg: '' }
    toast('Claude signed in')
    poll({ force: true })
  } catch (e) {
    if (e instanceof SignedOut) return fail(e)
    // the CLI exits on a wrong code, so the link is spent either way
    store.claudeLogin[id] = { phase: 'error', url: '', msg: errText(e) }
  }
  loadActivity()
}

/* ---------- deploy ---------- */

export function pickRepo(r: GithubRepo) {
  store.draft.repo = r
  store.draft.project = slug(r.fullName)
}

export function deploy() {
  if (Object.keys(draftErrors.value).length || paused() || guard('deploy', 'deploy')) return
  return runDeploy()
}

async function runDeploy() {
  const d = store.draft, name = 'dockbench-' + d.project
  d.run = { name, calls: [], id: null, error: null }
  try {
    const r = await api.deploy({ repo: d.repo!.fullName, project: d.project, gitUserName: d.gitName, gitUserEmail: d.gitEmail, auth: d.auth, token: d.auth === 'token' ? d.token : undefined, image: d.image, installClaude: d.installClaude, injectClaudeConfig: d.injectClaudeConfig && !!store.session?.claudeConfigRepo, setupRerun: d.setupRerun, vscodeConfig: d.vscodeConfig, ghLogin: d.ghLogin })
    d.token = ''
    if (d.run) { d.run.calls = r.calls; d.run.id = r.id }
    toast(r.warning ? `Deployed ${name}, but: ${r.warning}` : `Deployed ${name}`, r.warning ? 15_000 : undefined)
    await poll({ force: true })
    loadActivity()
    loadRepos(true)
  } catch (e) {
    if (e instanceof StepUpRequired) { d.run = null; askAgain('deploy', 'deploy') }
    else {
      // 409 and 502 carry the call trace, the failed call has no status
      if (d.run) { d.run.error = errText(e); d.run.calls = (e as { calls?: ApiCall[] }).calls ?? d.run.calls }
      fail(e)
      if (store.session) loadActivity()
    }
  }
}

export function resetDeploy() {
  store.draft = newDraft(store.session?.user, store.session?.email, store.session?.claudeConfigRepo)
  if (store.confirm?.target === 'deploy') store.confirm = null
}

/* ---------- Telegram bot ---------- */

export async function loadTelegram() {
  try {
    const t = await api.getTelegram()
    // a restarted bot no longer knows the claim code it handed out
    if (store.telegram && store.telegram.startedAt !== t.startedAt) store.tg.claim = null
    store.telegram = t
    store.tg.receivedAt = Date.now()
    store.tg.loadError = ''
  } catch (e) {
    if (e instanceof SignedOut) return expire()
    // toast once per failure streak, not on every poll
    if (!store.tg.loadError) fail(e)
    store.tg.loadError = errText(e)
  }
}

const TG_GUARD: Record<TgOp, Guarded> = { deploy: 'deploy', claim: 'deploy', update: 'update' }

export function telegramAction(op: TgOp) {
  if (store.tg.busy || paused() || guard('telegram-' + op, TG_GUARD[op])) return
  return runTelegram(op)
}

async function runTelegram(op: TgOp) {
  const g = store.tg
  g.busy = op
  g.error = ''
  g.calls = []
  try {
    if (op === 'deploy') {
      const gid = g.gid.trim() || undefined
      const r = await api.deployTelegram(g.token.trim(), gid)
      g.token = ''
      g.calls = r.calls
      toast(r.warning ? `Deployed @${r.bot}, but: ${r.warning}` : `Deployed @${r.bot}. Waiting for /status`, r.warning ? 15_000 : undefined)
    } else if (op === 'claim') {
      g.claim = await api.claimTelegram()
    } else {
      const r = await api.updateTelegram()
      g.calls = r.calls
      toast(r.upToDate ? 'The bot already runs the newest image, restarted it' : 'Updated the bot to the newest image')
    }
  } catch (e) {
    if (e instanceof StepUpRequired) askAgain('telegram-' + op, TG_GUARD[op])
    else {
      g.error = errText(e)
      g.calls = (e as { calls?: ApiCall[] }).calls ?? []
      fail(e)
    }
  } finally {
    g.busy = null
  }
  await loadTelegram()
  if (op !== 'claim') loadActivity()
}

/* ---------- usage (the collector's history) ---------- */

let usageTimer: ReturnType<typeof setInterval> | undefined
// only the newest request's answer lands: an older one can be for another window, or without the process lists the Usage page asked for since
let usageSeq = 0
let usageLanded = 0

export async function loadUsage() {
  const req = { seq: ++usageSeq, window: store.usage.window, top: store.usage.topWatchers > 0 }
  const lands = () => usageLands(req, usageLanded, { window: store.usage.window, wantTop: store.usage.topWatchers > 0 })
  try {
    const data = await api.getUtilization(req.window, req.top)
    if (!lands()) return
    usageLanded = req.seq
    store.usage.data = data
    store.usage.error = null
    store.usage.at = Date.now()
  } catch (e) {
    if (e instanceof SignedOut) return expire()
    if (!lands()) return
    usageLanded = req.seq
    // the graphs go empty rather than show an old window as if it were current
    store.usage.data = null
    store.usage.error = errText(e)
  }
}

function stopUsage() {
  clearInterval(usageTimer)
  usageTimer = undefined
}

// every mounted graph registers here: the first one loads and starts a 10 s refresh, the last one to leave stops it, so one open dashboard asks once every 10 s however many graphs it shows. top: the watcher needs the per-process lists (the Usage page); without one the answer leaves them out, about a fifth of the bytes. Call the returned function on unmount.
export function watchUsage(opts: { top?: boolean } = {}): () => void {
  const u = store.usage
  const first = u.watchers++ === 0
  const firstTop = !!opts.top && u.topWatchers++ === 0
  if (first) usageTimer = setInterval(() => { if (!asleep()) loadUsage() }, 10_000)
  // the lists are needed now, not at the next tick
  if (first || firstTop) loadUsage()
  let done = false
  return () => {
    // a sign-out in between replaced the slice, whose counters start again from 0
    if (done || store.usage !== u) return
    done = true
    if (opts.top) u.topWatchers--
    if (--u.watchers === 0) stopUsage()
  }
}

export function setUsageWindow(w: UsageWindow) {
  if (store.usage.window === w) return
  store.usage.window = w
  store.usage.data = null
  loadUsage()
}

/* ---------- dashboard and bot images ---------- */

// quiet: a failing background load must not toast every 5 minutes, the panel shows the last answer
export async function loadSystem() {
  try { store.system = await api.getSystem() } catch (e) { if (e instanceof SignedOut) expire() }
}

// pulls both images now instead of waiting for the server's 30-minute refresh
export async function checkSystem() {
  if (store.sys.busy || store.sys.restarting || paused()) return
  store.sys.busy = 'check'
  store.sys.error = ''
  try {
    const s = store.system = await api.checkSystem()
    const rows = [s.dashboard, s.collector, s.telegram].filter(r => r.deployed)
    const failed = rows.find(r => r.checkError)
    const n = rows.filter(r => r.imageUpdate).length
    toast(failed ? `Could not pull ${failed.name}: ${failed.checkError}` : n ? `${n} newer image${n > 1 ? 's' : ''} pulled, ready to install` : 'The dashboard and the bot run the newest images')
  } catch (e) { fail(e) } finally { store.sys.busy = null }
}

export function systemUpdate(which: 'dashboard' | 'telegram') {
  if (store.sys.busy || store.sys.restarting || paused() || guard('system-' + which, 'update')) return
  return runSystemUpdate(which)
}

async function runSystemUpdate(which: 'dashboard' | 'telegram') {
  const g = store.sys
  g.busy = which
  g.error = ''
  g.calls = []
  try {
    if (which === 'telegram') {
      const r = await api.updateTelegram()
      g.calls = r.calls
      toast(r.upToDate ? 'The bot already runs the newest image, restarted it' : 'Updated the bot to the newest image')
      await loadSystem()
      loadActivity()
      return
    }
    // the boot id from before, read fresh: comparing against an unloaded one would reload at once
    const before = (await api.getSystem()).bootId
    const r = await api.updateDashboard()
    g.calls = r.calls
    g.restarting = true
    await waitForRestart(before)
  } catch (e) {
    if (e instanceof StepUpRequired) askAgain('system-' + which, 'update')
    else {
      g.error = errText(e)
      g.calls = (e as { calls?: ApiCall[] }).calls ?? g.calls
      fail(e)
    }
  } finally {
    g.busy = null
  }
}

// The server answered, then restarts or is recreated about a second later: wait for another boot id, then load the new build. Errors in between are the server being down. 3 minutes covers compose recreating the container; the image is already pulled.
async function waitForRestart(before: string) {
  stopPolling()
  const until = Date.now() + 180_000
  while (Date.now() < until) {
    await sleep(2000)
    try {
      const s = await api.getSystem()
      if (s.bootId !== before) return freshReload()
      if (s.selfUpdateError) {
        store.sys.error = `The dashboard could not restart itself: ${s.selfUpdateError}`
        break
      }
    } catch (e) {
      if (e instanceof SignedOut) return freshReload()
    }
  }
  if (!store.sys.error) store.sys.error = 'The dashboard did not come back within 3 minutes. Check its stack and log in Portainer.'
  store.sys.restarting = false
  if (store.session) startPolling()
  loadActivity()
}

// the service worker would serve the old build's shell: let the new worker install and take over first, then reload
async function freshReload() {
  const reg = await navigator.serviceWorker?.getRegistration().catch(() => undefined)
  if (reg) {
    const took = new Promise(r => { navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }); setTimeout(r, 15_000) })
    await reg.update().catch(() => {})
    if (reg.installing || reg.waiting) await took
  }
  location.reload()
}

/* ---------- GitHub Actions ---------- */

// run ids running at the last load, per repo, shared by both loads so a finished run is told once
const ciRunning = new Map<string, Set<number>>()

function setCi(list: RepoActions[], all: boolean) {
  const ci: Record<string, RepoActions> = all ? {} : { ...store.ci }
  for (const a of list) if (a.deployedAs) ci[a.deployedAs] = a
  store.ci = ci
  const done = finishedRuns(ciRunning, list)
  if (done.length) toast(done.map(({ repo, run }) => `${run.workflow} ${runWord(run)} on ${repo.deployedAs ?? repo.repo}`).join(' · '))
}

// quiet: Bench works without it
export async function loadCi() {
  try { setCi(await api.getActions(true), true) } catch (e) { if (e instanceof SignedOut) expire() }
}

export async function loadActions() {
  try {
    const list = await api.getActions()
    store.actions = list
    store.actionsError = ''
    setCi(list, false)
  } catch (e) {
    if (e instanceof SignedOut) expire()
    else store.actionsError = `Could not load the runs: ${errText(e)}`
  }
}
