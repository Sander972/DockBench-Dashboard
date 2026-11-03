export function dockerFetch(host: string, path: string, init: BunFetchRequestInit = {}): Promise<Response> {
  if (host.startsWith('tcp://') || host.startsWith('http://')) return fetch(host.replace(/^tcp:/, 'http:') + path, init)
  return fetch('http://docker' + path, { ...init, unix: host })
}

export interface ContainerRow {
  id: string
  name: string
  state: string
  image: string
}

type Row = { Id: string; Names: string[]; State: string; Image: string }
const toRow = (c: Row): ContainerRow => ({ id: c.Id, name: c.Names[0].replace(/^\//, ''), state: c.State, image: c.Image })

async function listContainers(host: string, filters: Record<string, string[]>): Promise<ContainerRow[]> {
  const res = await dockerFetch(host, `/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify(filters))}`)
  if (!res.ok) throw new Error(`Docker list returned ${res.status}`)
  return ((await res.json()) as Row[]).map(toRow)
}

export const listDockbench = (host: string) => listContainers(host, { label: ['dockbench=true'] })

// one container by exact name, whatever its labels (the Telegram bot has no dockbench label); null when there is none
export async function containerByName(host: string, name: string): Promise<ContainerRow | null> {
  return (await listContainers(host, { name: [`^/${name}$`] }))[0] ?? null
}

export interface Inspect {
  startedAt: string
  finishedAt: string | null
  exitCode: number | null
  restartCount: number
  memLimit: number
  repoUrl: string | null
  // name of the volume mounted at /home/dev, for its size in systemDf
  homeVolume: string | null
  // the reference the container was created from (ghcr.io/x/dockbench:latest) and the image id it actually runs
  image: string
  imageId: string
  // compose project, which is the Portainer stack name; null for a container started without compose
  project: string | null
  // deploy options as the container was created with them; unset variables read as the image defaults
  config: { installClaude: boolean; injectClaudeConfig: boolean; vscodeConfig: boolean }
}

const ZERO_TIME = '0001-01-01T00:00:00Z'

export async function inspectContainer(host: string, id: string): Promise<Inspect> {
  const res = await dockerFetch(host, `/containers/${id}/json`)
  if (!res.ok) throw new Error(`Docker inspect returned ${res.status}`)
  const c = (await res.json()) as { Image: string; State: { Status: string; StartedAt: string; FinishedAt: string; ExitCode: number }; RestartCount: number; HostConfig: { Memory: number }; Config: { Env: string[]; Image: string; Labels?: Record<string, string> | null }; Mounts?: { Destination: string; Name?: string }[] }
  const env = Object.fromEntries(c.Config.Env.map((e) => e.split(/=(.*)/s).slice(0, 2)))
  const exited = c.State.Status === 'exited' || c.State.Status === 'dead'
  return {
    startedAt: c.State.StartedAt,
    finishedAt: c.State.FinishedAt === ZERO_TIME ? null : c.State.FinishedAt,
    exitCode: exited ? c.State.ExitCode : null,
    restartCount: c.RestartCount,
    memLimit: c.HostConfig.Memory,
    repoUrl: env.REPO_URL ?? null,
    homeVolume: c.Mounts?.find((m) => m.Destination === '/home/dev')?.Name ?? null,
    image: c.Config.Image,
    imageId: c.Image,
    project: c.Config.Labels?.['com.docker.compose.project'] ?? null,
    config: { installClaude: env.INSTALL_CLAUDE !== '0', injectClaudeConfig: !!env.CLAUDE_CONFIG_REPO, vscodeConfig: env.VSCODE_CONFIG !== '0' },
  }
}

// Docker multiplexes stdout and stderr when the container or exec has no TTY: 8-byte frames, byte 0 the stream (0-2), bytes 4-7 the big-endian payload length. A TTY stream is raw text, told apart by a first byte that is not a stream id or non-zero padding.
export function demux(buf: Uint8Array): string {
  const b = Buffer.from(buf)
  const framed = b.length >= 8 && b[0] <= 2 && b[1] === 0 && b[2] === 0 && b[3] === 0
  if (!framed) return b.toString('utf8')
  const parts: Buffer[] = []
  for (let i = 0; i + 8 <= b.length; ) {
    const n = b.readUInt32BE(i + 4)
    parts.push(b.subarray(i + 8, i + 8 + n))
    i += 8 + n
  }
  return Buffer.concat(parts).toString('utf8')
}

// colors and cursor moves from gh, mise and code tunnel would show up as garbage in the log box
export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '')

export function logLines(text: string): string[] {
  const lines = stripAnsi(text).split('\n').map((l) => l.replace(/\r$/, '').replace(/^.*\r/, ''))
  if (lines.at(-1) === '') lines.pop()
  return lines
}

export async function containerLogs(host: string, id: string, tail: number): Promise<string[]> {
  const res = await dockerFetch(host, `/containers/${id}/logs?stdout=true&stderr=true&tail=${tail}`)
  if (!res.ok) throw new Error(`Docker logs returned ${res.status}`)
  return logLines(demux(new Uint8Array(await res.arrayBuffer())))
}

// start, stop, restart. 304 means it already was in that state, which is what the caller wanted.
export async function containerPost(host: string, id: string, action: 'start' | 'stop' | 'restart'): Promise<number> {
  const res = await dockerFetch(host, `/containers/${id}/${action}`, { method: 'POST' })
  if (!res.ok && res.status !== 304) throw new Error(`Docker ${action} returned ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return res.status
}

// force: a running container goes too. 404 means it is already gone, which is what the caller wanted.
export async function removeContainer(host: string, id: string): Promise<void> {
  const res = await dockerFetch(host, `/containers/${id}?force=true`, { method: 'DELETE' })
  if (!res.ok && res.status !== 404) throw new Error(`Docker remove container returned ${res.status}: ${(await res.text()).slice(0, 300)}`)
}

// the volumes compose created for this project (it labels them with it), so an external volume the stack only mounts is never listed
export async function stackVolumes(host: string, project: string): Promise<string[]> {
  const res = await dockerFetch(host, `/volumes?filters=${encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${project}`] }))}`)
  if (!res.ok) throw new Error(`Docker list volumes returned ${res.status}`)
  return (((await res.json()) as { Volumes: { Name: string }[] | null }).Volumes ?? []).map((v) => v.Name)
}

// 404 means it is already gone; Docker answers 409 while a container still uses it
export async function removeVolume(host: string, name: string): Promise<void> {
  const res = await dockerFetch(host, `/volumes/${encodeURIComponent(name)}`, { method: 'DELETE' })
  if (!res.ok && res.status !== 404) throw new Error(`Docker remove volume ${name} returned ${res.status}: ${(await res.text()).slice(0, 300)}`)
}

export interface ExecOutcome {
  exitCode: number | null
  output: string
  calls: { method: string; path: string; status: number | null }[]
}

// create, run attached until the process exits, then read the exit code. Runs as dev in the workspace like the API doc says; GIT_TERMINAL_PROMPT=0 makes git fail instead of waiting for a password nobody can type. ponytail: an exec that outlives the timeout keeps running in the container, the caller only stops waiting.
export async function execRun(host: string, id: string, cmd: string[], { timeoutMs = 120_000, keep = 20_000, workDir = '/home/dev/workspace' } = {}): Promise<ExecOutcome> {
  const calls: ExecOutcome['calls'] = []
  const call = (method: string, path: string) => (calls.push({ method, path, status: null }), calls.at(-1)!)
  const c1 = call('POST', `/containers/${id.slice(0, 12)}/exec`)
  const created = await dockerFetch(host, `/containers/${id}/exec`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ User: 'dev', WorkingDir: workDir, Cmd: cmd, Env: ['GIT_TERMINAL_PROMPT=0'], AttachStdout: true, AttachStderr: true }) })
  c1.status = created.status
  if (!created.ok) throw Object.assign(new Error(`Docker exec returned ${created.status}: ${(await created.text()).slice(0, 300)}`), { calls })
  const execId = ((await created.json()) as { Id: string }).Id
  const c2 = call('POST', `/exec/${execId.slice(0, 12)}/start`)
  const started = await dockerFetch(host, `/exec/${execId}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Detach: false, Tty: false }), signal: AbortSignal.timeout(timeoutMs) })
  c2.status = started.status
  const output = stripAnsi(demux(new Uint8Array(await started.arrayBuffer()))).slice(-keep)
  const c3 = call('GET', `/exec/${execId.slice(0, 12)}/json`)
  const inspected = await dockerFetch(host, `/exec/${execId}/json`)
  c3.status = inspected.status
  const exitCode = inspected.ok ? ((await inspected.json()) as { ExitCode: number | null }).ExitCode : null
  return { exitCode, output, calls }
}

// image id behind a reference or id, and the digests it was pulled under (ghcr.io/x/dockbench@sha256:abc)
export async function imageInspect(host: string, image: string): Promise<{ id: string; digests: string[] }> {
  const res = await dockerFetch(host, `/images/${image}/json`)
  if (!res.ok) throw new Error(`Docker image inspect returned ${res.status}`)
  const i = (await res.json()) as { Id: string; RepoDigests?: string[] }
  return { id: i.Id, digests: i.RepoDigests ?? [] }
}

export interface Stats {
  cpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number }
  precpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number }
  memory_stats: { usage?: number; limit?: number; stats?: Record<string, number> }
}

// share of the whole host (0-100, not docker stats' per-core 400%), matching HostUsage.cpuPct and the "x of n cores" readout. Memory as docker stats shows it: usage minus page cache (inactive_file on cgroup v2, total_inactive_file on v1).
export function parseStats(s: Stats): { cpuPct: number; memUsed: number; memLimit: number } {
  const cpu = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage
  // without a previous system time the difference would be the host's whole uptime
  const pre = s.precpu_stats.system_cpu_usage
  const sys = pre ? (s.cpu_stats.system_cpu_usage ?? 0) - pre : 0
  const m = s.memory_stats
  // as docker stats: cgroup v1's hierarchical total_inactive_file first, then inactive_file, each only when below usage, else the raw usage
  const usage = m.usage ?? 0
  const cache = [m.stats?.total_inactive_file, m.stats?.inactive_file].find((c) => c !== undefined && c < usage) ?? 0
  return { cpuPct: sys > 0 && cpu > 0 ? (cpu / sys) * 100 : 0, memUsed: usage - cache, memLimit: m.limit ?? 0 }
}

// stream=false makes the daemon wait for a second sample (about 1 s) so precpu_stats is filled
export async function containerStats(host: string, id: string): Promise<ReturnType<typeof parseStats>> {
  const res = await dockerFetch(host, `/containers/${id}/stats?stream=false`)
  if (!res.ok) throw new Error(`Docker stats returned ${res.status}`)
  return parseStats((await res.json()) as Stats)
}

export interface DiskSizes {
  rw: Map<string, number>
  volumes: Map<string, number>
}

// writable layer per container id and size per volume name. Docker reports -1 for a size it does not know.
export async function systemDf(host: string): Promise<DiskSizes> {
  // shared() starts no new df while one runs, so a df that never answers must fail instead of blocking every refresh; 10 min leaves room for a slow df on a host with many large layers or volumes. df sends nothing until it is done, so Bun's 5 min idle timeout is turned off to let the 10 min signal decide.
  const res = await dockerFetch(host, '/system/df?type=container&type=volume', { signal: AbortSignal.timeout(600_000), timeout: false })
  if (!res.ok) throw new Error(`Docker df returned ${res.status}`)
  const d = (await res.json()) as { Containers?: { Id: string; SizeRw?: number }[]; Volumes?: { Name: string; UsageData?: { Size: number } }[] }
  return {
    rw: new Map((d.Containers ?? []).map((c) => [c.Id, Math.max(0, c.SizeRw ?? 0)])),
    volumes: new Map((d.Volumes ?? []).map((v) => [v.Name, Math.max(0, v.UsageData?.Size ?? 0)])),
  }
}

export interface DockerInfo {
  name: string
  ncpu: number
  memTotal: number
  dockerVersion: string
}

export async function dockerInfo(host: string): Promise<DockerInfo> {
  const res = await dockerFetch(host, '/info')
  if (!res.ok) throw new Error(`Docker info returned ${res.status}`)
  const i = (await res.json()) as { Name: string; NCPU: number; MemTotal: number; ServerVersion: string }
  return { name: i.Name, ncpu: i.NCPU, memTotal: i.MemTotal, dockerVersion: i.ServerVersion }
}

export function splitImage(image: string): { name: string; tag: string; registry: string } {
  const slash = image.lastIndexOf('/')
  const colon = image.lastIndexOf(':')
  const hasTag = colon > slash
  const name = hasTag ? image.slice(0, colon) : image
  const tag = hasTag ? image.slice(colon + 1) : 'latest'
  const first = name.split('/')[0]
  const registry = name.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost') ? first : 'docker.io'
  return { name, tag, registry }
}
