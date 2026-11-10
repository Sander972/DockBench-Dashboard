import { beforeAll, expect, test, vi } from 'vitest'
import type { DevContainer, HostUsage } from './types'
import type { LiveHandlers } from './api/live'

// the store's forced-poll guard against stale live snapshots, with the API and the EventSource faked: only staleSnapshot and the store wiring run for real
let feed: LiveHandlers
const getHost = vi.fn<() => Promise<HostUsage>>()
const getContainers = vi.fn<() => Promise<DevContainer[]>>()
vi.mock('./api', () => ({ api: { getHost: () => getHost(), getContainers: () => getContainers(), getSession: async () => null }, SignedOut: class extends Error {}, StepUpRequired: class extends Error {} }))
vi.mock('./api/live', async (orig) => ({ ...(await orig<typeof import('./api/live')>()), openLive: (h: LiveHandlers) => { feed = h; return { close() {} } } }))
vi.mock('./composables/usePrefs', () => ({ prefs: { poll: 5, notify: false } }))
vi.mock('./lib/notify', () => ({ notify: () => {}, notifyOn: () => false }))
vi.mock('./lib/haptics', () => ({ haptic: () => {} }))
vi.stubGlobal('document', { hidden: false, addEventListener() {}, createElement: () => ({}) })

let s: typeof import('./store')
beforeAll(async () => { s = await import('./store') })

const host = (polledAt: string) => ({ reachable: true, polledAt, name: polledAt }) as HostUsage
const box = (id: string) => ({ id, name: id, state: 'running' }) as DevContainer
const ids = () => s.store.containers.map((c) => c.id)

test('after a forced poll, a snapshot built before it is dropped and a newer one is merged and clears the guard', async () => {
  s.store.session = { user: 'octocat' } as never
  s.connectLive()
  feed.snapshot({ host: host('2026-11-10T10:00:00Z'), containers: [box('a')] })
  expect(s.store.host?.name).toBe('2026-11-10T10:00:00Z')

  getHost.mockResolvedValueOnce(host('2026-11-10T10:00:10Z'))
  getContainers.mockResolvedValueOnce([box('forced')])
  await s.poll({ force: true })
  expect(ids()).toEqual(['forced'])

  s.store.live = 'connecting' // the browser's own reconnect: a dropped snapshot still turns the feed on
  feed.snapshot({ host: host('2026-11-10T10:00:05Z'), containers: [box('stale')] })
  expect(ids()).toEqual(['forced'])
  expect(s.store.host?.name).toBe('2026-11-10T10:00:10Z')
  expect(s.store.live).toBe('on')

  feed.snapshot({ host: host('2026-11-10T10:00:12Z'), containers: [box('new')] })
  expect(ids()).toEqual(['new'])
  // guard cleared: even a snapshot older than the forced poll merges again
  feed.snapshot({ host: host('2026-11-10T10:00:09Z'), containers: [box('after')] })
  expect(ids()).toEqual(['after'])
})

test('a poll whose container list a newer snapshot overtook does not merge it over the snapshot', async () => {
  let answer!: (l: DevContainer[]) => void
  getHost.mockResolvedValueOnce(host('2026-11-10T11:00:00Z'))
  getContainers.mockReturnValueOnce(new Promise((r) => { answer = r }))
  const run = s.poll({ force: true })
  await Promise.resolve()
  await Promise.resolve()
  feed.snapshot({ host: host('2026-11-10T11:00:02Z'), containers: [box('snap')] })
  answer([box('poll')])
  await run
  expect(ids()).toEqual(['snap'])
  expect(s.store.host?.name).toBe('2026-11-10T11:00:02Z')
})

test('connectLive clears the forced-poll guard, so a server clock stepping back does not drop every snapshot for ever', async () => {
  getHost.mockResolvedValueOnce(host('2026-11-10T12:00:00Z'))
  getContainers.mockResolvedValueOnce([box('forced')])
  await s.poll({ force: true })
  feed.snapshot({ host: host('2026-11-10T11:59:00Z'), containers: [box('stepped')] })
  expect(ids()).toEqual(['forced'])
  s.closeLive()
  s.connectLive()
  feed.snapshot({ host: host('2026-11-10T11:59:01Z'), containers: [box('stepped')] })
  expect(ids()).toEqual(['stepped'])
})
