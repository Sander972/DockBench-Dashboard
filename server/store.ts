import { appendFile, mkdir, rename } from 'node:fs/promises'

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

export async function appendEvent(dataDir: string, event: ActivityEvent): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  await appendFile(`${dataDir}/activity.jsonl`, JSON.stringify(event) + '\n')
}

// ponytail: reads the whole file on every request, fine for a personal log; rotate or switch to SQLite if it grows past a few MB
export async function readEvents(dataDir: string, limit = 200): Promise<ActivityEvent[]> {
  const f = Bun.file(`${dataDir}/activity.jsonl`)
  if (!(await f.exists())) return []
  const lines = (await f.text()).split('\n').filter(Boolean)
  return lines.slice(-limit).reverse().map((l) => JSON.parse(l) as ActivityEvent)
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
