import { describe, expect, it } from 'vitest'
import type { DevContainer, DevContainerStatus } from '../types'
import { compare, needsAttention, verdict } from './verdict'

const G = 1024 ** 3
const st = (o: Partial<DevContainerStatus> = {}): DevContainerStatus => ({
  repo: 'a/b', tunnel_name: 'b', branch: 'main', dirty: 0, last_commit: null, ahead: 0, behind: 0, tunnel: 'connected', mise: {}, claude_logged_in: true, uptime_seconds: 60, ...o,
})
const c = (o: Partial<DevContainer> = {}): DevContainer => ({
  id: 'x', name: 'dockbench-x', repo: 'a/b', state: 'running', startedAt: '', finishedAt: null, exitCode: null, restartCount: 0, cpuPct: 5, memUsed: 1 * G, memLimit: 4 * G,
  diskRw: 0, diskVolume: 0, status: st(), statusError: null, statusFetchedAt: null, lastFetchAt: null, pending: null, deviceCode: null, lastError: null,
  image: 'ghcr.io/x/dockbench:latest', imageUpdate: null, imageCheckedAt: null, config: { installClaude: true, injectClaudeConfig: false, vscodeConfig: true }, ...o,
})
const w = (o: Partial<DevContainer>) => { const v = verdict(c(o)); return `${v.sev} ${v.word}${v.blink ? ' *' : ''}` }

describe('verdict, handoff 6.1', () => {
  it('pending action', () => {
    expect(w({ pending: 'stop' })).toBe('warn Stopping… *')
    expect(w({ pending: 'start', state: 'exited' })).toBe('warn Starting… *')
    expect(w({ pending: 'restart', state: 'restarting', restartCount: 9 })).toBe('warn Restarting… *')
    expect(w({ pending: 'update' })).toBe('warn Updating… *')
    expect(w({ pending: 'config' })).toBe('warn Applying… *')
    expect(w({ pending: 'vscode' })).toBe('warn Replacing… *')
  })
  it('exited', () => expect(w({ state: 'exited', status: null })).toBe('off Stopped'))
  it('restarting', () => {
    expect(w({ state: 'restarting', restartCount: 3 })).toBe('bad Restarting *')
    expect(w({ state: 'restarting', restartCount: 4 })).toBe('bad Restart loop *')
  })
  it('starting', () => {
    expect(w({ statusError: 'starting', status: null })).toBe('warn Starting *')
    expect(w({ statusError: 'starting', status: null, deviceCode: { code: 'AAAA-BBBB', kind: 'gh' } })).toBe('warn Login needed *')
  })
  it('status dead', () => expect(w({ statusError: 'dead' })).toBe('bad Status down'))
  it('tunnel states', () => {
    expect(w({ status: st({ tunnel: 'waiting_for_login' }) })).toBe('warn Tunnel login *')
    expect(w({ status: st({ tunnel: 'down' }) })).toBe('bad Tunnel down')
    expect(w({ status: st({ tunnel: 'unknown' }) })).toBe('warn Tunnel unknown')
  })
  it('CPU hot and RAM full', () => {
    expect(w({ cpuPct: 90 })).toBe('warn CPU hot')
    expect(w({ cpuPct: 89.9 })).toBe('ok Running')
    expect(w({ memUsed: 3.6 * G })).toBe('warn RAM full')
    expect(w({ memUsed: 3.5 * G })).toBe('ok Running')
  })
  it('running', () => expect(w({})).toBe('ok Running'))

  it('first match wins', () => {
    expect(w({ pending: 'stop', state: 'restarting', restartCount: 14 })).toBe('warn Stopping… *')
    expect(w({ state: 'exited', statusError: 'dead', cpuPct: 99 })).toBe('off Stopped')
    expect(w({ state: 'restarting', statusError: 'starting', restartCount: 1 })).toBe('bad Restarting *')
    expect(w({ statusError: 'starting', status: st({ tunnel: 'down' }) })).toBe('warn Starting *')
    expect(w({ statusError: 'dead', status: st({ tunnel: 'waiting_for_login' }) })).toBe('bad Status down')
    expect(w({ status: st({ tunnel: 'waiting_for_login' }), cpuPct: 95 })).toBe('warn Tunnel login *')
    expect(w({ status: st({ tunnel: 'down' }), cpuPct: 95 })).toBe('bad Tunnel down')
    expect(w({ status: st({ tunnel: 'unknown' }), memUsed: 4 * G })).toBe('warn Tunnel unknown')
    expect(w({ cpuPct: 95, memUsed: 4 * G })).toBe('warn CPU hot')
  })

  it('needsAttention and attention sort', () => {
    expect(needsAttention(c({ statusError: 'dead' }))).toBe(true)
    expect(needsAttention(c({ pending: 'stop' }))).toBe(false)
    expect(needsAttention(c({ state: 'exited' }))).toBe(false)
    const list = [c({ name: 'b', state: 'exited' }), c({ name: 'z' }), c({ name: 'y', cpuPct: 95 }), c({ name: 'a' }), c({ name: 'q', statusError: 'dead' })]
    expect(list.sort(compare.attention).map(x => x.name)).toEqual(['q', 'y', 'a', 'z', 'b'])
  })
})
