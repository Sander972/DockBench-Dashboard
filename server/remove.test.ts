import { expect, test } from 'bun:test'
import { removeStack, stackKeys, type RemoveDeps } from './remove'
import type { ApiCall } from './store'

const env = (o: Record<string, string>) => Object.entries(o).map(([name, value]) => ({ name, value }))

test('stackKeys: the workspace key only with an SSH_KEY, the config key only with a config repo', () => {
  expect(stackKeys(env({ REPO_URL: 'git@github.com:Octocat/Shop.git', SSH_KEY: 'k', CLAUDE_CONFIG_REPO: 'git@github.com:octocat/dotclaude.git' }))).toEqual([{ repo: 'octocat/shop', readOnly: false }, { repo: 'octocat/dotclaude', readOnly: true }])
  expect(stackKeys(env({ REPO_URL: 'https://github.com/octocat/shop.git', SSH_KEY: '', CLAUDE_CONFIG_REPO: '' }))).toEqual([])
})

function harness(over: Partial<RemoveDeps> = {}) {
  const calls: ApiCall[] = []
  const done: string[] = []
  const step = async <T>(method: string, path: string, ok: number, run: () => Promise<T>) => {
    const c: ApiCall = { method, path, status: null }
    calls.push(c)
    const out = await run()
    c.status = ok
    return out
  }
  const deps: RemoveDeps = {
    deleteStack: async () => { done.push('stack') },
    removeContainer: async () => { done.push('container') },
    listVolumes: async () => ['dockbench-shop_home'],
    removeVolume: async (v) => { done.push(`volume ${v}`) },
    findKeys: async (_repo, ro) => [{ id: ro ? 2 : 1 }],
    deleteKey: async (repo, id) => { done.push(`key ${repo} ${id}`) },
    ...over,
  }
  const run = () => removeStack({ stackId: 7, containerId: 'abcdef1234567890', homeVolume: 'dockbench-shop_home', title: 'dockbench-shop', keys: [{ repo: 'octocat/shop', readOnly: false }, { repo: 'octocat/dotclaude', readOnly: true }] }, deps, step)
  return { calls, done, run }
}

test('removeStack deletes the stack, the container, its volumes and both keys', async () => {
  const h = harness()
  expect(await h.run()).toEqual({ warnings: [], volumes: 1, keys: 2 })
  expect(h.done).toEqual(['stack', 'container', 'volume dockbench-shop_home', 'key octocat/shop 1', 'key octocat/dotclaude 2'])
  expect(h.calls.every((c) => c.status !== null)).toBe(true)
})

test('removeStack touches nothing else when the stack delete fails', async () => {
  const h = harness({ deleteStack: async () => { throw new Error('Portainer delete stack returned 500') } })
  await expect(h.run()).rejects.toThrow('returned 500')
  expect(h.done).toEqual([])
})

test('after the stack is gone, a failed step only warns and the rest still runs', async () => {
  const h = harness({
    removeVolume: async () => { throw new Error('Docker remove volume dockbench-shop_home returned 409: in use') },
    findKeys: async (repo) => { if (repo === 'octocat/shop') throw new Error('GitHub returned 404'); return [{ id: 2 }] },
  })
  const { warnings: w, volumes, keys } = await h.run()
  expect([volumes, keys]).toEqual([0, 1])
  expect(w).toHaveLength(2)
  expect(w[0]).toContain('Could not remove the volume dockbench-shop_home')
  expect(w[1]).toContain('deploy key dockbench-shop from octocat/shop: GitHub returned 404')
  expect(h.done).toEqual(['stack', 'container', 'key octocat/dotclaude 2'])
})

test('a /home/dev volume missing from the stack list stays and warns, never silently', async () => {
  const h = harness({ listVolumes: async () => [] })
  const r = await h.run()
  expect(r.volumes).toBe(0)
  expect(r.warnings).toEqual(["The /home/dev volume dockbench-shop_home is not labeled as this stack's, so it was kept. Remove it in Portainer under Volumes."])
  expect(h.done).not.toContain('volume dockbench-shop_home')
})

test('a failed volume list warns once, without the kept-volume warning', async () => {
  const r = await harness({ listVolumes: async () => { throw new Error('Docker list volumes returned 500') } }).run()
  expect(r.warnings).toEqual(['Could not list the volumes: Docker list volumes returned 500.'])
})
