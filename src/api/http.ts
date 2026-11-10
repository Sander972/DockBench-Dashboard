import type { Session } from '../types'
import type { Api } from './index'
import { SignedOut } from './errors'

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const post = method !== 'GET'
  const r = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: post ? { 'Content-Type': 'application/json' } : undefined,
    body: post ? JSON.stringify(body ?? {}) : undefined,
  })
  if (r.status === 401) throw new SignedOut()
  const data = r.headers.get('content-type')?.includes('json') ? await r.json() : null
  if (!r.ok) throw Object.assign(new Error(data?.message || data?.error || `${method} ${path} · ${r.status}`), { calls: data?.calls })
  return data as T
}

export const http: Api = {
  getSession: () => req<Session>('GET', '/api/session').catch(e => {
    if (e instanceof SignedOut) return null
    throw e
  }),
  signInGithub: () => window.location.assign('/api/auth/github/start'),
  signOut: all => req('POST', '/api/auth/logout', all ? { all: true } : {}),
  getHost: () => req('GET', '/api/host'),
  getUtilization: (window, top) => req('GET', `/api/utilization?window=${window}&top=${top ? 1 : 0}`),
  getContainers: () => req('GET', '/api/containers'),
  getLogs: id => req('GET', `/api/containers/${id}/logs?tail=100`),
  containerAction: (id, action) => req('POST', `/api/containers/${id}/${action}`),
  checkImages: () => req('POST', '/api/images/check'),
  gitExec: (id, kind) => req('POST', `/api/containers/${id}/git/${kind}`),
  getRepos: () => req('GET', '/api/github/repos'),
  deploy: r => req('POST', '/api/deploy', r),
  getTelegram: () => req('GET', '/api/telegram'),
  deployTelegram: (token) => req('POST', '/api/telegram/deploy', { token }),
  claimTelegram: () => req('POST', '/api/telegram/claim'),
  updateTelegram: () => req('POST', '/api/telegram/update'),
  getSystem: () => req('GET', '/api/system'),
  getActions: deployedOnly => req('GET', deployedOnly ? '/api/actions?deployed=1' : '/api/actions'),
  checkSystem: () => req('POST', '/api/system/check'),
  updateDashboard: () => req('POST', '/api/system/dashboard/update'),
  getActivity: () => req('GET', '/api/activity'),
  setClaudeConfig: claudeConfigRepo => req('POST', '/api/settings/claude', { claudeConfigRepo }),
  setVscodeSettings: vscodeSettings => req('POST', '/api/settings/vscode', { vscodeSettings }),
  listSessions: () => req('GET', '/api/sessions'),
  revokeSession: id => req('DELETE', `/api/sessions/${encodeURIComponent(id)}`),
  setSessionLimits: l => req('POST', '/api/settings/sessions', l),
  applyConfig: (id, cfg) => req('POST', `/api/containers/${id}/config`, cfg),
  getVscode: id => req('GET', `/api/containers/${id}/vscode`),
  replaceVscode: id => req('POST', `/api/containers/${id}/vscode`),
  startClaudeLogin: id => req('POST', `/api/containers/${id}/claude-login`),
  sendClaudeCode: (id, code) => req('POST', `/api/containers/${id}/claude-login/code`, { code }),
  claudeLogout: id => req('POST', `/api/containers/${id}/claude-logout`),
  pullClaudeConfig: id => req('POST', `/api/containers/${id}/claude-config`),
  getClaudeConfigDiff: id => req('GET', `/api/containers/${id}/claude-config`),
}
