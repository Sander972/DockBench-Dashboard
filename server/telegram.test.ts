import { expect, test } from 'bun:test'
import { botName, dockerGid, getMe, parseGid, setupCode, telegramEnv, validToken } from './telegram'

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'

test('validToken accepts a BotFather token and nothing else', () => {
  expect(validToken(TOKEN)).toBe(true)
  expect(validToken(` ${TOKEN} `)).toBe(true)
  for (const bad of ['', 'abc', '123:short', `x${TOKEN}`, 42, null]) expect(validToken(bad)).toBe(false)
})

test('setupCode takes the newest code when several boots printed one', () => {
  const lines = [
    '2026-10-14 10:00:00,000 INFO setup: open a private chat with @mybot and send: /setup 0123456789abcdef',
    '2026-10-14 10:00:01,000 INFO polling from offset 0, docker at unix:///var/run/docker.sock',
    '2026-10-14 10:05:00,000 INFO setup: open a private chat with @mybot and send: /setup fedcba9876543210',
  ]
  expect(setupCode(lines)).toBe('fedcba9876543210')
  expect(setupCode(lines.slice(0, 2))).toBe('0123456789abcdef')
  expect(setupCode(['setup: send /setup@mybot in the forum group'])).toBeNull()
  expect(setupCode([])).toBeNull()
})

test('telegramEnv sets the token, the socket group and the cpuset', () => {
  expect(telegramEnv(TOKEN, 999, '1-3')).toEqual([{ name: 'TELEGRAM_BOT_TOKEN', value: TOKEN }, { name: 'DOCKER_GID', value: '999' }, { name: 'CPUSET', value: '1-3' }])
})

test('getMe answers the username and never leaks the token in an error', async () => {
  const ok = (async () => Response.json({ ok: true, result: { username: 'mybot' } })) as unknown as typeof fetch
  expect(await getMe(TOKEN, ok)).toBe('mybot')
  const refused = (async () => Response.json({ ok: false, description: 'Unauthorized' }, { status: 401 })) as unknown as typeof fetch
  const e1 = await getMe(TOKEN, refused).catch((e) => e)
  expect(e1.status).toBe(400)
  expect(e1.message).toBe('Telegram refused the token: Unauthorized')
  const down = (async (url: string) => { throw new Error(`connect failed ${url}`) }) as unknown as typeof fetch
  const e2 = await getMe(TOKEN, down).catch((e) => e)
  expect(e2.status).toBe(502)
  expect(e2.message).not.toContain(TOKEN)
})

test('dockerGid is null for a tcp host or a missing socket', async () => {
  expect(await dockerGid('tcp://proxy:2375')).toBeNull()
  expect(await dockerGid('/nonexistent/docker.sock')).toBeNull()
})

test('botName asks Telegram with the container own token, once per container, never trusting /status', async () => {
  const docker = Bun.serve({ port: 0, fetch: () => Response.json({ Config: { Env: ['PATH=/usr/bin', `TELEGRAM_BOT_TOKEN=${TOKEN}`] } }) })
  const asked: string[] = []
  const tg = (async (url: string) => (asked.push(url), Response.json({ ok: true, result: { username: 'realbot' } }))) as unknown as typeof fetch
  const host = `http://localhost:${docker.port}`
  expect(await botName(host, 'c1', tg)).toBe('realbot')
  expect(await botName(host, 'c1', tg)).toBe('realbot')
  expect(asked).toEqual([`https://api.telegram.org/bot${TOKEN}/getMe`])
  docker.stop()
})

test('parseGid takes a whole number or a digit string, reads blank as not given and anything else as invalid', () => {
  expect(parseGid(999)).toBe(999)
  expect(parseGid('999')).toBe(999)
  expect(parseGid(0)).toBe(0)
  for (const v of [undefined, null, '']) expect(parseGid(v)).toBeNull()
  for (const v of ['abc', ' ', '1e3', '-1', -1, 1.5, false, true, [], {}]) expect(parseGid(v)).toBe('invalid')
})
