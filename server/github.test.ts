import { expect, spyOn, test } from 'bun:test'
import { authorizeUrl, fetchRepos, noreplyEmail, normalizeRepo, sameLogin } from './github'

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
