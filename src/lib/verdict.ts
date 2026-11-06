import type { DevContainer } from '../types'
import { DISK_BUDGET } from './format'

export type Sev = 'ok' | 'warn' | 'bad' | 'off'
export interface Verdict { sev: Sev; word: string; blink: boolean }

export const cpuPct = (c: DevContainer) => (c.state === 'running' ? c.cpuPct : 0)
export const memPct = (c: DevContainer) => (c.state === 'running' && c.memLimit ? (c.memUsed / c.memLimit) * 100 : 0)
export const diskBytes = (c: DevContainer) => c.diskRw + c.diskVolume
export const diskPct = (c: DevContainer) => (diskBytes(c) / DISK_BUDGET) * 100

const PENDING = { stop: 'Stopping…', start: 'Starting…', restart: 'Restarting…', update: 'Updating…', config: 'Applying…', vscode: 'Replacing…', claudeConfig: 'Downloading…', remove: 'Removing…' }
const v = (sev: Sev, word: string, blink = false): Verdict => ({ sev, word, blink })

// handoff 6.1, first match wins
export function verdict(c: DevContainer): Verdict {
  if (c.pending) return v('warn', PENDING[c.pending], true)
  if (c.state === 'exited') return v('off', 'Stopped')
  if (c.state === 'restarting') return v('bad', c.restartCount > 3 ? 'Restart loop' : 'Restarting', true)
  // created, paused, dead are not in the table: show the Docker state as an off verdict rather than "Running"
  if (c.state !== 'running') return v('off', c.state[0].toUpperCase() + c.state.slice(1))
  if (c.statusError === 'starting') return v('warn', c.deviceCode ? 'Login needed' : 'Starting', true)
  if (c.statusError === 'dead') return v('bad', 'Status down')
  const t = c.status?.tunnel
  if (t === 'waiting_for_login') return v('warn', 'Tunnel login', true)
  if (t === 'down') return v('bad', 'Tunnel down')
  if (t === 'unknown') return v('warn', 'Tunnel unknown')
  if (cpuPct(c) >= 90) return v('warn', 'CPU hot')
  if (memPct(c) >= 90) return v('warn', 'RAM full')
  return v('ok', 'Running')
}

export const needsAttention = (c: DevContainer) => !c.pending && ['warn', 'bad'].includes(verdict(c).sev)

export const rank: Record<Sev, number> = { bad: 0, warn: 1, ok: 2, off: 3 }

export type SortKey = 'attention' | 'cpu' | 'mem' | 'disk' | 'name'
export const compare: Record<SortKey, (a: DevContainer, b: DevContainer) => number> = {
  attention: (a, b) => rank[verdict(a).sev] - rank[verdict(b).sev] || a.name.localeCompare(b.name),
  cpu: (a, b) => cpuPct(b) - cpuPct(a),
  mem: (a, b) => memPct(b) - memPct(a),
  disk: (a, b) => diskBytes(b) - diskBytes(a),
  name: (a, b) => a.name.localeCompare(b.name),
}
