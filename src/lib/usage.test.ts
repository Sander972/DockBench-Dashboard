import { describe, expect, test } from 'vitest'
import type { Utilization } from '../types'
import { byName, containerSeries, hostSeries, summarize, topByName } from './usage'

const GiB = 2 ** 30
// three 10 s points; a1 and a2 are the same container before and after a recreate, both named shop; db runs throughout
const u: Utilization = {
  window: '1h',
  stepMs: 10_000,
  at: 30_000,
  points: [
    { t: 10_000, host: { cpuPct: 50, stealPct: 1, memUsed: 10 * GiB, load1: 2 }, containers: { a1: { name: 'shop', cpuPct: 20, memUsed: 2 * GiB }, d1: { name: 'db', cpuPct: 10, memUsed: GiB } }, top: { a1: [{ comm: 'node', pids: [1], cpuPct: 15, rss: GiB }], host: [{ comm: 'dockerd', pids: [9], cpuPct: 4, rss: 100 }] } },
    { t: 20_000, host: { cpuPct: 60, stealPct: 2, memUsed: 11 * GiB, load1: 3 }, containers: { a1: { name: 'shop', cpuPct: 10, memUsed: 2 * GiB }, a2: { name: 'shop', cpuPct: 20, memUsed: GiB }, d1: { name: 'db', cpuPct: 10, memUsed: GiB } }, top: { a1: [{ comm: 'node', pids: [1], cpuPct: 5, rss: GiB }], a2: [{ comm: 'node', pids: [7], cpuPct: 15, rss: GiB }, { comm: 'git', pids: [8], cpuPct: 5, rss: 10 }] } },
    { t: 30_000, host: { cpuPct: 40, stealPct: 0, memUsed: 9 * GiB, load1: 1 }, containers: { a2: { name: 'shop', cpuPct: 15, memUsed: 3 * GiB }, d1: { name: 'db', cpuPct: 5, memUsed: GiB } }, top: { a2: [{ comm: 'node', pids: [7], cpuPct: 12, rss: 2 * GiB }] } },
  ],
  containers: [
    { id: 'a2', name: 'shop', image: 'x', dockbench: true, cpuPct: 14, memUsed: 3 * GiB, memLimit: 20 * GiB },
    { id: 'd1', name: 'db', image: 'y', dockbench: false, cpuPct: 6, memUsed: GiB, memLimit: 20 * GiB },
  ],
  processes: [{ comm: 'node', pids: [7, 11], container: 'a2', cpuPct: 13, rss: 2 * GiB }],
  names: { a1: { name: 'shop', dockbench: false }, a2: { name: 'shop', dockbench: true }, d1: { name: 'db', dockbench: false } },
}

describe('usage', () => {
  test('hostSeries maps the host figures of every point', () => {
    const h = hostSeries(u)
    expect(h.cpu).toEqual([{ t: 10_000, v: 50 }, { t: 20_000, v: 60 }, { t: 30_000, v: 40 }])
    expect(h.steal.map((p) => p.v)).toEqual([1, 2, 0])
    expect(h.mem[2]).toEqual({ t: 30_000, v: 9 * GiB })
  })

  test('byName joins the ids of one name, dockbench if any of them is', () => {
    const m = byName(u)
    expect([...m.keys()].sort()).toEqual(['db', 'shop'])
    expect(m.get('shop')).toEqual({ ids: ['a1', 'a2'], dockbench: true })
    expect(m.get('db')).toEqual({ ids: ['d1'], dockbench: false })
  })

  test('containerSeries sums the ids per point and leaves out points where none ran', () => {
    expect(containerSeries(u, ['a1', 'a2']).cpu).toEqual([{ t: 10_000, v: 20 }, { t: 20_000, v: 30 }, { t: 30_000, v: 15 }])
    expect(containerSeries(u, ['a2']).mem).toEqual([{ t: 20_000, v: GiB }, { t: 30_000, v: 3 * GiB }])
  })

  test('the host group is what the host used outside every container', () => {
    expect(containerSeries(u, ['host']).cpu).toEqual([{ t: 10_000, v: 20 }, { t: 20_000, v: 20 }, { t: 30_000, v: 20 }])
    expect(containerSeries(u, ['host']).mem[0]).toEqual({ t: 10_000, v: 7 * GiB })
  })

  test('summarize gives the current figures from the snapshot and the window average and peak', () => {
    expect(summarize(u, ['a1', 'a2'])).toEqual({ cur: 14, avg: 65 / 3, peak: 30, mem: 3 * GiB })
    // the host group has no snapshot figure: its current value is the newest point
    expect(summarize(u, ['host'])).toMatchObject({ cur: 20, avg: 20, peak: 20, mem: 5 * GiB })
  })

  test('topByName merges a name across ids, takes current pids and cpu from the snapshot and sorts by average', () => {
    const t = topByName(u, ['a1', 'a2'])
    expect(t.map((r) => r.comm)).toEqual(['node', 'git'])
    expect(t[0]).toMatchObject({ comm: 'node', pids: [7, 11], cur: 13, rss: 2 * GiB })
    expect(t[0].avg).toBeCloseTo((15 + 20 + 12) / 3)
    expect(t[0].series).toEqual([{ t: 10_000, v: 15 }, { t: 20_000, v: 20 }, { t: 30_000, v: 12 }])
    // git no longer runs: no pids, no current cpu, its last resident size
    expect(t[1]).toMatchObject({ comm: 'git', pids: [], cur: 0, rss: 10 })
    expect(t[1].avg).toBeCloseTo(5 / 3)
    expect(topByName(u, ['host']).map((r) => r.comm)).toEqual(['dockerd'])
  })
})
