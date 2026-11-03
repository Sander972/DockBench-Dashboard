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
})

const { routes } = await import('./routes')
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
  expect(location).toContain('scope=repo+read%3Auser&')
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
