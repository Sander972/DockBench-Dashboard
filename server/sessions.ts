import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, rename } from 'node:fs/promises'
import { SESSION_TTL_SECONDS } from './session'

// One record per signed-in device, in /data/sessions.json. The cookie is only the record id plus an HMAC; expiry lives here: idle (idleDays since lastSeenAt) and hard (30 days since createdAt).
export interface SessionRecord { id: string; createdAt: number; lastSeenAt: number; device: string; ip: string }
export interface SessionLimits { maxDevices: number; idleDays: number }
export const DEFAULT_LIMITS: SessionLimits = { maxDevices: 5, idleDays: 2 }

const DAY = 24 * 3600 * 1000
const FLUSH_MS = 60_000

const sign = (secret: string, id: string) => createHmac('sha256', secret).update(id).digest('base64url')
export const signCookie = (secret: string, id: string) => `${id}.${sign(secret, id)}`
// the id when the cookie is `<id>.<hmac>` under this secret, else null (an old `<issued>.<expiry>.<hmac>` cookie has three parts and fails here)
export function parseCookie(secret: string, cookie: string | undefined | null): string | null {
  const parts = (cookie ?? '').split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  const got = Buffer.from(parts[1])
  const want = Buffer.from(sign(secret, parts[0]))
  // compared by bytes: timingSafeEqual throws on a byte-length mismatch, which a non-ASCII signature of the right string length would cause
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null
  return parts[0]
}

// only this process writes the file, so it is read once per data dir and kept in memory; flushed with temp file plus rename through one queue
type Cache = { list: SessionRecord[]; flushedAt: number }
// the load promise, not its result, so two first calls on a cold cache share one read and one list
const caches = new Map<string, Promise<Cache>>()
let queue: Promise<unknown> = Promise.resolve()

const isRecord = (v: unknown): v is SessionRecord => {
  const r = v as Partial<SessionRecord> | null
  return !!r && typeof r.id === 'string' && typeof r.createdAt === 'number' && typeof r.lastSeenAt === 'number' && typeof r.device === 'string' && typeof r.ip === 'string'
}

function load(dataDir: string): Promise<Cache> {
  let c = caches.get(dataDir)
  if (!c) {
    c = read(dataDir)
    caches.set(dataDir, c)
  }
  return c
}

async function read(dataDir: string): Promise<Cache> {
  const f = Bun.file(`${dataDir}/sessions.json`)
  const stored = (await f.exists()) ? ((await f.json().catch(() => null)) as { sessions?: unknown } | null) : null
  // anything malformed reads as no sessions (fail closed), the next write rewrites it
  const list = Array.isArray(stored?.sessions) ? stored!.sessions.filter(isRecord) : []
  return { list, flushedAt: 0 }
}

// flushedAt is set when the write is queued, so a burst of touches right after it queues no second one; the write serializes c.list as it is when it runs
function flush(dataDir: string, c: Cache, now: number): Promise<void> {
  c.flushedAt = now
  const run = queue.then(async () => {
    await mkdir(dataDir, { recursive: true })
    await Bun.write(`${dataDir}/sessions.json.tmp`, JSON.stringify({ sessions: c.list }))
    await rename(`${dataDir}/sessions.json.tmp`, `${dataDir}/sessions.json`)
  })
  queue = run.catch(() => {})
  return run
}

const alive = (r: SessionRecord, limits: SessionLimits, now: number) => now - r.lastSeenAt < limits.idleDays * DAY && now - r.createdAt < SESSION_TTL_SECONDS * 1000

// drops dead records in place; true when something was dropped
function prune(c: Cache, limits: SessionLimits, now: number): boolean {
  const before = c.list.length
  c.list = c.list.filter((r) => alive(r, limits, now))
  return c.list.length !== before
}

// evicts the least recently seen records until the cap holds, never keepId
function evict(c: Cache, max: number, keepId: string): boolean {
  let dropped = false
  while (c.list.length > max) {
    const victim = c.list.filter((r) => r.id !== keepId).sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0]
    if (!victim) break
    c.list = c.list.filter((r) => r !== victim)
    dropped = true
  }
  return dropped
}

export async function createSessionRecord(dataDir: string, who: { device: string; ip: string }, limits: SessionLimits, now = Date.now()): Promise<SessionRecord> {
  const c = await load(dataDir)
  prune(c, limits, now)
  const r: SessionRecord = { id: randomBytes(16).toString('base64url'), createdAt: now, lastSeenAt: now, device: who.device, ip: who.ip }
  c.list.push(r)
  evict(c, limits.maxDevices, r.id)
  await flush(dataDir, c, now)
  return { ...r }
}

export async function findAlive(dataDir: string, id: string, limits: SessionLimits, now = Date.now()): Promise<SessionRecord | null> {
  const c = await load(dataDir)
  const r = c.list.find((s) => s.id === id)
  return r && alive(r, limits, now) ? { ...r } : null
}

// marks the device seen now; the file follows at most once a minute, the next create, revoke or evict writes it anyway
export async function touch(dataDir: string, id: string, now = Date.now()): Promise<void> {
  const c = await load(dataDir)
  const r = c.list.find((s) => s.id === id)
  if (!r) return
  r.lastSeenAt = now
  if (now - c.flushedAt >= FLUSH_MS) await flush(dataDir, c, now)
}

export async function revoke(dataDir: string, id: string): Promise<boolean> {
  const c = await load(dataDir)
  const before = c.list.length
  c.list = c.list.filter((s) => s.id !== id)
  if (c.list.length === before) return false
  await flush(dataDir, c, Date.now())
  return true
}

export async function revokeAll(dataDir: string): Promise<void> {
  const c = await load(dataDir)
  c.list = []
  await flush(dataDir, c, Date.now())
}

export async function listSessions(dataDir: string, limits: SessionLimits, now = Date.now()): Promise<SessionRecord[]> {
  const c = await load(dataDir)
  if (prune(c, limits, now)) await flush(dataDir, c, now)
  return c.list.map((r) => ({ ...r })).sort((a, b) => b.lastSeenAt - a.lastSeenAt)
}

// after the cap was lowered in Settings: evict now, keeping the device that changed it
export async function enforceLimit(dataDir: string, limits: SessionLimits, keepId: string, now = Date.now()): Promise<void> {
  const c = await load(dataDir)
  const pruned = prune(c, limits, now)
  if (evict(c, limits.maxDevices, keepId) || pruned) await flush(dataDir, c, now)
}
