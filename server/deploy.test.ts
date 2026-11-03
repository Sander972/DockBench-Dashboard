import { expect, test } from 'bun:test'
import { deploy, validateDeploy, type DeployDeps } from './deploy'
import type { ContainerRow } from './docker'

const IMG = 'ghcr.io/sander972/dockbench:latest'
const good = { repo: 'octocat/shop', project: 'shop', gitUserName: 'Mona', gitUserEmail: '1+octocat@users.noreply.github.com' }

test('validateDeploy accepts a good body, trims, defaults the image and ignores auth fields', () => {
  const r = validateDeploy({ ...good, project: ' shop ', auth: 'device', token: 'github_pat_x', image: '' }, IMG)
  expect(r).toEqual({ ok: true, value: { ...good, image: IMG, installClaude: true, injectClaudeConfig: false, setupRerun: false, vscodeConfig: true, ghLogin: false } })
  const custom = validateDeploy({ ...good, image: 'ghcr.io/sander972/dockbench:abc' }, IMG)
  expect(custom.ok && custom.value.image).toBe('ghcr.io/sander972/dockbench:abc')
})

test('validateDeploy reads the options as strict booleans: install Claude unless false, inject and setup rerun only when true', () => {
  const v = (body: object) => (validateDeploy({ ...good, ...body }, IMG) as { ok: true; value: { installClaude: boolean; injectClaudeConfig: boolean } }).value
  expect(v({ installClaude: false, injectClaudeConfig: true, setupRerun: true })).toMatchObject({ installClaude: false, injectClaudeConfig: true, setupRerun: true })
  expect(v({ installClaude: 'no', injectClaudeConfig: 'yes', setupRerun: 1 })).toMatchObject({ installClaude: true, injectClaudeConfig: false, setupRerun: false })
  expect(v({ vscodeConfig: false })).toMatchObject({ vscodeConfig: false })
  expect(v({ vscodeConfig: 'no' })).toMatchObject({ vscodeConfig: true })
  expect(v({ ghLogin: true })).toMatchObject({ ghLogin: true })
  expect(v({ ghLogin: 'yes' })).toMatchObject({ ghLogin: false })
})

test('validateDeploy rejects bad input with a reason', () => {
  const bad = (body: unknown) => (validateDeploy(body, IMG) as { ok: false; error: string }).error
  expect(bad(null)).toBe('repo must be owner/name')
  expect(bad({ ...good, repo: 'https://github.com/a/b' })).toBe('repo must be owner/name')
  expect(bad({ ...good, project: '' })).toBe('project is required')
  expect(bad({ ...good, project: 'a'.repeat(21) })).toBe('project must be at most 20 characters')
  expect(bad({ ...good, project: 'Shop' })).toContain('project must match')
  expect(bad({ ...good, project: '-shop' })).toContain('project must match')
  expect(bad({ ...good, project: 'telegram' })).toBe('project telegram is taken by the Telegram bot')
  expect(bad({ ...good, gitUserName: '' })).toBe('gitUserName is required')
  expect(bad({ ...good, gitUserEmail: 'nope' })).toBe('gitUserEmail must be an email')
  expect(bad({ ...good, image: 'a b' })).toBe('image must not contain spaces')
})

const row = (name: string): ContainerRow => ({ id: 'abc123', name, state: 'running', image: IMG })

function fakes(over: Partial<DeployDeps> = {}) {
  const log: string[] = []
  const deps: DeployDeps = {
    listContainers: async () => [],
    findStack: async () => null,
    pullImage: async () => { log.push('pull') },
    createDeployKey: async () => { log.push('key'); return { id: 42 } },
    deleteDeployKey: async (id) => { log.push(`unkey ${id}`) },
    createStack: async () => { log.push('create'); return { Id: 7 } },
    sleep: async () => {},
    ...over,
  }
  return { deps, log }
}

test('deploy refuses an existing container with 409 and creates nothing', async () => {
  const { deps, log } = fakes({ listContainers: async () => [row('dockbench-shop')] })
  await expect(deploy('shop', 'octocat/shop', deps)).rejects.toMatchObject({ status: 409 })
  expect(log).toEqual([])
})

test('deploy refuses an existing stack with 409', async () => {
  const { deps, log } = fakes({ findStack: async () => ({ Id: 1 }) })
  await expect(deploy('shop', 'octocat/shop', deps)).rejects.toMatchObject({ status: 409 })
  expect(log).toEqual([])
})

test('a failed pull becomes a 502 with the calls so far and no stack is created', async () => {
  const { deps, log } = fakes({ pullImage: async () => { throw new Error('Image pull failed: denied') } })
  const err = await deploy('shop', 'octocat/shop', deps).catch((e) => e)
  expect(err).toMatchObject({ status: 502, message: 'Image pull failed: denied' })
  expect(err.calls.map((c: { path: string; status: number | null }) => [c.path, c.status])).toEqual([['/containers/json', 200], ['/api/stacks', 200], ['/images/create', null]])
  expect(log).toEqual([])
})

test('deploy pulls, creates the stack and finds the container on a later poll', async () => {
  let polls = 0
  const { deps, log } = fakes({ listContainers: async () => (++polls >= 3 ? [row('dockbench-shop')] : []) })
  const result = await deploy('shop', 'octocat/shop', deps)
  expect(log).toEqual(['pull', 'key', 'create'])
  expect(result).toMatchObject({ id: 'abc123', name: 'dockbench-shop' })
  expect(result.calls.map((c) => `${c.method} ${c.path} ${c.status}`)).toContain('POST /api/stacks/create/standalone/string 200')
  expect(result.calls.map((c) => `${c.method} ${c.path} ${c.status}`)).toContain('POST /repos/octocat/shop/keys 201')
})

test('without a deploy key (ghLogin), deploy creates no key and a failed stack has none to delete', async () => {
  const { deps, log } = fakes({ createDeployKey: undefined, deleteDeployKey: undefined, createStack: async () => { throw new Error('Portainer create stack returned 500: boom') } })
  await expect(deploy('shop', 'octocat/shop', deps)).rejects.toMatchObject({ message: 'Portainer create stack returned 500: boom' })
  expect(log).toEqual(['pull'])
})

test('deploy returns an empty id when the container never shows up', async () => {
  const { deps } = fakes()
  expect((await deploy('shop', 'octocat/shop', deps)).id).toBe('')
})

test('a refused deploy key is a 502 and no stack is created', async () => {
  const { deps, log } = fakes({ createDeployKey: async () => { throw new Error('GitHub /repos/octocat/shop/keys returned 403: admin rights required') } })
  const err = await deploy('shop', 'octocat/shop', deps).catch((e) => e)
  expect(err).toMatchObject({ status: 502, message: 'GitHub /repos/octocat/shop/keys returned 403: admin rights required' })
  expect(log).toEqual(['pull'])
})

test('stack failure deletes the key and keeps the Portainer error', async () => {
  const { deps, log } = fakes({ createStack: async () => { throw new Error('Portainer create stack returned 500: boom') } })
  const err = await deploy('shop', 'octocat/shop', deps).catch((e) => e)
  expect(err).toMatchObject({ status: 502, message: 'Portainer create stack returned 500: boom' })
  expect(log).toEqual(['pull', 'key', 'unkey 42'])
  expect(err.calls.map((c: { method: string; path: string; status: number | null }) => `${c.method} ${c.path} ${c.status}`)).toEqual([
    'GET /containers/json 200', 'GET /api/stacks 200', 'POST /images/create 200', 'POST /repos/octocat/shop/keys 201', 'POST /api/stacks/create/standalone/string null', 'GET /api/stacks 200', 'DELETE /repos/octocat/shop/keys/42 204',
  ])
})

test('a stack create whose response failed but that Portainer did create keeps the key', async () => {
  let created = false
  const { deps, log } = fakes({
    findStack: async () => (created ? { Id: 7 } : null),
    createStack: async () => { created = true; throw new Error('Portainer create stack: timeout') },
  })
  await expect(deploy('shop', 'octocat/shop', deps)).rejects.toMatchObject({ message: 'Portainer create stack: timeout' })
  expect(log).toEqual(['pull', 'key'])
})

test('when Portainer cannot say whether the stack exists, the key is kept', async () => {
  let checks = 0
  const { deps, log } = fakes({
    findStack: async () => { if (++checks > 1) throw new Error('Portainer down'); return null },
    createStack: async () => { throw new Error('Portainer create stack returned 500: boom') },
  })
  const err = await deploy('shop', 'octocat/shop', deps).catch((e) => e)
  expect(err.message).toBe('Portainer create stack returned 500: boom')
  expect(log).toEqual(['pull', 'key'])
  expect(err.calls.at(-1)).toEqual({ method: 'GET', path: '/api/stacks', status: null })
})

test('a failed key deletion does not hide the stack error', async () => {
  const { deps } = fakes({ createStack: async () => { throw new Error('Portainer create stack returned 500: boom') }, deleteDeployKey: async () => { throw new Error('GitHub down') } })
  const err = await deploy('shop', 'octocat/shop', deps).catch((e) => e)
  expect(err.message).toBe('Portainer create stack returned 500: boom')
  expect(err.calls.at(-1)).toEqual({ method: 'DELETE', path: '/repos/octocat/shop/keys/42', status: null })
})

test('with a config repo, deploy adds its read-only key after the workspace key and before the stack', async () => {
  const { deps, log } = fakes({ createConfigKey: async () => { log.push('config key'); return { id: 43 } }, deleteConfigKey: async (id) => { log.push(`unconfig ${id}`) } })
  const result = await deploy('shop', 'octocat/shop', deps, 'octocat/claude-config')
  expect(log).toEqual(['pull', 'key', 'config key', 'create'])
  expect(result.calls.map((c) => `${c.method} ${c.path} ${c.status}`)).toContain('POST /repos/octocat/claude-config/keys 201')
})

test('a refused config key deletes the workspace key and creates no stack', async () => {
  const { deps, log } = fakes({ createConfigKey: async () => { throw new Error('GitHub /repos/octocat/claude-config/keys returned 404: Not Found') }, deleteConfigKey: async () => {} })
  const err = await deploy('shop', 'octocat/shop', deps, 'octocat/claude-config').catch((e) => e)
  expect(err).toMatchObject({ status: 502, message: 'GitHub /repos/octocat/claude-config/keys returned 404: Not Found' })
  expect(log).toEqual(['pull', 'key', 'unkey 42'])
  expect(err.calls.at(-1)).toEqual({ method: 'DELETE', path: '/repos/octocat/shop/keys/42', status: 204 })
})

test('stack failure deletes both keys when there is a config repo', async () => {
  const { deps, log } = fakes({
    createConfigKey: async () => { log.push('config key'); return { id: 43 } },
    deleteConfigKey: async (id) => { log.push(`unconfig ${id}`) },
    createStack: async () => { throw new Error('Portainer create stack returned 500: boom') },
  })
  await expect(deploy('shop', 'octocat/shop', deps, 'octocat/claude-config')).rejects.toMatchObject({ message: 'Portainer create stack returned 500: boom' })
  expect(log).toEqual(['pull', 'key', 'config key', 'unkey 42', 'unconfig 43'])
})
