import { expect, test } from 'bun:test'
import { BOOT_ID, imageRow } from './system'
import type { Inspect } from './docker'

const x: Inspect = { startedAt: '2026-10-14T10:00:00Z', finishedAt: null, exitCode: null, restartCount: 0, memLimit: 0, repoUrl: null, homeVolume: null, image: 'ghcr.io/sander972/dockbench-dashboard:latest', imageId: 'sha256:old', project: 'dashboard', config: { installClaude: true, injectClaudeConfig: false, vscodeConfig: true }, entrypoint: null }
const c = { id: 'abc', name: 'dockbench-dashboard', state: 'running', image: x.image }

test('imageRow: not deployed when there is no container', () => {
  expect(imageRow('dockbench-telegram', null, null, null)).toEqual({ name: 'dockbench-telegram', deployed: false, state: null, startedAt: null, image: null, imageUpdate: null, imageCheckedAt: null, checkError: null })
})

test('imageRow: an update when the pulled tag points to another image id, unknown before the first pull, the pull error passed on', () => {
  expect(imageRow(c.name, c, x, null).imageUpdate).toBeNull()
  const newer = imageRow(c.name, c, x, { imageId: 'sha256:new', at: Date.parse('2026-10-14T11:00:00Z'), error: null })
  expect(newer).toMatchObject({ deployed: true, state: 'running', imageUpdate: true, imageCheckedAt: '2026-10-14T11:00:00.000Z', checkError: null })
  expect(imageRow(c.name, c, x, { imageId: 'sha256:old', at: 0, error: 'Image pull returned 401' })).toMatchObject({ imageUpdate: false, checkError: 'Image pull returned 401' })
})

test('BOOT_ID is fixed for the process', async () => {
  expect(BOOT_ID).toBe((await import('./system')).BOOT_ID)
  expect(BOOT_ID).toMatch(/^[0-9a-f-]{36}$/)
})
