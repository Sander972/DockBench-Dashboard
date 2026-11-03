import { expect, test } from 'bun:test'
import { cpuPctBetween, cpuSampler, parseCpu, parseMemUsed } from './host'
import { parseStats } from './docker'

test('host cpu is busy jiffies over total between two /proc/stat samples', () => {
  const a = parseCpu('cpu  100 0 100 700 100 0 0 0 50 0\ncpu0 1 2 3 4\n')
  const b = parseCpu('cpu  200 0 200 1300 100 0 0 0 90 0\n')
  expect(a).toEqual({ busy: 200, total: 1000 })
  expect(cpuPctBetween(a, b)).toBe(25)
  expect(cpuPctBetween(b, b)).toBe(0)
})

test('host memory used is MemTotal minus MemAvailable in bytes', () => {
  expect(parseMemUsed('MemTotal:       8000 kB\nMemFree:         1000 kB\nMemAvailable:    3000 kB\n')).toBe(5000 * 1024)
})

test('container stats give share of the host and memory without page cache', () => {
  const s = parseStats({
    cpu_stats: { cpu_usage: { total_usage: 3_000 }, system_cpu_usage: 20_000 },
    precpu_stats: { cpu_usage: { total_usage: 1_000 }, system_cpu_usage: 10_000 },
    memory_stats: { usage: 500, limit: 4000, stats: { inactive_file: 100 } },
  })
  expect(s).toEqual({ cpuPct: 20, memUsed: 400, memLimit: 4000 })
  // first sample after start: precpu has no system time yet
  expect(parseStats({ cpu_stats: { cpu_usage: { total_usage: 5 } }, precpu_stats: { cpu_usage: { total_usage: 0 } }, memory_stats: { usage: 10, stats: { total_inactive_file: 4 } } })).toEqual({ cpuPct: 0, memUsed: 6, memLimit: 0 })
  // precpu system time missing while cpu_stats has it: still 0, not a ratio over the host's uptime; cgroup v1 carries both cache keys and total_ wins
  expect(parseStats({ cpu_stats: { cpu_usage: { total_usage: 5 }, system_cpu_usage: 1_000 }, precpu_stats: { cpu_usage: { total_usage: 0 } }, memory_stats: { usage: 10, stats: { inactive_file: 1, total_inactive_file: 4 } } })).toEqual({ cpuPct: 0, memUsed: 6, memLimit: 0 })
  // a cache figure at or above usage is skipped, as docker stats does, instead of reading 0
  const mem = (stats: Record<string, number>) => parseStats({ cpu_stats: { cpu_usage: { total_usage: 0 } }, precpu_stats: { cpu_usage: { total_usage: 0 } }, memory_stats: { usage: 10, stats } }).memUsed
  expect(mem({ total_inactive_file: 12, inactive_file: 3 })).toBe(7)
  expect(mem({ total_inactive_file: 10 })).toBe(10)
})

test('host cpu is measured since the last poll, with a fresh sample first and after an idle gap', async () => {
  const samples = [{ busy: 0, total: 0 }, { busy: 50, total: 100 }, { busy: 60, total: 200 }, { busy: 60, total: 300 }, { busy: 160, total: 400 }]
  let n = 0
  let fail = false
  // margins of ~90 ms and ~250 ms around minMs and staleMs, so a slow runner or a GC pause does not flip a branch
  const pct = cpuSampler(async () => { if (fail) throw new Error('no /proc'); return samples[n++] }, 100, 400)
  expect(await Promise.all([pct(), pct()])).toEqual([50, 50]) // concurrent first calls share one fresh sample
  expect(n).toBe(2)
  expect(await pct()).toBe(50) // within minMs: last figure, no read
  expect(n).toBe(2)
  await Bun.sleep(150)
  expect(await pct()).toBe(10) // since the last poll
  await Bun.sleep(500)
  fail = true
  await expect(pct()).rejects.toThrow('no /proc')
  fail = false
  expect(await pct()).toBe(100) // after an idle gap a failed fresh sample is retried, and the figure is the fresh sample, not the gap's 50% average
})
