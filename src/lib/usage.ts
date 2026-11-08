// Pure views over the /api/utilization answer. Containers are keyed by id in the collector and by name here: the ids of one name (a container recreated during the window) join into one row and one series. The key 'host' stands for what the host used outside every container.
import type { UsageWindow, Utilization } from '../types'

export interface Pt { t: number; v: number }

export const HOST = 'host'

export const WINDOW_MS: Record<UsageWindow, number> = { '1h': 3_600_000, '6h': 21_600_000, '24h': 86_400_000 }
export const WINDOW_LABEL: Record<UsageWindow, string> = { '1h': 'Last hour', '6h': 'Last 6 hours', '24h': 'Last 24 hours' }

// the time span a graph draws: the window ending at the collector's latest sample
export function span(u: Utilization): { from: number; to: number } {
  return { from: u.at - WINDOW_MS[u.window], to: u.at }
}

export function hostSeries(u: Utilization): { cpu: Pt[]; steal: Pt[]; mem: Pt[] } {
  return {
    cpu: u.points.map((p) => ({ t: p.t, v: p.host.cpuPct })),
    steal: u.points.map((p) => ({ t: p.t, v: p.host.stealPct })),
    mem: u.points.map((p) => ({ t: p.t, v: p.host.memUsed })),
  }
}

export function byName(u: Utilization): Map<string, { ids: string[]; dockbench: boolean }> {
  const m = new Map<string, { ids: string[]; dockbench: boolean }>()
  for (const [id, n] of Object.entries(u.names)) {
    const e = m.get(n.name) ?? { ids: [], dockbench: false }
    e.ids.push(id)
    e.dockbench ||= n.dockbench
    m.set(n.name, e)
  }
  for (const e of m.values()) e.ids.sort()
  return m
}

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)

// the sum over the ids per point, leaving out points where none of them ran, so a container that did not exist yet is a gap; ['host'] is the host total minus every container
export function containerSeries(u: Utilization, ids: string[]): { cpu: Pt[]; mem: Pt[] } {
  const cpu: Pt[] = [], mem: Pt[] = []
  for (const p of u.points) {
    const cs = Object.values(p.containers)
    if (ids.length === 1 && ids[0] === HOST) {
      cpu.push({ t: p.t, v: Math.max(0, p.host.cpuPct - sum(cs.map((c) => c.cpuPct))) })
      mem.push({ t: p.t, v: Math.max(0, p.host.memUsed - sum(cs.map((c) => c.memUsed))) })
      continue
    }
    const here = ids.map((id) => p.containers[id]).filter((c) => c !== undefined)
    if (!here.length) continue
    cpu.push({ t: p.t, v: sum(here.map((c) => c.cpuPct)) })
    mem.push({ t: p.t, v: sum(here.map((c) => c.memUsed)) })
  }
  return { cpu, mem }
}

// current CPU and memory from the snapshot (the host group has none: its newest point), average and peak CPU over the window
export function summarize(u: Utilization, ids: string[]): { cur: number; avg: number; peak: number; mem: number } {
  const s = containerSeries(u, ids)
  const avg = s.cpu.length ? sum(s.cpu.map((p) => p.v)) / s.cpu.length : 0
  const peak = Math.max(0, ...s.cpu.map((p) => p.v))
  if (ids.length === 1 && ids[0] === HOST) return { cur: s.cpu.at(-1)?.v ?? 0, avg, peak, mem: s.mem.at(-1)?.v ?? 0 }
  const now = u.containers.filter((c) => ids.includes(c.id))
  return { cur: sum(now.map((c) => c.cpuPct)), avg, peak, mem: sum(now.map((c) => c.memUsed)) }
}

// the process names the history kept for these ids, merged per name across ids and points; average over the points where any of the ids ran (a name missing from a point's top list counts 0), current pids and CPU from the snapshot, RSS from the snapshot or else the last point that listed it
export function topByName(u: Utilization, ids: string[]): { comm: string; pids: number[]; cur: number; avg: number; rss: number; series: Pt[] }[] {
  const rows = new Map<string, { total: number; rss: number; series: Pt[] }>()
  let n = 0
  for (const p of u.points) {
    const lists = ids.map((id) => p.top[id]).filter((l) => l !== undefined)
    if (!lists.length && !ids.some((id) => p.containers[id])) continue
    n++
    const here = new Map<string, { cpu: number; rss: number }>()
    for (const e of lists.flat()) {
      const h = here.get(e.comm) ?? { cpu: 0, rss: 0 }
      h.cpu += e.cpuPct
      h.rss += e.rss
      here.set(e.comm, h)
    }
    for (const [comm, h] of here) {
      const r = rows.get(comm) ?? { total: 0, rss: 0, series: [] }
      r.total += h.cpu
      r.rss = h.rss
      r.series.push({ t: p.t, v: h.cpu })
      rows.set(comm, r)
    }
  }
  const procs = u.processes.filter((p) => ids.includes(p.container))
  return [...rows].map(([comm, r]) => {
    const now = procs.filter((p) => p.comm === comm)
    return {
      comm,
      pids: now.flatMap((p) => p.pids).sort((a, b) => a - b),
      cur: sum(now.map((p) => p.cpuPct)),
      avg: n ? r.total / n : 0,
      rss: now.length ? sum(now.map((p) => p.rss)) : r.rss,
      series: r.series,
    }
  }).sort((a, b) => b.avg - a.avg)
}
