import { expect, test, vi } from 'vitest'
import { feedStale, openLive, sessionGone, staleSnapshot, type LiveHandlers } from './live'

// the parts of EventSource the wrapper uses: named listeners, onerror, readyState, close()
class FakeSource {
  static CONNECTING = 0; static OPEN = 1; static CLOSED = 2
  static last: FakeSource
  url: string
  readyState = 0
  onerror: ((e: Event) => void) | null = null
  closed = false
  listeners: Record<string, (e: MessageEvent) => void> = {}
  constructor(url: string) { this.url = url; FakeSource.last = this }
  addEventListener(name: string, fn: (e: MessageEvent) => void) { this.listeners[name] = fn }
  close() { this.closed = true; this.readyState = 2 }
  emit(name: string, data: string) { this.listeners[name]({ data } as MessageEvent) }
}

function handlers(): LiveHandlers & { calls: string[] } {
  const calls: string[] = []
  return { calls, snapshot: s => calls.push('snapshot:' + JSON.stringify(s)), down: e => calls.push('down:' + e), signedOut: () => calls.push('signedOut'), connecting: () => calls.push('connecting'), closed: () => calls.push('closed') }
}

test('maps the three server events to the handlers and parses their JSON', () => {
  vi.stubGlobal('EventSource', FakeSource)
  const h = handlers()
  openLive(h)
  expect(FakeSource.last.url).toBe('/api/live')
  FakeSource.last.emit('snapshot', '{"host":{"reachable":true},"containers":[]}')
  FakeSource.last.emit('down', '{"error":"socket did not answer"}')
  FakeSource.last.emit('signed-out', '{}')
  expect(h.calls).toEqual(['snapshot:{"host":{"reachable":true},"containers":[]}', 'down:socket did not answer', 'signedOut'])
  vi.unstubAllGlobals()
})

test('a connection error while the browser retries says connecting; a closed source (non-2xx answer) says closed; close() closes the source', () => {
  vi.stubGlobal('EventSource', FakeSource)
  const h = handlers()
  const live = openLive(h)
  FakeSource.last.readyState = 0
  FakeSource.last.onerror!(new Event('error'))
  FakeSource.last.readyState = 2
  FakeSource.last.onerror!(new Event('error'))
  expect(h.calls).toEqual(['connecting', 'closed'])
  live.close()
  expect(FakeSource.last.closed).toBe(true)
  vi.unstubAllGlobals()
})

test('sessionGone is true only when the session check answers null: a thrown check (server down) is not a sign-out', async () => {
  expect(await sessionGone(async () => null)).toBe(true)
  expect(await sessionGone(async () => ({ user: 'a' }))).toBe(false)
  expect(await sessionGone(async () => { throw new TypeError('fetch failed') })).toBe(false)
})

test('feedStale flags a feed that has not delivered for three intervals', () => {
  expect(feedStale(10_000, 15_999)).toBe(false)
  expect(feedStale(10_000, 16_001)).toBe(true)
  expect(feedStale(0, 1)).toBe(false)
})

test('staleSnapshot drops a snapshot built before the last forced poll, even when it lands after it', () => {
  const forcedAt = Date.parse('2026-11-09T10:00:01Z') // the forced poll after an action merged first
  expect(staleSnapshot('2026-11-09T10:00:00Z', forcedAt)).toBe(true) // the ticker's build from before the action, landing late
  expect(staleSnapshot('2026-11-09T10:00:02Z', forcedAt)).toBe(false) // the next tick
  expect(staleSnapshot('2026-11-09T10:00:00Z', 0)).toBe(false) // no forced poll yet
})
