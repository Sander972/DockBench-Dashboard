import type { DevContainer, HostUsage } from '../types'

export interface Snapshot { host: HostUsage; containers: DevContainer[] }
// connecting: the browser lost the stream and retries by itself. closed: the server answered the reconnect with a non-2xx (a 401 once the session is gone) and the browser gave up; the caller checks the session and decides.
export interface LiveHandlers { snapshot(s: Snapshot): void; down(error: string): void; signedOut(): void; connecting(): void; closed(): void }
export interface Live { close(): void }

// GET /api/live as Server-Sent Events: `snapshot` {host, containers}, `down` {error}, `signed-out` {}
export function openLive(h: LiveHandlers): Live {
  const es = new EventSource('/api/live')
  es.addEventListener('snapshot', e => h.snapshot(JSON.parse((e as MessageEvent).data)))
  es.addEventListener('down', e => h.down((JSON.parse((e as MessageEvent).data) as { error: string }).error))
  es.addEventListener('signed-out', () => h.signedOut())
  es.onerror = () => (es.readyState === EventSource.CLOSED ? h.closed() : h.connecting())
  return { close: () => es.close() }
}

// after the server refused a reconnect: only a null session (401) is a sign-out; a check that throws (server restarting behind the proxy) leaves the feed off for the timer to retry
export async function sessionGone(getSession: () => Promise<unknown>): Promise<boolean> {
  try { return (await getSession()) === null } catch { return false }
}

// a feed that is 'on' but has delivered nothing for three intervals is dead (half-open socket after sleep, a wedged ticker): reconnect it. lastAt 0 means no delivery yet, which the connect path handles
export const feedStale = (lastAt: number, now: number, intervalMs = 2000) => lastAt > 0 && now - lastAt > 3 * intervalMs
