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
