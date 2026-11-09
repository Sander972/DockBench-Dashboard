import type { BunRequest, Server } from 'bun'
import { join } from 'node:path'
import { env } from './env'
import { device, HttpError, json } from './http'
import { createSession, SESSION_TTL_SECONDS, verifySession } from './session'
import { verifyTotp } from './totp'
import { authorizeUrl, createDeployKey, deleteDeployKey, exchangeCode, findDeployKeys, fetchRepos, fetchUser, normalizeRepo, noreplyEmail, sameLogin } from './github'
import { appendEvent, LIMIT_RANGES, readAccount, readEvents, readSettings, writeAccount, writeSettings, type Account, type ActivityEvent, type ApiCall, type Settings } from './store'
import { createSessionRecord, enforceLimit, findAlive, listSessions, parseCookie, revoke, revokeAll, signCookie, touch, type SessionLimits } from './sessions'
import { createLive } from './live'
import { containerByName, containerLogs, containerPost, dockerInfo, execRun, imageInspect, inspectContainer, listDockbench, removeContainer, removeVolume, stackVolumes, systemDf, unlessGone } from './docker'
import { diskUsage } from './host'
import { createCollector, history as collectorHistory, WINDOWS, type Window } from './collector'
import { cpusetFor, createStack, deleteStack, findStack, fromStackFile, patchEnv, pullImage, putStack, readStack, redeployStack, STACK_FILE, stackEnv, TELEGRAM_STACK_FILE, vscodeEnv } from './portainer'
import { afterFailedCreate, deploy, DeployFailure, REPO_RE, validateDeploy } from './deploy'
import { deleteKeys, keyTitle, removeStack, stackKeys } from './remove'
import { generateDeployKey } from './sshkey'
import { deviceCode, fetchStatus, imageChecker, inspectCache, lastError, shared, statusTracker, ttlCache, updateAvailable } from './containers'
import { botName, dockerGid, fetchBotStatus, getMe, parseGid, setupCode, telegramEnv, TELEGRAM_IMAGE, TELEGRAM_NAME, validToken, type BotStatus } from './telegram'
import { BOOT_ID, COLLECTOR_NAME, DASHBOARD_NAME, imageRow } from './system'
import { runsCache, summarize } from './actions'
import { CONFIG_DIFF_MAX, configDiffCmd, configPullCmd, lastLine, loginCodeCmd, loginStartCmd, loginUrl, logoutCmd, parseConfigDiff } from './claude'
import { newChallenge, readPasskeys, takeChallenge, userHandle, verifyAssertion, verifyRegistration, writePasskeys, type Guarded, type StoredPasskey } from './passkey'

const secure = env.publicUrl.startsWith('https://')
const cookieOpts = { httpOnly: true, sameSite: 'lax' as const, secure, path: '/' }
// a page on a sibling subdomain (a proxied dev container) is same-site, not same-origin, and must not write. Browsers send Sec-Fetch-Site only to https or localhost, so plain-http LAN access and older Safari fall back to Origin, which browsers send on every POST.
const appOrigin = new URL(env.publicUrl).origin
const crossSite = (req: Request) => {
  if (req.method === 'GET') return false
  const site = req.headers.get('sec-fetch-site')
  return site ? site !== 'same-origin' : req.headers.get('origin') !== appOrigin
}
const portainer = { url: env.portainerUrl, apiKey: env.portainerApiKey, endpointId: env.portainerEndpointId }
const redirectUri = `${env.publicUrl}/api/auth/github/callback`
// GitHub passed, 2FA code still owed. Its own key, so a pending cookie never verifies as a session.
const pendingSecret = `${env.sessionSecret}:totp-pending`
const PENDING_TTL_SECONDS = 300
// ponytail: in-memory, so a restart clears the lockout and the replay guard; fine for one user behind GitHub OAuth
let lastTotpStep = -1
let totpFails = 0
let totpLockedUntil = 0

type Handler<T extends string> = (req: BunRequest<T>, server: Server<undefined>) => Response | Promise<Response>
// the record id from the session cookie, null when the cookie is missing or not signed by us
const sessionId = (req: Request) => parseCookie(env.sessionSecret, (req as BunRequest<string>).cookies.get('session'))
const limits = async (): Promise<SessionLimits> => { const s = await readSettings(env.dataDir); return { maxDevices: s.maxDevices, idleDays: s.idleDays } }
// a request that passes is this device's "last seen": the sliding idle expiry
const auth = <T extends string>(h: Handler<T>): Handler<T> => async (req, server) => {
  if (crossSite(req)) return json({ error: 'cross-site request' }, 403)
  const id = sessionId(req)
  if (!id || !(await findAlive(env.dataDir, id, await limits()))) return json({ error: 'unauthorized' }, 401)
  await touch(env.dataDir, id)
  return h(req, server)
}

// nginx proxy manager overwrites X-Real-IP with the peer address; a request that bypasses it can fake the header, which only mislabels the log and the device list. Cut to 45 chars (the longest IPv6 text) so a faked one cannot bloat them.
const clientIp = (req: Request, server: Server<undefined>) => req.headers.get('x-real-ip')?.slice(0, 45) || server.requestIP(req)?.address || ''
const who = (req: Request, server: Server<undefined>) => ({ device: device(req.headers.get('user-agent')), ip: clientIp(req, server) })
const log = (req: Request, server: Server<undefined>, what: string, target: string, extra: Partial<ActivityEvent> = {}) =>
  appendEvent(env.dataDir, { at: new Date().toISOString(), actor: env.githubLogin, what, target, ok: true, calls: [], ...who(req, server), ...extra })

async function requireAccount(): Promise<Account> {
  const a = await readAccount(env.dataDir)
  if (!a) throw new HttpError(401, 'no GitHub account stored, sign in again')
  return a
}

const errMsg = (e: unknown) => (e as Error).message

// 'ok', or why the code is refused. Shared by the 2FA sign-in step and adding the first passkey, so one lockout and one replay guard cover both.
function checkTotp(code: unknown): 'ok' | 'wrong' | 'locked' {
  if (Date.now() < totpLockedUntil) return 'locked'
  const step = verifyTotp(env.totpKey, code)
  if (step === null || step <= lastTotpStep) {
    if (++totpFails >= 5) {
      totpFails = 0
      totpLockedUntil = Date.now() + 15 * 60_000
    }
    return 'wrong'
  }
  lastTotpStep = step
  totpFails = 0
  return 'ok'
}

// A passkey check opens a 5-minute window for the guarded actions, held in its own signed cookie keyed by the session id, so a session cookie never passes for it and it dies with its device's session.
const stepUpSecret = (id: string) => `${env.sessionSecret}:step-up:${id}`
const STEP_UP_TTL_SECONDS = 300
const rp = { rpId: new URL(env.publicUrl).hostname, origin: appOrigin }

async function stepUpUntil(req: BunRequest<string>): Promise<number> {
  const id = sessionId(req)
  const c = req.cookies.get('step_up')
  return id && verifySession(stepUpSecret(id), c) ? Number(c!.split('.')[1]) : 0
}

function grantStepUp(req: BunRequest<string>, now: number, id: string): number {
  req.cookies.set('step_up', createSession(stepUpSecret(id), now, STEP_UP_TTL_SECONDS), { ...cookieOpts, maxAge: STEP_UP_TTL_SECONDS })
  return now + STEP_UP_TTL_SECONDS * 1000
}

// a new device record and its cookie; other devices stay signed in, the least recently seen one goes when the cap is reached
async function signIn(req: BunRequest<string>, server: Server<undefined>): Promise<string> {
  const r = await createSessionRecord(env.dataDir, who(req, server), await limits())
  req.cookies.set('session', signCookie(env.sessionSecret, r.id), { ...cookieOpts, maxAge: SESSION_TTL_SECONDS })
  return r.id
}

// only enforced once a passkey exists, since without one there is nothing to check with
async function requireStepUp(req: BunRequest<string>, action: Guarded) {
  const p = await readPasskeys(env.dataDir)
  if (p.creds.length && p.stepUp[action] && !(await stepUpUntil(req))) throw new HttpError(403, 'step_up_required')
}

// verifies a navigator.credentials.get() answer against the stored passkeys and saves the new counter
async function checkPasskey(body: unknown, purpose: 'login' | 'step-up'): Promise<StoredPasskey> {
  const cred = (body ?? {}) as { id?: unknown; response?: { clientDataJSON?: unknown } }
  const challenge = takeChallenge(cred.response?.clientDataJSON, purpose)
  const file = await readPasskeys(env.dataDir)
  const stored = file.creds.find((c) => c.id === cred.id)
  if (!stored) throw new Error('this passkey is not registered here')
  stored.signCount = verifyAssertion(cred, stored, { challenge, ...rp })
  stored.lastUsedAt = new Date().toISOString()
  await writePasskeys(env.dataDir, file)
  return stored
}

const assertionOptions = (purpose: 'login' | 'step-up', creds: StoredPasskey[]) => ({ challenge: newChallenge(purpose), rpId: rp.rpId, timeout: 60_000, userVerification: 'required', allowCredentials: creds.map((c) => ({ type: 'public-key', id: c.id })) })

// every container route takes ids from the URL, so it only ever acts on a container that carries the dockbench label
async function dockbench(id: string) {
  const r = (await listDockbench(env.dockerHost)).find((c) => c.id === id)
  if (!r) throw new HttpError(404, 'no dockbench container with that id')
  return r
}

// /system/df walks every container layer and volume (12-17 s of dockerd on the VPS for ~76 GB of /home/dev volumes), so it is far too slow to run on each poll, and the daemon refuses a second one while one runs. ponytail: disk sizes lag up to 15 min plus two df runs, read 0 until the first df answers, and keep the last good sizes while df fails.
const diskSizes = shared(15 * 60_000, () => systemDf(env.dockerHost), { rw: new Map<string, number>(), volumes: new Map<string, number>() })
// the live tick's inspect per container, and Docker's /info (name, cores, RAM, version), reused between ticks instead of asked every 2 s
const inspects = inspectCache((id) => inspectContainer(env.dockerHost, id))
const info = ttlCache(5 * 60_000, () => dockerInfo(env.dockerHost))
// for routes.test.ts only: the module-level /info cache would otherwise carry one test's answer into the next for 5 minutes
export const testHooks = { resetInfo: () => info.reset() }
// host, container and process usage from the collector container; one /metrics answer per live interval serves both views of a tick
const collector = createCollector(env.collectorUrl, 2000)
const statusView = statusTracker((name) => fetchStatus(`http://${name}:8080/status`))
const botStatusUrl = `http://${TELEGRAM_NAME}:8080/status`
// ghcr.io refuses the GitHub OAuth token, so a digest lookup cannot authenticate; pulling through Portainer uses the PAT stored under its Registries, then the tag's local image id is the answer. ponytail: the 30-minute refresh downloads a new image in the background, a registry-side digest lookup if disk or bandwidth matter.
const images = imageChecker(async (ref) => {
  await pullImage(portainer, ref)
  return (await imageInspect(env.dockerHost, ref)).id
})
// GitHub Actions runs per repo (30 s, ETag) and the account's repo list (5 min) for /api/actions
const actionRuns = runsCache()
let repoList: { at: number; token: string; rows: Awaited<ReturnType<typeof fetchRepos>> } | null = null
async function listRepos(token: string) {
  if (!repoList || repoList.token !== token || Date.now() - repoList.at > 300_000) repoList = { at: Date.now(), token, rows: await fetchRepos(token, false) }
  return repoList.rows
}

// time of the last successful fetch or pull per container name, seeded from the activity log once, so the 2 s live tick does not reread the whole log for it
let lastFetch: Map<string, string> | null = null
async function lastFetches(): Promise<Map<string, string>> {
  if (!lastFetch) {
    const m = new Map<string, string>()
    for (const e of (await readEvents(env.dataDir)).reverse()) if (e.ok && (e.what === 'Fetched' || e.what === 'Pulled')) m.set(e.target, e.at)
    lastFetch = m
  }
  return lastFetch
}

// action in progress per container id, so every tab sees "Stopping…" and a second action is refused
const pending = new Map<string, 'start' | 'stop' | 'restart' | 'update' | 'config' | 'vscode' | 'claudeConfig' | 'remove'>()
// container names with a deploy in flight (/api/deploy, /api/telegram/deploy)
const deploying = new Set<string>()

// runs `run` while `pending` holds the container; no await between the check and the set, or two requests both pass
async function withPending(id: string, name: string, kind: NonNullable<ReturnType<typeof pending.get>>, run: () => Promise<Response>): Promise<Response> {
  if (pending.has(id)) return json({ error: `${name} is busy: ${pending.get(id)} in progress` }, 409)
  pending.set(id, kind)
  try {
    return await run()
  } finally {
    pending.delete(id)
  }
}

// the call trace of a multi-step action: each step is listed before it runs and gets its status once it succeeds, so a failure shows which call broke
function tracer() {
  const calls: ApiCall[] = []
  const step = async <T>(method: string, path: string, okStatus: number, run: () => Promise<T>): Promise<T> => {
    const call: ApiCall = { method, path, status: null }
    calls.push(call)
    const out = await run()
    call.status = okStatus
    return out
  }
  return { calls, step }
}

// compose replaced the container under the same name; wait up to 10 s for the new one
async function replacement(name: string, oldId: string) {
  for (let i = 0; i < 20; i++) {
    const n = await containerByName(env.dockerHost, name)
    if (n && n.id !== oldId) return n
    await Bun.sleep(500)
  }
  return null
}

// the file the image seeds and Replace overwrites; entrypoint.sh pins it with --server-data-dir
const MACHINE_SETTINGS = '/home/dev/.vscode-server/data/Machine/settings.json'
// edits made in the container are not held to the 20,000-character cap of Settings
const VSCODE_READ_MAX = 200_000
// rides base64 in the stack env (vscodeEnv), so it stays far below the 128 KiB one env var may hold; VS_MAX in src/views/SettingsView.vue mirrors it
const MAX_VSCODE_SETTINGS = 20_000

// Applies a newer image: pull it through Portainer, then redeploy the container's Portainer stack, which recreates the container on the new image and keeps its volumes. The container id changes, so the answer carries the new one. Shared by the dev containers and the Telegram bot; the caller holds `pending` and the step-up check.
async function updateViaStack(req: BunRequest<string>, server: Server<undefined>, c: { id: string; name: string }): Promise<Response> {
  const { calls, step } = tracer()
  const started = Date.now()
  const id = c.id
  try {
    const x = await step('GET', `/containers/${id.slice(0, 12)}/json`, 200, () => inspectContainer(env.dockerHost, id))
    await step('POST', '/images/create', 200, () => pullImage(portainer, x.image))
    const pulled = await step('GET', `/images/${x.image}/json`, 200, () => imageInspect(env.dockerHost, x.image))
    images.check(x.image).catch(() => {})
    if (pulled.id === x.imageId) {
      // nothing to recreate: restart it in place, which also starts a stopped container
      await step('POST', `/containers/${id.slice(0, 12)}/restart`, 204, () => containerPost(env.dockerHost, id, 'restart'))
      await log(req, server, 'Updated', c.name, { note: 'already on the newest image, restarted', calls, ms: Date.now() - started })
      return json({ id, name: c.name, calls, upToDate: true })
    }
    const stack = await step('GET', '/api/stacks', 200, () => findStack(portainer, x.project ?? c.name))
    if (!stack) throw new HttpError(409, `${c.name} is not a Portainer stack, so the dashboard cannot recreate it. Recreate it from wherever it was started.`)
    await step('PUT', `/api/stacks/${stack.Id}`, 200, () => redeployStack(portainer, stack.Id))
    const next = await step('GET', '/containers/json', 200, () => replacement(c.name, id))
    await log(req, server, 'Updated', c.name, { calls, ms: Date.now() - started })
    return json({ id: next?.id ?? '', name: c.name, calls, upToDate: false })
  } catch (e) {
    await log(req, server, 'Update failed', c.name, { ok: false, note: errMsg(e), calls, ms: Date.now() - started })
    return json({ error: errMsg(e), calls }, e instanceof HttpError ? e.status : 502)
  }
}

// set when the self-update's restart or redeploy failed after the answer went out, so the page waiting for the new server can stop and say why
let selfUpdateError: string | null = null

// the Updates panel: the dashboard's own container, its collector and the bot. check pulls their images first (through Portainer, like the dev containers), otherwise the last known answer is used and refreshed in the background.
async function systemView(check: boolean) {
  const [dashboard, telegram, collector] = await Promise.all([DASHBOARD_NAME, TELEGRAM_NAME, COLLECTOR_NAME].map(async (name) => {
    const c = await containerByName(env.dockerHost, name)
    // a container removed between the lookup and the inspect (the panel's own recreate) reads as not deployed for this answer
    const x = c ? await unlessGone(inspectContainer(env.dockerHost, c.id)) : null
    const k = !x ? null : check && !x.image.includes('@') ? await images.check(x.image) : images.peek(x.image)
    return imageRow(name, c, x, k)
  }))
  return { bootId: BOOT_ID, dashboard, telegram, collector, selfUpdateError }
}

const PAST = { start: 'Started', stop: 'Stopped', restart: 'Restarted' } as const
const VERB = { start: 'Start', stop: 'Stop', restart: 'Restart' } as const

// start, stop, restart. Stop and restart wait for the container to exit (Docker gives it 10 s), so the idle timeout is lifted like on deploy.
function containerAction(a: 'start' | 'stop' | 'restart') {
  return auth(async (req: BunRequest<'/api/containers/:id/start'>, server) => {
    server.timeout(req, 0)
    if (a !== 'start') await requireStepUp(req, a)
    const id = req.params.id
    const c = await dockbench(id)
    return withPending(id, c.name, a, async () => {
      const call: ApiCall = { method: 'POST', path: `/containers/${id.slice(0, 12)}/${a}`, status: null }
      const started = Date.now()
      try {
        call.status = await containerPost(env.dockerHost, id, a)
        inspects.forget(id) // a restart keeps the state running: the next tick must see the new start time
        await log(req, server, PAST[a], c.name, { calls: [call], ms: Date.now() - started })
        return json({})
      } catch (e) {
        await log(req, server, `${VERB[a]} failed`, c.name, { ok: false, note: errMsg(e), calls: [call], ms: Date.now() - started })
        return json({ error: errMsg(e), calls: [call] }, 502)
      }
    })
  })
}

// name of the dockbench container cloned from each repo, keyed by lowercase owner/name
async function deployedRepos(): Promise<Map<string, string>> {
  const rows = await listDockbench(env.dockerHost)
  const inspected = await Promise.all(rows.map((r) => unlessGone(inspectContainer(env.dockerHost, r.id))))
  const map = new Map<string, string>()
  rows.forEach((r, i) => {
    const repo = normalizeRepo(inspected[i]?.repoUrl ?? null)
    if (repo) map.set(repo, r.name)
  })
  return map
}

// HostUsage in src/types.ts. reachable false when the socket does not answer; usage figures come from the collector and read 0 with collector false when it does not answer; disk is 0 where statfs is missing (dev on Windows)
async function hostView() {
  const polledAt = new Date().toISOString()
  const [snap, docker] = await Promise.all([
    collector.latest(),
    Promise.all([info(), diskUsage(env.dataDir).catch(() => ({ diskTotal: 0, diskUsed: 0 }))]).catch(() => null),
  ])
  const h = snap?.host
  const usage = { cpuPct: h?.cpuPct ?? 0, memUsed: h?.memUsed ?? 0, stealPct: h?.stealPct ?? 0, load1: h?.load1 ?? 0, psiCpuSome10: h?.psiCpuSome10 ?? 0, collector: !!snap }
  if (!docker) return { name: '', ncpu: 0, memTotal: 0, diskTotal: 0, dockerVersion: '', diskUsed: 0, ...usage, polledAt, reachable: false }
  return { ...docker[0], ...docker[1], ...usage, polledAt, reachable: true }
}

// DevContainer in src/types.ts. /status is waited on for up to 2 s per container; usage comes from the collector by id (0 for a container it has not sampled yet or when it does not answer), disk sizes and registry digests from caches, so none of them holds a poll up.
async function containersView() {
  const [rows, snap] = await Promise.all([listDockbench(env.dockerHost), collector.latest()])
  const df = diskSizes()
  const fetched = await lastFetches()
  inspects.keep(rows.map((r) => r.id))
  const views = await Promise.all(rows.map(async (r) => {
    const x = await unlessGone(inspects.get(r.id, r.state))
    if (!x) return null
    const running = r.state === 'running'
    const s = running ? snap?.containers.find((c) => c.id === r.id) : undefined
    const sv = await statusView(r.id, r.name, x.startedAt, running)
    // the log is read only while it says something /status cannot: a device code before the first answer or while the tunnel waits for approval, the fatal line of a restart loop
    const needLog = r.state === 'restarting' || (running && (sv.statusError === 'starting' || sv.status?.tunnel === 'waiting_for_login'))
    const log = needLog ? await containerLogs(env.dockerHost, r.id, 100).catch(() => []) : []
    // a stopped container triggers no image pull; it is checked again once started
    const check = r.state === 'exited' ? null : images.peek(x.image)
    return {
      id: r.id, name: r.name, repo: x.repoUrl, state: r.state,
      startedAt: x.startedAt, finishedAt: x.finishedAt, exitCode: x.exitCode, restartCount: x.restartCount,
      // no memory limit in the stack, so HostConfig.Memory is 0; the collector's limit is then the host's RAM, which keeps the RAM meter meaningful
      cpuPct: s?.cpuPct ?? 0, memUsed: s?.memUsed ?? 0, memLimit: x.memLimit || s?.memLimit || 0,
      diskRw: df.rw.get(r.id) ?? 0, diskVolume: x.homeVolume ? df.volumes.get(x.homeVolume) ?? 0 : 0,
      ...sv,
      lastFetchAt: fetched.get(r.name) ?? null,
      pending: pending.get(r.id) ?? null,
      deviceCode: deviceCode(log),
      lastError: lastError(log),
      image: x.image,
      imageUpdate: updateAvailable(x.image, check?.imageId ?? null, x.imageId),
      imageCheckedAt: check ? new Date(check.at).toISOString() : null,
      config: x.config,
    }
  }))
  return views.filter((v) => v !== null)
}

// the SSE feed: hostView never throws, containersView throws when Docker is down, which the feed reports as a `down` event
const live = createLive(async () => { const [host, containers] = await Promise.all([hostView(), containersView()]); return { host, containers } }, {
  // an open feed counts as use of the device (touch), and a revoked or idle device is cut on the next tick
  sessionAlive: async (id) => { const ok = !!(await findAlive(env.dataDir, id, await limits())); if (ok) await touch(env.dataDir, id); return ok },
})

export const routes = {
  '/api/auth/github/start': (req: BunRequest<'/api/auth/github/start'>) => {
    const state = crypto.randomUUID()
    req.cookies.set('oauth_state', state, { ...cookieOpts, maxAge: 600 })
    return Response.redirect(authorizeUrl(env.githubClientId, redirectUri, state))
  },

  '/api/auth/github/callback': async (req: BunRequest<'/api/auth/github/callback'>, server: Server<undefined>) => {
    const url = new URL(req.url)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (!state || state !== req.cookies.get('oauth_state')) return json({ error: 'invalid oauth state' }, 400)
    req.cookies.delete('oauth_state')
    // no code with a valid state: the user cancelled on GitHub's consent screen (error=access_denied)
    if (!code) {
      await log(req, server, 'Sign-in failed', 'github', { ok: false, note: url.searchParams.get('error') ?? 'no code' })
      return Response.redirect('/sign-in?error=oauth')
    }
    let token: string
    let user: Awaited<ReturnType<typeof fetchUser>>
    try {
      token = await exchangeCode(env.githubClientId, env.githubClientSecret, code, redirectUri)
      user = await fetchUser(token)
    } catch (e) {
      await log(req, server, 'Sign-in failed', 'github', { ok: false, note: (e as Error).message })
      return Response.redirect('/sign-in?error=oauth')
    }
    if (!sameLogin(user.login, env.githubLogin)) {
      await log(req, server, 'Sign-in failed', user.login, { ok: false, note: 'not the allowed account' })
      return Response.redirect(`/sign-in?error=denied&login=${encodeURIComponent(user.login)}`)
    }
    await writeAccount(env.dataDir, { ...user, token })
    req.cookies.set('totp_pending', createSession(pendingSecret, Date.now(), PENDING_TTL_SECONDS), { ...cookieOpts, maxAge: PENDING_TTL_SECONDS })
    return Response.redirect('/sign-in?step=totp')
  },

  '/api/auth/totp': {
    POST: async (req: BunRequest<'/api/auth/totp'>, server: Server<undefined>) => {
      if (crossSite(req)) return json({ error: 'cross-site request' }, 403)
      if (!verifySession(pendingSecret, req.cookies.get('totp_pending'))) return json({ error: 'sign in with GitHub first' }, 401)
      if (Date.now() < totpLockedUntil) return json({ error: 'too many wrong codes, try again later' }, 429)
      const body = (await req.json().catch(() => null)) as { code?: unknown } | null
      if (checkTotp(body?.code) !== 'ok') {
        await log(req, server, 'Sign-in failed', env.githubLogin, { ok: false, note: 'wrong 2FA code' })
        return json({ error: 'wrong code' }, 400)
      }
      req.cookies.delete('totp_pending')
      await signIn(req, server)
      await log(req, server, 'Signed in', env.githubLogin)
      return json({})
    },
  },

  // Passkey sign-in, in place of GitHub plus the 2FA code. Not behind auth, like /api/auth/totp. Only discoverable passkeys, so the options name no credential ids to an unauthenticated caller.
  '/api/auth/passkey/options': {
    POST: async (req: BunRequest<'/api/auth/passkey/options'>) => {
      if (crossSite(req)) return json({ error: 'cross-site request' }, 403)
      if (!(await readPasskeys(env.dataDir)).creds.length) return json({ error: 'No passkey is registered yet. Sign in with GitHub, then add one in Settings.' }, 400)
      return json(assertionOptions('login', []))
    },
  },

  '/api/auth/passkey/verify': {
    POST: async (req: BunRequest<'/api/auth/passkey/verify'>, server: Server<undefined>) => {
      if (crossSite(req)) return json({ error: 'cross-site request' }, 403)
      await requireAccount()
      try {
        await checkPasskey(await req.json().catch(() => null), 'login')
      } catch (e) {
        await log(req, server, 'Sign-in failed', 'passkey', { ok: false, note: errMsg(e) })
        return json({ error: errMsg(e) }, 400)
      }
      const id = await signIn(req, server)
      // the sign-in itself was a passkey check, so the guarded actions do not ask again right away
      grantStepUp(req, Date.now(), id)
      await log(req, server, 'Signed in', env.githubLogin, { note: 'passkey' })
      return json({})
    },
  },

  '/api/auth/step-up/options': {
    POST: auth(async () => {
      const { creds } = await readPasskeys(env.dataDir)
      if (!creds.length) return json({ error: 'No passkey is registered. Add one in Settings.' }, 400)
      return json(assertionOptions('step-up', creds))
    }),
  },

  '/api/auth/step-up/verify': {
    POST: auth(async (req: BunRequest<'/api/auth/step-up/verify'>) => {
      try {
        await checkPasskey(await req.json().catch(() => null), 'step-up')
      } catch (e) {
        return json({ error: errMsg(e) }, 400)
      }
      return json({ stepUpUntil: grantStepUp(req, Date.now(), sessionId(req)!) })
    }),
  },

  // body { all: true } signs every device out ("Sign out everywhere" in Settings); the default signs this device out only
  '/api/auth/logout': {
    POST: auth(async (req: BunRequest<'/api/auth/logout'>, server) => {
      const body = ((await req.json().catch(() => null)) ?? {}) as { all?: unknown }
      if (body.all === true) await revokeAll(env.dataDir)
      else await revoke(env.dataDir, sessionId(req)!)
      req.cookies.delete('session')
      req.cookies.delete('step_up')
      await log(req, server, body.all === true ? 'Signed out everywhere' : 'Signed out', env.githubLogin)
      return json({})
    }),
  },

  // Session in src/types.ts
  '/api/session': auth(async (req: BunRequest<'/api/session'>) => {
    const a = await requireAccount()
    const p = await readPasskeys(env.dataDir)
    const { claudeConfigRepo, vscodeSettings, maxDevices, idleDays } = await readSettings(env.dataDir)
    return json({ user: env.githubLogin, email: noreplyEmail(a), stepUpUntil: (await stepUpUntil(req)) || null, passkeys: p.creds.length, stepUp: p.stepUp, claudeConfigRepo, vscodeSettings, maxDevices, idleDays })
  }),

  // PasskeyInfo[] in src/types.ts; the public keys stay on the server
  '/api/passkeys': {
    GET: auth(async () => json((await readPasskeys(env.dataDir)).creds.map(({ id, name, createdAt, lastUsedAt }) => ({ id, name, createdAt, lastUsedAt })))),
    // body { name, credential }: the navigator.credentials.create() answer to the options below
    POST: auth(async (req: BunRequest<'/api/passkeys'>, server) => {
      const body = (await req.json().catch(() => null)) as { name?: unknown; credential?: { response?: { clientDataJSON?: unknown; attestationObject?: unknown } } } | null
      let reg: ReturnType<typeof verifyRegistration>
      try {
        const challenge = takeChallenge(body?.credential?.response?.clientDataJSON, 'register')
        reg = verifyRegistration(body!.credential!, { challenge, ...rp })
      } catch (e) {
        return json({ error: errMsg(e) }, 400)
      }
      const file = await readPasskeys(env.dataDir)
      if (file.creds.some((c) => c.id === reg.id)) return json({ error: 'This passkey is already registered.' }, 409)
      const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 40) : 'Passkey'
      file.creds.push({ ...reg, name, createdAt: new Date().toISOString(), lastUsedAt: null })
      await writePasskeys(env.dataDir, file)
      await log(req, server, 'Passkey added', name)
      return json({}, 201)
    }),
  },

  // A passkey outlives sessions and logouts, so adding one takes more than the session cookie: a passkey check when one already exists, otherwise the current authenticator code (body { code }).
  '/api/passkeys/options': {
    POST: auth(async (req: BunRequest<'/api/passkeys/options'>) => {
      const { creds } = await readPasskeys(env.dataDir)
      if (creds.length) {
        if (!(await stepUpUntil(req))) throw new HttpError(403, 'step_up_required')
      } else {
        const r = checkTotp(((await req.json().catch(() => null)) as { code?: unknown } | null)?.code)
        if (r === 'locked') return json({ error: 'Too many wrong codes. Wait 15 minutes, then try again.' }, 429)
        if (r === 'wrong') return json({ error: 'That code is wrong or was already used. Enter the current one from your authenticator app.' }, 400)
      }
      return json({
        challenge: newChallenge('register'),
        rp: { id: rp.rpId, name: 'DockBench' },
        user: { id: userHandle(env.githubLogin), name: env.githubLogin, displayName: env.githubLogin },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        timeout: 60_000,
        attestation: 'none',
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        excludeCredentials: creds.map((c) => ({ type: 'public-key', id: c.id })),
      })
    }),
  },

  '/api/passkeys/:id': {
    DELETE: auth(async (req: BunRequest<'/api/passkeys/:id'>, server) => {
      if (!(await stepUpUntil(req))) throw new HttpError(403, 'step_up_required')
      const file = await readPasskeys(env.dataDir)
      const gone = file.creds.find((c) => c.id === req.params.id)
      if (!gone) return json({ error: 'no passkey with that id' }, 404)
      file.creds = file.creds.filter((c) => c !== gone)
      await writePasskeys(env.dataDir, file)
      await log(req, server, 'Passkey removed', gone.name)
      return json({})
    }),
  },

  // StepUpPrefs in src/types.ts: which actions ask for a passkey. Turning a guard off needs a passkey check itself, or a stolen session could switch them all off.
  '/api/settings/step-up': {
    POST: auth(async (req: BunRequest<'/api/settings/step-up'>) => {
      const body = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>
      const file = await readPasskeys(env.dataDir)
      const next = { ...file.stepUp }
      for (const k of Object.keys(next) as Guarded[]) if (typeof body[k] === 'boolean') next[k] = body[k] as boolean
      const loosens = (Object.keys(next) as Guarded[]).some((k) => file.stepUp[k] && !next[k])
      if (loosens && file.creds.length && !(await stepUpUntil(req))) throw new HttpError(403, 'step_up_required')
      file.stepUp = next
      await writePasskeys(env.dataDir, file)
      return json(next)
    }),
  },

  // body { claudeConfigRepo }: owner/name, or '' to stop injecting. Only new deploys read it; running containers keep the repo their stack was made with.
  '/api/settings/claude': {
    POST: auth(async (req: BunRequest<'/api/settings/claude'>, server) => {
      const body = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>
      const repo = typeof body.claudeConfigRepo === 'string' ? body.claudeConfigRepo.trim() : ''
      if (repo && !REPO_RE.test(repo)) return json({ error: 'claudeConfigRepo must be owner/name' }, 400)
      await writeSettings(env.dataDir, { claudeConfigRepo: repo })
      await log(req, server, 'Claude config repo set', repo || 'none')
      return json({ claudeConfigRepo: repo })
    }),
  },

  // body { vscodeSettings }: settings.json text (comments allowed), '' for the image's own. Read by new deploys and by Replace on a container, never pushed to running ones.
  '/api/settings/vscode': {
    POST: auth(async (req: BunRequest<'/api/settings/vscode'>, server) => {
      const body = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>
      const text = typeof body.vscodeSettings === 'string' ? body.vscodeSettings.trim() : ''
      if (text.length > MAX_VSCODE_SETTINGS) return json({ error: `vscodeSettings must be at most ${MAX_VSCODE_SETTINGS} characters` }, 400)
      await writeSettings(env.dataDir, { vscodeSettings: text })
      await log(req, server, 'VS Code settings set', text ? `${text.length} characters` : 'image default')
      return json({ vscodeSettings: text })
    }),
  },

  // body { maxDevices, idleDays }: integers in LIMIT_RANGES. Lowering the cap signs the least recently seen devices out at once, never the caller.
  '/api/settings/sessions': {
    POST: auth(async (req: BunRequest<'/api/settings/sessions'>, server) => {
      const body = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>
      const next = {} as Pick<Settings, 'maxDevices' | 'idleDays'>
      for (const k of ['maxDevices', 'idleDays'] as const) {
        const [min, max] = LIMIT_RANGES[k]
        const v = body[k]
        if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) return json({ error: `${k} must be a whole number from ${min} to ${max}` }, 400)
        next[k] = v
      }
      await writeSettings(env.dataDir, next)
      await enforceLimit(env.dataDir, next, sessionId(req)!)
      await log(req, server, 'Device limits set', `${next.maxDevices} devices, ${next.idleDays} idle days`)
      return json(next)
    }),
  },

  // DeviceSession in src/types.ts: every signed-in device, newest activity first, the caller flagged
  '/api/sessions': auth(async (req: BunRequest<'/api/sessions'>) => {
    const me = sessionId(req)
    return json((await listSessions(env.dataDir, await limits())).map((r) => ({ ...r, current: r.id === me })))
  }),

  // signs one device out; the caller may sign itself out here too (its next request answers 401). No step-up: it only tightens access.
  '/api/sessions/:id': {
    DELETE: auth(async (req: BunRequest<'/api/sessions/:id'>, server) => {
      const gone = (await listSessions(env.dataDir, await limits())).find((r) => r.id === req.params.id)
      if (!gone || !(await revoke(env.dataDir, gone.id))) return json({ error: 'no device with that id' }, 404)
      await log(req, server, 'Device signed out', gone.device, { note: gone.ip })
      return json({})
    }),
  },

  '/api/github/repos': auth(async () => {
    const [repos, deployed] = await Promise.all([fetchRepos((await requireAccount()).token), deployedRepos()])
    return json(repos.map((r) => ({ ...r, deployedAs: deployed.get(r.fullName.toLowerCase()) ?? null })))
  }),

  '/api/host': auth(async () => json(await hostView())),
  '/api/containers': auth(async () => json(await containersView())),
  // Utilization in src/types.ts: the collector's history over a window plus its latest snapshot, with every container id resolved to a name and the dockbench flag. top=0 leaves the per-process lists out (the Bench graphs). Gzipped when the browser accepts it: a day of points with process lists is about 2 MB of JSON, refetched every 10 s while a graph shows.
  '/api/utilization': auth(async (req) => {
    const q = new URL(req.url).searchParams
    const w = q.get('window') ?? '1h'
    if (!Object.hasOwn(WINDOWS, w)) throw new HttpError(400, 'window must be 1h, 6h or 24h')
    const [h, snap] = await Promise.all([env.collectorUrl ? collectorHistory(env.collectorUrl, w as Window, Date.now(), q.get('top') !== '0').catch(() => null) : null, collector.latest()])
    if (!h || !snap) return json({ error: 'collector unreachable' }, 503)
    const names: Record<string, { name: string; dockbench: boolean }> = {}
    for (const p of h.points) for (const [id, c] of Object.entries(p.containers)) names[id] = { name: c.name, dockbench: false }
    for (const c of snap.containers) names[c.id] = { name: c.name, dockbench: c.dockbench }
    const body = JSON.stringify({ window: w, stepMs: h.stepMs, at: snap.at, points: h.points, containers: snap.containers, processes: snap.processes, names })
    if (!/\bgzip\b/.test(req.headers.get('accept-encoding') ?? '')) return new Response(body, { headers: { 'content-type': 'application/json', vary: 'accept-encoding' } })
    return new Response(Bun.gzipSync(body), { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', vary: 'accept-encoding' } })
  }),
  // Server-Sent Events: `snapshot` {host, containers} every 2 s, `down` {error} while Docker does not answer, `signed-out` {} then close when the session is gone. Cached nowhere (no-store, X-Accel-Buffering: no for nginx).
  '/api/live': auth(async (req: BunRequest<'/api/live'>, server) => { server.timeout(req, 0); return live.handle(sessionId(req)!) }),

  '/api/containers/:id/logs': auth(async (req: BunRequest<'/api/containers/:id/logs'>) => {
    const c = await dockbench(req.params.id)
    const tail = Math.min(1000, Math.max(1, Number(new URL(req.url).searchParams.get('tail')) || 100))
    return json(await containerLogs(env.dockerHost, c.id, tail))
  }),

  '/api/containers/:id/start': { POST: containerAction('start') },
  '/api/containers/:id/stop': { POST: containerAction('stop') },
  '/api/containers/:id/restart': { POST: containerAction('restart') },

  '/api/containers/:id/update': {
    POST: auth(async (req: BunRequest<'/api/containers/:id/update'>, server) => {
      server.timeout(req, 0)
      await requireStepUp(req, 'update')
      const id = req.params.id
      const c = await dockbench(id)
      return withPending(id, c.name, 'update', () => updateViaStack(req, server, c))
    }),
  },

  // RemoveResult in src/types.ts: deletes the container's Portainer stack, then the container if compose left it, the stack's volumes (/home/dev, the workspace with any unpushed work) and its deploy keys on GitHub. Cannot be undone, so it has its own `remove` step-up. Once the stack is gone a later failure only warns, in the answer and the log note.
  '/api/containers/:id/remove': {
    POST: auth(async (req: BunRequest<'/api/containers/:id/remove'>, server) => {
      server.timeout(req, 0)
      await requireStepUp(req, 'remove')
      const id = req.params.id
      const c = await dockbench(id)
      const a = await requireAccount()
      return withPending(id, c.name, 'remove', async () => {
        const { calls, step } = tracer()
        const started = Date.now()
        try {
          const x = await step('GET', `/containers/${id.slice(0, 12)}/json`, 200, () => inspectContainer(env.dockerHost, id))
          const stack = await step('GET', '/api/stacks', 200, () => findStack(portainer, x.project ?? c.name))
          if (!stack) throw new HttpError(409, `${c.name} is not a Portainer stack, so the dashboard cannot remove it. Remove it wherever it was started.`)
          const s = await step('GET', `/api/stacks/${stack.Id}`, 200, () => readStack(portainer, stack.Id))
          const title = keyTitle(s.env, c.name)
          const { warnings, volumes, keys } = await removeStack({ stackId: stack.Id, containerId: id, homeVolume: x.homeVolume, title, keys: stackKeys(s.env) }, {
            deleteStack: () => deleteStack(portainer, stack.Id),
            removeContainer: () => removeContainer(env.dockerHost, id),
            listVolumes: () => stackVolumes(env.dockerHost, stack.Name),
            removeVolume: (name) => removeVolume(env.dockerHost, name),
            findKeys: (repo, readOnly) => findDeployKeys(a.token, repo, title, readOnly),
            deleteKey: (repo, keyId) => deleteDeployKey(a.token, repo, keyId),
          }, step)
          const warning = warnings.join(' ') || undefined
          await log(req, server, 'Removed', c.name, { calls, ms: Date.now() - started, ...(warning && { note: warning }) })
          return json({ volumes, keys, ...(warning && { warning }) })
        } catch (e) {
          await log(req, server, 'Remove failed', c.name, { ok: false, note: errMsg(e), calls, ms: Date.now() - started })
          return json({ error: errMsg(e), calls }, e instanceof HttpError ? e.status : 502)
        }
      })
    }),
  },

  // UpdateResult in src/types.ts, plus `warning` when the old config key could not be removed. Body { installClaude, injectClaudeConfig, vscodeConfig }, strict booleans: rewrites the container's stack variables and recreates it from the current STACK_FILE (home volume kept) on the image its tag points to here, so a newer image the 30-minute check already pulled comes along. Turning the Claude config on adds a read-only deploy key on the config repo from Settings; turning it off removes it. Turning VS Code settings on takes the current global ones, written by the container only on a home volume without Machine settings; they stay as they are while that option does not change. The re-PUT also sets CPUSET from the host's core count, so a stack from before the CPU reserve is recreated on it even when no option changed. The same options on the same image answer 409, since compose would recreate nothing.
  '/api/containers/:id/config': {
    POST: auth(async (req: BunRequest<'/api/containers/:id/config'>, server) => {
      server.timeout(req, 0)
      await requireStepUp(req, 'update')
      const b = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>
      if (![b.installClaude, b.injectClaudeConfig, b.vscodeConfig].every((x) => typeof x === 'boolean')) return json({ error: 'installClaude, injectClaudeConfig and vscodeConfig must be booleans' }, 400)
      const id = req.params.id
      const c = await dockbench(id)
      const a = await requireAccount()
      const settings = await readSettings(env.dataDir)
      return withPending(id, c.name, 'config', async () => {
        const { calls, step } = tracer()
        const started = Date.now()
        let note = `Claude ${b.installClaude ? 'on' : 'off'}, config ${b.injectClaudeConfig ? 'on' : 'off'}, VS Code ${b.vscodeConfig ? 'on' : 'off'}`
        let warning: string | undefined
        let added: { repo: string; id: number; stackId: number; key: string } | null = null
        try {
          const x = await step('GET', `/containers/${id.slice(0, 12)}/json`, 200, () => inspectContainer(env.dockerHost, id))
          const stack = await step('GET', '/api/stacks', 200, () => findStack(portainer, x.project ?? c.name))
          if (!stack) throw new HttpError(409, `${c.name} is not a Portainer stack, so the dashboard cannot change it. Change it wherever it was started.`)
          const s = await step('GET', `/api/stacks/${stack.Id}`, 200, () => readStack(portainer, stack.Id))
          const cur = new Map(s.env.map((e) => [e.name, e.value]))
          if (!fromStackFile(s.env)) throw new HttpError(409, `${c.name} was not deployed from the current dashboard. Change its variables in Portainer.`)
          // compose recreates it on whatever image its tag points to here, so say so when that is not the one it runs
          const tagged = await imageInspect(env.dockerHost, x.image).catch(() => null)
          if (tagged && tagged.id !== x.imageId) note += ', newer image'
          const title = keyTitle(s.env, c.name)
          // on/off as Inspect.config reads it (any value is on); the repo itself only for removing its key
          const oldValue = cur.get('CLAUDE_CONFIG_REPO') ?? ''
          const oldRepo = normalizeRepo(oldValue)
          const patch = [{ name: 'INSTALL_CLAUDE', value: b.installClaude ? '1' : '0' }]
          // an unknown core count keeps the stack's CPUSET, so a failed /info neither unpins the container nor recreates it
          const ncpu = (await info().catch(() => null))?.ncpu
          if (ncpu) patch.push({ name: 'CPUSET', value: cpusetFor(ncpu) })
          // the settings the stack carries change only with its VS Code option, so toggling another option keeps them
          if (b.vscodeConfig !== (cur.get('VSCODE_CONFIG') !== '0')) patch.push(...vscodeEnv(b.vscodeConfig as boolean, settings.vscodeSettings))
          if (b.injectClaudeConfig && !oldValue) {
            const repo = settings.claudeConfigRepo
            if (!repo) throw new HttpError(400, 'Set the Claude config repo in Settings first')
            const key = generateDeployKey()
            added = { repo, stackId: stack.Id, key: key.privateKeyBase64, ...(await step('POST', `/repos/${repo}/keys`, 201, () => createDeployKey(a.token, repo, title, key.publicKey, true))) }
            patch.push({ name: 'CLAUDE_CONFIG_REPO', value: `git@github.com:${repo}.git` }, { name: 'CLAUDE_CONFIG_KEY', value: key.privateKeyBase64 })
          } else if (!b.injectClaudeConfig && oldValue) {
            patch.push({ name: 'CLAUDE_CONFIG_REPO', value: '' }, { name: 'CLAUDE_CONFIG_KEY', value: '' })
          }
          const nextEnv = patchEnv(s.env, patch)
          // compose recreates nothing for the same env on the same image, and the wait for a new container would only time out
          if (tagged?.id === x.imageId && JSON.stringify(nextEnv) === JSON.stringify(s.env)) throw new HttpError(409, `${c.name} already runs with these options.`)
          await step('PUT', `/api/stacks/${stack.Id}`, 200, () => putStack(portainer, stack.Id, STACK_FILE, nextEnv))
          added = null // the stack holds it now
          if (!b.injectClaudeConfig && oldRepo) {
            // the stack is already changed, so a failure here only warns: the key stays valid on GitHub until removed, so the answer and the log say so
            try {
              await deleteKeys(oldRepo, () => findDeployKeys(a.token, oldRepo, title, true), (keyId) => deleteDeployKey(a.token, oldRepo, keyId), step)
            } catch (e) {
              warning = `Could not remove the read-only deploy key ${title} from ${oldRepo}: ${errMsg(e)}. Remove it under the repo's Settings > Deploy keys.`
              note += `. ${warning}`
            }
          }
          const next = await step('GET', '/containers/json', 200, () => replacement(c.name, id))
          await log(req, server, 'Configured', c.name, { note, calls, ms: Date.now() - started })
          return json({ id: next?.id ?? '', name: c.name, calls, upToDate: false, ...(warning && { warning }) })
        } catch (e) {
          // only the PUT can fail after the key exists, and a failed answer can still mean an applied stack: the key goes only when the stack is known not to hold it
          if (added) {
            const { key, repo, id: keyId } = added
            const now = await readStack(portainer, added.stackId).catch(() => null)
            if (now && !now.env.some((v) => v.name === 'CLAUDE_CONFIG_KEY' && v.value === key)) await deleteDeployKey(a.token, repo, keyId).catch(() => {})
          }
          // a failure after the PUT (waiting for the new container) must not hide a key left on GitHub
          const msg = warning ? `${errMsg(e)}. ${warning}` : errMsg(e)
          await log(req, server, 'Configure failed', c.name, { ok: false, note: msg, calls, ms: Date.now() - started })
          return json({ error: msg, calls }, e instanceof HttpError ? e.status : 502)
        }
      })
    }),
  },

  // { settings }: the container's VS Code Machine settings text, null when it has none. POST overwrites them with the global ones from Settings, no recreate needed, guarded by the `update` step-up.
  '/api/containers/:id/vscode': {
    GET: auth(async (req: BunRequest<'/api/containers/:id/vscode'>) => {
      const c = await dockbench(req.params.id)
      if (c.state !== 'running') return json({ error: `${c.name} is not running` }, 409)
      // exit 3 only when the file is missing, so a failed read is an error and not "none"; /home/dev because the workspace is missing until the clone ran
      // one character over the cap is kept, so only a file longer than the cap is refused
      let r: Awaited<ReturnType<typeof execRun>>
      try {
        r = await execRun(env.dockerHost, c.id, ['sh', '-c', '[ ! -e "$1" ] && exit 3; cat "$1"', 'sh', MACHINE_SETTINGS], { timeoutMs: 10_000, keep: VSCODE_READ_MAX + 1, workDir: '/home/dev' })
      } catch (e) {
        // a Docker failure or the timeout, answered like the git exec route
        return json({ error: `Could not read the VS Code settings in ${c.name}: ${errMsg(e)}`, calls: (e as { calls?: ApiCall[] }).calls ?? [] }, 502)
      }
      if (r.exitCode === 3) return json({ settings: null })
      if (r.exitCode !== 0) return json({ error: `Could not read the VS Code settings in ${c.name}: ${r.output.trim().split('\n').at(-1)?.slice(0, 300) || `exit code ${r.exitCode}`}`, calls: r.calls }, 502)
      // execRun keeps the tail, so a longer file would come back without its start
      if (r.output.length > VSCODE_READ_MAX) return json({ error: `${c.name} has VS Code Machine settings over ${VSCODE_READ_MAX} characters. Edit them in the container.` }, 409)
      return json({ settings: r.output })
    }),
    POST: auth(async (req: BunRequest<'/api/containers/:id/vscode'>, server) => {
      await requireStepUp(req, 'update')
      const id = req.params.id
      const c = await dockbench(id)
      if (c.state !== 'running') return json({ error: `${c.name} is not running` }, 409)
      const { vscodeSettings } = await readSettings(env.dataDir)
      if (!vscodeSettings) return json({ error: 'Set the VS Code settings in Settings first' }, 400)
      // held in `pending` so Update and Apply config cannot recreate the container under the write
      return withPending(id, c.name, 'vscode', async () => {
        const started = Date.now()
        let calls: ApiCall[] = []
        try {
          // the text goes in as an argument, never through a shell string
          const r = await execRun(env.dockerHost, c.id, ['sh', '-c', 'mkdir -p "${1%/*}" && printf %s "$2" > "$1"', 'sh', MACHINE_SETTINGS, vscodeSettings], { timeoutMs: 10_000, workDir: '/home/dev' })
          calls = r.calls
          if (r.exitCode !== 0) throw new Error(r.output.trim().split('\n').at(-1)?.slice(0, 300) || `exit code ${r.exitCode}`)
          await log(req, server, 'VS Code settings replaced', c.name, { calls, ms: Date.now() - started })
          return json({ settings: vscodeSettings })
        } catch (e) {
          calls = (e as { calls?: ApiCall[] }).calls ?? calls
          await log(req, server, 'VS Code settings replace failed', c.name, { ok: false, note: errMsg(e), calls, ms: Date.now() - started })
          return json({ error: errMsg(e), calls }, 502)
        }
      })
    }),
  },

  // GET { commit, diff, truncated }: what ~/.claude changed since the config commit it last downloaded, as a git diff ('' when nothing). POST { commit }: downloads the Claude config repo again over ~/.claude now, like the start does, without a restart. Overwrites edits made in the container, so it is guarded by the `update` step-up.
  '/api/containers/:id/claude-config': {
    GET: auth(async (req: BunRequest<'/api/containers/:id/claude-config'>) => {
      const c = await dockbench(req.params.id)
      if (c.state !== 'running') return json({ error: `${c.name} is not running` }, 409)
      let r: Awaited<ReturnType<typeof execRun>>
      try {
        r = await execRun(env.dockerHost, c.id, configDiffCmd, { timeoutMs: 15_000, keep: CONFIG_DIFF_MAX + 100, workDir: '/home/dev' })
      } catch (e) {
        return json({ error: `Could not read the Claude config changes in ${c.name}: ${errMsg(e)}`, calls: (e as { calls?: ApiCall[] }).calls ?? [] }, 502)
      }
      if (r.exitCode === 3) return json({ error: `${c.name} does not inject the Claude config` }, 409)
      if (r.exitCode === 4) return json({ error: `${c.name} has not downloaded the Claude config yet` }, 409)
      if (r.exitCode !== 0) return json({ error: `Could not read the Claude config changes in ${c.name}: ${lastLine(r.output) || `exit code ${r.exitCode}`}`, calls: r.calls }, 502)
      return json(parseConfigDiff(r.output))
    }),
    POST: auth(async (req: BunRequest<'/api/containers/:id/claude-config'>, server) => {
      server.timeout(req, 0)
      await requireStepUp(req, 'update')
      const id = req.params.id
      const c = await dockbench(id)
      if (c.state !== 'running') return json({ error: `${c.name} is not running` }, 409)
      return withPending(id, c.name, 'claudeConfig', async () => {
        const started = Date.now()
        let calls: ApiCall[] = []
        try {
          const r = await execRun(env.dockerHost, c.id, configPullCmd, { timeoutMs: 60_000, workDir: '/home/dev' })
          calls = r.calls
          if (r.exitCode === 3) throw new HttpError(409, `${c.name} does not inject the Claude config. Turn it on under Configuration first.`)
          if (r.exitCode !== 0) throw new Error(`Could not download the Claude config: ${lastLine(r.output) || `exit code ${r.exitCode}`}`)
          const commit = lastLine(r.output)
          await log(req, server, 'Claude config downloaded', c.name, { note: commit, calls, ms: Date.now() - started })
          return json({ commit })
        } catch (e) {
          calls = (e as { calls?: ApiCall[] }).calls ?? calls
          await log(req, server, 'Claude config download failed', c.name, { ok: false, note: errMsg(e), calls, ms: Date.now() - started })
          return json({ error: errMsg(e), calls }, e instanceof HttpError ? e.status : 502)
        }
      })
    }),
  },

  // Claude Code sign-in from the Bench page: { url } to open, then the code claude.com gives back. No step-up: it only adds the user's own credentials. The log never holds the link or the code.
  '/api/containers/:id/claude-login': {
    POST: auth(async (req: BunRequest<'/api/containers/:id/claude-login'>, server) => {
      server.timeout(req, 0)
      const c = await dockbench(req.params.id)
      if (c.state !== 'running') return json({ error: `${c.name} is not running` }, 409)
      const started = Date.now()
      let calls: ApiCall[] = []
      try {
        const r = await execRun(env.dockerHost, c.id, loginStartCmd, { timeoutMs: 30_000, workDir: '/home/dev' })
        calls = r.calls
        if (r.exitCode === 4) throw new HttpError(409, `Claude Code is not installed in ${c.name}`)
        const url = r.exitCode === 0 && loginUrl(r.output)
        if (!url) throw new Error(`Claude Code printed no sign-in link: ${lastLine(r.output) || `exit code ${r.exitCode}`}`)
        await log(req, server, 'Claude sign-in started', c.name, { calls, ms: Date.now() - started })
        return json({ url })
      } catch (e) {
        calls = (e as { calls?: ApiCall[] }).calls ?? calls
        await log(req, server, 'Claude sign-in failed', c.name, { ok: false, note: errMsg(e), calls, ms: Date.now() - started })
        return json({ error: errMsg(e), calls }, e instanceof HttpError ? e.status : 502)
      }
    }),
  },

  // { ok: true } once claude signed out and its credentials file is gone, so the next /status shows the sign-in callout again (switching accounts). No step-up: it only drops the user's own credentials.
  '/api/containers/:id/claude-logout': {
    POST: auth(async (req: BunRequest<'/api/containers/:id/claude-logout'>, server) => {
      server.timeout(req, 0)
      const c = await dockbench(req.params.id)
      if (c.state !== 'running') return json({ error: `${c.name} is not running` }, 409)
      const started = Date.now()
      let calls: ApiCall[] = []
      try {
        const r = await execRun(env.dockerHost, c.id, logoutCmd, { timeoutMs: 30_000, workDir: '/home/dev' })
        calls = r.calls
        if (r.exitCode === 4) throw new HttpError(409, `Claude Code is not installed in ${c.name}`)
        if (r.exitCode !== 0) throw new Error(`Claude Code sign-out failed: ${lastLine(r.output) || `exit code ${r.exitCode}`}`)
        await log(req, server, 'Claude signed out', c.name, { calls, ms: Date.now() - started })
        return json({ ok: true })
      } catch (e) {
        calls = (e as { calls?: ApiCall[] }).calls ?? calls
        await log(req, server, 'Claude sign-out failed', c.name, { ok: false, note: errMsg(e), calls, ms: Date.now() - started })
        return json({ error: errMsg(e), calls }, e instanceof HttpError ? e.status : 502)
      }
    }),
  },

  // { ok: true } once claude accepted the code. One wrong code ends the attempt (the CLI exits), so the next try starts again.
  '/api/containers/:id/claude-login/code': {
    POST: auth(async (req: BunRequest<'/api/containers/:id/claude-login/code'>, server) => {
      server.timeout(req, 0)
      const code = ((await req.json().catch(() => null)) as { code?: unknown } | null)?.code
      if (typeof code !== 'string' || !code.trim()) return json({ error: 'Paste the code claude.com showed' }, 400)
      const c = await dockbench(req.params.id)
      if (c.state !== 'running') return json({ error: `${c.name} is not running` }, 409)
      const started = Date.now()
      let calls: ApiCall[] = []
      try {
        const r = await execRun(env.dockerHost, c.id, loginCodeCmd(code.trim()), { timeoutMs: 45_000, workDir: '/home/dev' })
        calls = r.calls
        if (r.exitCode === 6) throw new HttpError(409, `No sign-in is waiting in ${c.name}, start it again`)
        if (r.exitCode === 7) throw new Error('Claude Code did not answer the code within 30 s')
        if (r.exitCode !== 0) throw new HttpError(r.exitCode == null ? 502 : 400, lastLine(r.output) || `Claude Code exited with ${r.exitCode}`)
        await log(req, server, 'Claude signed in', c.name, { calls, ms: Date.now() - started })
        return json({ ok: true })
      } catch (e) {
        calls = (e as { calls?: ApiCall[] }).calls ?? calls
        await log(req, server, 'Claude sign-in failed', c.name, { ok: false, note: errMsg(e), calls, ms: Date.now() - started })
        return json({ error: errMsg(e), calls }, e instanceof HttpError ? e.status : 502)
      }
    }),
  },

  // Pulls every image the dev containers run, instead of waiting for the 30-minute refresh. A pull can download a whole image, so the idle timeout is lifted. The next /api/containers carries the result.
  '/api/images/check': {
    POST: auth(async (req: BunRequest<'/api/images/check'>, server) => {
      server.timeout(req, 0)
      const rows = await listDockbench(env.dockerHost)
      const refs = [...new Set((await Promise.all(rows.map((r) => unlessGone(inspectContainer(env.dockerHost, r.id))))).flatMap((x) => (x && !x.image.includes('@') ? [x.image] : [])))]
      return json(await Promise.all(refs.map(async (image) => ({ image, ...(await images.check(image)) }))))
    }),
  },

  // ExecResult in src/types.ts. Exit codes other than 0 still answer 200: the git output is the answer. Only a Docker failure is a 502.
  '/api/containers/:id/git/:kind': {
    POST: auth(async (req: BunRequest<'/api/containers/:id/git/:kind'>, server) => {
      server.timeout(req, 0)
      const { id, kind } = req.params
      if (kind !== 'fetch' && kind !== 'pull') return json({ error: 'unknown git action' }, 404)
      if (kind === 'pull') await requireStepUp(req, 'pull')
      const c = await dockbench(id)
      if (c.state !== 'running') return json({ error: `${c.name} is not running` }, 409)
      const cmd = kind === 'fetch' ? ['git', 'fetch'] : ['git', 'pull', '--ff-only']
      const verb = kind === 'fetch' ? 'Fetch' : 'Pull'
      const started = Date.now()
      try {
        const r = await execRun(env.dockerHost, id, cmd)
        const ok = r.exitCode === 0
        const note = ok ? undefined : r.output.trim().split('\n').at(-1)?.slice(0, 300)
        await log(req, server, ok ? `${verb}ed` : `${verb} failed`, c.name, { ok, note, calls: r.calls, ms: Date.now() - started })
        if (ok) (await lastFetches()).set(c.name, new Date().toISOString())
        return json({ cmd: cmd.join(' '), ...r })
      } catch (e) {
        const calls = (e as { calls?: ApiCall[] }).calls ?? []
        await log(req, server, `${verb} failed`, c.name, { ok: false, note: errMsg(e), calls, ms: Date.now() - started })
        return json({ error: errMsg(e), calls }, 502)
      }
    }),
  },

  // RepoActions[] in src/types.ts: every repo the account sees (100 newest pushes) plus the repos dev containers were cloned from; ?deployed=1 only the latter, for Bench. The token stays here: only run facts go to the browser.
  '/api/actions': auth(async (req: BunRequest<'/api/actions'>) => {
    const { token } = await requireAccount()
    const onlyDeployed = new URL(req.url).searchParams.get('deployed') === '1'
    const [deployed, all] = await Promise.all([deployedRepos().catch(() => new Map<string, string>()), listRepos(token)])
    // the list is asked for Bench too (cached 5 min): it carries the default branch, which decides whether CI passes
    const rows = onlyDeployed ? all.filter((r) => deployed.has(r.fullName.toLowerCase())) : all
    const repos = new Map(rows.map((r) => [r.fullName.toLowerCase(), { repo: r.fullName, private: r.private as boolean | null, defaultBranch: r.defaultBranch as string | null, pushedAt: r.pushedAt as string | null }]))
    // a deployed repo outside the list (another owner, or older than the 100 newest pushes) still gets a row
    for (const k of deployed.keys()) if (!repos.has(k)) repos.set(k, { repo: k, private: null, defaultBranch: null, pushedAt: null })
    return json(await Promise.all([...repos].map(async ([k, r]) => {
      const x = await actionRuns(token, r.repo)
      return { ...r, deployedAs: deployed.get(k) ?? null, ...summarize(x.runs, r.defaultBranch ?? ''), checkedAt: new Date(x.at).toISOString(), error: x.error }
    })))
  }),

  '/api/activity': auth(async () => json(await readEvents(env.dataDir))),

  '/api/deploy': {
    POST: auth(async (req: BunRequest<'/api/deploy'>, server) => {
      // pull plus the 10 s poll can outlast Bun's idle timeout (10 s, enforced on GET only in Bun 1.4.2, but the image floats on oven/bun:1)
      server.timeout(req, 0)
      await requireStepUp(req, 'deploy')
      const v = validateDeploy(await req.json().catch(() => null), env.dockbenchImage)
      if (!v.ok) return json({ error: v.error }, 400)
      const { repo, project, gitUserName, gitUserEmail, image, installClaude, injectClaudeConfig, setupRerun, vscodeConfig, ghLogin } = v.value
      const settings = await readSettings(env.dataDir)
      const configRepo = injectClaudeConfig ? settings.claudeConfigRepo : ''
      if (injectClaudeConfig && !configRepo) return json({ error: 'Set the Claude config repo in Settings first' }, 400)
      const a = await requireAccount()
      // two deploys of one project would both pass the 409 checks before either creates its stack; one server process, so a set is the lock
      const name = `dockbench-${project}`
      if (deploying.has(name)) return json({ error: `A deploy of ${name} is already running` }, 409)
      deploying.add(name)
      const started = Date.now()
      try {
        const key = ghLogin ? null : generateDeployKey()
        const configKey = configRepo ? generateDeployKey() : null
        const cpuset = cpusetFor((await info().catch(() => null))?.ncpu ?? 0)
        const result = await deploy(project, repo, {
          listContainers: () => listDockbench(env.dockerHost),
          findStack: (name) => findStack(portainer, name),
          pullImage: () => pullImage(portainer, image),
          ...(key && {
            createDeployKey: () => createDeployKey(a.token, repo, `dockbench-${project}`, key.publicKey),
            deleteDeployKey: (id: number) => deleteDeployKey(a.token, repo, id),
          }),
          createConfigKey: () => createDeployKey(a.token, configRepo, `dockbench-${project}`, configKey!.publicKey, true),
          deleteConfigKey: (id) => deleteDeployKey(a.token, configRepo, id),
          createStack: (name) => createStack(portainer, name, stackEnv({ project, repo, image, sshKey: key?.privateKeyBase64 ?? '', gitUserName, gitUserEmail, installClaude, setupRerun, claudeConfigRepo: configRepo, claudeConfigKey: configKey?.privateKeyBase64 ?? '', vscodeConfig, vscodeSettings: settings.vscodeSettings, cpuset })),
        }, configRepo)
        await log(req, server, 'Deployed', result.name, { calls: result.calls, ms: Date.now() - started, ...(result.warning && { note: result.warning }) })
        return json(result, 201)
      } catch (e) {
        const f = e instanceof DeployFailure ? e : new DeployFailure(502, (e as Error).message, [])
        await log(req, server, 'Deploy failed', name, { ok: false, note: f.message, calls: f.calls, ms: Date.now() - started })
        return json({ error: f.message, calls: f.calls }, f.status)
      } finally {
        deploying.delete(name)
      }
    }),
  },

  // TelegramStatus in src/types.ts; now is the server clock, which the page compares the bot's last_poll_at with (same host), so a skewed browser clock does not turn row 1 red. /status is asked with a 2 s timeout on every poll: the bot answers from memory, so there is no tracker like the dev containers have.
  '/api/telegram': auth(async () => {
    const c = await containerByName(env.dockerHost, TELEGRAM_NAME)
    // removed between the lookup and the inspect (an update recreating it) reads as not deployed for this answer
    const x = c && (await unlessGone(inspectContainer(env.dockerHost, c.id)))
    if (!c || !x) return json({ deployed: false, state: null, startedAt: null, image: null, imageUpdate: null, status: null, statusError: null, now: new Date().toISOString() })
    let status: BotStatus | null = null
    let statusError: 'starting' | 'dead' | null = null
    if (c.state === 'running') {
      // ponytail: "starting" for the first 30 s after a start, then "dead"; a tracker like statusTracker if that misleads
      status = await fetchBotStatus(botStatusUrl).catch(() => null)
      if (status) status.bot = await botName(env.dockerHost, c.id).catch(() => '') // '' hides the t.me links until Telegram answers
      if (!status) statusError = x.startedAt && Date.now() - Date.parse(x.startedAt) < 30_000 ? 'starting' : 'dead'
    }
    const check = images.peek(x.image)
    return json({ deployed: true, state: c.state, startedAt: x.startedAt, image: x.image, imageUpdate: updateAvailable(x.image, check?.imageId ?? null, x.imageId), status, statusError, now: new Date().toISOString() })
  }),

  // body { token, dockerGid? }: getMe checks the token, then the same checks and Portainer stack as a dev container deploy. The token goes only to Telegram and into the stack env.
  '/api/telegram/deploy': {
    POST: auth(async (req: BunRequest<'/api/telegram/deploy'>, server) => {
      server.timeout(req, 0)
      await requireStepUp(req, 'deploy')
      const body = (await req.json().catch(() => null)) as { token?: unknown; dockerGid?: unknown } | null
      if (!validToken(body?.token)) return json({ error: 'token must be the one @BotFather gave, like 123456789:AAH…' }, 400)
      const token = body.token.trim()
      // the typed id is only read, and checked, when the socket's group cannot be read here
      const gid = (await dockerGid(env.dockerHost)) ?? parseGid(body.dockerGid)
      if (gid === 'invalid') return json({ error: 'Docker group id must be a whole number' }, 400)
      // a double submit would pass the 409 checks twice, and the second create's lookup would find the first one's stack
      if (deploying.has(TELEGRAM_NAME)) return json({ error: `A deploy of ${TELEGRAM_NAME} is already running` }, 409)
      deploying.add(TELEGRAM_NAME)
      const { calls, step } = tracer()
      const started = Date.now()
      try {
        const bot = await step('GET', '/getMe', 200, () => getMe(token))
        if (gid === null) throw new HttpError(400, 'The Docker socket group id could not be read here. Enter it under Docker group id: run stat -c %g /var/run/docker.sock on the VPS.')
        if (await step('GET', '/containers/json', 200, () => containerByName(env.dockerHost, TELEGRAM_NAME))) throw new HttpError(409, `Container ${TELEGRAM_NAME} already exists`)
        if (await step('GET', '/api/stacks', 200, () => findStack(portainer, TELEGRAM_NAME))) throw new HttpError(409, `Stack ${TELEGRAM_NAME} already exists. Remove it in Portainer to deploy again.`)
        await step('POST', '/images/create', 200, () => pullImage(portainer, TELEGRAM_IMAGE))
        const cpuset = cpusetFor((await info().catch(() => null))?.ncpu ?? 0)
        let warning: string | undefined
        try {
          await step('POST', '/api/stacks/create/standalone/string', 200, () => createStack(portainer, TELEGRAM_NAME, telegramEnv(token, gid, cpuset), TELEGRAM_STACK_FILE))
        } catch (e) {
          warning = await afterFailedCreate(e, calls, () => findStack(portainer, TELEGRAM_NAME))
        }
        await log(req, server, 'Deployed', TELEGRAM_NAME, { calls, ms: Date.now() - started, ...(warning && { note: warning }) })
        return json({ bot, calls, ...(warning && { warning }) }, 201)
      } catch (e) {
        await log(req, server, 'Deploy failed', TELEGRAM_NAME, { ok: false, note: errMsg(e), calls, ms: Date.now() - started })
        return json({ error: errMsg(e), calls }, e instanceof HttpError ? e.status : 502)
      } finally {
        deploying.delete(TELEGRAM_NAME)
      }
    }),
  },

  // The one-time setup code from the bot's log, as a t.me link that claims the bot. Whoever claims it gets a shell in every dev container, so it takes the deploy passkey check and is never part of a poll.
  '/api/telegram/claim': {
    POST: auth(async (req: BunRequest<'/api/telegram/claim'>) => {
      await requireStepUp(req, 'deploy')
      const c = await containerByName(env.dockerHost, TELEGRAM_NAME)
      if (!c || c.state !== 'running') return json({ error: `${TELEGRAM_NAME} is not running` }, 409)
      const s = await fetchBotStatus(botStatusUrl).catch(() => null)
      if (!s) return json({ error: 'The bot does not answer /status yet. Try again in a few seconds.' }, 409)
      if (s.owner) return json({ error: 'The bot already has an owner.' }, 409)
      const code = setupCode(await containerLogs(env.dockerHost, c.id, 200))
      if (!code) return json({ error: 'No setup code in the bot log. Restart the bot to print a new one.' }, 404)
      return json({ code, link: `https://t.me/${await botName(env.dockerHost, c.id)}?start=${code}` })
    }),
  },

  '/api/telegram/update': {
    POST: auth(async (req: BunRequest<'/api/telegram/update'>, server) => {
      server.timeout(req, 0)
      await requireStepUp(req, 'update')
      const c = await containerByName(env.dockerHost, TELEGRAM_NAME)
      if (!c) return json({ error: `${TELEGRAM_NAME} is not deployed` }, 404)
      return withPending(c.id, c.name, 'update', () => updateViaStack(req, server, c))
    }),
  },

  // SystemStatus in src/types.ts
  '/api/system': auth(async () => json(await systemView(false))),

  // pulls the dashboard, collector and bot images now instead of waiting for the 30-minute refresh; a pull can take a while, so the idle timeout is lifted
  '/api/system/check': {
    POST: auth(async (req: BunRequest<'/api/system/check'>, server) => {
      server.timeout(req, 0)
      return json(await systemView(true))
    }),
  },

  // The dashboard updating itself: pull its image and the collector's through Portainer, answer, then restart in place (both on their newest image) or redeploy its own Portainer stack (either image new), so the pair never ends up mismatched. Both stop this process, so they run after the answer is out; Portainer and the Docker daemon finish them on their own. The page then waits for a new bootId on /api/system and reloads.
  '/api/system/dashboard/update': {
    POST: auth(async (req: BunRequest<'/api/system/dashboard/update'>, server) => {
      server.timeout(req, 0)
      await requireStepUp(req, 'update')
      const c = await containerByName(env.dockerHost, DASHBOARD_NAME)
      if (!c) return json({ error: `This server does not run as container ${DASHBOARD_NAME}, so it cannot update itself. Pull and redeploy its stack in Portainer.` }, 409)
      if (pending.has(c.id)) return json({ error: `${c.name} is busy: ${pending.get(c.id)} in progress` }, 409)
      pending.set(c.id, 'update')
      const { calls, step } = tracer()
      const started = Date.now()
      try {
        const x = await step('GET', `/containers/${c.id.slice(0, 12)}/json`, 200, () => inspectContainer(env.dockerHost, c.id))
        await step('POST', '/images/create', 200, () => pullImage(portainer, x.image))
        const pulled = await step('GET', `/images/${x.image}/json`, 200, () => imageInspect(env.dockerHost, x.image))
        images.check(x.image).catch(() => {})
        // a stack without the collector (deployed before it existed) is not an error
        const k = await containerByName(env.dockerHost, COLLECTOR_NAME)
        let collectorCurrent = true
        if (k) {
          const kx = await step('GET', `/containers/${k.id.slice(0, 12)}/json`, 200, () => inspectContainer(env.dockerHost, k.id))
          await step('POST', '/images/create', 200, () => pullImage(portainer, kx.image))
          const kp = await step('GET', `/images/${kx.image}/json`, 200, () => imageInspect(env.dockerHost, kx.image))
          images.check(kx.image).catch(() => {})
          collectorCurrent = kp.id === kx.imageId
        }
        const upToDate = pulled.id === x.imageId && collectorCurrent
        let apply = () => containerPost(env.dockerHost, c.id, 'restart') as Promise<unknown>
        if (!upToDate) {
          const stack = await step('GET', '/api/stacks', 200, () => findStack(portainer, x.project ?? c.name))
          if (!stack) throw new HttpError(409, `${c.name} is not a Portainer stack (compose project ${x.project ?? 'unknown'}), so it cannot recreate itself. Pull and redeploy it where it was started.`)
          apply = () => redeployStack(portainer, stack.Id)
        }
        await log(req, server, 'Updated', c.name, { note: upToDate ? 'already on the newest image, restarting' : 'recreating on the new image', calls, ms: Date.now() - started })
        selfUpdateError = null
        setTimeout(() => {
          apply().catch(async (e) => {
            selfUpdateError = errMsg(e)
            pending.delete(c.id)
            await log(req, server, 'Update failed', c.name, { ok: false, note: selfUpdateError }).catch(() => {})
          })
        }, 1000)
        return json({ id: c.id, name: c.name, calls, upToDate, restarting: true })
      } catch (e) {
        pending.delete(c.id)
        await log(req, server, 'Update failed', c.name, { ok: false, note: errMsg(e), calls, ms: Date.now() - started })
        return json({ error: errMsg(e), calls }, e instanceof HttpError ? e.status : 502)
      }
    }),
  },

  '/api/*': () => json({ error: 'not found' }, 404),

  // ponytail: no directory check. Vite hashes /assets/ names, so those are cached for good; the shell, sw.js, the manifest and the icons are revalidated on every load, so a deploy is picked up at once.
  '/*': async (req: BunRequest<'/*'>) => {
    let path: string
    try {
      path = decodeURIComponent(new URL(req.url).pathname)
    } catch {
      return new Response('Bad request', { status: 400 })
    }
    if (path.includes('..') || path.includes('\0')) return new Response('Not found', { status: 404 })
    const file = Bun.file(join(env.staticDir, path))
    const headers = { 'cache-control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' }
    if (path !== '/' && (await file.exists())) return new Response(file, { headers })
    // a chunk of another build: never the shell, which would be cached for good under that name
    if (path.startsWith('/assets/')) return new Response('Not found', { status: 404 })
    return new Response(Bun.file(join(env.staticDir, 'index.html')), { headers })
  },
}
