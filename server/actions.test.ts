import { expect, test } from 'bun:test'
import { runsCache, summarize, toRun, type ActionRun } from './actions'

let n = 0
const run = (workflow: string, status: string, conclusion: string | null, branch = 'main'): ActionRun => ({ id: ++n, workflow, title: 't', branch, event: 'push', status, conclusion, sha: 'abc1234', url: `https://github.com/o/r/actions/runs/${n}`, startedAt: '2026-10-14T10:00:00Z', updatedAt: '2026-10-14T10:01:00Z' })

test('summarize: running wins, then a failed latest run of any workflow on the default branch', () => {
  const ok = run('build', 'completed', 'success'), bad = run('deploy', 'completed', 'failure'), oldBad = run('build', 'completed', 'failure')
  expect(summarize([ok, bad, oldBad], 'main')).toMatchObject({ state: 'failure', latest: [ok, bad], lastSuccess: ok, lastFailure: bad, running: [] })
  const going = run('build', 'in_progress', null)
  expect(summarize([going, ok], 'main')).toMatchObject({ state: 'running', running: [going] })
  expect(summarize([ok, oldBad], 'main').state).toBe('success')
  expect(summarize([], 'main')).toEqual({ state: 'none', running: [], latest: [], lastSuccess: null, lastFailure: null })
})

test('summarize: a failure on a feature branch does not make main red; without default-branch runs every branch counts', () => {
  const feat = run('build', 'completed', 'failure', 'feat'), main = run('build', 'completed', 'success')
  expect(summarize([feat, main], 'main')).toMatchObject({ state: 'success', lastFailure: feat })
  expect(summarize([feat], 'main').state).toBe('failure')
  expect(summarize([run('build', 'completed', 'cancelled')], 'main').state).toBe('success')
})

test('toRun keeps the facts the page needs', () => {
  expect(toRun({ id: 1, name: 'CI', display_title: 'fix: x', head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', head_sha: '0123456789abcdef', html_url: 'u', run_started_at: '2026-10-14T10:00:00Z', created_at: '2026-10-14T09:59:00Z', updated_at: '2026-10-14T10:05:00Z' }))
    .toEqual({ id: 1, workflow: 'CI', title: 'fix: x', branch: 'main', event: 'push', status: 'completed', conclusion: 'success', sha: '0123456', url: 'u', startedAt: '2026-10-14T10:00:00Z', updatedAt: '2026-10-14T10:05:00Z' })
})

test('runsCache sends the ETag back, keeps runs on a 304, keeps the last runs on an error, and caches for the ttl', async () => {
  const seen: (string | null)[] = []
  let answer: () => Response = () => new Response(JSON.stringify({ workflow_runs: [{ id: 7, name: 'CI', head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', head_sha: 'abcdef0123', html_url: 'u', created_at: 'c', updated_at: 'u' }] }), { headers: { etag: 'W/"1"' } })
  const fake = (async (_url: string, init: RequestInit) => { seen.push(new Headers(init.headers).get('if-none-match')); return answer() }) as unknown as typeof fetch
  const get = runsCache(fake, 0)
  expect((await get('t', 'o/r')).runs[0].id).toBe(7)
  answer = () => new Response(null, { status: 304 })
  expect((await get('t', 'o/r')).runs[0].id).toBe(7)
  answer = () => new Response('boom', { status: 502 })
  const failed = await get('t', 'o/r')
  expect(failed.runs[0].id).toBe(7)
  expect(failed.error).toBe('GitHub actions runs returned 502')
  expect(seen).toEqual([null, 'W/"1"', 'W/"1"'])
  answer = () => new Response('nope', { status: 404 })
  expect(await get('t', 'o/gone')).toMatchObject({ runs: [], error: null })
  const cached = runsCache(fake, 60_000)
  await cached('t', 'o/x'); await cached('t', 'o/x')
  expect(seen.length).toBe(5)
})
