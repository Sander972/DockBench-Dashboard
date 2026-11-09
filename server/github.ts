// repo: the repo list and deploy keys on private repos. workflow: GitHub checks a deploy key created through an OAuth App against that app's scopes, so without it a container's push touching .github/workflows/ is refused. read:packages is not asked for: pulls go through Portainer's own registry credentials
export const OAUTH_SCOPES = 'repo workflow read:user'
const API = 'https://api.github.com'

// GitHub logins are case-insensitive, so GITHUB_LOGIN=OctoCat must admit octocat
export const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export function authorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, scope: OAUTH_SCOPES, state })
  return `https://github.com/login/oauth/authorize?${q}`
}

export async function exchangeCode(clientId: string, clientSecret: string, code: string, redirectUri: string): Promise<string> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
  })
  const data = (await res.json()) as { access_token?: string; error?: string }
  if (!data.access_token) throw new Error(`GitHub token exchange failed: ${data.error ?? res.status}`)
  return data.access_token
}

async function ghFetch(token: string, url: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'dockbench-dashboard', ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
  if (!res.ok) throw new Error(`GitHub ${url.replace(API, '')} returned ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return res
}

async function gh<T>(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await ghFetch(token, API + path, init)
  return res.status === 204 ? (undefined as T) : (res.json() as Promise<T>)
}

// every page of a list, following the Link header's rel="next": only on api.github.com (the token goes with it) and for at most 50 pages
async function ghAll<T>(token: string, path: string): Promise<T[]> {
  const out: T[] = []
  let url: string | null = API + path
  for (let page = 0; url && page < 50; page++) {
    const res = await ghFetch(token, url)
    out.push(...((await res.json()) as T[]))
    const next = res.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1]
    url = next?.startsWith(API + '/') ? next : null
  }
  return out
}

export interface GithubUser {
  login: string
  id: number
  name: string | null
  avatar_url: string
}

export function fetchUser(token: string): Promise<GithubUser> {
  return gh<GithubUser>(token, '/user')
}

export function noreplyEmail(user: { id: number; login: string }): string {
  return `${user.id}+${user.login}@users.noreply.github.com`
}

// Same shape as GithubRepo in src/types.ts, minus deployedAs which the route resolves against running containers.
export interface RepoRow {
  fullName: string
  private: boolean
  language: string | null
  defaultBranch: string
  pushedAt: string
  description: string | null
}

// ponytail: first 100 repos by last push, no pagination; add a page loop if you ever own more
// adminOnly (the default, for deploy): deploy needs to add a deploy key, which GitHub refuses to collaborators. An org that disables deploy keys still fails at deploy time with GitHub's own message. The Actions page lists every repo the account can see.
export async function fetchRepos(token: string, adminOnly = true): Promise<RepoRow[]> {
  const repos = await gh<{ full_name: string; private: boolean; language: string | null; default_branch: string; pushed_at: string; description: string | null; permissions?: { admin?: boolean } }[]>(token, '/user/repos?per_page=100&sort=pushed')
  return repos.filter((r) => !adminOnly || r.permissions?.admin).map((r) => ({ fullName: r.full_name, private: r.private, language: r.language, defaultBranch: r.default_branch, pushedAt: r.pushed_at, description: r.description }))
}

// REPO_URL as the image accepts it (owner/name, https URL, ssh URL) to lowercase owner/name, or null when it is not a GitHub repo
export function normalizeRepo(repoUrl: string | null | undefined): string | null {
  if (!repoUrl) return null
  const m = repoUrl.trim().replace(/\.git$/, '').match(/^(?:https?:\/\/github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+)$/)
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null
}

// one read/write deploy key per container, titled dockbench-<project> so a future remove action can find it
export function createDeployKey(token: string, repo: string, title: string, key: string, readOnly = false): Promise<{ id: number }> {
  return gh<{ id: number }>(token, `/repos/${repo}/keys`, { method: 'POST', body: { title, key, read_only: readOnly } })
}

// the container's read/write key and its read-only config key share a title (same repo when the config repo is the project repo), so readOnly tells them apart; every match, because a removal that failed earlier leaves a duplicate with the same title
export async function findDeployKeys(token: string, repo: string, title: string, readOnly: boolean): Promise<{ id: number }[]> {
  return (await ghAll<{ id: number; title: string; read_only: boolean }>(token, `/repos/${repo}/keys?per_page=100`)).filter((k) => k.title === title && k.read_only === readOnly)
}

export function deleteDeployKey(token: string, repo: string, id: number): Promise<void> {
  return gh<void>(token, `/repos/${repo}/keys/${id}`, { method: 'DELETE' })
}
