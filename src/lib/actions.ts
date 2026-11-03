import type { ActionRun, RepoActions } from '../types'

export type Sev = 'ok' | 'warn' | 'bad' | 'off'
export type CiFilter = 'all' | 'running' | 'failure' | 'success' | 'none'

const FAILED = ['failure', 'timed_out', 'startup_failure']

export const isRunning = (r: ActionRun) => r.status !== 'completed'

export function runSev(r: ActionRun): Sev {
  if (isRunning(r)) return 'warn'
  return r.conclusion === 'success' ? 'ok' : r.conclusion && FAILED.includes(r.conclusion) ? 'bad' : 'off'
}

export function runWord(r: ActionRun): string {
  if (isRunning(r)) return r.status === 'in_progress' ? 'running' : r.status === 'waiting' ? 'waiting' : 'queued'
  return r.conclusion === 'success' ? 'passed' : r.conclusion && FAILED.includes(r.conclusion) ? 'failed' : (r.conclusion ?? 'done').replace('_', ' ')
}

export const REPO_SEV: Record<RepoActions['state'], Sev> = { running: 'warn', failure: 'bad', success: 'ok', none: 'off' }
export const REPO_WORD: Record<RepoActions['state'], string> = { running: 'running', failure: 'failing', success: 'passing', none: 'no CI' }

const ORDER: Record<RepoActions['state'], number> = { running: 0, failure: 1, success: 2, none: 3 }
const lastActivity = (a: RepoActions) => Math.max(Date.parse(a.pushedAt ?? '') || 0, ...[...a.running, ...a.latest].map(r => Date.parse(r.updatedAt) || 0))

export type CiSort = 'status' | 'recent' | 'failure' | 'name'
const failedAt = (a: RepoActions) => Date.parse(a.lastFailure?.updatedAt ?? '') || 0
const SORTERS: Record<CiSort, (a: RepoActions, b: RepoActions) => number> = {
  status: (a, b) => ORDER[a.state] - ORDER[b.state] || lastActivity(b) - lastActivity(a),
  recent: (a, b) => lastActivity(b) - lastActivity(a),
  failure: (a, b) => failedAt(b) - failedAt(a),
  name: () => 0,
}

// search matches the repo, the dev container, workflow names, branches and commit titles; by default the most recently active repos come first (sort `status` puts running and failing ones before that); ties fall back to the repo name
export function filterRepos(list: RepoActions[], q: string, f: CiFilter, sort: CiSort = 'recent'): RepoActions[] {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return list
    .filter(a => f === 'all' || a.state === f)
    .filter(a => {
      if (!words.length) return true
      const hay = [a.repo, a.deployedAs, ...[...a.running, ...a.latest].flatMap(r => [r.workflow, r.branch, r.title])].filter(Boolean).join(' ').toLowerCase()
      return words.every(w => hay.includes(w))
    })
    .sort((a, b) => SORTERS[sort](a, b) || a.repo.localeCompare(b.repo))
}

export function counts(list: RepoActions[]): Record<CiFilter, number> {
  const c = { all: list.length, running: 0, failure: 0, success: 0, none: 0 }
  for (const a of list) c[a.state]++
  return c
}

// Runs that were running at the previous load and are not anymore, with how they ended when this load knows it. running: repo -> run ids, updated in place. A repo seen for the first time reports nothing, so a page load never toasts old runs.
export function finishedRuns(running: Map<string, Set<number>>, list: RepoActions[]): { repo: RepoActions; run: ActionRun }[] {
  const out: { repo: RepoActions; run: ActionRun }[] = []
  for (const a of list) {
    const prev = running.get(a.repo)
    const now = new Set(a.running.map(r => r.id))
    if (prev) {
      for (const id of prev) {
        if (now.has(id)) continue
        const run = [...a.latest, a.lastSuccess, a.lastFailure].find(r => r?.id === id)
        if (run && !isRunning(run)) out.push({ repo: a, run })
      }
    }
    running.set(a.repo, now)
  }
  return out
}

export const actionsUrl = (repo: string) => `https://github.com/${repo}/actions`
