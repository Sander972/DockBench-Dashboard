// GitHub Actions status per repo for the Actions page and the CI section of a dev container. Kept free of env so tests drive it with fakes.

// ActionRun in src/types.ts
export interface ActionRun {
  id: number
  workflow: string
  title: string
  branch: string | null
  event: string
  status: string
  conclusion: string | null
  sha: string
  url: string
  startedAt: string
  updatedAt: string
}

export type RepoState = 'running' | 'failure' | 'success' | 'none'

// RepoActions in src/types.ts, minus private, deployedAs and pushedAt which the route adds
export interface RunSummary {
  state: RepoState
  running: ActionRun[]
  latest: ActionRun[]
  lastSuccess: ActionRun | null
  lastFailure: ActionRun | null
}

interface GhRun { id: number; name: string | null; display_title?: string; head_branch: string | null; event: string; status: string | null; conclusion: string | null; head_sha: string; html_url: string; run_started_at?: string | null; created_at: string; updated_at: string }

const FAILED = new Set(['failure', 'timed_out', 'startup_failure'])
const RUNNING = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending'])

export const toRun = (r: GhRun): ActionRun => ({
  id: r.id, workflow: r.name ?? 'workflow', title: (r.display_title ?? '').slice(0, 200), branch: r.head_branch, event: r.event,
  status: r.status ?? 'completed', conclusion: r.conclusion, sha: r.head_sha.slice(0, 7), url: r.html_url,
  startedAt: r.run_started_at ?? r.created_at, updatedAt: r.updated_at,
})

// runs newest first. latest = the newest finished-or-running run per workflow on the default branch (any branch when the default has none), which is what "is main green" means; the repo state is running if anything runs, else failure if one of those failed.
export function summarize(runs: ActionRun[], defaultBranch: string): RunSummary {
  const running = runs.filter((r) => RUNNING.has(r.status))
  const onDefault = runs.filter((r) => r.branch === defaultBranch)
  const pool = onDefault.length ? onDefault : runs
  const seen = new Set<string>()
  const latest = pool.filter((r) => !seen.has(r.workflow) && seen.add(r.workflow))
  const done = runs.filter((r) => r.status === 'completed')
  const state: RepoState = running.length ? 'running' : !latest.length ? 'none' : latest.some((r) => r.conclusion && FAILED.has(r.conclusion)) ? 'failure' : 'success'
  return {
    state, running, latest,
    lastSuccess: done.find((r) => r.conclusion === 'success') ?? null,
    lastFailure: done.find((r) => !!r.conclusion && FAILED.has(r.conclusion)) ?? null,
  }
}

export interface RepoRuns { runs: ActionRun[]; at: number; error: string | null }

// The last 30 runs per repo, fetched at most once per ttlMs and with If-None-Match: GitHub answers 304 for an unchanged list, which does not count against the rate limit, so polling every repo every 30 s costs almost nothing. One fetch per repo at a time, at most `limit` repos at once. A failed fetch keeps the last runs with the error.
export function runsCache(fetcher: typeof fetch = fetch, ttlMs = 30_000, limit = 8) {
  const known = new Map<string, RepoRuns & { etag: string | null }>()
  const inflight = new Map<string, Promise<void>>()
  let active = 0
  const waiting: (() => void)[] = []
  const slot = async () => {
    if (active >= limit) await new Promise<void>((r) => waiting.push(r))
    active++
  }
  const release = () => { active--; waiting.shift()?.() }

  async function load(token: string, repo: string) {
    const k = known.get(repo)
    await slot()
    try {
      const res = await fetcher(`https://api.github.com/repos/${repo}/actions/runs?per_page=30`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'dockbench-dashboard', ...(k?.etag ? { 'If-None-Match': k.etag } : {}) },
        signal: AbortSignal.timeout(15_000),
      })
      if (res.status === 304 && k) {
        known.set(repo, { ...k, at: Date.now(), error: null })
        return
      }
      // 404: Actions turned off or no access; the repo simply has no runs to show
      if (res.status === 404) {
        known.set(repo, { runs: [], at: Date.now(), error: null, etag: null })
        return
      }
      if (!res.ok) throw new Error(`GitHub actions runs returned ${res.status}`)
      const body = (await res.json()) as { workflow_runs?: GhRun[] }
      known.set(repo, { runs: (body.workflow_runs ?? []).map(toRun), at: Date.now(), error: null, etag: res.headers.get('etag') })
    } catch (e) {
      known.set(repo, { runs: k?.runs ?? [], at: Date.now(), error: (e as Error).message.slice(0, 200), etag: k?.etag ?? null })
    } finally {
      release()
    }
  }

  return async function get(token: string, repo: string): Promise<RepoRuns> {
    const k = known.get(repo)
    if (!k || Date.now() - k.at >= ttlMs) {
      let p = inflight.get(repo)
      if (!p) {
        p = load(token, repo).finally(() => inflight.delete(repo))
        inflight.set(repo, p)
      }
      await p
    }
    const { runs, at, error } = known.get(repo)!
    return { runs, at, error }
  }
}
