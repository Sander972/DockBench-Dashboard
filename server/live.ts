// Server-Sent Events feed of the host and container snapshot. One ticker for every open stream: it starts with the first subscriber, builds a snapshot every interval through `source` and stops with the last subscriber, so an idle dashboard costs no Docker calls. Each tick first asks `sessionAlive` for every subscriber, so a revoked device is told `signed-out` and closed before it sees another snapshot.
export interface Snapshot { host: unknown; containers: unknown }
export interface LiveOpts { sessionAlive(id: string): Promise<boolean>; intervalMs?: number; retryMs?: number }

type Sub = { id: string; ctrl: ReadableStreamDefaultController<Uint8Array> }

export function createLive(source: () => Promise<Snapshot>, opts: LiveOpts) {
  const interval = opts.intervalMs ?? 2000
  const enc = new TextEncoder()
  const subs = new Set<Sub>()
  let last: { at: number; data: string } | null = null
  let timer: ReturnType<typeof setInterval> | undefined
  let building = false

  const drop = (s: Sub) => {
    if (!subs.delete(s)) return
    try { s.ctrl.close() } catch { /* already closed by the client */ }
    if (!subs.size) { clearInterval(timer); timer = undefined }
  }
  const send = (s: Sub, event: string, data: string) => {
    try { s.ctrl.enqueue(enc.encode(`event: ${event}\ndata: ${data}\n\n`)) } catch { drop(s) }
  }

  // one build at a time: a tick that fires while the previous snapshot is still being built is skipped, not queued
  async function tick() {
    if (building || !subs.size) return
    building = true
    try {
      for (const s of [...subs]) if (!(await opts.sessionAlive(s.id))) { send(s, 'signed-out', '{}'); drop(s) }
      if (!subs.size) return
      let event = 'snapshot', data: string
      try {
        data = JSON.stringify(await source())
        last = { at: Date.now(), data }
      } catch (e) {
        event = 'down'
        data = JSON.stringify({ error: (e as Error).message })
      }
      for (const s of [...subs]) send(s, event, data)
    } finally {
      building = false
    }
  }

  return {
    // the stream for one signed-in device; `sessionId` is only used for the per-tick alive check and never written to the stream
    handle(sessionId: string): Response {
      let sub: Sub
      const body = new ReadableStream<Uint8Array>({
        start(ctrl) {
          sub = { id: sessionId, ctrl }
          subs.add(sub)
          ctrl.enqueue(enc.encode(`retry: ${opts.retryMs ?? 2000}\n\n`))
          // a snapshot younger than one interval is good enough for a newcomer; else build one now
          if (last && Date.now() - last.at < interval) send(sub, 'snapshot', last.data)
          else void tick()
          timer ??= setInterval(() => void tick(), interval)
        },
        cancel() { drop(sub) },
      })
      return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } })
    },
    close() { for (const s of [...subs]) drop(s) },
    get subscribers() { return subs.size },
  }
}
