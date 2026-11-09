import { expect, spyOn, test } from 'bun:test'
import { authorizeUrl, fetchRepos, findDeployKeys, noreplyEmail, normalizeRepo, sameLogin } from './github'

test('fetchRepos lists only repos the token can add a deploy key to', async () => {
  const row = (full_name: string, admin?: boolean) => ({ full_name, private: true, language: null, default_branch: 'main', pushed_at: '', description: null, ...(admin === undefined ? {} : { permissions: { admin } }) })
  const spy = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json([row('me/mine', true), row('org/collab', false), row('org/unknown')]))
  try {
    expect((await fetchRepos('gho_x')).map((r) => r.fullName)).toEqual(['me/mine'])
  } finally {
    spy.mockRestore()
  }
})

test('authorizeUrl carries client id, callback, scopes and state', () => {
  const url = new URL(authorizeUrl('cid', 'https://dock.example.com/api/auth/github/callback', 'st4te'))
  expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize')
  expect(url.searchParams.get('client_id')).toBe('cid')
  expect(url.searchParams.get('redirect_uri')).toBe('https://dock.example.com/api/auth/github/callback')
  expect(url.searchParams.get('scope')).toBe('repo workflow read:user')
  expect(url.searchParams.get('state')).toBe('st4te')
})

test('noreplyEmail', () => {
  expect(noreplyEmail({ id: 42, login: 'octocat' })).toBe('42+octocat@users.noreply.github.com')
})

test('normalizeRepo accepts every REPO_URL form the image accepts', () => {
  expect(normalizeRepo('octocat/Shop')).toBe('octocat/shop')
  expect(normalizeRepo('https://github.com/octocat/api-gateway.git')).toBe('octocat/api-gateway')
  expect(normalizeRepo('git@github.com:octocat/ml-pipeline.git')).toBe('octocat/ml-pipeline')
  expect(normalizeRepo(' octocat/notes ')).toBe('octocat/notes')
  expect(normalizeRepo('https://gitlab.com/a/b')).toBeNull()
  expect(normalizeRepo('')).toBeNull()
  expect(normalizeRepo(undefined)).toBeNull()
})

test('sameLogin ignores case, as GitHub logins do', () => {
  expect(sameLogin('OctoCat', 'octocat')).toBe(true)
  expect(sameLogin('octocat', 'octocat2')).toBe(false)
})

test('findDeployKeys follows the Link header past the first 100 keys', async () => {
  const key = (id: number, title = 'dockbench-shop', read_only = false) => ({ id, title, read_only })
  const urls: string[] = []
  const spy = spyOn(globalThis, 'fetch').mockImplementation((async (url: string) => {
    urls.push(url)
    if (url.endsWith('page=2')) return Response.json([key(3), key(4, 'dockbench-shop', true)])
    return Response.json([key(1), key(2, 'other')], { headers: { link: '<https://api.github.com/repositories/1/keys?per_page=100&page=2>; rel="next", <https://api.github.com/repositories/1/keys?per_page=100&page=2>; rel="last"' } })
  }) as unknown as typeof fetch)
  try {
    expect((await findDeployKeys('gho_x', 'me/shop', 'dockbench-shop', false)).map((k) => k.id)).toEqual([1, 3])
    expect(urls).toEqual(['https://api.github.com/repos/me/shop/keys?per_page=100', 'https://api.github.com/repositories/1/keys?per_page=100&page=2'])
  } finally {
    spy.mockRestore()
  }
})
