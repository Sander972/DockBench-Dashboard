import type { ContainerRow } from './docker'
import { HttpError } from './http'
import type { ApiCall } from './store'

export const PROJECT_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
export const REPO_RE = /^[\w.-]+\/[\w.-]+$/

// Subset of DeployRequest in src/types.ts that the server uses. `auth` and `token` are accepted and ignored: the container gets its own deploy key for the repo, or with ghLogin signs in to gh itself.
export interface DeployInput {
  repo: string
  project: string
  gitUserName: string
  gitUserEmail: string
  image: string
  installClaude: boolean // absent means true, like INSTALL_CLAUDE in the image
  injectClaudeConfig: boolean // the repo comes from Settings, never from the request
  setupRerun: boolean // SETUP_RERUN=1: .devcontainer/setup.sh on every start, not only on a new container
  vscodeConfig: boolean // absent means true, like VSCODE_CONFIG in the image; the settings come from Settings
  ghLogin: boolean // no deploy key: empty SSH_KEY and an https REPO_URL, so the image runs the gh device login (account-wide access, for multi-repo workspaces)
}

export function validateDeploy(body: unknown, defaultImage: string): { ok: true; value: DeployInput } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>
  const s = (k: string) => (typeof b[k] === 'string' ? (b[k] as string).trim() : '')
  const value = { repo: s('repo'), project: s('project'), gitUserName: s('gitUserName'), gitUserEmail: s('gitUserEmail'), image: s('image') || defaultImage, installClaude: b.installClaude !== false, injectClaudeConfig: b.injectClaudeConfig === true, setupRerun: b.setupRerun === true, vscodeConfig: b.vscodeConfig !== false, ghLogin: b.ghLogin === true }
  if (!REPO_RE.test(value.repo)) return { ok: false, error: 'repo must be owner/name' }
  if (!value.project) return { ok: false, error: 'project is required' }
  if (value.project.length > 20) return { ok: false, error: 'project must be at most 20 characters' }
  if (!PROJECT_RE.test(value.project)) return { ok: false, error: 'project must match ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' }
  if (value.project === 'telegram') return { ok: false, error: 'project telegram is taken by the Telegram bot' }
  if (!value.gitUserName) return { ok: false, error: 'gitUserName is required' }
  // both end up in the stack env and in git config, where a newline would add lines
  for (const k of ['gitUserName', 'gitUserEmail'] as const) if (/[\x00-\x1f\x7f]/.test(value[k])) return { ok: false, error: `${k} must be one line without control characters` }
  if (!value.gitUserEmail.includes('@')) return { ok: false, error: 'gitUserEmail must be an email' }
  if (/\s/.test(value.image)) return { ok: false, error: 'image must not contain spaces' }
  return { ok: true, value }
}

export interface DeployDeps {
  listContainers: () => Promise<ContainerRow[]>
  findStack: (name: string) => Promise<{ Id: number } | null>
  pullImage: () => Promise<void>
  // the workspace repo's key; absent with ghLogin, where the container signs in to gh instead
  createDeployKey?: () => Promise<{ id: number }>
  deleteDeployKey?: (id: number) => Promise<void>
  // the read-only key on the Claude config repo, called only when deploy gets a configRepo
  createConfigKey?: () => Promise<{ id: number }>
  deleteConfigKey?: (id: number) => Promise<void>
  createStack: (name: string) => Promise<{ Id: number }>
  sleep?: (ms: number) => Promise<void>
}

// Same shape as DeployResult in src/api/index.ts. `id` is the new container id, or '' when it had not appeared within 10 seconds.
export interface DeployResult {
  id: string
  name: string
  calls: ApiCall[]
  // set when Portainer created the stack but its answer to the create was lost
  warning?: string
}

// A failed create answer can still mean a created stack: asks Portainer (one call in calls per lookup), then answers the warning when the stack exists, so the deploy is reported done instead of a failure followed by a 409 on the next try. When Portainer itself refused (a status other than a gateway's 502, 503 or 504) one lookup settles it, and onNone runs when it confirms there is no stack. When the answer was lost (network error, timeout, gateway status), Portainer may still be running compose up and saves the stack only after it, so the lookup is repeated lostChecks times waitMs apart, and onNone never runs: keys deleted under a stack saved late leave a container that cannot clone, while a key left over is only clutter. Otherwise rethrows e.
export async function afterFailedCreate(e: unknown, calls: ApiCall[], findStack: () => Promise<{ Id: number } | null>, onNone?: () => Promise<void>, sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms), lostChecks = 6, waitMs = 5000): Promise<string> {
  // deploy() wraps the create error in a DeployFailure whose own status is the dashboard's answer, so Portainer's status is read from the original
  const status = ((e instanceof DeployFailure ? e.cause : e) as { status?: unknown } | undefined)?.status
  const refused = typeof status === 'number' && ![502, 503, 504].includes(status)
  for (let left = refused ? 1 : lostChecks; ; ) {
    const check: ApiCall = { method: 'GET', path: '/api/stacks', status: null }
    calls.push(check)
    const stack = await findStack().then((s) => { check.status = 200; return s }, () => undefined)
    if (stack) return `Portainer created the stack, but its answer was lost: ${(e as Error).message}`
    if (refused && stack === null) await onNone?.()
    if (--left <= 0) throw e
    await sleep(waitMs)
  }
}

export class DeployFailure extends Error {
  status: number
  calls: ApiCall[]
  constructor(status: number, message: string, calls: ApiCall[], cause?: unknown) {
    super(message, { cause })
    this.status = status
    this.calls = calls
  }
}

// ponytail: statuses are the expected success codes, the real upstream code is not threaded back; a step that throws leaves its status null
export async function deploy(project: string, repo: string, deps: DeployDeps, configRepo = ''): Promise<DeployResult> {
  const name = `dockbench-${project}`
  const calls: ApiCall[] = []
  const step = async <T>(method: string, path: string, okStatus: number, run: () => Promise<T>): Promise<T> => {
    const call: ApiCall = { method, path, status: null }
    calls.push(call)
    try {
      const out = await run()
      call.status = okStatus
      return out
    } catch (e) {
      throw e instanceof HttpError ? new DeployFailure(e.status, e.message, calls, e) : new DeployFailure(502, (e as Error).message, calls, e)
    }
  }
  const existing = await step('GET', '/containers/json', 200, deps.listContainers)
  if (existing.some((c) => c.name === name)) throw new DeployFailure(409, `Container ${name} already exists`, calls)
  if (await step('GET', '/api/stacks', 200, () => deps.findStack(name))) throw new DeployFailure(409, `Stack ${name} already exists`, calls)
  await step('POST', '/images/create', 200, deps.pullImage)
  const key = deps.createDeployKey ? await step('POST', `/repos/${repo}/keys`, 201, deps.createDeployKey) : null
  // best effort: the error that got us here is what the user needs to see
  const unkey = async (r: string, id: number, del: (id: number) => Promise<void>) => {
    const call: ApiCall = { method: 'DELETE', path: `/repos/${r}/keys/${id}`, status: null }
    calls.push(call)
    await del(id).then(() => { call.status = 204 }, () => {})
  }
  let configKey: { id: number } | null = null
  if (configRepo) {
    try {
      configKey = await step('POST', `/repos/${configRepo}/keys`, 201, deps.createConfigKey!)
    } catch (e) {
      if (key) await unkey(repo, key.id, deps.deleteDeployKey!)
      throw e
    }
  }
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let warning: string | undefined
  try {
    await step('POST', '/api/stacks/create/standalone/string', 200, () => deps.createStack(name))
  } catch (e) {
    // the keys must not outlive a stack that was never created. A created stack's container clones with these keys, so they go only when Portainer refused the create and confirms there is no stack.
    warning = await afterFailedCreate(e, calls, () => deps.findStack(name), async () => {
      if (key) await unkey(repo, key.id, deps.deleteDeployKey!)
      if (configKey) await unkey(configRepo, configKey.id, deps.deleteConfigKey!)
    }, sleep)
  }
  let id = ''
  for (let i = 0; i < 10 && !id; i++) {
    id = (await step('GET', '/containers/json', 200, deps.listContainers)).find((c) => c.name === name)?.id ?? ''
    if (!id) await sleep(1000)
  }
  return { id, name, calls, ...(warning && { warning }) }
}
