import { expect, test } from 'bun:test'
import { deviceCode, imageChecker, inspectCache, lastError, shared, statusTracker, ttlCache, updateAvailable, type DevContainerStatus } from './containers'

const st = { tunnel: 'connected', mise: {} } as unknown as DevContainerStatus

test('device code and fatal line come from the newest log lines', () => {
  const log = ['! First copy your one-time code: AAAA-1111', 'Cloning...', 'fatal: repository not found', 'To grant access to the server, please log into https://github.com/login/device and use code BBBB-2222', 'fatal: second']
  expect(deviceCode(log)).toEqual({ code: 'BBBB-2222', kind: 'tunnel' })
  expect(deviceCode(log.slice(0, 3))).toEqual({ code: 'AAAA-1111', kind: 'gh' })
  expect(deviceCode(['nothing'])).toBeNull()
  expect(lastError(log)).toBe('fatal: second')
  expect(lastError([])).toBeNull()
})

test('status is starting until the first answer, dead when it stops answering, starting again after a restart', async () => {
  let answer: () => Promise<DevContainerStatus> = () => Promise.reject(new Error('refused'))
  let calls = 0
  const view = statusTracker(() => (calls++, answer()), 20, 0)

  expect((await view('a', 'x', 't1', true)).statusError).toBe('starting')
  answer = async () => st
  const ok = await view('a', 'x', 't1', true)
  expect(ok.statusError).toBeNull()
  expect(ok.status).toBe(st)
  expect(ok.statusFetchedAt).not.toBeNull()

  answer = () => Promise.reject(new Error('refused'))
  const dead = await view('a', 'x', 't1', true)
  expect(dead.statusError).toBe('dead')
  expect(dead.status).toBe(st)

  // a stopped container keeps the last answer but has no status error, and nothing is fetched
  const before = calls
  expect((await view('a', 'x', 't1', false)).statusError).toBeNull()
  expect(calls).toBe(before)

  expect((await view('a', 'x', 't2', true)).statusError).toBe('starting')
})

test('/status is asked at most once per minMs, at once after a restart', async () => {
  let calls = 0
  const view = statusTracker(async () => (calls++, st), 20, 60)
  await view('a', 'x', 't1', true)
  await view('a', 'x', 't1', true)
  expect(calls).toBe(1)
  await Bun.sleep(70)
  expect((await view('a', 'x', 't1', true)).statusError).toBeNull()
  expect(calls).toBe(2)
  // a restart asks at once, whatever the interval; a failure counts as a request too
  let fail = true
  const flaky = statusTracker(() => (calls++, fail ? Promise.reject(new Error('refused')) : Promise.resolve(st)), 20, 60)
  await flaky('b', 'y', 't1', true)
  fail = false
  expect((await flaky('b', 'y', 't1', true)).statusError).toBe('starting')
  expect((await flaky('b', 'y', 't2', true)).statusError).toBeNull()
  expect(calls).toBe(4)
})

test('a slow /status is never asked twice at once', async () => {
  let calls = 0
  let release!: (s: DevContainerStatus) => void
  const view = statusTracker(() => (calls++, new Promise((r) => (release = r))), 10, 0)
  expect((await view('a', 'x', 't', true)).statusError).toBe('starting')
  expect((await view('a', 'x', 't', true)).statusError).toBe('starting')
  expect(calls).toBe(1)
  release(st)
  await Bun.sleep(1)
  expect((await view('a', 'x', 't', true)).statusError).toBeNull()
})

test('image checks answer from cache and refresh in the background', async () => {
  let digest = 'sha256:1'
  let lookups = 0
  const images = imageChecker(async () => (lookups++, digest), 50)
  expect(images.peek('img:latest')).toBeNull()
  await Bun.sleep(1)
  expect(images.peek('img:latest')?.imageId).toBe('sha256:1')
  expect(lookups).toBe(1)
  digest = 'sha256:2'
  expect((await images.check('img:latest')).imageId).toBe('sha256:2')

  const failing = imageChecker(async () => { throw new Error('denied') })
  expect(await failing.check('img')).toMatchObject({ imageId: null, error: 'denied' })
})

test('an update is available when the tag points to another image than the running one', () => {
  expect(updateAvailable('r/x:latest', 'sha256:new', 'sha256:old')).toBe(true)
  expect(updateAvailable('r/x:latest', 'sha256:old', 'sha256:old')).toBe(false)
  expect(updateAvailable('r/x:latest', null, 'sha256:old')).toBeNull()
  expect(updateAvailable('r/x@sha256:old', 'sha256:new', 'sha256:old')).toBeNull()
})

test('shared never waits, serves the last good value while it reloads and keeps it when a reload fails', async () => {
  let n = 0
  // ttl -1: every call finds the value stale, without depending on Date.now() ticking during Bun.sleep(1)
  const get = shared(-1, async () => { if (++n === 2) throw new Error('busy'); return n }, 0)
  expect(get()).toBe(0) // load 1 starts, the initial value is served meanwhile
  await Bun.sleep(1)
  expect(get()).toBe(1) // reload 2 fails in the background
  await Bun.sleep(1)
  expect(get()).toBe(1) // reload 3 starts, old value served meanwhile
  await Bun.sleep(1)
  expect(get()).toBe(3)
})

test('inspect is reused while the state holds and the answer is young, asked again on a state change, a forget or a failure', async () => {
  let calls = 0
  let fail = false
  const c = inspectCache(async (id) => { calls++; if (fail) throw new Error('down'); return `${id}#${calls}` }, 30)
  expect(await c.get('a', 'running')).toBe('a#1')
  expect(await c.get('a', 'running')).toBe('a#1')
  expect(await c.get('a', 'exited')).toBe('a#2')
  c.forget('a')
  expect(await c.get('a', 'exited')).toBe('a#3')
  await Bun.sleep(40)
  // a stopped container is not asked again past the ttl, only once the list shows another state
  expect(await c.get('a', 'exited')).toBe('a#3')
  expect(await c.get('a', 'running')).toBe('a#4')
  await Bun.sleep(40)
  expect(await c.get('a', 'running')).toBe('a#5')
  fail = true
  c.forget('a')
  await expect(c.get('a', 'exited')).rejects.toThrow('down')
  fail = false
  expect(await c.get('a', 'exited')).toBe('a#7')
  c.keep(['b'])
  expect(await c.get('a', 'exited')).toBe('a#8')
})

test('ttlCache shares one answer for the ttl and keeps no failure', async () => {
  let calls = 0
  let fail = false
  const get = ttlCache(30, async () => { calls++; if (fail) throw new Error('down'); return calls })
  expect(await Promise.all([get(), get()])).toEqual([1, 1])
  expect(await get()).toBe(1)
  await Bun.sleep(40)
  fail = true
  await expect(get()).rejects.toThrow('down')
  fail = false
  expect(await get()).toBe(3)
})
