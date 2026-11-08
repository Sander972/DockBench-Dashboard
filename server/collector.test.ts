import { expect, test } from 'bun:test'
import { createCollector, history, latest, WINDOWS } from './collector'

const snapshot = { at: 1, intervalMs: 2000, host: { ncpu: 4, cpuPct: 42, stealPct: 1, iowaitPct: 0, memTotal: 8, memUsed: 4, load1: 2, load5: 1, load15: 1, psiCpuSome10: 3 }, containers: [], processes: [] }
let fake: (req: Request) => Response | Promise<Response> = () => Response.json(snapshot)
let requests: URL[] = []
const server = Bun.serve({ port: 0, fetch: (req) => (requests.push(new URL(req.url)), fake(req)) })
const base = `http://localhost:${server.port}`

test('latest returns null on timeout, error and no base', async () => {
  fake = async () => (await Bun.sleep(1500), Response.json(snapshot))
  const t = performance.now()
  expect(await latest(base)).toBeNull()
  expect(performance.now() - t).toBeLessThan(1400)
  fake = () => new Response('no sample yet', { status: 503 })
  expect(await latest(base)).toBeNull()
  expect(await latest('http://localhost:1')).toBeNull()
  requests = []
  expect(await createCollector(undefined, 2000).latest()).toBeNull()
  expect(await createCollector('', 2000).latest()).toBeNull()
  expect(requests).toHaveLength(0)
})

test('latest answers the snapshot from /metrics', async () => {
  fake = () => Response.json(snapshot)
  requests = []
  expect((await latest(base))?.host.cpuPct).toBe(42)
  expect(requests[0].pathname).toBe('/metrics')
})

test('createCollector shares one answer per ttl', async () => {
  fake = () => Response.json(snapshot)
  requests = []
  const c = createCollector(base, 200)
  const [a, b] = await Promise.all([c.latest(), c.latest()])
  expect(a?.host.cpuPct).toBe(42)
  expect(b).toBe(a)
  await c.latest()
  expect(requests).toHaveLength(1)
  await Bun.sleep(250)
  await c.latest()
  expect(requests).toHaveLength(2)
})

test('history asks the window and step and throws on 503', async () => {
  fake = () => Response.json({ stepMs: 60_000, points: [] })
  requests = []
  expect(await history(base, '6h', 100_000_000)).toEqual({ stepMs: 60_000, points: [] })
  const q = requests[0].searchParams
  expect(requests[0].pathname).toBe('/history')
  expect(q.get('step')).toBe('60000')
  expect(Number(q.get('to')) - Number(q.get('from'))).toBe(21_600_000)
  expect(Number(q.get('to'))).toBe(100_000_000)
  expect(WINDOWS['24h']).toEqual({ ms: 86_400_000, stepMs: 240_000 })
  fake = () => new Response('down', { status: 503 })
  await expect(history(base, '1h')).rejects.toThrow()
})
