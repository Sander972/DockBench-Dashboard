import { expect, spyOn, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionRecord, DEFAULT_LIMITS, enforceLimit, findAlive, listSessions, parseCookie, revoke, revokeAll, signCookie, touch } from './sessions'

const secret = 'test-secret-at-least-32-characters-long'
const who = { device: 'Linux · Chrome', ip: '10.0.0.1' }
const DAY = 24 * 3600 * 1000
const fresh = () => mkdtemp(join(tmpdir(), 'dockbench-sessions-'))

test('cookie: a signature of the right length in characters but not in bytes is refused, not thrown', () => {
  const sig = signCookie(secret, 'abc').split('.')[1]
  expect(parseCookie(secret, `abc.\u00e9${sig.slice(1)}`)).toBeNull()
})

test('cookie: id round-trips, a tampered id or signature or another secret fails, the old three-part format fails', () => {
  const c = signCookie(secret, 'abc')
  expect(c.split('.')).toHaveLength(2)
  expect(parseCookie(secret, c)).toBe('abc')
  expect(parseCookie(secret, 'abd.' + c.split('.')[1])).toBeNull()
  expect(parseCookie(secret, 'abc.' + c.split('.')[1].replace(/^./, (ch) => (ch === 'a' ? 'b' : 'a')))).toBeNull()
  expect(parseCookie('other-secret-at-least-32-characters-long', c)).toBeNull()
  expect(parseCookie(secret, '1700000000000.1702592000000.deadbeef')).toBeNull()
  expect(parseCookie(secret, undefined)).toBeNull()
  expect(parseCookie(secret, '')).toBeNull()
  expect(parseCookie(secret, 'nodot')).toBeNull()
})

test('a created record is found, persisted and listed; a missing id is null', async () => {
  const dir = await fresh()
  const r = await createSessionRecord(dir, who, DEFAULT_LIMITS, 1_000)
  expect(r.id.length).toBeGreaterThanOrEqual(20)
  expect(r).toMatchObject({ createdAt: 1_000, lastSeenAt: 1_000, ...who })
  expect(await findAlive(dir, r.id, DEFAULT_LIMITS, 2_000)).toEqual(r)
  expect(await findAlive(dir, 'nope', DEFAULT_LIMITS, 2_000)).toBeNull()
  const stored = (await Bun.file(join(dir, 'sessions.json')).json()) as { sessions: unknown[] }
  expect(stored.sessions).toEqual([r])
  expect(await listSessions(dir, DEFAULT_LIMITS, 2_000)).toEqual([r])
})

test('idle expiry at idleDays and the hard cap at 30 days', async () => {
  const dir = await fresh()
  const r = await createSessionRecord(dir, who, { maxDevices: 5, idleDays: 2 }, 0)
  expect(await findAlive(dir, r.id, { maxDevices: 5, idleDays: 2 }, 2 * DAY - 1)).not.toBeNull()
  expect(await findAlive(dir, r.id, { maxDevices: 5, idleDays: 2 }, 2 * DAY)).toBeNull()
  const dir2 = await fresh()
  const s = await createSessionRecord(dir2, who, { maxDevices: 5, idleDays: 30 }, 0)
  for (let d = 1; d <= 29; d++) await touch(dir2, s.id, d * DAY)
  expect(await findAlive(dir2, s.id, { maxDevices: 5, idleDays: 30 }, 30 * DAY - 1)).not.toBeNull()
  await touch(dir2, s.id, 30 * DAY - 1)
  expect(await findAlive(dir2, s.id, { maxDevices: 5, idleDays: 30 }, 30 * DAY)).toBeNull()
})

test('touch moves lastSeenAt, flushes at most once a minute, and the next create flushes the pending value', async () => {
  const dir = await fresh()
  const r = await createSessionRecord(dir, who, DEFAULT_LIMITS, 0)
  const file = () => Bun.file(join(dir, 'sessions.json')).json() as Promise<{ sessions: { id: string; lastSeenAt: number }[] }>
  await touch(dir, r.id, 30_000)
  expect((await findAlive(dir, r.id, DEFAULT_LIMITS, 30_000))!.lastSeenAt).toBe(30_000)
  expect((await file()).sessions[0].lastSeenAt).toBe(0)
  await touch(dir, r.id, 61_000)
  expect((await file()).sessions[0].lastSeenAt).toBe(61_000)
  await touch(dir, r.id, 70_000)
  expect((await file()).sessions[0].lastSeenAt).toBe(61_000)
  await createSessionRecord(dir, who, DEFAULT_LIMITS, 70_000)
  expect((await file()).sessions.find((s) => s.id === r.id)!.lastSeenAt).toBe(70_000)
})

test('creating past maxDevices evicts the least recently seen records, never the new one', async () => {
  const dir = await fresh()
  const limits = { maxDevices: 2, idleDays: 2 }
  const a = await createSessionRecord(dir, who, limits, 1_000)
  const b = await createSessionRecord(dir, who, limits, 2_000)
  await touch(dir, a.id, 3_000)
  const c = await createSessionRecord(dir, who, limits, 500) // older createdAt and lastSeenAt than both, still kept: it is the one being created
  expect((await listSessions(dir, limits, 3_000)).map((s) => s.id)).toEqual([a.id, c.id])
  expect(await findAlive(dir, b.id, limits, 3_000)).toBeNull()
})

test('enforceLimit keeps keepId even when it is the oldest', async () => {
  const dir = await fresh()
  const limits = { maxDevices: 5, idleDays: 2 }
  const old = await createSessionRecord(dir, who, limits, 1_000)
  const ids = [] as string[]
  for (let i = 0; i < 4; i++) ids.push((await createSessionRecord(dir, who, limits, 2_000 + i)).id)
  await enforceLimit(dir, { maxDevices: 2, idleDays: 2 }, old.id, 3_000)
  const left = (await listSessions(dir, limits, 3_000)).map((s) => s.id)
  expect(left).toEqual([ids[3], old.id])
})

test('revoke removes one, answers false for unknown ids, revokeAll empties; dead records are dropped on list', async () => {
  const dir = await fresh()
  const a = await createSessionRecord(dir, who, DEFAULT_LIMITS, 0)
  const b = await createSessionRecord(dir, who, DEFAULT_LIMITS, DAY)
  expect(await revoke(dir, a.id)).toBe(true)
  expect(await revoke(dir, a.id)).toBe(false)
  expect((await listSessions(dir, DEFAULT_LIMITS, DAY)).map((s) => s.id)).toEqual([b.id])
  expect(await listSessions(dir, DEFAULT_LIMITS, 3 * DAY + 1)).toEqual([])
  expect(((await Bun.file(join(dir, 'sessions.json')).json()) as { sessions: unknown[] }).sessions).toEqual([])
  await createSessionRecord(dir, who, DEFAULT_LIMITS, 4 * DAY)
  await revokeAll(dir)
  expect(await listSessions(dir, DEFAULT_LIMITS, 4 * DAY)).toEqual([])
})

test('a corrupt or malformed sessions.json reads as no sessions and the next create rewrites it', async () => {
  for (const content of ['{"sess', '{}', '{"sessions":"x"}', '{"sessions":[{"id":1}]}', '{"sessions":[{"id":"a","createdAt":"x","lastSeenAt":1,"device":"d","ip":"i"}]}']) {
    const dir = await fresh()
    await Bun.write(join(dir, 'sessions.json'), content)
    expect(await findAlive(dir, 'a', DEFAULT_LIMITS, 1)).toBeNull()
    expect(await listSessions(dir, DEFAULT_LIMITS, 1)).toEqual([])
    const r = await createSessionRecord(dir, who, DEFAULT_LIMITS, 1)
    expect(((await Bun.file(join(dir, 'sessions.json')).json()) as { sessions: unknown[] }).sessions).toEqual([r])
  }
})

test('two first calls on a cold cache share one load, so both new sessions are kept', async () => {
  const dir = await fresh()
  const [a, b] = await Promise.all([createSessionRecord(dir, who, DEFAULT_LIMITS, 1), createSessionRecord(dir, who, DEFAULT_LIMITS, 1)])
  expect((await listSessions(dir, DEFAULT_LIMITS, 1)).map((s) => s.id).sort()).toEqual([a.id, b.id].sort())
})

test('a burst of touches past the flush interval queues one write', async () => {
  const dir = await fresh()
  const r = await createSessionRecord(dir, who, DEFAULT_LIMITS, 1)
  const write = spyOn(Bun, 'write')
  try {
    await Promise.all(Array.from({ length: 10 }, (_, i) => touch(dir, r.id, 61_000 + i)))
    expect(write).toHaveBeenCalledTimes(1)
  } finally {
    write.mockRestore()
  }
})
