import { expect, test } from 'bun:test'
import { createLive } from './live'

type Ev = { event: string; data: string }
// reads SSE frames from a response body: `retry:` lines are skipped, each `event:` + `data:` pair becomes one Ev
function reader(res: Response) {
  const rd = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const queue: Ev[] = []
  let done = false
  const pump = async () => {
    while (true) {
      const { value, done: d } = await rd.read()
      if (d) { done = true; return }
      buf += dec.decode(value)
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const event = /^event: (.*)$/m.exec(frame)?.[1]
        const data = /^data: (.*)$/m.exec(frame)?.[1]
        if (event && data !== undefined) queue.push({ event, data })
      }
    }
  }
  void pump()
  const next = async (ms = 1000): Promise<Ev | null> => {
    const until = Date.now() + ms
    while (Date.now() < until) { if (queue.length) return queue.shift()!; if (done) return null; await Bun.sleep(5) }
    return null
  }
  return { next, isDone: () => done, cancel: () => rd.cancel() }
}

test('headers, the first snapshot at once, then one per tick, and the ticker stops with the last subscriber', async () => {
  let n = 0
  const live = createLive(async () => ({ host: { n: ++n }, containers: [] }), { sessionAlive: async () => true, intervalMs: 40 })
  const res = live.handle('s1')
  expect(res.headers.get('content-type')).toBe('text/event-stream')
  expect(res.headers.get('cache-control')).toBe('no-store')
  expect(res.headers.get('x-accel-buffering')).toBe('no')
  const r = reader(res)
  expect(await r.next()).toEqual({ event: 'snapshot', data: '{"host":{"n":1},"containers":[]}' })
  expect(await r.next()).toEqual({ event: 'snapshot', data: '{"host":{"n":2},"containers":[]}' })
  expect(live.subscribers).toBe(1)
  await r.cancel()
  await Bun.sleep(100)
  expect(live.subscribers).toBe(0)
  const calls = n
  await Bun.sleep(100)
  expect(n).toBe(calls)
})

test('a second subscriber gets the latest snapshot without a new source call; closing one keeps the other fed', async () => {
  let n = 0
  const live = createLive(async () => ({ host: { n: ++n }, containers: [] }), { sessionAlive: async () => true, intervalMs: 500 })
  const a = reader(live.handle('same-device'))
  expect((await a.next())!.data).toBe('{"host":{"n":1},"containers":[]}')
  const b = reader(live.handle('same-device'))
  expect((await b.next())!.data).toBe('{"host":{"n":1},"containers":[]}')
  expect(n).toBe(1)
  await a.cancel()
  expect((await b.next(1500))!.data).toBe('{"host":{"n":2},"containers":[]}')
  live.close()
})

test('a throwing source sends down every tick and the stream stays open until the source answers again', async () => {
  let fail = true
  const live = createLive(async () => { if (fail) throw new Error('socket did not answer'); return { host: { ok: 1 }, containers: [] } }, { sessionAlive: async () => true, intervalMs: 40 })
  const r = reader(live.handle('s1'))
  expect(await r.next()).toEqual({ event: 'down', data: '{"error":"socket did not answer"}' })
  expect((await r.next())!.event).toBe('down')
  fail = false
  let ev = await r.next()
  while (ev && ev.event === 'down') ev = await r.next()
  expect(ev).toEqual({ event: 'snapshot', data: '{"host":{"ok":1},"containers":[]}' })
  live.close()
})

test('a revoked session gets signed-out and its stream closes, the others continue', async () => {
  const alive = new Set(['a', 'b'])
  const live = createLive(async () => ({ host: {}, containers: [] }), { sessionAlive: async (id) => alive.has(id), intervalMs: 40 })
  const a = reader(live.handle('a'))
  const b = reader(live.handle('b'))
  await a.next()
  await b.next()
  alive.delete('a')
  let ev = await a.next()
  while (ev && ev.event === 'snapshot') ev = await a.next()
  expect(ev).toEqual({ event: 'signed-out', data: '{}' })
  expect(await a.next(200)).toBeNull()
  expect(a.isDone()).toBe(true)
  expect((await b.next())!.event).toBe('snapshot')
  expect(live.subscribers).toBe(1)
  live.close()
  await Bun.sleep(20)
  expect(b.isDone()).toBe(true)
})

test('a slow source is never overlapped: ticks while one build runs are skipped', async () => {
  let running = 0, overlapped = false
  const live = createLive(async () => { if (running++) overlapped = true; await Bun.sleep(120); running--; return { host: {}, containers: [] } }, { sessionAlive: async () => true, intervalMs: 30 })
  const r = reader(live.handle('s'))
  await r.next()
  await r.next()
  expect(overlapped).toBe(false)
  live.close()
})
