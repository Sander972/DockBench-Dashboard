import { appendFile, mkdir, rename, stat } from 'node:fs/promises'

export interface Account {
  login: string
  id: number
  name: string | null
  avatar_url: string
  token: string
}

// Same shape as ApiCall and ActivityEvent in src/types.ts
export interface ApiCall {
  method: string
  path: string
  status: number | null
}

export interface ActivityEvent {
  at: string
  actor: string
  what: string
  target: string
  ok: boolean
  note?: string
  calls: ApiCall[]
  ms?: number
  ip?: string
  device?: string
}

export async function readAccount(dataDir: string): Promise<Account | null> {
  const f = Bun.file(`${dataDir}/github.json`)
  return (await f.exists()) ? f.json() : null
}

export async function writeAccount(dataDir: string, account: Account): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  await Bun.write(`${dataDir}/github.json`, JSON.stringify(account))
}

// Activity log operations run one at a time: two appends crossing the cap together would both rotate and the second would move a one-line file over the rotated one, and a read between a rotation's two files would see the same lines twice. The next operation waits at most stallMs from when this one started, so a stalled disk hangs only the request whose operation stalled, not every later one.
let activityQueue: Promise<unknown> = Promise.resolve()
function queued<T>(op: () => Promise<T>, stallMs: number): Promise<T> {
  const prev = activityQueue
  const run = prev.then(op)
  activityQueue = prev.then(() => Promise.race([run, Bun.sleep(stallMs)])).catch(() => {})
  return run
}

// the unauthenticated OAuth callback writes events too, so the log is capped: past maxBytes it moves to activity.jsonl.1 (replacing the previous one) and starts again
export function appendEvent(dataDir: string, event: ActivityEvent, maxBytes = 5 * 1024 * 1024, stallMs = 5000): Promise<void> {
  return queued(async () => {
    await mkdir(dataDir, { recursive: true })
    const path = `${dataDir}/activity.jsonl`
    const line = JSON.stringify(event) + '\n'
    if ((await stat(path).then((s) => s.size, () => 0)) + Buffer.byteLength(line) > maxBytes) await rename(path, `${path}.1`).catch(() => {})
    await appendFile(path, line)
  }, stallMs)
}

// the last n lines of a file, read backwards in 64 KB chunks until more than n line ends are in, so a large file (a log from before the cap) costs only its tail; decoded once at the end, so a chunk edge never splits a character of a kept line
async function tailLines(path: string, n: number): Promise<string[]> {
  const f = Bun.file(path)
  if (n <= 0 || !(await f.exists())) return []
  const chunks: Uint8Array[] = []
  let end = f.size, ends = 0
  while (end > 0 && ends <= n) {
    const start = Math.max(0, end - 64 * 1024)
    const chunk = new Uint8Array(await f.slice(start, end).arrayBuffer())
    chunks.unshift(chunk)
    for (const b of chunk) if (b === 10) ends++
    end = start
  }
  return Buffer.concat(chunks).toString('utf8').split('\n').filter(Boolean).slice(-n)
}

// newest first; when the newest file holds fewer than limit events (right after a rotation) the rotated one tops it up
export function readEvents(dataDir: string, limit = 200, stallMs = 5000): Promise<ActivityEvent[]> {
  return queued(async () => {
    const lines = await tailLines(`${dataDir}/activity.jsonl`, limit)
    return [...(await tailLines(`${dataDir}/activity.jsonl.1`, limit - lines.length)), ...lines].reverse().map((l) => JSON.parse(l) as ActivityEvent)
  }, stallMs)
}

// time of the last successful fetch or pull per container name, from the whole log (both files) so a fetch older than the newest events still counts; read once per process
export async function lastFetchTimes(dataDir: string): Promise<Map<string, string>> {
  const m = new Map<string, string>()
  for (const e of (await readEvents(dataDir, Infinity)).reverse()) if (e.ok && (e.what === 'Fetched' || e.what === 'Pulled')) m.set(e.target, e.at)
  return m
}

// Settings in src/types.ts. /data/settings.json: dashboard-wide defaults that are not secrets. A missing or corrupt file reads as the defaults.
export interface Settings {
  claudeConfigRepo: string // owner/name of the user's ~/.claude repo, '' for none
  vscodeSettings: string // VS Code settings.json text (comments allowed) seeded into new dev containers, '' for the image's own
  maxDevices: number // signed-in devices kept at once (1 to 20); a login past it signs the least recently seen one out
  idleDays: number // days a device may stay unused before it is signed out (1 to 30)
}
// [min, max, default]
export const LIMIT_RANGES = { maxDevices: [1, 20, 5], idleDays: [1, 30, 2] } as const

export async function readSettings(dataDir: string): Promise<Settings> {
  const f = Bun.file(`${dataDir}/settings.json`)
  const stored = (await f.exists()) ? ((await f.json().catch(() => null)) as Partial<Settings> | null) : null
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  // integers only, clamped into the range; anything else is the default
  const int = (v: unknown, [min, max, def]: readonly [number, number, number]) => (typeof v === 'number' && Number.isInteger(v) ? Math.min(max, Math.max(min, v)) : def)
  return { claudeConfigRepo: str(stored?.claudeConfigRepo), vscodeSettings: str(stored?.vscodeSettings), maxDevices: int(stored?.maxDevices, LIMIT_RANGES.maxDevices), idleDays: int(stored?.idleDays, LIMIT_RANGES.idleDays) }
}

// merges into the stored settings, so saving one field keeps the others. Writes run one at a time, or two saves would each merge into the old file and share the tmp path.
let settingsQueue: Promise<unknown> = Promise.resolve()
export function writeSettings(dataDir: string, patch: Partial<Settings>): Promise<void> {
  const run = settingsQueue.then(async () => {
    const s = { ...(await readSettings(dataDir)), ...patch }
    await mkdir(dataDir, { recursive: true })
    await Bun.write(`${dataDir}/settings.json.tmp`, JSON.stringify(s))
    await rename(`${dataDir}/settings.json.tmp`, `${dataDir}/settings.json`)
  })
  settingsQueue = run.catch(() => {})
  return run
}
