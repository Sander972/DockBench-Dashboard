import { readFile, statfs } from 'node:fs/promises'

// /proc/stat and /proc/meminfo are not namespaced, so inside the dashboard container they describe the whole host. ponytail: these are the dashboard's own host, wrong if DOCKER_HOST points at another machine.

// busy and total jiffies from the aggregate "cpu" line; guest time is already counted in user, so only the first 8 columns add up
export function parseCpu(stat: string): { busy: number; total: number } {
  const [user, nice, system, idle, iowait, irq, softirq, steal] = stat.split('\n')[0].trim().split(/\s+/).slice(1, 9).map(Number)
  const total = user + nice + system + idle + iowait + irq + softirq + steal
  return { busy: total - idle - iowait, total }
}

export function cpuPctBetween(a: { busy: number; total: number }, b: { busy: number; total: number }): number {
  const total = b.total - a.total
  return total > 0 ? ((b.busy - a.busy) / total) * 100 : 0
}

// used = MemTotal - MemAvailable, the figure free and htop show; meminfo is in kB
export function parseMemUsed(meminfo: string): number {
  const kb = (key: string) => Number(meminfo.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1] ?? 0)
  return (kb('MemTotal') - kb('MemAvailable')) * 1024
}

// busy share since the previous call (the last poll), so a steady poll does not wait. With no sample yet, or the last one over staleMs old (an idle gap, whose average is not the current load), the call takes a fresh minMs sample instead; staleMs sits above the slowest poll option (15 s), so a steady poll never pays for one. A call within minMs of the last sample gets the last figure, since a few ms of jiffies measure nothing. performance.now() is monotonic, so a wall-clock step cannot freeze the figure.
export function cpuSampler(read: () => Promise<{ busy: number; total: number }>, minMs = 1000, staleMs = 20_000): () => Promise<number> {
  let prev: { at: number; cpu: { busy: number; total: number }; pct: number } | null = null
  let fresh: Promise<void> | null = null
  const sample = async () => {
    const a = await read()
    await Bun.sleep(minMs)
    const cpu = await read()
    prev = { at: performance.now(), cpu, pct: cpuPctBetween(a, cpu) }
  }
  return async () => {
    // concurrent calls share one fresh sample; a failed one is dropped so the next call retries
    if (!prev || performance.now() - prev.at > staleMs) await (fresh ??= sample().finally(() => { fresh = null }))
    const p = prev!
    if (performance.now() - p.at < minMs) return p.pct
    const cpu = await read()
    // another call stored a sample while this one read, so p is no longer the baseline and the window would be a few ms
    if (prev !== p) return prev!.pct
    prev = { at: performance.now(), cpu, pct: cpuPctBetween(p.cpu, cpu) }
    return prev.pct
  }
}

export const hostCpuPct = cpuSampler(async () => parseCpu(await readFile('/proc/stat', 'utf8')))

export async function hostMemUsed(): Promise<number> {
  return parseMemUsed(await readFile('/proc/meminfo', 'utf8'))
}

// the filesystem holding path; /data is a Docker volume, so this is the disk Docker's data root sits on
export async function diskUsage(path: string): Promise<{ diskTotal: number; diskUsed: number }> {
  const s = await statfs(path)
  return { diskTotal: s.blocks * s.bsize, diskUsed: (s.blocks - s.bfree) * s.bsize }
}
