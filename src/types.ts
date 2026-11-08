export type TunnelState = 'connected' | 'waiting_for_login' | 'down' | 'unknown'

export interface DevContainerStatus {
  repo: string | null
  tunnel_name: string | null
  branch: string | null
  dirty: number | null
  last_commit: { sha: string; message: string; date: string } | null
  ahead: number | null
  behind: number | null
  tunnel: TunnelState
  mise: Record<string, string>
  workspace_file?: string | null // bare name of the repo's root *.code-workspace; absent from older images
  claude_installed?: boolean // absent from images before INSTALL_CLAUDE, which always had Claude Code
  claude_logged_in: boolean
  // the three below are absent from images before the background plugin sync
  claude_version?: string | null
  claude_plugins?: Record<string, string | null> // plugin@marketplace -> installed version
  claude_plugin_sync?: { state: 'running' | 'done'; at: string; warnings: string[] } | null // null until the first sync of this container starts
  uptime_seconds: number
}

export type ContainerState = 'running' | 'exited' | 'restarting' | 'created' | 'paused' | 'dead'

// update recreates the container on the newest image, so its id changes
export type ContainerAction = 'start' | 'stop' | 'restart' | 'update' | 'remove'
// what holds the container on the server: an action, Apply config (recreates it) or Replace VS Code settings (an exec)
export type Pending = ContainerAction | 'config' | 'vscode' | 'claudeConfig'
export type GitKind = 'fetch' | 'pull'

export interface DevContainer {
  id: string
  name: string
  // the container's REPO_URL, known even while it is stopped and status is null
  repo: string | null
  state: ContainerState
  startedAt: string
  finishedAt: string | null
  exitCode: number | null
  restartCount: number
  cpuPct: number
  memUsed: number
  memLimit: number
  diskRw: number
  diskVolume: number
  status: DevContainerStatus | null
  statusError: 'starting' | 'dead' | null
  statusFetchedAt: string | null
  lastFetchAt: string | null
  pending: Pending | null
  // device code parsed by the server from the log tail (gh "one-time code: X" or code tunnel "use code X")
  deviceCode: { code: string; kind: 'gh' | 'tunnel' } | null
  // last "fatal:" line of the log, shown in the restart-loop callout
  lastError: string | null
  // image reference the container was created from; imageUpdate is true when the registry has a newer one, null while unknown
  image: string
  imageUpdate: boolean | null
  imageCheckedAt: string | null
  // deploy options the container was created with, read from its env
  config: ContainerConfig
}

// installClaude: INSTALL_CLAUDE; injectClaudeConfig: CLAUDE_CONFIG_REPO set; vscodeConfig: VSCODE_CONFIG (seeds the VS Code Machine settings on a new home volume)
export interface ContainerConfig { installClaude: boolean; injectClaudeConfig: boolean; vscodeConfig: boolean }

// cpuPct, memUsed, stealPct, load1 and psiCpuSome10 come from the collector: 0 with collector false when it does not answer
export interface HostUsage { name: string; ncpu: number; memTotal: number; diskTotal: number; dockerVersion: string; cpuPct: number; memUsed: number; stealPct: number; load1: number; psiCpuSome10: number; collector: boolean; diskUsed: number; polledAt: string; reachable: boolean }

// GET /api/utilization?window=: the collector's history over a window (points keyed by container id or "host" for top) with its latest snapshot and every id resolved to a name
export type UsageWindow = '1h' | '6h' | '24h'
export interface UsageTop { comm: string; pids: number[]; cpuPct: number; rss: number }
export interface UsagePoint { t: number; host: { cpuPct: number; stealPct: number; memUsed: number; load1: number }; containers: Record<string, { name: string; cpuPct: number; memUsed: number }>; top: Record<string, UsageTop[]> }
export interface UsageContainer { id: string; name: string; image: string; dockbench: boolean; cpuPct: number; memUsed: number; memLimit: number }
export interface UsageProcess { comm: string; pids: number[]; container: string; cpuPct: number; rss: number }
export interface Utilization { window: UsageWindow; stepMs: number; at: number; points: UsagePoint[]; containers: UsageContainer[]; processes: UsageProcess[]; names: Record<string, { name: string; dockbench: boolean }> }

export interface ApiCall { method: string; path: string; status: number | null }

export interface ActivityEvent { at: string; actor: string; what: string; target: string; ok: boolean; note?: string; calls: ApiCall[]; ms?: number; ip?: string; device?: string }

export interface ExecResult { cmd: string; exitCode: number | null; output: string; calls: ApiCall[] }

export interface GithubRepo { fullName: string; private: boolean; language: string | null; defaultBranch: string; pushedAt: string; description: string | null; deployedAs: string | null }

// injectClaudeConfig uses Session.claudeConfigRepo, the server never takes the repo from the request
export interface DeployRequest { repo: string; project: string; gitUserName: string; gitUserEmail: string; auth: 'device' | 'token'; token?: string; image: string; installClaude: boolean; injectClaudeConfig: boolean; setupRerun: boolean; vscodeConfig: boolean; ghLogin: boolean }

// actions that ask for a passkey again once one is registered
export type Guarded = 'stop' | 'restart' | 'pull' | 'deploy' | 'update' | 'remove'
export type StepUpPrefs = Record<Guarded, boolean>

// stepUpUntil: ms until which no passkey check is asked again, null when none is open
// claudeConfigRepo: owner/name of the ~/.claude repo injected at deploy, '' for none
// vscodeSettings: VS Code settings.json text seeded into new dev containers, '' for the image's own
// maxDevices, idleDays: the device limits set in Settings (how many stay signed in, how long one may stay unused)
export interface Session { user: string; email: string; stepUpUntil: number | null; passkeys: number; stepUp: StepUpPrefs; claudeConfigRepo: string; vscodeSettings: string; maxDevices: number; idleDays: number }

// GET /api/sessions: one row per signed-in device, newest activity first; current is the device asking
export interface DeviceSession { id: string; createdAt: number; lastSeenAt: number; device: string; ip: string; current: boolean }

export interface PasskeyInfo { id: string; name: string; createdAt: string; lastUsedAt: string | null }

export interface ImageCheck { image: string; imageId: string | null; at: number; error: string | null }

export interface UpdateResult { id: string; name: string; calls: ApiCall[]; upToDate: boolean }
// POST /api/containers/:id/remove: how many volumes and deploy keys went; warning when the stack is gone but a volume or deploy key could not be removed or the /home/dev volume was kept
export interface RemoveResult { volumes: number; keys: number; warning?: string }
// POST /api/containers/:id/config; warning when the config key turned off could not be removed from GitHub
export interface ConfigResult extends UpdateResult { warning?: string }
// GET /api/containers/:id/claude-config: what ~/.claude changed since `commit`, the config commit it last downloaded, as a git diff ('' when nothing); truncated when cut at 200,000 bytes
export interface ConfigDiff { commit: string; diff: string; truncated: boolean }

export interface Prefs {
  theme: 'system' | 'light' | 'dark'
  accent: string
  poll: 2 | 5 | 15
  compact: boolean
  notify: boolean // system notifications while the dashboard is in the background
}

// GET /status of the Telegram bot, passed through by GET /api/telegram
// runs: Claude sessions running in the topic (bots from before 2026-10-14 send running only)
export interface BotStatus { bot: string; owner: boolean; group: boolean; topics: { name: string; running: boolean; runs?: number; queued: number }[]; last_poll_at: string | null; uptime_seconds: number }
export interface TelegramStatus { deployed: boolean; state: string | null; startedAt: string | null; image: string | null; imageUpdate: boolean | null; status: BotStatus | null; statusError: 'starting' | 'dead' | null }
export interface TelegramClaim { code: string; link: string }

// GET /api/system: the dashboard's own container and the bot's, for the Updates panel in Settings. imageUpdate as on DevContainer; checkError is why the last pull failed.
export interface SystemImage { name: string; deployed: boolean; state: string | null; startedAt: string | null; image: string | null; imageUpdate: boolean | null; imageCheckedAt: string | null; checkError: string | null }
// bootId changes when the dashboard server restarts; selfUpdateError is set when its restart or redeploy failed after answering
export interface SystemStatus { bootId: string; dashboard: SystemImage; telegram: SystemImage; collector: SystemImage; selfUpdateError: string | null }
export interface SelfUpdateResult extends UpdateResult { restarting: true }

// GET /api/actions: GitHub Actions per repo. status queued|in_progress|waiting|completed…, conclusion success|failure|cancelled|timed_out|skipped… once completed.
export interface ActionRun { id: number; workflow: string; title: string; branch: string | null; event: string; status: string; conclusion: string | null; sha: string; url: string; startedAt: string; updatedAt: string }
// state: running if a run is going, failure if the latest run of a workflow on the default branch failed, none without runs. latest: newest run per workflow on the default branch. private, defaultBranch and pushedAt are null for a deployed repo outside the account's 100 newest.
export interface RepoActions { repo: string; private: boolean | null; defaultBranch: string | null; pushedAt: string | null; deployedAs: string | null; state: 'running' | 'failure' | 'success' | 'none'; running: ActionRun[]; latest: ActionRun[]; lastSuccess: ActionRun | null; lastFailure: ActionRun | null; checkedAt: string; error: string | null }
