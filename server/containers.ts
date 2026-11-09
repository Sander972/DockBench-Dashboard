// What /api/containers adds on top of the Docker API: /status tracking, facts parsed from the log tail, and the slow lookups (disk sizes, registry digests) cached so a poll never waits on them. Kept free of env so tests can drive it with fakes.

export interface DevContainerStatus {
  repo: string | null
  tunnel_name: string | null
  branch: string | null
  dirty: number | null
  last_commit: { sha: string; message: string; date: string } | null
  ahead: number | null
  behind: number | null
  tunnel: 'connected' | 'waiting_for_login' | 'down' | 'unknown'
  mise: Record<string, string>
  workspace_file?: string | null
  claude_installed?: boolean
  claude_logged_in: boolean
  claude_version?: string | null
  claude_plugins?: Record<string, string | null>
  claude_plugin_sync?: { state: 'running' | 'done'; at: string; warnings: string[] } | null
  uptime_seconds: number
}

// the newest device code in the log tail: gh prints "one-time code: XXXX-XXXX", code tunnel "use code XXXX-XXXX"
export function deviceCode(lines: string[]): { code: string; kind: 'gh' | 'tunnel' } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const gh = lines[i].match(/one-time code: ([A-Z0-9]{4}-[A-Z0-9]{4})/)
    if (gh) return { code: gh[1], kind: 'gh' }
    const tunnel = lines[i].match(/use code ([A-Z0-9]{4}-[A-Z0-9]{4})/)
    if (tunnel) return { code: tunnel[1], kind: 'tunnel' }
  }
  return null
}

// the last "fatal:" line, which is why a failing clone puts the container in a restart loop
export function lastError(lines: string[]): string | null {
  return lines.findLast((l) => l.startsWith('fatal:'))?.slice(0, 300) ?? null
}

export interface StatusView {
  status: DevContainerStatus | null
  statusError: 'starting' | 'dead' | null
  statusFetchedAt: string | null
}

interface Track {
  startedAt: string
  status: DevContainerStatus | null
  fetchedAt: string | null
  answered: boolean
  failed: boolean
  inflight: Promise<void> | null
  /** performance.now() when the last request settled; 0 asks at once */
  settled: number
}

// One /status request per container at a time, whatever the number of tabs polling, and none sooner than minMs after the last one settled: the 2 s live tick would otherwise ask every container on every tick for facts (branch, dirty count, tunnel) that change over seconds. A poll waits up to waitMs for the answer, otherwise it reports what is known and the request carries on for the next poll. "starting" until /status answers once since the container (re)started (a restart asks at once), "dead" when it answered before and fails now. ponytail: in memory, so after a dashboard restart a dead status server shows as starting.
export function statusTracker(fetchStatus: (name: string) => Promise<DevContainerStatus>, waitMs = 2000, minMs = 5000) {
  const tracks = new Map<string, Track>()
  return async function view(id: string, name: string, startedAt: string, running: boolean): Promise<StatusView> {
    let t = tracks.get(id)
    if (t && running && t.startedAt !== startedAt) t = { ...t, startedAt, answered: false, failed: false, inflight: null, settled: 0 }
    if (!t) t = { startedAt, status: null, fetchedAt: null, answered: false, failed: false, inflight: null, settled: 0 }
    tracks.set(id, t)
    const track = t
    if (running) {
      if (!track.inflight && (track.settled === 0 || performance.now() - track.settled >= minMs)) {
        track.inflight = fetchStatus(name).then(
          (s) => { track.status = s; track.fetchedAt = new Date().toISOString(); track.answered = true; track.failed = false },
          () => { track.failed = true },
        ).finally(() => { track.inflight = null; track.settled = performance.now() })
      }
      if (track.inflight) await Promise.race([track.inflight, Bun.sleep(waitMs)])
    }
    const statusError = !running ? null : !track.answered ? 'starting' : track.failed ? 'dead' : null
    return { status: track.status, statusError, statusFetchedAt: track.fetchedAt }
  }
}

export async function fetchStatus(url: string): Promise<DevContainerStatus> {
  const res = await fetch(url, { signal: AbortSignal.timeout(40_000) })
  if (!res.ok) throw new Error(`/status returned ${res.status}`)
  const s = (await res.json()) as DevContainerStatus
  if (!s || typeof s !== 'object' || typeof s.mise !== 'object') throw new Error('/status answered something else')
  return s
}

// last good value (initial until the first load answers), reloaded in the background once the last load ended over ttlMs ago, so no call ever waits on load; one load runs at a time. A failed load keeps the last value and is retried after ttlMs (on the next call while there is no value yet), so a failing load does not rerun on every call. Timing from the end of a load keeps a load slower than ttlMs from running back to back. performance.now() is monotonic, so a wall-clock step cannot stall the reloads.
export function shared<T>(ttlMs: number, load: () => Promise<T>, initial: T): () => T {
  let last: { v: T } | null = null
  let ended = 0
  let running: Promise<void> | null = null
  return () => {
    if (!running && (!last || performance.now() - ended > ttlMs)) {
      running = load().then((v) => { last = { v } }, () => {}).finally(() => { running = null; ended = performance.now() })
    }
    return last ? last.v : initial
  }
}

// Inspect answers per container id for the live tick, reused while the container list shows the same state and the answer is younger than ttlMs: inspect changes only when a container starts, stops or restarts (a recreate brings a new id). A state change refetches at once, the ttl bounds a restart the list only ever showed as running (a stopped container has none, so it is not asked again until it starts), and forget() drops one after the dashboard's own action. A failed inspect is not kept.
export function inspectCache<T>(inspect: (id: string) => Promise<T>, ttlMs = 10_000) {
  const known = new Map<string, { state: string; at: number; p: Promise<T> }>()
  return {
    get(id: string, state: string): Promise<T> {
      const k = known.get(id)
      if (k && k.state === state && (state === 'exited' || performance.now() - k.at < ttlMs)) return k.p
      const p = inspect(id)
      known.set(id, { state, at: performance.now(), p })
      p.catch(() => { if (known.get(id)?.p === p) known.delete(id) })
      return p
    },
    forget(id: string) { known.delete(id) },
    // the ids still listed; the others (removed, recreated under a new id) are dropped
    keep(ids: string[]) { const live = new Set(ids); for (const id of known.keys()) if (!live.has(id)) known.delete(id) },
  }
}

// One answer shared for ttlMs from when it arrived, for facts that do not change between ticks (Docker's /info). A failure is not kept, so the next call asks again.
export function ttlCache<T>(ttlMs: number, load: () => Promise<T>): () => Promise<T> {
  let cached: { at: number; p: Promise<T> } | null = null
  return () => {
    if (!cached || performance.now() - cached.at >= ttlMs) {
      const p = load()
      const entry = { at: Number.POSITIVE_INFINITY, p }
      cached = entry
      p.then(() => { entry.at = performance.now() }, () => { if (cached === entry) cached = null })
    }
    return cached.p
  }
}

export interface ImageCheck {
  imageId: string | null
  at: number
  error: string | null
}

// Newest image id per image reference (what the tag points to after a pull). peek never waits: it answers what is known and refreshes in the background when older than ttlMs; check waits, for the "Check for update" button. A failed lookup keeps the last id and is retried after ttlMs.
export function imageChecker(lookup: (ref: string) => Promise<string>, ttlMs = 30 * 60_000) {
  const known = new Map<string, ImageCheck>()
  const running = new Map<string, Promise<void>>()
  const refresh = (ref: string) => {
    let p = running.get(ref)
    if (!p) {
      p = lookup(ref).then(
        (imageId) => { known.set(ref, { imageId, at: Date.now(), error: null }) },
        (e) => { known.set(ref, { imageId: known.get(ref)?.imageId ?? null, at: Date.now(), error: (e as Error).message }) },
      ).finally(() => running.delete(ref))
      running.set(ref, p)
    }
    return p
  }
  return {
    peek(ref: string): ImageCheck | null {
      const k = known.get(ref)
      if (!k || Date.now() - k.at > ttlMs) refresh(ref)
      return k ?? null
    },
    async check(ref: string): Promise<ImageCheck> {
      await refresh(ref)
      return known.get(ref)!
    },
  }
}

// true when the tag now points to another image than the one this container runs. null when unknown, or for a reference pinned by digest, which has nothing to update to.
export function updateAvailable(ref: string, newest: string | null, running: string): boolean | null {
  if (!newest || ref.includes('@')) return null
  return newest !== running
}
