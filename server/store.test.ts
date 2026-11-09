import { expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendEvent, readAccount, readEvents, readSettings, writeAccount, writeSettings } from './store'

test('events come back newest first and limited', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockbench-'))
  expect(await readEvents(dir)).toEqual([])
  for (let i = 1; i <= 3; i++) await appendEvent(dir, { at: `t${i}`, actor: 'octocat', what: 'Deployed', target: `p${i}`, ok: true, calls: [] })
  expect((await readEvents(dir)).map((e) => e.target)).toEqual(['p3', 'p2', 'p1'])
  expect((await readEvents(dir, 2)).map((e) => e.target)).toEqual(['p3', 'p2'])
})

test('account roundtrip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockbench-'))
  expect(await readAccount(dir)).toBeNull()
  const account = { login: 'octocat', id: 1, name: null, avatar_url: '', token: 'gho_x' }
  await writeAccount(dir, account)
  expect(await readAccount(dir)).toEqual(account)
})

test('two settings saves at once both land', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockbench-'))
  await Promise.all([writeSettings(dir, { claudeConfigRepo: 'a/b' }), writeSettings(dir, { vscodeSettings: '{}' })])
  expect(await readSettings(dir)).toEqual({ claudeConfigRepo: 'a/b', vscodeSettings: '{}', maxDevices: 5, idleDays: 2 })
})

test('session limits default to 5 devices and 2 idle days, clamp out-of-range values and keep the other settings', async () => {
  const d = await mkdtemp(join(tmpdir(), 'dockbench-settings-'))
  expect(await readSettings(d)).toMatchObject({ maxDevices: 5, idleDays: 2 })
  await writeSettings(d, { maxDevices: 3, idleDays: 7 })
  expect(await readSettings(d)).toMatchObject({ maxDevices: 3, idleDays: 7, claudeConfigRepo: '', vscodeSettings: '' })
  await Bun.write(join(d, 'settings.json'), JSON.stringify({ maxDevices: 99, idleDays: 0, claudeConfigRepo: 'a/b' }))
  expect(await readSettings(d)).toMatchObject({ maxDevices: 20, idleDays: 1, claudeConfigRepo: 'a/b' })
  await Bun.write(join(d, 'settings.json'), JSON.stringify({ maxDevices: 'x', idleDays: 2.7 }))
  expect(await readSettings(d)).toMatchObject({ maxDevices: 5, idleDays: 2 })
})

test('the activity log rotates past maxBytes into one .1 file and readEvents tops the newest up from it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockbench-activity-'))
  const ev = (target: string) => ({ at: 't', actor: 'octocat', what: 'Deployed', target, ok: true, calls: [] })
  const size = JSON.stringify(ev('p1')).length + 1
  for (let i = 1; i <= 5; i++) await appendEvent(dir, ev(`p${i}`), size * 2)
  // p1 p2 rotate when p3 would pass the cap, p3 p4 when p5 would: .1 holds p3 p4, the old .1 is dropped
  expect((await readEvents(dir)).map((e) => e.target)).toEqual(['p5', 'p4', 'p3'])
  expect((await readEvents(dir, 2)).map((e) => e.target)).toEqual(['p5', 'p4'])
  expect((await Bun.file(join(dir, 'activity.jsonl.1')).text()).split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { target: string }).target)).toEqual(['p3', 'p4'])
})

test('appends that cross the cap at the same time rotate once each in order, losing no rotated file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockbench-activity-'))
  const ev = (target: string) => ({ at: 't', actor: 'octocat', what: 'Deployed', target, ok: true, calls: [] })
  const size = JSON.stringify(ev('p1')).length + 1
  await appendEvent(dir, ev('p1'), size * 2)
  await appendEvent(dir, ev('p2'), size * 2)
  await Promise.all(['p3', 'p4', 'p5'].map((t) => appendEvent(dir, ev(t), size * 2)))
  const targets = async (f: string) => (await Bun.file(join(dir, f)).text()).split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { target: string }).target)
  expect(await targets('activity.jsonl.1')).toEqual(['p3', 'p4'])
  expect(await targets('activity.jsonl')).toEqual(['p5'])
})
