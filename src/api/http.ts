import type { Session } from '../types'
import type { Api } from './index'
import { SignedOut, StepUpRequired } from './errors'

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
  if (r.status === 403 && data?.error === 'step_up_required') throw new StepUpRequired()
  if (!r.ok) throw Object.assign(new Error(data?.message || data?.error || `${method} ${path} · ${r.status}`), { calls: data?.calls })
  return data as T
}

const b64uDecode = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0))
const b64uEncode = (b: ArrayBuffer | null) => (b ? btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : null)
type CredRef = { id: string; type: 'public-key' }

// WebAuthn round trip: options from the server, assertion from the authenticator, verify on the server
async function passkey<T>(base: string): Promise<T> {
  const o = await req<{ challenge: string; allowCredentials?: CredRef[] } & Record<string, unknown>>('POST', base + '/options')
  const publicKey = {
    ...o,
    challenge: b64uDecode(o.challenge),
    allowCredentials: o.allowCredentials?.map(c => ({ ...c, id: b64uDecode(c.id) })),
  } as PublicKeyCredentialRequestOptions
  const cred = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null
  if (!cred) throw new Error('No passkey was used.')
  const a = cred.response as AuthenticatorAssertionResponse
  return req<T>('POST', base + '/verify', {
    id: cred.id,
    rawId: b64uEncode(cred.rawId),
    type: cred.type,
    response: {
      authenticatorData: b64uEncode(a.authenticatorData),
      clientDataJSON: b64uEncode(a.clientDataJSON),
      signature: b64uEncode(a.signature),
      userHandle: b64uEncode(a.userHandle),
    },
  })
}

// creation options (the first passkey needs the authenticator code), the new credential from the authenticator, then the server checks and stores it
async function register(name: string, code?: string): Promise<void> {
  const o = await req<{ challenge: string; user: { id: string } & Record<string, unknown>; excludeCredentials: CredRef[] } & Record<string, unknown>>('POST', '/api/passkeys/options', { code })
  const publicKey = {
    ...o,
    challenge: b64uDecode(o.challenge),
    user: { ...o.user, id: b64uDecode(o.user.id) },
    excludeCredentials: o.excludeCredentials.map(c => ({ ...c, id: b64uDecode(c.id) })),
  } as unknown as PublicKeyCredentialCreationOptions
  const cred = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null
  if (!cred) throw new Error('No passkey was created.')
  const a = cred.response as AuthenticatorAttestationResponse
  await req('POST', '/api/passkeys', {
    name,
    credential: { id: cred.id, rawId: b64uEncode(cred.rawId), type: cred.type, response: { clientDataJSON: b64uEncode(a.clientDataJSON), attestationObject: b64uEncode(a.attestationObject) } },
  })
}

export const http: Api = {
  getSession: () => req<Session>('GET', '/api/session').catch(e => {
    if (e instanceof SignedOut) return null
    throw e
  }),
  signInGithub: () => window.location.assign('/api/auth/github/start'),
  signInPasskey: () => passkey('/api/auth/passkey'),
  stepUp: async () => (await passkey<{ stepUpUntil: number }>('/api/auth/step-up')).stepUpUntil,
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
  deployTelegram: (token, dockerGid) => req('POST', '/api/telegram/deploy', { token, dockerGid }),
  claimTelegram: () => req('POST', '/api/telegram/claim'),
  updateTelegram: () => req('POST', '/api/telegram/update'),
  getSystem: () => req('GET', '/api/system'),
  getActions: deployedOnly => req('GET', deployedOnly ? '/api/actions?deployed=1' : '/api/actions'),
  checkSystem: () => req('POST', '/api/system/check'),
  updateDashboard: () => req('POST', '/api/system/dashboard/update'),
  getActivity: () => req('GET', '/api/activity'),
  listPasskeys: () => req('GET', '/api/passkeys'),
  addPasskey: register,
  removePasskey: id => req('DELETE', `/api/passkeys/${encodeURIComponent(id)}`),
  setStepUp: p => req('POST', '/api/settings/step-up', p),
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
