import { expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = await mkdtemp(join(tmpdir(), 'dockbench-routes-'))
const staticDir = join(dir, 'public')
await Bun.write(join(staticDir, 'index.html'), '<h1>app</h1>')
await Bun.write(join(dir, 'secret.txt'), 'secret')
await Bun.write(join(staticDir, 'assets', 'index-abc123.js'), 'js')
// Docker that lists slower than the server idle timeout below (Bun checks it on a ~4 s tick) and fails everything else, unless a test swaps in its own fake
let dockerFake: ((req: Request) => Response | Promise<Response>) | null = null
const docker = Bun.serve({ port: 0, fetch: async (req) => (dockerFake ? dockerFake(req) : new URL(req.url).pathname === '/containers/json' ? (await Bun.sleep(6000), Response.json([])) : new Response('down', { status: 500 })) })
// Portainer that fails everything unless a test swaps in its own fake
let portainerFake: ((req: Request) => Response | Promise<Response>) | null = null
const portainer = Bun.serve({ port: 0, fetch: (req) => (portainerFake ? portainerFake(req) : new Response('down', { status: 500 })) })
// api.github.com and api.telegram.org are hardcoded, so a test that needs them sets externalFake, which answers for those two hosts only; every other fetch goes out unchanged
let externalFake: ((req: Request) => Response | Promise<Response>) | null = null
const realFetch = globalThis.fetch
globalThis.fetch = Object.assign((input: string | URL | Request, init?: BunFetchRequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  return externalFake && /^https:\/\/api\.(github\.com|telegram\.org)\//.test(url) ? Promise.resolve(externalFake(input instanceof Request ? input : new Request(url, init))) : realFetch(input, init)
}, realFetch)
// collector that has no sample yet (503) unless a test swaps in its own fake
let collectorFake: ((req: Request) => Response | Promise<Response>) | null = null
const collectorServer = Bun.serve({ port: 0, fetch: (req) => (collectorFake ? collectorFake(req) : new Response('no sample yet', { status: 503 })) })
Object.assign(process.env, {
  PUBLIC_URL: 'http://localhost:5173',
  GITHUB_CLIENT_ID: 'cid',
  GITHUB_CLIENT_SECRET: 'csecret',
  GITHUB_LOGIN: 'octocat',
  SESSION_SECRET: 'test-secret-at-least-32-characters-long',
  TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  PORTAINER_URL: `http://localhost:${portainer.port}`,
  PORTAINER_API_KEY: 'pk',
  PORTAINER_ENDPOINT_ID: '1',
  DATA_DIR: dir,
  STATIC_DIR: staticDir,
  DOCKER_HOST: `http://localhost:${docker.port}`,
  COLLECTOR_URL: `http://localhost:${collectorServer.port}`,
})

const { routes, testHooks } = await import('./routes')
const { onError } = await import('./http')
const { createSession } = await import('./session')
const { createSessionRecord, DEFAULT_LIMITS, signCookie } = await import('./sessions')
// the cap is raised for the tests: many of them sign in and must not evict the shared cookie below
await Bun.write(join(dir, 'settings.json'), JSON.stringify({ maxDevices: 20 }))
const server = Bun.serve({ port: 0, routes, error: onError, idleTimeout: 1 })
const base = `http://localhost:${server.port}`
const mint = async () => `session=${signCookie(process.env.SESSION_SECRET!, (await createSessionRecord(dir, { device: 'test', ip: '127.0.0.1' }, DEFAULT_LIMITS)).id)}`
let session = await mint()

test('api routes without a session answer 401', async () => {
  for (const path of ['/api/session', '/api/github/repos', '/api/host', '/api/containers', '/api/activity', '/api/telegram', '/api/actions', '/api/actions?deployed=1']) expect((await fetch(base + path)).status).toBe(401)
  expect((await fetch(`${base}/api/deploy`, { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(401)
  expect((await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(401)
})

test('telegram writes need a session and refuse cross-site requests', async () => {
  for (const path of ['/api/telegram/deploy', '/api/telegram/claim', '/api/telegram/update']) {
    expect((await fetch(base + path, { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(401)
    expect((await fetch(base + path, { method: 'POST', headers: { cookie: session, 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
  }
})

test('system routes need a session and refuse cross-site writes', async () => {
  expect((await fetch(`${base}/api/system`)).status).toBe(401)
  for (const path of ['/api/system/check', '/api/system/dashboard/update']) {
    expect((await fetch(base + path, { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(401)
    expect((await fetch(base + path, { method: 'POST', headers: { cookie: session, 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
  }
})

test('telegram deploy with a malformed token answers 400 before calling Telegram, Docker or Portainer', async () => {
  const res = await fetch(`${base}/api/telegram/deploy`, { method: 'POST', headers: { cookie: session, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ token: 'nope' }) })
  expect(res.status).toBe(400)
  expect(((await res.json()) as { error: string }).error).toBe('token must be the one @BotFather gave, like 123456789:AAH…')
})

test('telegram deploy with a typed Docker group id that is not a whole number answers 400 before calling Telegram', async () => {
  for (const dockerGid of ['abc', -1, 1.5, false, [], ' ']) {
    const res = await fetch(`${base}/api/telegram/deploy`, { method: 'POST', headers: { cookie: session, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ token: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', dockerGid }) })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('Docker group id must be a whole number')
  }
})

test('a cookie signed with another secret, an unknown id, an idle record or the old three-part format is refused', async () => {
  const { touch } = await import('./sessions')
  const id = session.slice('session='.length).split('.')[0]
  expect((await fetch(`${base}/api/session`, { headers: { cookie: `session=${signCookie('other-secret-at-least-32-characters-long', id)}` } })).status).toBe(401)
  expect((await fetch(`${base}/api/session`, { headers: { cookie: `session=${signCookie(process.env.SESSION_SECRET!, 'unknown-id')}` } })).status).toBe(401)
  expect((await fetch(`${base}/api/session`, { headers: { cookie: `session=${createSession(process.env.SESSION_SECRET!)}` } })).status).toBe(401)
  const idle = await createSessionRecord(dir, { device: 'test', ip: '127.0.0.1' }, DEFAULT_LIMITS)
  await touch(dir, idle.id, Date.now() - 3 * 24 * 3600 * 1000)
  expect((await fetch(`${base}/api/session`, { headers: { cookie: `session=${signCookie(process.env.SESSION_SECRET!, idle.id)}` } })).status).toBe(401)
})

test('start redirects to GitHub and sets the state cookie', async () => {
  const res = await fetch(`${base}/api/auth/github/start`, { redirect: 'manual' })
  expect(res.status).toBe(302)
  const location = res.headers.get('location')!
  expect(location.startsWith('https://github.com/login/oauth/authorize?')).toBe(true)
  expect(location).toContain('scope=repo+workflow+read%3Auser&')
  expect(location).toContain(encodeURIComponent('http://localhost:5173/api/auth/github/callback'))
  expect(res.headers.get('set-cookie')).toContain('oauth_state=')
})

test('callback without a matching state answers 400 and never calls GitHub', async () => {
  expect((await fetch(`${base}/api/auth/github/callback?code=abc`, { redirect: 'manual' })).status).toBe(400)
  expect((await fetch(`${base}/api/auth/github/callback?code=abc&state=zzz`, { redirect: 'manual' })).status).toBe(400)
  const res = await fetch(`${base}/api/auth/github/callback?code=abc&state=zzz`, { redirect: 'manual', headers: { cookie: 'oauth_state=other' } })
  expect(res.status).toBe(400)
})

test('deploy with a bad body answers 400 before touching anything', async () => {
  const res = await fetch(`${base}/api/deploy`, { method: 'POST', headers: { cookie: session, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ repo: 'bad' }) })
  expect(res.status).toBe(400)
  expect(((await res.json()) as { error: string }).error).toBe('repo must be owner/name')
  const notJson = await fetch(`${base}/api/deploy`, { method: 'POST', headers: { cookie: session, 'sec-fetch-site': 'same-origin' }, body: 'nope' })
  expect(notJson.status).toBe(400)
})

test('the Claude config repo setting takes owner/name or empty, and deploy refuses to inject without one', async () => {
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { cookie: session, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(body) })
  const good = { repo: 'octocat/shop', project: 'shop', gitUserName: 'Mona', gitUserEmail: 'a@b.c', injectClaudeConfig: true }
  const inject = await post('/api/deploy', good)
  expect(inject.status).toBe(400)
  expect(((await inject.json()) as { error: string }).error).toBe('Set the Claude config repo in Settings first')
  expect((await post('/api/settings/claude', { claudeConfigRepo: 'https://github.com/a/b' })).status).toBe(400)
  const set = await post('/api/settings/claude', { claudeConfigRepo: ' octocat/claude-config ' })
  expect(await set.json()).toEqual({ claudeConfigRepo: 'octocat/claude-config' })
  expect(await Bun.file(join(dir, 'settings.json')).json()).toEqual({ claudeConfigRepo: 'octocat/claude-config', vscodeSettings: '', maxDevices: 20, idleDays: 2 })
  // with a repo set, deploy gets past the setting and stops at the missing account
  expect((await post('/api/deploy', good)).status).toBe(401)
  expect(await (await post('/api/settings/claude', { claudeConfigRepo: '' })).json()).toEqual({ claudeConfigRepo: '' })
  expect((await fetch(`${base}/api/settings/claude`, { method: 'POST', headers: { cookie: session, 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
})

test('the VS Code settings are capped, trimmed, and saved next to the Claude config repo without clearing it', async () => {
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { cookie: session, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(body) })
  await post('/api/settings/claude', { claudeConfigRepo: 'octocat/claude-config' })
  expect((await post('/api/settings/vscode', { vscodeSettings: 'x'.repeat(20_001) })).status).toBe(400)
  const text = '{\n  // theme\n  "workbench.colorTheme": "Default Dark Modern"\n}'
  expect(await (await post('/api/settings/vscode', { vscodeSettings: `\n${text}\n` })).json()).toEqual({ vscodeSettings: text })
  expect(await Bun.file(join(dir, 'settings.json')).json()).toEqual({ claudeConfigRepo: 'octocat/claude-config', vscodeSettings: text, maxDevices: 20, idleDays: 2 })
  await post('/api/settings/claude', { claudeConfigRepo: '' })
  expect(await Bun.file(join(dir, 'settings.json')).json()).toEqual({ claudeConfigRepo: '', vscodeSettings: text, maxDevices: 20, idleDays: 2 })
  for (const path of ['/api/settings/vscode', '/api/containers/abc/config', '/api/containers/abc/vscode']) {
    expect((await fetch(base + path, { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(401)
    expect((await fetch(base + path, { method: 'POST', headers: { cookie: session, 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
  }
  expect((await post('/api/containers/abc/config', { installClaude: 'yes', injectClaudeConfig: true, vscodeConfig: true })).status).toBe(400)
})

test('session without a stored account answers 401', async () => {
  expect((await fetch(`${base}/api/session`, { headers: { cookie: session } })).status).toBe(401)
})

test('host answers reachable false when the socket does not answer', async () => {
  const res = await fetch(`${base}/api/host`, { headers: { cookie: session } })
  expect(res.status).toBe(200)
  expect(((await res.json()) as { reachable: boolean }).reachable).toBe(false)
})

const collectorSnap = {
  at: 1000, intervalMs: 2000,
  host: { ncpu: 4, cpuPct: 42, stealPct: 2, iowaitPct: 0, memTotal: 8e9, memUsed: 4e9, load1: 3, load5: 2, load15: 1, psiCpuSome10: 5 },
  containers: [{ id: 'c1', name: 'dockbench-shop', image: 'x', dockbench: true, cpuPct: 7, memUsed: 500, memLimit: 8e9 }],
  processes: [{ comm: 'node', pids: [10], container: 'c1', cpuPct: 5, rss: 400 }],
}
const collectorWith = (points: unknown[] = []) => (req: Request) => (new URL(req.url).pathname === '/metrics' ? Response.json(collectorSnap) : Response.json({ stepMs: 10_000, points }))
// the server shares one /metrics answer per live interval (2 s), so a test that swaps the fake waits it out
const collectorTtl = () => Bun.sleep(2100)

test("host carries the collector's cpu and collector true", async () => {
  collectorFake = collectorWith()
  await collectorTtl()
  const res = await fetch(`${base}/api/host`, { headers: { cookie: session } })
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ cpuPct: 42, memUsed: 4e9, stealPct: 2, load1: 3, psiCpuSome10: 5, collector: true })
})

test('host carries zeros and collector false when the collector is down', async () => {
  collectorFake = null
  await collectorTtl()
  const res = await fetch(`${base}/api/host`, { headers: { cookie: session } })
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ cpuPct: 0, memUsed: 0, stealPct: 0, load1: 0, psiCpuSome10: 0, collector: false })
})

test('containers take cpu and mem from the collector by id', async () => {
  dockerFake = (req) => {
    const u = new URL(req.url)
    if (u.pathname === '/containers/json') return Response.json([{ Id: 'c1', Names: ['/dockbench-shop'], State: 'running', Image: 'x' }, { Id: 'c2', Names: ['/dockbench-new'], State: 'running', Image: 'x' }])
    if (u.pathname === '/containers/c1/json' || u.pathname === '/containers/c2/json') return Response.json({ Image: 'sha256:a', State: { Status: 'running', StartedAt: '2026-11-08T10:00:00Z', FinishedAt: '0001-01-01T00:00:00Z', ExitCode: 0 }, RestartCount: 0, HostConfig: { Memory: 0 }, Config: { Env: [], Image: 'x', Labels: {} }, Mounts: [] })
    return new Response('down', { status: 500 })
  }
  collectorFake = collectorWith()
  await collectorTtl()
  try {
    const rows = (await (await fetch(`${base}/api/containers`, { headers: { cookie: session } })).json()) as { id: string; cpuPct: number; memUsed: number; memLimit: number }[]
    expect(rows.map((r) => [r.id, r.cpuPct, r.memUsed, r.memLimit])).toEqual([['c1', 7, 500, 8e9], ['c2', 0, 0, 0]])
  } finally {
    dockerFake = null
  }
})

test('utilization 400 on a bad window and 503 when the collector is down', async () => {
  expect((await fetch(`${base}/api/utilization?window=1h`)).status).toBe(401)
  for (const w of ['2h', 'toString', '']) expect((await fetch(`${base}/api/utilization?window=${w}`, { headers: { cookie: session } })).status).toBe(400)
  collectorFake = null
  const res = await fetch(`${base}/api/utilization?window=1h`, { headers: { cookie: session } })
  expect(res.status).toBe(503)
  expect(await res.json()).toEqual({ error: 'collector unreachable' })
})

test('utilization resolves names', async () => {
  const point = { t: 900, host: { cpuPct: 1, stealPct: 0, memUsed: 1, load1: 1 }, containers: { c1: { name: 'dockbench-shop', cpuPct: 1, memUsed: 2 }, old: { name: 'gone', cpuPct: 0, memUsed: 0 } }, top: {} }
  collectorFake = collectorWith([point])
  await collectorTtl()
  try {
    const res = await fetch(`${base}/api/utilization?window=6h`, { headers: { cookie: session } })
    expect(res.status).toBe(200)
    const u = (await res.json()) as Record<string, unknown>
    expect(u).toMatchObject({ window: '6h', stepMs: 10_000, at: 1000, points: [point], containers: collectorSnap.containers, processes: collectorSnap.processes })
    expect(u.names).toEqual({ c1: { name: 'dockbench-shop', dockbench: true }, old: { name: 'gone', dockbench: false } })
  } finally {
    collectorFake = null
  }
})

test('utilization leaves the process lists to the collector when asked and answers gzip', async () => {
  const seen: URL[] = []
  const point = { t: 900, host: { cpuPct: 1, stealPct: 0, memUsed: 1, load1: 1 }, containers: {}, top: {} }
  const inner = collectorWith([point])
  collectorFake = (req) => (seen.push(new URL(req.url)), inner(req))
  await collectorTtl()
  try {
    const res = await fetch(`${base}/api/utilization?window=1h&top=0`, { headers: { cookie: session, 'accept-encoding': 'gzip' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(((await res.json()) as { points: unknown[] }).points).toEqual([point])
    expect(seen.find((u) => u.pathname === '/history')?.searchParams.get('top')).toBe('0')
    seen.length = 0
    await fetch(`${base}/api/utilization?window=1h`, { headers: { cookie: session } })
    expect(seen.find((u) => u.pathname === '/history')?.searchParams.get('top')).toBe('1')
  } finally {
    collectorFake = null
  }
})

test('unknown api paths answer 404 json, not the app', async () => {
  const res = await fetch(`${base}/api/auth/nope/options`, { method: 'POST', headers: { cookie: session } })
  expect(res.status).toBe(404)
  expect(res.headers.get('content-type')).toContain('json')
})

test('static route serves the app and never a file outside STATIC_DIR', async () => {
  expect(await (await fetch(`${base}/`)).text()).toBe('<h1>app</h1>')
  expect(await (await fetch(`${base}/some/client/route`)).text()).toBe('<h1>app</h1>')
  for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/x/..%2f..%2fsecret.txt']) {
    const res = await fetch(base + path)
    expect(await res.text()).not.toBe('secret')
  }
})

test('a malformed or NUL path answers 4xx without the static dir in the body', async () => {
  for (const path of ['/%zz', '/%00', '/assets/%E0%A4%A']) {
    const res = await fetch(base + path)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    expect(await res.text()).not.toContain(staticDir)
  }
})

test('a cookie whose signature has the right length in characters but not in bytes answers 401, not 500', async () => {
  const id = session.slice('session='.length).split('.')[0]
  const res = await fetch(`${base}/api/session`, { headers: { cookie: `session=${id}.\u00e9${'a'.repeat(42)}` } })
  expect(res.status).toBe(401)
})

test('a container removed between the list and its inspect is left out, not a 500', async () => {
  dockerFake = (req) => {
    const u = new URL(req.url)
    if (u.pathname === '/containers/json') return Response.json([{ Id: 'g1', Names: ['/dockbench-kept'], State: 'exited', Image: 'x' }, { Id: 'g2', Names: ['/dockbench-gone'], State: 'exited', Image: 'x' }])
    if (u.pathname === '/containers/g1/json') return Response.json({ Image: 'sha256:a', State: { Status: 'exited', StartedAt: '2026-11-08T10:00:00Z', FinishedAt: '2026-11-08T11:00:00Z', ExitCode: 0 }, RestartCount: 0, HostConfig: { Memory: 0 }, Config: { Env: [], Image: 'x', Labels: {} }, Mounts: [] })
    if (u.pathname === '/containers/g2/json') return Response.json({ message: 'No such container: g2' }, { status: 404 })
    return new Response('down', { status: 500 })
  }
  try {
    const res = await fetch(`${base}/api/containers`, { headers: { cookie: session } })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { id: string }[]).map((r) => r.id)).toEqual(['g1'])
  } finally {
    dockerFake = null
  }
})

test('hashed assets are cached for good, the shell is revalidated', async () => {
  expect((await fetch(`${base}/assets/index-abc123.js`)).headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  for (const path of ['/', '/bench', '/index.html']) expect((await fetch(base + path)).headers.get('cache-control')).toBe('no-cache')
})

test('cancelling on the GitHub consent screen goes back to sign-in, not a JSON page', async () => {
  const res = await fetch(`${base}/api/auth/github/callback?error=access_denied&state=s1`, { redirect: 'manual', headers: { cookie: 'oauth_state=s1' } })
  expect(res.status).toBe(302)
  expect(res.headers.get('location')).toBe('/sign-in?error=oauth')
})

test('2FA: only a pending cookie plus the current code mints a session, once', async () => {
  const { base32Decode, totpAt } = await import('./totp')
  const key = base32Decode(process.env.TOTP_SECRET!)
  const pending = `totp_pending=${createSession(`${process.env.SESSION_SECRET}:totp-pending`, Date.now(), 300)}`
  const send = (cookie: string, code: string) => fetch(`${base}/api/auth/totp`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ code }) })
  const code = totpAt(key, Math.floor(Date.now() / 30000))
  const wrong = totpAt(key, Math.floor(Date.now() / 30000) + 5)

  // no pending cookie, a session passed off as pending, or a pending cookie passed off as a session
  expect((await send('', code)).status).toBe(401)
  expect((await send(`totp_pending=${createSession(process.env.SESSION_SECRET!)}`, code)).status).toBe(401)
  expect((await fetch(`${base}/api/host`, { headers: { cookie: pending.replace('totp_pending', 'session') } })).status).toBe(401)

  expect((await send(pending, wrong)).status).toBe(400)
  const ok = await send(pending, code)
  expect(ok.status).toBe(200)
  expect(ok.headers.getSetCookie().some((c) => c.startsWith('session='))).toBe(true)
  const minted = ok.headers.getSetCookie().find((c) => c.startsWith('session='))!.split(';')[0]
  await Bun.write(join(dir, 'github.json'), JSON.stringify({ login: 'octocat', id: 1, name: null, avatar_url: '', token: 'gho_x' }))
  expect((await fetch(`${base}/api/session`, { headers: { cookie: minted } })).status).toBe(200)
  // the code was used: a replay is a wrong code
  expect((await send(pending, code)).status).toBe(400)
  // the other device stays signed in
  expect((await fetch(`${base}/api/session`, { headers: { cookie: session } })).status).toBe(200)

  for (let i = 0; i < 5; i++) await send(pending, wrong)
  expect((await send(pending, code)).status).toBe(429)
})

test('logout revokes only its own device; { all: true } revokes every device', async () => {
  await Bun.write(join(dir, 'github.json'), JSON.stringify({ login: 'octocat', id: 1, name: null, avatar_url: '', token: 'gho_x' }))
  const same = { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }
  const first = await mint()
  const second = await mint()
  expect((await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie: first, ...same } })).status).toBe(200)
  expect((await fetch(`${base}/api/session`, { headers: { cookie: first } })).status).toBe(401)
  expect((await fetch(`${base}/api/session`, { headers: { cookie: second } })).status).toBe(200)
  const third = await mint()
  expect((await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie: second, ...same }, body: JSON.stringify({ all: true }) })).status).toBe(200)
  expect((await fetch(`${base}/api/session`, { headers: { cookie: third } })).status).toBe(401)
  expect((await fetch(`${base}/api/session`, { headers: { cookie: session } })).status).toBe(401)
  const events = (await (await fetch(`${base}/api/activity`, { headers: { cookie: await mint() } })).json()) as { what: string }[]
  expect(events.map((e) => e.what)).toContain('Signed out everywhere')
  // later tests use the module-level cookie, which revokeAll just killed: mint it again
  session = await mint()
})

test('the session carries the device limits', async () => {
  await Bun.write(join(dir, 'github.json'), JSON.stringify({ login: 'octocat', id: 1, name: null, avatar_url: '', token: 'gho_x' }))
  const s = (await (await fetch(`${base}/api/session`, { headers: { cookie: session } })).json()) as { maxDevices: number; idleDays: number }
  expect(s).toMatchObject({ maxDevices: 20, idleDays: 2 })
})

test('a deploy slower than the idle timeout still gets its response', async () => {
  await Bun.write(join(dir, 'github.json'), JSON.stringify({ login: 'octocat', id: 1, name: null, avatar_url: '', token: 'gho_x' }))
  const body = JSON.stringify({ repo: 'a/b', project: 'slow', gitUserName: 'A', gitUserEmail: 'a@b.c' })
  const res = await fetch(`${base}/api/deploy`, { method: 'POST', headers: { cookie: session, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body })
  expect(res.status).toBe(502)
}, 15000)

test('a POST without Sec-Fetch-Site: same-origin is refused before any session check', async () => {
  for (const path of ['/api/auth/logout', '/api/deploy']) {
    const r = await fetch(base + path, { method: 'POST', headers: { cookie: session } })
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({ error: 'cross-site request' })
    expect((await fetch(base + path, { method: 'POST', headers: { cookie: session, 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
  }
  expect((await fetch(`${base}/api/auth/totp`, { method: 'POST', headers: { 'sec-fetch-site': 'same-site' } })).status).toBe(403)
})

test('without Sec-Fetch-Site (plain http, older Safari) the Origin header decides', async () => {
  const post = (headers: Record<string, string>) => fetch(`${base}/api/deploy`, { method: 'POST', headers: { cookie: session, 'content-type': 'application/json', ...headers }, body: '{}' })
  expect((await post({ origin: 'http://localhost:5173' })).status).toBe(400)
  expect((await post({ origin: 'http://evil.example' })).status).toBe(403)
  expect((await post({ origin: 'http://dev.localhost:5173' })).status).toBe(403)
  // Sec-Fetch-Site wins when both are present
  expect((await post({ origin: 'http://localhost:5173', 'sec-fetch-site': 'same-site' })).status).toBe(403)
})

test('Claude sign-in: start answers the link, the code goes to the CLI, and the log holds neither', async () => {
  const url = 'https://claude.com/cai/oauth/authorize?code=true&state=s3cr3t'
  const frame = (s: string) => {
    const h = Buffer.alloc(8)
    h[0] = 1
    h.writeUInt32BE(Buffer.byteLength(s), 4)
    return Buffer.concat([h, Buffer.from(s)])
  }
  let state = 'running'
  let exec = { out: '', code: 0 }
  const cmds: string[][] = []
  dockerFake = async (req) => {
    const path = new URL(req.url).pathname
    if (path === '/containers/json') return Response.json([{ Id: 'c1', Names: ['/dockbench-shop'], State: state, Image: 'x' }])
    if (path === '/containers/c1/exec') return (cmds.push(((await req.json()) as { Cmd: string[] }).Cmd), Response.json({ Id: 'e1' }, { status: 201 }))
    if (path === '/exec/e1/start') return new Response(frame(exec.out))
    if (path === '/exec/e1/json') return Response.json({ ExitCode: exec.code })
    return new Response('down', { status: 500 })
  }
  const post = (path: string, body?: unknown) => fetch(base + path, { method: 'POST', headers: { cookie: session, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(body ?? {}) })
  const start = () => post('/api/containers/c1/claude-login')
  const send = (code: unknown) => post('/api/containers/c1/claude-login/code', { code })
  try {
    for (const path of ['/api/containers/c1/claude-login', '/api/containers/c1/claude-login/code']) {
      expect((await fetch(base + path, { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(401)
      expect((await fetch(base + path, { method: 'POST', headers: { cookie: session, 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    }
    expect((await post('/api/containers/nope/claude-login')).status).toBe(404)

    exec = { out: `If the browser didn't open, visit: ${url}\n`, code: 0 }
    expect(await (await start()).json()).toEqual({ url })
    exec = { out: '', code: 4 }
    const missing = await start()
    expect(missing.status).toBe(409)
    expect(((await missing.json()) as { error: string }).error).toBe('Claude Code is not installed in dockbench-shop')
    exec = { out: 'Opening browser to sign in…\n', code: 5 }
    expect((await start()).status).toBe(502)

    for (const bad of ['', '  ', 42, undefined]) expect((await send(bad)).status).toBe(400)
    exec = { out: 'Paste code here if prompted > Login failed: Request failed with status code 400\n', code: 1 }
    const wrong = await send(' abc#XYZ-secret-code ')
    expect(wrong.status).toBe(400)
    expect(((await wrong.json()) as { error: string }).error).toBe('Login failed: Request failed with status code 400')
    expect(cmds.at(-1)!.at(-1)).toBe('abc#XYZ-secret-code')
    // claude died with nothing after the prompt: its last line is the link, whose state must not reach the log
    exec = { out: `If the browser didn't open, visit: ${url}\nPaste code here if prompted > \n`, code: 137 }
    expect(((await (await send('abc')).json()) as { error: string }).error).toBe("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize")
    exec = { out: '', code: 6 }
    expect((await send('abc#XYZ-secret-code')).status).toBe(409)
    exec = { out: 'Login successful.\n', code: 0 }
    expect(await (await send('abc#XYZ-secret-code')).json()).toEqual({ ok: true })

    const logout = () => post('/api/containers/c1/claude-logout')
    expect((await fetch(base + '/api/containers/c1/claude-logout', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(401)
    exec = { out: 'Successfully logged out from your Anthropic account.\n', code: 0 }
    expect(await (await logout()).json()).toEqual({ ok: true })
    expect(cmds.at(-1)!.at(-1)).toContain('claude auth logout')
    exec = { out: '', code: 4 }
    expect((await logout()).status).toBe(409)
    exec = { out: 'Error: boom\n', code: 1 }
    const failed = await logout()
    expect(failed.status).toBe(502)
    expect(((await failed.json()) as { error: string }).error).toBe('Claude Code sign-out failed: Error: boom')

    const pull = () => post('/api/containers/c1/claude-config')
    expect((await fetch(base + '/api/containers/c1/claude-config', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(401)
    exec = { out: 'abc1234\n', code: 0 }
    expect(await (await pull()).json()).toEqual({ commit: 'abc1234' })
    expect(cmds.at(-1)!.at(-1)).toContain('reset -q --hard FETCH_HEAD')
    exec = { out: '', code: 3 }
    expect((await pull()).status).toBe(409)
    exec = { out: 'fatal: Could not read from remote repository.\n', code: 128 }
    const unreachable = await pull()
    expect(unreachable.status).toBe(502)
    expect(((await unreachable.json()) as { error: string }).error).toBe('Could not download the Claude config: fatal: Could not read from remote repository.')

    const changes = () => fetch(base + '/api/containers/c1/claude-config', { headers: { cookie: session } })
    expect((await fetch(base + '/api/containers/c1/claude-config')).status).toBe(401)
    const diff = 'diff --git a/settings.json b/settings.json\n-  "model": "opus",\n+  "model": "sonnet",\n'
    exec = { out: `3b67f50\n${diff}`, code: 0 }
    expect(await (await changes()).json()).toEqual({ commit: '3b67f50', diff, truncated: false })
    expect(cmds.at(-1)!.at(-1)).toContain('--exclude-standard')
    exec = { out: '3b67f50\n', code: 0 }
    expect(await (await changes()).json()).toEqual({ commit: '3b67f50', diff: '', truncated: false })
    // over the cap: cut at the last whole line
    exec = { out: `3b67f50\n${'+x\n'.repeat(70_000)}`, code: 0 }
    const cut = (await (await changes()).json()) as { diff: string; truncated: boolean }
    expect(cut.truncated).toBe(true)
    expect(cut.diff.length).toBeLessThanOrEqual(200_000)
    expect(cut.diff.endsWith('+x\n')).toBe(true)
    exec = { out: '', code: 3 }
    expect((await changes()).status).toBe(409)
    exec = { out: '', code: 4 }
    expect(((await (await changes()).json()) as { error: string }).error).toBe('dockbench-shop has not downloaded the Claude config yet')
    exec = { out: 'fatal: bad object HEAD\n', code: 1 }
    expect((await changes()).status).toBe(502)

    state = 'exited'
    expect((await changes()).status).toBe(409)
    expect((await pull()).status).toBe(409)
    expect((await start()).status).toBe(409)
    expect((await send('abc#XYZ-secret-code')).status).toBe(409)
    expect((await logout()).status).toBe(409)

    const { readEvents } = await import('./store')
    const events = (await readEvents(dir)).filter((e) => e.what.startsWith('Claude'))
    expect(events.map((e) => e.what)).toContain('Claude signed in')
    expect(events.map((e) => e.what)).toContain('Claude sign-in started')
    expect(events.map((e) => e.what)).toContain('Claude signed out')
    const logged = JSON.stringify(events)
    expect(logged).not.toContain('s3cr3t')
    expect(logged).not.toContain('XYZ-secret')
  } finally {
    dockerFake = null
  }
})

test('devices: list marks the caller, delete revokes one, limits validate and evict at once but keep the caller', async () => {
  await Bun.write(join(dir, 'github.json'), JSON.stringify({ login: 'octocat', id: 1, name: null, avatar_url: '', token: 'gho_x' }))
  const same = { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }
  const a = await mint()
  const b = await mint()
  type Dev = { id: string; current: boolean; device: string; ip: string; lastSeenAt: number }
  const list = (cookie: string) => fetch(`${base}/api/sessions`, { headers: { cookie } }).then((r) => r.json() as Promise<Dev[]>)
  expect((await fetch(`${base}/api/sessions`)).status).toBe(401)
  const seen = await list(a)
  expect(seen.filter((d) => d.current)).toHaveLength(1)
  expect(seen.find((d) => d.current)!.device).toBe('test')
  expect(seen[0].lastSeenAt).toBeGreaterThanOrEqual(seen[seen.length - 1].lastSeenAt)
  const bId = b.slice('session='.length).split('.')[0]
  expect((await fetch(`${base}/api/sessions/${bId}`, { method: 'DELETE', headers: { cookie: a, ...same } })).status).toBe(200)
  expect((await fetch(`${base}/api/sessions/${bId}`, { method: 'DELETE', headers: { cookie: a, ...same } })).status).toBe(404)
  expect((await fetch(`${base}/api/session`, { headers: { cookie: b } })).status).toBe(401)
  const events = (await (await fetch(`${base}/api/activity`, { headers: { cookie: a } })).json()) as { what: string; target: string }[]
  expect(events[0]).toMatchObject({ what: 'Device signed out', target: 'test' })

  const set = (cookie: string, body: unknown) => fetch(`${base}/api/settings/sessions`, { method: 'POST', headers: { cookie, ...same }, body: JSON.stringify(body) })
  expect((await set(a, { maxDevices: 0, idleDays: 2 })).status).toBe(400)
  expect((await set(a, { maxDevices: 5, idleDays: 31 })).status).toBe(400)
  expect((await set(a, { maxDevices: 2.5, idleDays: 2 })).status).toBe(400)
  expect((await set(a, { maxDevices: '3', idleDays: 2 })).status).toBe(400)
  // the cap drops to 1: every other device goes (the shared cookie too), the caller stays whatever its lastSeenAt
  const ok = await set(a, { maxDevices: 1, idleDays: 3 })
  expect(await ok.json()).toEqual({ maxDevices: 1, idleDays: 3 })
  expect((await list(a)).map((d) => d.current)).toEqual([true])
  expect((await fetch(`${base}/api/session`, { headers: { cookie: session } })).status).toBe(401)
  expect((await set(a, { maxDevices: 20, idleDays: 2 })).status).toBe(200)
  session = await mint()
})

test('the live feed needs a session and streams snapshots with the stream headers', async () => {
  expect((await fetch(`${base}/api/live`)).status).toBe(401)
  const ctrl = new AbortController()
  const res = await fetch(`${base}/api/live`, { headers: { cookie: session }, signal: ctrl.signal })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('text/event-stream')
  expect(res.headers.get('cache-control')).toBe('no-store')
  expect(res.headers.get('x-accel-buffering')).toBe('no')
  const rd = res.body!.getReader()
  let text = ''
  // the harness Docker lists slowly, so the first frame after `retry:` is a down event or, if the fake answers, a snapshot
  while (!/event: (down|snapshot)\n/.test(text)) text += new TextDecoder().decode((await rd.read()).value)
  expect(text.startsWith('retry: 2000\n\n')).toBe(true)
  ctrl.abort()
}, 15000)

test('remove: refuses a non-stack container and a second remove, then deletes the stack, the container and the volumes labeled with its project', async () => {
  await Bun.write(join(dir, 'github.json'), JSON.stringify({ login: 'octocat', id: 1, name: null, avatar_url: '', token: 'gho_x' }))
  const post = (cookie: string, site = 'same-origin', id = 'c1') => fetch(`${base}/api/containers/${id}/remove`, { method: 'POST', headers: { cookie, 'sec-fetch-site': site } })
  const seen: string[] = []
  let stacks: { Id: number; Name: string; EndpointId: number }[] = []
  let hold: Promise<void> = Promise.resolve()
  dockerFake = (req) => {
    const u = new URL(req.url)
    seen.push(`docker ${req.method} ${u.pathname}${u.search}`)
    if (u.pathname === '/containers/json') return Response.json([{ Id: 'c1', Names: ['/dockbench-shop'], State: 'exited', Image: 'x' }])
    if (u.pathname === '/containers/c1/json') return Response.json({ Image: 'sha256:a', State: { Status: 'exited', StartedAt: '', FinishedAt: '0001-01-01T00:00:00Z', ExitCode: 0 }, RestartCount: 0, HostConfig: { Memory: 0 }, Config: { Env: [], Image: 'x', Labels: { 'com.docker.compose.project': 'dockbench-shop' } }, Mounts: [{ Destination: '/home/dev', Name: 'dockbench-shop_home' }] })
    if (u.pathname === '/volumes') return Response.json({ Volumes: [{ Name: 'dockbench-shop_home' }] })
    if (req.method === 'DELETE') return new Response(null, { status: 204 })
    return new Response('down', { status: 500 })
  }
  portainerFake = async (req) => {
    const u = new URL(req.url)
    seen.push(`portainer ${req.method} ${u.pathname}`)
    if (u.pathname === '/api/stacks') return (await hold, Response.json(stacks))
    if (u.pathname === '/api/stacks/3/file') return Response.json({ StackFileContent: '' })
    if (u.pathname === '/api/stacks/3' && req.method === 'GET') return Response.json({ Env: [{ name: 'PROJECT', value: 'shop' }, { name: 'SSH_KEY', value: '' }, { name: 'CLAUDE_CONFIG_REPO', value: '' }] })
    if (u.pathname === '/api/stacks/3' && req.method === 'DELETE') return new Response(null, { status: 204 })
    return new Response('down', { status: 500 })
  }
  try {
    expect((await post('')).status).toBe(401)
    expect((await post(session, 'cross-site')).status).toBe(403)
    expect((await post(session, 'same-origin', 'nope')).status).toBe(404)
    const lone = await post(session)
    expect(lone.status).toBe(409)
    expect(((await lone.json()) as { error: string }).error).toContain('is not a Portainer stack')

    stacks = [{ Id: 3, Name: 'dockbench-shop', EndpointId: 1 }]
    let release = () => {}
    hold = new Promise((r) => { release = r })
    seen.length = 0
    const first = post(session)
    while (!seen.includes('portainer GET /api/stacks')) await Bun.sleep(5)
    // the first remove holds the container, so a second one is refused before it touches anything
    expect((await post(session)).status).toBe(409)
    release()
    const res = await first
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ volumes: 1, keys: 0 })
    expect(seen).toContain('portainer DELETE /api/stacks/3')
    expect(seen).toContain('docker DELETE /containers/c1?force=true')
    expect(seen).toContain(`docker GET /volumes?filters=${encodeURIComponent(JSON.stringify({ label: ['com.docker.compose.project=dockbench-shop'] }))}`)
    expect(seen).toContain('docker DELETE /volumes/dockbench-shop_home')
    const { readEvents } = await import('./store')
    expect((await readEvents(dir)).find((e) => e.target === 'dockbench-shop' && e.what.startsWith('Remove'))?.what).toBe('Removed')
  } finally {
    dockerFake = null
    portainerFake = null
  }
})

test('dashboard update pulls the collector image too and redeploys the stack when only the collector is newer', async () => {
  const seen: string[] = []
  const rows: Record<string, { Id: string; img: string; ref: string }> = {
    'dockbench-dashboard': { Id: 'd1', img: 'sha256:dash', ref: 'ghcr.io/sander972/dockbench-dashboard:latest' },
    'dockbench-collector': { Id: 'k1', img: 'sha256:old', ref: 'ghcr.io/sander972/dockbench-collector:latest' },
  }
  const newest: Record<string, string> = { 'ghcr.io/sander972/dockbench-dashboard:latest': 'sha256:dash', 'ghcr.io/sander972/dockbench-collector:latest': 'sha256:new' }
  dockerFake = (req) => {
    const u = new URL(req.url)
    seen.push(`docker ${req.method} ${u.pathname}`)
    if (u.pathname === '/containers/json') {
      const name = (JSON.parse(u.searchParams.get('filters') ?? '{}') as { name?: string[] }).name?.[0]?.slice(2, -1) ?? ''
      const r = rows[name]
      return Response.json(r ? [{ Id: r.Id, Names: [`/${name}`], State: 'running', Image: r.ref }] : [])
    }
    const r = Object.values(rows).find((x) => u.pathname === `/containers/${x.Id}/json`)
    if (r) return Response.json({ Image: r.img, State: { Status: 'running', StartedAt: '2026-11-08T10:00:00Z', FinishedAt: '0001-01-01T00:00:00Z', ExitCode: 0 }, RestartCount: 0, HostConfig: { Memory: 0 }, Config: { Env: [], Image: r.ref, Labels: { 'com.docker.compose.project': 'dockbench-dashboard' } }, Mounts: [] })
    const ref = Object.keys(newest).find((k) => u.pathname === `/images/${k}/json`)
    if (ref) return Response.json({ Id: newest[ref], RepoDigests: [] })
    return new Response('down', { status: 500 })
  }
  portainerFake = (req) => {
    const u = new URL(req.url)
    seen.push(`portainer ${req.method} ${u.pathname}${u.pathname.endsWith('/images/create') ? u.search : ''}`)
    if (u.pathname === '/api/registries') return Response.json([])
    if (u.pathname.endsWith('/docker/images/create')) return new Response('{"status":"done"}\n')
    if (u.pathname === '/api/stacks') return Response.json([{ Id: 5, Name: 'dockbench-dashboard', EndpointId: 1 }])
    if (u.pathname === '/api/stacks/5/file') return Response.json({ StackFileContent: 'services: {}' })
    if (u.pathname === '/api/stacks/5') return req.method === 'PUT' ? Response.json({}) : Response.json({ Env: [] })
    return new Response('down', { status: 500 })
  }
  try {
    const res = await fetch(`${base}/api/system/dashboard/update`, { method: 'POST', headers: { cookie: session, 'sec-fetch-site': 'same-origin' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: 'd1', upToDate: false, restarting: true })
    expect(seen).toContain('portainer POST /api/endpoints/1/docker/images/create?fromImage=ghcr.io%2Fsander972%2Fdockbench-collector&tag=latest')
    await Bun.sleep(1300)
    expect(seen).toContain('portainer PUT /api/stacks/5')
    expect(seen).not.toContain('docker POST /containers/d1/restart')
    const sys = (await (await fetch(`${base}/api/system`, { headers: { cookie: session } })).json()) as Record<string, { name: string; imageUpdate: boolean | null }>
    expect(sys.collector).toMatchObject({ name: 'dockbench-collector', imageUpdate: true })
    expect(sys.dashboard).toMatchObject({ imageUpdate: false })
  } finally {
    dockerFake = null
    portainerFake = null
  }
})

test('config re-PUT adds CPUSET from the host core count, so an older stack gets the reserve without an option change; a matching CPUSET with nothing else changed, or an unknown core count, still answers 409', async () => {
  testHooks.resetInfo()
  await Bun.write(join(dir, 'github.json'), JSON.stringify({ login: 'octocat', id: 1, name: null, avatar_url: '', token: 'gho_x' }))
  const image = 'ghcr.io/x/dockbench:latest'
  const older = [{ name: 'PROJECT', value: 'shop' }, { name: 'DOCKBENCH_IMAGE', value: image }, { name: 'SSH_KEY', value: 'k' }, { name: 'INSTALL_CLAUDE', value: '1' }, { name: 'CLAUDE_CONFIG_REPO', value: '' }, { name: 'CLAUDE_CONFIG_KEY', value: '' }, { name: 'VSCODE_CONFIG', value: '1' }, { name: 'VSCODE_SETTINGS', value: '' }]
  let stackEnv = older
  let put: { env: { name: string; value: string }[] } | null = null
  let infoUp = false
  dockerFake = (req) => {
    const u = new URL(req.url)
    if (u.pathname === '/info') return infoUp ? Response.json({ Name: 'vps', NCPU: 4, MemTotal: 8e9, ServerVersion: '29' }) : new Response('down', { status: 500 })
    // the recreated container shows up under a new id once the stack is PUT
    if (u.pathname === '/containers/json') return Response.json([{ Id: put ? 'c2' : 'c1', Names: ['/dockbench-shop'], State: 'running', Image: image }])
    if (u.pathname === '/containers/c1/json') return Response.json({ Image: 'sha256:a', State: { Status: 'running', StartedAt: '2026-11-09T10:00:00Z', FinishedAt: '0001-01-01T00:00:00Z', ExitCode: 0 }, RestartCount: 0, HostConfig: { Memory: 0 }, Config: { Env: [], Image: image, Labels: { 'com.docker.compose.project': 'dockbench-shop' } }, Mounts: [] })
    if (u.pathname === `/images/${image}/json`) return Response.json({ Id: 'sha256:a', RepoDigests: [] })
    return new Response('down', { status: 500 })
  }
  portainerFake = async (req) => {
    const u = new URL(req.url)
    if (u.pathname === '/api/stacks') return Response.json([{ Id: 4, Name: 'dockbench-shop', EndpointId: 1 }])
    if (u.pathname === '/api/stacks/4/file') return Response.json({ StackFileContent: '' })
    if (u.pathname === '/api/stacks/4' && req.method === 'GET') return Response.json({ Env: stackEnv })
    if (u.pathname === '/api/stacks/4' && req.method === 'PUT') return (put = (await req.json()) as typeof put, Response.json({}))
    return new Response('down', { status: 500 })
  }
  const same = { installClaude: true, injectClaudeConfig: false, vscodeConfig: true }
  const post = () => fetch(`${base}/api/containers/c1/config`, { method: 'POST', headers: { cookie: session, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify(same) })
  try {
    // /info down (a failure is not cached): the stack keeps the CPUSET it has, so the same options still answer 409 instead of unpinning and recreating it
    stackEnv = [...older, { name: 'CPUSET', value: '1-3' }]
    expect((await post()).status).toBe(409)
    expect(put).toBeNull()

    infoUp = true
    stackEnv = older
    const res = await post()
    expect(res.status).toBe(200)
    expect(put!.env).toContainEqual({ name: 'CPUSET', value: '1-3' })
    expect(put!.env.filter((e) => e.name !== 'CPUSET')).toEqual(older)

    stackEnv = [...older, { name: 'CPUSET', value: '1-3' }]
    put = null
    const again = await post()
    expect(again.status).toBe(409)
    expect(((await again.json()) as { error: string }).error).toContain('already runs with these options')
    expect(put).toBeNull()
  } finally {
    dockerFake = null
    portainerFake = null
  }
})

test('a dev container deploy and a Telegram deploy pass CPUSET from the host core count to the new stack', async () => {
  await Bun.write(join(dir, 'github.json'), JSON.stringify({ login: 'octocat', id: 1, name: null, avatar_url: '', token: 'gho_x' }))
  testHooks.resetInfo()
  const created: Record<string, { name: string; value: string }[]> = {}
  dockerFake = (req) => {
    const u = new URL(req.url)
    if (u.pathname === '/info') return Response.json({ Name: 'vps', NCPU: 4, MemTotal: 8e9, ServerVersion: '29' })
    // the Telegram deploy asks by name for its own container, which never exists here
    if (u.pathname === '/containers/json') return Response.json(created['dockbench-cpu'] && !u.searchParams.get('filters')?.includes('telegram') ? [{ Id: 'n1', Names: ['/dockbench-cpu'], State: 'running', Image: 'x' }] : [])
    return new Response('down', { status: 500 })
  }
  portainerFake = async (req) => {
    const u = new URL(req.url)
    if (u.pathname === '/api/stacks') return Response.json([])
    if (u.pathname === '/api/registries') return Response.json([])
    if (u.pathname === '/api/endpoints/1/docker/images/create') return new Response('{"status":"done"}\n')
    if (u.pathname === '/api/stacks/create/standalone/string') {
      const b = (await req.json()) as { name: string; env: { name: string; value: string }[] }
      created[b.name] = b.env
      return Response.json({ Id: 9 })
    }
    return new Response('down', { status: 500 })
  }
  externalFake = (req) => (new URL(req.url).pathname.endsWith('/getMe') ? Response.json({ ok: true, result: { username: 'mybot' } }) : new Response('unexpected', { status: 500 }))
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { cookie: session, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(body) })
  try {
    const dev = await post('/api/deploy', { repo: 'a/b', project: 'cpu', gitUserName: 'A', gitUserEmail: 'a@b.c', ghLogin: true })
    expect(dev.status).toBe(201)
    expect(created['dockbench-cpu']).toContainEqual({ name: 'CPUSET', value: '1-3' })
    const tg = await post('/api/telegram/deploy', { token: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', dockerGid: '999' })
    expect(tg.status).toBe(201)
    expect(created['dockbench-telegram']).toContainEqual({ name: 'CPUSET', value: '1-3' })
    expect(created['dockbench-telegram']).toContainEqual({ name: 'DOCKER_GID', value: '999' })
  } finally {
    dockerFake = null
    portainerFake = null
    externalFake = null
  }
})

test('config end to end: dropping the Claude config removes every duplicate key, the VS Code env is patched only on a flip, the same env answers 409', async () => {
  await Bun.write(join(dir, 'github.json'), JSON.stringify({ login: 'octocat', id: 1, name: null, avatar_url: '', token: 'gho_x' }))
  await Bun.write(join(dir, 'settings.json'), JSON.stringify({ maxDevices: 20, claudeConfigRepo: 'octocat/cfg', vscodeSettings: '{"a":1}' }))
  testHooks.resetInfo()
  const image = 'ghcr.io/x/dockbench:latest'
  const base0 = [{ name: 'PROJECT', value: 'cfg' }, { name: 'DOCKBENCH_IMAGE', value: image }, { name: 'SSH_KEY', value: 'k' }, { name: 'INSTALL_CLAUDE', value: '1' }, { name: 'CLAUDE_CONFIG_REPO', value: 'git@github.com:octocat/cfg.git' }, { name: 'CLAUDE_CONFIG_KEY', value: 'ck' }, { name: 'VSCODE_CONFIG', value: '1' }, { name: 'VSCODE_SETTINGS', value: 'old' }, { name: 'CPUSET', value: '1-3' }]
  let stackEnv = base0
  let put: { env: { name: string; value: string }[] } | null = null
  let containerId = 'k1'
  const github: string[] = []
  dockerFake = (req) => {
    const u = new URL(req.url)
    if (u.pathname === '/info') return Response.json({ Name: 'vps', NCPU: 4, MemTotal: 8e9, ServerVersion: '29' })
    if (u.pathname === '/containers/json') return Response.json([{ Id: containerId, Names: ['/dockbench-cfg'], State: 'running', Image: image }])
    if (u.pathname === `/containers/${containerId}/json`) return Response.json({ Image: 'sha256:a', State: { Status: 'running', StartedAt: '2026-11-09T10:00:00Z', FinishedAt: '0001-01-01T00:00:00Z', ExitCode: 0 }, RestartCount: 0, HostConfig: { Memory: 0 }, Config: { Env: [], Image: image, Labels: { 'com.docker.compose.project': 'dockbench-cfg' } }, Mounts: [] })
    if (u.pathname === `/images/${image}/json`) return Response.json({ Id: 'sha256:a', RepoDigests: [] })
    return new Response('down', { status: 500 })
  }
  portainerFake = async (req) => {
    const u = new URL(req.url)
    if (u.pathname === '/api/stacks') return Response.json([{ Id: 6, Name: 'dockbench-cfg', EndpointId: 1 }])
    if (u.pathname === '/api/stacks/6/file') return Response.json({ StackFileContent: '' })
    if (u.pathname === '/api/stacks/6' && req.method === 'GET') return Response.json({ Env: stackEnv })
    if (u.pathname === '/api/stacks/6' && req.method === 'PUT') {
      put = (await req.json()) as typeof put
      stackEnv = put!.env
      containerId = containerId === 'k1' ? 'k2' : 'k1' // recreated under a new id, so the route does not wait for the replacement
      return Response.json({})
    }
    return new Response('down', { status: 500 })
  }
  externalFake = (req) => {
    const u = new URL(req.url)
    github.push(`${req.method} ${u.pathname}`)
    if (req.method === 'GET' && u.pathname === '/repos/octocat/cfg/keys') return Response.json([{ id: 1, title: 'dockbench-cfg', read_only: true }, { id: 2, title: 'dockbench-cfg', read_only: true }, { id: 3, title: 'dockbench-cfg', read_only: false }, { id: 4, title: 'dockbench-other', read_only: true }])
    if (req.method === 'DELETE') return new Response(null, { status: 204 })
    return new Response('unexpected', { status: 500 })
  }
  const post = (b: { installClaude: boolean; injectClaudeConfig: boolean; vscodeConfig: boolean }) => fetch(`${base}/api/containers/${containerId}/config`, { method: 'POST', headers: { cookie: session, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify(b) })
  const val = (k: string) => put!.env.find((e) => e.name === k)?.value
  try {
    // config off, VS Code unchanged: the stack drops the config repo and key, keeps the VS Code settings it has, and both read-only keys with the container's title go
    const off = await post({ installClaude: true, injectClaudeConfig: false, vscodeConfig: true })
    expect(off.status).toBe(200)
    expect([val('CLAUDE_CONFIG_REPO'), val('CLAUDE_CONFIG_KEY'), val('VSCODE_SETTINGS')]).toEqual(['', '', 'old'])
    expect(github).toEqual(['GET /repos/octocat/cfg/keys', 'DELETE /repos/octocat/cfg/keys/1', 'DELETE /repos/octocat/cfg/keys/2'])

    // VS Code flipped off: its env is patched, nothing on GitHub is touched
    github.length = 0
    put = null
    expect((await post({ installClaude: true, injectClaudeConfig: false, vscodeConfig: false })).status).toBe(200)
    expect(val('VSCODE_CONFIG')).toBe('0')
    expect(github).toEqual([])

    // the same options again: same env on the same image, nothing to recreate
    put = null
    const same = await post({ installClaude: true, injectClaudeConfig: false, vscodeConfig: false })
    expect(same.status).toBe(409)
    expect(put).toBeNull()
  } finally {
    dockerFake = null
    portainerFake = null
    externalFake = null
    await Bun.write(join(dir, 'settings.json'), JSON.stringify({ maxDevices: 20 }))
  }
})

test('a second deploy of the same project while the first runs answers 409 at once', async () => {
  await Bun.write(join(dir, 'github.json'), JSON.stringify({ login: 'octocat', id: 1, name: null, avatar_url: '', token: 'gho_x' }))
  dockerFake = async (req) => (new URL(req.url).pathname === '/containers/json' ? (await Bun.sleep(300), Response.json([])) : new Response('down', { status: 500 }))
  const post = () => fetch(`${base}/api/deploy`, { method: 'POST', headers: { cookie: session, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ repo: 'a/b', project: 'twice', gitUserName: 'A', gitUserEmail: 'a@b.c', ghLogin: true }) })
  try {
    const first = post()
    await Bun.sleep(50)
    const second = await post()
    expect(second.status).toBe(409)
    expect(((await second.json()) as { error: string }).error).toBe('A deploy of dockbench-twice is already running')
    expect((await first).status).toBe(502) // Portainer is down in this test, so the first one fails after its list
    // the lock is released when the first one ends
    expect((await post()).status).toBe(502)
  } finally {
    dockerFake = null
  }
})

test('a Telegram stack create whose answer was lost but that Portainer created answers 201 with a warning', async () => {
  let created = false
  dockerFake = (req) => (new URL(req.url).pathname === '/containers/json' ? Response.json([]) : new Response('down', { status: 500 }))
  portainerFake = (req) => {
    const u = new URL(req.url)
    if (u.pathname === '/api/stacks') return Response.json(created ? [{ Id: 8, Name: 'dockbench-telegram', EndpointId: 1 }] : [])
    if (u.pathname === '/api/registries') return Response.json([])
    if (u.pathname === '/api/endpoints/1/docker/images/create') return new Response('{"status":"done"}\n')
    if (u.pathname === '/api/stacks/create/standalone/string') return (created = true, new Response('gateway timeout', { status: 504 }))
    return new Response('down', { status: 500 })
  }
  externalFake = () => Response.json({ ok: true, result: { username: 'mybot' } })
  try {
    const res = await fetch(`${base}/api/telegram/deploy`, { method: 'POST', headers: { cookie: session, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ token: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', dockerGid: '999' }) })
    expect(res.status).toBe(201)
    expect(((await res.json()) as { warning?: string }).warning).toContain("Portainer created the stack, but its answer was lost")
  } finally {
    dockerFake = null
    portainerFake = null
    externalFake = null
  }
})

// last in the file: passkeys.json turns on step-up, undone at the end
test('passkey sign-in mints a session and a step-up window; guarded actions and passkey changes need that window', async () => {
  const { softKey } = await import('./softkey')
  const { verifyRegistration, writePasskeys } = await import('./passkey')
  await Bun.write(join(dir, 'github.json'), JSON.stringify({ login: 'octocat', id: 7, name: null, avatar_url: '', token: 'gho_x' }))
  const same = { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }
  const post = (path: string, body: unknown, cookie = '') => fetch(base + path, { method: 'POST', headers: { cookie, ...same }, body: JSON.stringify(body) })
  const del = (path: string, cookie: string) => fetch(base + path, { method: 'DELETE', headers: { cookie, ...same } })
  const cookieOf = (r: Response, name: string) => r.headers.getSetCookie().find((c) => c.startsWith(name + '='))!.split(';')[0]
  const opts = async (path: string, cookie = '') => (await (await post(path, {}, cookie)).json()) as { challenge: string; rpId: string; allowCredentials: unknown[]; excludeCredentials: unknown[] }
  const deploy = (cookie: string) => post('/api/deploy', {}, cookie)

  expect((await post('/api/auth/passkey/options', {})).status).toBe(400)
  // without a passkey nothing asks for one: deploy goes straight to body validation
  expect((await deploy(session)).status).toBe(400)

  const key = softKey('localhost', 'http://localhost:5173')
  const reg = verifyRegistration(key.create('seed'), { challenge: 'seed', rpId: 'localhost', origin: 'http://localhost:5173' })
  await writePasskeys(dir, { creds: [{ ...reg, name: 'laptop', createdAt: '', lastUsedAt: null }], stepUp: { stop: true, restart: true, pull: true, deploy: true, update: true, remove: true } })

  const refused = await deploy(session)
  expect(refused.status).toBe(403)
  expect(await refused.json()).toEqual({ error: 'step_up_required' })

  const login = await opts('/api/auth/passkey/options')
  expect(login.rpId).toBe('localhost')
  expect(login.allowCredentials).toEqual([])
  expect((await post('/api/auth/passkey/verify', key.get(login.challenge, { o: 'http://evil.example' }))).status).toBe(400)
  // the failed try used up that challenge
  expect((await post('/api/auth/passkey/verify', key.get(login.challenge))).status).toBe(400)
  const ok = await post('/api/auth/passkey/verify', key.get((await opts('/api/auth/passkey/options')).challenge))
  expect(ok.status).toBe(200)
  const s = cookieOf(ok, 'session')
  const u = cookieOf(ok, 'step_up')

  const me = (await (await fetch(`${base}/api/session`, { headers: { cookie: `${s}; ${u}` } })).json()) as { stepUpUntil: number }
  expect(me).toMatchObject({ user: 'octocat', email: '7+octocat@users.noreply.github.com', passkeys: 1, stepUp: { deploy: true } })
  expect(me.stepUpUntil).toBeGreaterThan(Date.now())
  expect((await deploy(`${s}; ${u}`)).status).toBe(400)
  expect((await deploy(s)).status).toBe(403)
  expect((await post('/api/containers/abc/vscode', {}, s)).status).toBe(403)
  // remove has its own step-up, checked before the container is even looked up
  expect((await post('/api/containers/abc/remove', {}, s)).status).toBe(403)
  expect(await (await post('/api/containers/abc/remove', {}, s)).json()).toEqual({ error: 'step_up_required' })
  // a session cookie never passes as a step-up cookie
  expect((await deploy(`${s}; step_up=${s.slice('session='.length)}`)).status).toBe(403)
  // a step-up cookie from one device never passes with another device's session
  const other = await mint()
  expect((await deploy(`${other}; ${u}`)).status).toBe(403)

  const step = await opts('/api/auth/step-up/options', s)
  expect(step.allowCredentials).toEqual([{ type: 'public-key', id: key.id }])
  const granted = await post('/api/auth/step-up/verify', key.get(step.challenge), s)
  expect(granted.status).toBe(200)
  expect((await deploy(`${s}; ${cookieOf(granted, 'step_up')}`)).status).toBe(400)

  // a second passkey, loosening a guard and removing a passkey all need the window
  expect((await post('/api/passkeys/options', {}, s)).status).toBe(403)
  expect((await post('/api/settings/step-up', { deploy: false }, s)).status).toBe(403)
  expect((await post('/api/settings/step-up', { deploy: false }, `${s}; ${u}`)).status).toBe(200)
  expect((await deploy(s)).status).toBe(400)
  const key2 = softKey('localhost', 'http://localhost:5173')
  const add = await opts('/api/passkeys/options', `${s}; ${u}`)
  expect(add.excludeCredentials).toEqual([{ type: 'public-key', id: key.id }])
  expect((await post('/api/passkeys', { name: 'phone', credential: key2.create(add.challenge) }, s)).status).toBe(201)
  const list = (await (await fetch(`${base}/api/passkeys`, { headers: { cookie: s } })).json()) as { name: string }[]
  expect(list.map((p) => p.name)).toEqual(['laptop', 'phone'])
  expect(JSON.stringify(list)).not.toContain('jwk')
  expect((await del(`/api/passkeys/${key2.id}`, s)).status).toBe(403)
  expect((await del(`/api/passkeys/${key2.id}`, `${s}; ${u}`)).status).toBe(200)

  await Bun.write(join(dir, 'passkeys.json'), '{}')
})
