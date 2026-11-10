import type { ActivityEvent, ApiCall, ConfigDiff, ConfigResult, ContainerAction, ContainerConfig, DeployRequest, DevContainer, DeviceSession, ExecResult, GitKind, GithubRepo, HostUsage, ImageCheck, PasskeyInfo, RepoActions, SelfUpdateResult, Session, StepUpPrefs, SystemStatus, TelegramClaim, TelegramStatus, RemoveResult, UpdateResult, UsageWindow, Utilization } from '../types'
import { http } from './http'

export { SignedOut, StepUpRequired } from './errors'

// msg is optional (handoff section 8 has none); the store falls back to gitMsg()
export type GitResult = ExecResult & { msg?: string }
// warning: Portainer created the stack but its answer to the create was lost
export interface DeployResult { id: string; name: string; calls: ApiCall[]; warning?: string }

// handoff section 9
export interface Api {
  getSession(): Promise<Session | null>
  // leaves the page for GitHub
  signInGithub(): void
  // sets the session cookie; the caller reloads into the app
  signInPasskey(): Promise<void>
  // passkey re-check, returns the new stepUpUntil (ms)
  stepUp(): Promise<number>
  // all: every device, not only this one
  signOut(all?: boolean): Promise<void>
  getHost(): Promise<HostUsage>
  getContainers(): Promise<DevContainer[]>
  // the collector's history over a window with its latest snapshot; top false leaves the per-process lists out; fails with 'collector unreachable' when it does not answer
  getUtilization(window: UsageWindow, top: boolean): Promise<Utilization>
  getLogs(id: string): Promise<string[]>
  // update answers UpdateResult, remove RemoveResult, the others {}
  containerAction(id: string, action: ContainerAction): Promise<Partial<UpdateResult> & Partial<RemoveResult>>
  checkImages(): Promise<ImageCheck[]>
  gitExec(id: string, kind: GitKind): Promise<GitResult>
  getRepos(): Promise<GithubRepo[]>
  deploy(req: DeployRequest): Promise<DeployResult>
  getTelegram(): Promise<TelegramStatus>
  deployTelegram(token: string): Promise<{ bot: string; calls: ApiCall[]; warning?: string }>
  claimTelegram(): Promise<TelegramClaim>
  updateTelegram(): Promise<UpdateResult>
  getSystem(): Promise<SystemStatus>
  // deployedOnly: just the repos dev containers were cloned from
  getActions(deployedOnly?: boolean): Promise<RepoActions[]>
  // pulls the dashboard and bot images now
  checkSystem(): Promise<SystemStatus>
  // answers before the server restarts itself; wait for a new bootId on getSystem
  updateDashboard(): Promise<SelfUpdateResult>
  getActivity(): Promise<ActivityEvent[]>
  listPasskeys(): Promise<PasskeyInfo[]>
  // code: the authenticator code, needed for the first passkey only
  addPasskey(name: string, code?: string): Promise<void>
  removePasskey(id: string): Promise<void>
  setStepUp(p: Partial<StepUpPrefs>): Promise<StepUpPrefs>
  // '' stops injecting; only later deploys read it
  setClaudeConfig(repo: string): Promise<{ claudeConfigRepo: string }>
  // '' means the image's own; only later deploys and Replace read it
  setVscodeSettings(text: string): Promise<{ vscodeSettings: string }>
  listSessions(): Promise<DeviceSession[]>
  // signs that device out; its next request answers 401
  revokeSession(id: string): Promise<void>
  // lowering maxDevices signs the least recently seen devices out at once, never this one
  setSessionLimits(l: { maxDevices: number; idleDays: number }): Promise<{ maxDevices: number; idleDays: number }>
  // rewrites the stack variables and recreates the container, so the id changes
  applyConfig(id: string, cfg: ContainerConfig): Promise<ConfigResult>
  // the container's VS Code Machine settings, null when it has none
  getVscode(id: string): Promise<{ settings: string | null }>
  // overwrites them with the global ones
  replaceVscode(id: string): Promise<{ settings: string }>
  // starts claude auth login in the container and answers the link it printed
  startClaudeLogin(id: string): Promise<{ url: string }>
  // the code claude.com showed after sign-in; one wrong code ends the attempt
  sendClaudeCode(id: string, code: string): Promise<{ ok: true }>
  // signs Claude Code out in the container (credentials file removed), so another account can be signed in
  claudeLogout(id: string): Promise<{ ok: true }>
  // downloads the Claude config repo again over ~/.claude, answers the short commit it landed on
  pullClaudeConfig(id: string): Promise<{ commit: string }>
  // what ~/.claude changed since that commit
  getClaudeConfigDiff(id: string): Promise<ConfigDiff>
}

export const api: Api = http
