import { describe, expect, it } from 'vitest'
import type { ActionRun, RepoActions } from '../types'
import { counts, filterRepos, finishedRuns, runSev, runWord } from './actions'

const run = (id: number, workflow: string, status: string, conclusion: string | null, extra: Partial<ActionRun> = {}): ActionRun => ({ id, workflow, title: 'fix login', branch: 'main', event: 'push', status, conclusion, sha: 'abc1234', url: 'u', startedAt: '2026-10-14T10:00:00Z', updatedAt: '2026-10-14T10:00:00Z', ...extra })
const repo = (name: string, state: RepoActions['state'], extra: Partial<RepoActions> = {}): RepoActions => ({ repo: name, private: true, defaultBranch: 'main', pushedAt: '2026-10-01T00:00:00Z', deployedAs: null, state, running: [], latest: [], lastSuccess: null, lastFailure: null, checkedAt: '', error: null, ...extra })

describe('runs', () => {
  it('words and severities', () => {
    expect([runWord(run(1, 'b', 'in_progress', null)), runSev(run(1, 'b', 'queued', null))]).toEqual(['running', 'warn'])
    expect([runWord(run(1, 'b', 'completed', 'success')), runSev(run(1, 'b', 'completed', 'success'))]).toEqual(['passed', 'ok'])
    expect([runWord(run(1, 'b', 'completed', 'timed_out')), runSev(run(1, 'b', 'completed', 'timed_out'))]).toEqual(['failed', 'bad'])
    expect([runWord(run(1, 'b', 'completed', 'cancelled')), runSev(run(1, 'b', 'completed', 'cancelled'))]).toEqual(['cancelled', 'off'])
  })
})

describe('filterRepos', () => {
  const list = [
    repo('me/old', 'success', { pushedAt: '2025-01-01T00:00:00Z' }),
    repo('me/shop', 'failure', { deployedAs: 'dockbench-shop' }),
    repo('me/new', 'success', { pushedAt: '2026-10-13T00:00:00Z', latest: [run(5, 'deploy', 'completed', 'success', { branch: 'release' })] }),
    repo('me/api', 'running'),
    repo('me/docs', 'none'),
  ]
  it('puts running, then failing first, then the most recently active', () => {
    expect(filterRepos(list, '', 'all', 'status').map(a => a.repo)).toEqual(['me/api', 'me/shop', 'me/new', 'me/old', 'me/docs'])
  })
  it('sorts by latest activity, latest failure or name', () => {
    const fail = repo('me/zed', 'success', { pushedAt: null, lastFailure: run(7, 'ci', 'completed', 'failure', { updatedAt: '2026-10-12T00:00:00Z' }) })
    expect(filterRepos([...list, fail], '', 'all', 'recent').map(a => a.repo)).toEqual(['me/new', 'me/api', 'me/docs', 'me/shop', 'me/old', 'me/zed'])
    expect(filterRepos([...list, fail], '', 'all', 'failure')[0].repo).toBe('me/zed')
    expect(filterRepos(list, '', 'all', 'name').map(a => a.repo)).toEqual(['me/api', 'me/docs', 'me/new', 'me/old', 'me/shop'])
  })
  it('searches repo, container, workflow and branch, every word must match', () => {
    expect(filterRepos(list, 'dockbench-shop', 'all').map(a => a.repo)).toEqual(['me/shop'])
    expect(filterRepos(list, 'deploy release', 'all').map(a => a.repo)).toEqual(['me/new'])
    expect(filterRepos(list, 'ME/', 'failure').map(a => a.repo)).toEqual(['me/shop'])
  })
  it('counts per state', () => {
    expect(counts(list)).toEqual({ all: 5, running: 1, failure: 1, success: 2, none: 1 })
  })
})

describe('finishedRuns', () => {
  it('reports a run that stopped running, with its conclusion, but nothing on the first load', () => {
    const seen = new Map<string, Set<number>>()
    expect(finishedRuns(seen, [repo('me/shop', 'running', { running: [run(9, 'build', 'in_progress', null)] })])).toEqual([])
    const done = run(9, 'build', 'completed', 'success')
    const out = finishedRuns(seen, [repo('me/shop', 'success', { latest: [done], lastSuccess: done })])
    expect(out.map(x => [x.repo.repo, x.run.conclusion])).toEqual([['me/shop', 'success']])
    expect(finishedRuns(seen, [repo('me/shop', 'success', { latest: [done] })])).toEqual([])
  })
})
