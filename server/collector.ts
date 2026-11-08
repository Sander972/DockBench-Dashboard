// Client of the dockbench-collector container (collector/ in this repo): the latest host, container and process usage from GET /metrics and the history from GET /history. Functions take the base URL, so tests never import env.ts.

export interface Snapshot {
  at: number
  intervalMs: number
  host: { ncpu: number; cpuPct: number; stealPct: number; iowaitPct: number; memTotal: number; memUsed: number; load1: number; load5: number; load15: number; psiCpuSome10: number }
  containers: { id: string; name: string; image: string; dockbench: boolean; cpuPct: number; memUsed: number; memLimit: number }[]
  processes: { comm: string; pids: number[]; container: string; cpuPct: number; rss: number }[]
}

export interface HistoryPoint {
  t: number
  host: { cpuPct: number; stealPct: number; memUsed: number; load1: number }
  containers: Record<string, { name: string; cpuPct: number; memUsed: number }>
  top: Record<string, { comm: string; pids: number[]; cpuPct: number; rss: number }[]>
}

export type Window = '1h' | '6h' | '24h'

// steps that give at most 360 points per window
export const WINDOWS: Record<Window, { ms: number; stepMs: number }> = {
  '1h': { ms: 3_600_000, stepMs: 10_000 },
  '6h': { ms: 21_600_000, stepMs: 60_000 },
  '24h': { ms: 86_400_000, stepMs: 240_000 },
}

// null on any failure, so a down or hung collector never holds the live tick longer than timeoutMs
export async function latest(base: string, timeoutMs = 1000): Promise<Snapshot | null> {
  try {
    const res = await fetch(`${base}/metrics`, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok ? ((await res.json()) as Snapshot) : null
  } catch {
    return null
  }
}

// top false leaves the per-process lists out (empty `top` per point): the graphs outside the Usage page need only host and container figures, about a fifth of the bytes
export async function history(base: string, w: Window, now = Date.now(), top = true): Promise<{ stepMs: number; points: HistoryPoint[] }> {
  const { ms, stepMs } = WINDOWS[w]
  const res = await fetch(`${base}/history?from=${now - ms}&to=${now}&step=${stepMs}&top=${top ? 1 : 0}`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`collector history returned ${res.status}`)
  return (await res.json()) as { stepMs: number; points: HistoryPoint[] }
}

// one /metrics answer (or failure) shared for ttlMs, so the host and container views of one live tick make one call; no base means no collector
export function createCollector(base: string | undefined, ttlMs: number) {
  let cached: { at: number; p: Promise<Snapshot | null> } | null = null
  return {
    latest(): Promise<Snapshot | null> {
      if (!base) return Promise.resolve(null)
      if (!cached || performance.now() - cached.at >= ttlMs) cached = { at: performance.now(), p: latest(base) }
      return cached.p
    },
  }
}
