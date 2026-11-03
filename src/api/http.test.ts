import { expect, test, vi } from 'vitest'
import { http } from './http'

test('a failed deploy keeps the call trace from the server', async () => {
  const calls = [{ method: 'GET', path: '/containers/json', status: 200 }, { method: 'POST', path: '/images/create', status: null }]
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'pull failed', calls }), { status: 502, headers: { 'content-type': 'application/json' } }))
  const e = await http.deploy({ repo: 'a/b', project: 'b', gitUserName: 'A', gitUserEmail: 'a@b', auth: 'token', image: '', installClaude: true, injectClaudeConfig: false, setupRerun: false, vscodeConfig: true, ghLogin: false }).catch(e => e)
  expect(e.message).toBe('pull failed')
  expect(e.calls).toEqual(calls)
  vi.unstubAllGlobals()
})
