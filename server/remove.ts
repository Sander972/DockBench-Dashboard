import { normalizeRepo } from './github'

export interface RemoveDeps {
  deleteStack: () => Promise<void>
  removeContainer: () => Promise<void>
  listVolumes: () => Promise<string[]>
  removeVolume: (name: string) => Promise<void>
  // keys titled dockbench-<project> on that repo with that read_only flag
  findKeys: (repo: string, readOnly: boolean) => Promise<{ id: number }[]>
  deleteKey: (repo: string, id: number) => Promise<void>
}

export type Step = <T>(method: string, path: string, okStatus: number, run: () => Promise<T>) => Promise<T>

// the title of a container's deploy keys, from its stack's PROJECT variable or else its name
export const keyTitle = (env: { name: string; value: string }[], name: string) => `dockbench-${env.find((e) => e.name === 'PROJECT')?.value ?? name.replace(/^dockbench-/, '')}`

// deletes every key `find` lists on the repo, so a duplicate left by an earlier failure goes too; answers how many went
export async function deleteKeys(repo: string, find: () => Promise<{ id: number }[]>, del: (id: number) => Promise<void>, step: Step): Promise<number> {
  const keys = await step('GET', `/repos/${repo}/keys`, 200, find)
  for (const { id } of keys) await step('DELETE', `/repos/${repo}/keys/${id}`, 204, () => del(id))
  return keys.length
}

// the deploy keys a stack's variables point to: the read/write key on the workspace repo (none with ghLogin, whose SSH_KEY is empty) and the read-only one on the Claude config repo
export function stackKeys(env: { name: string; value: string }[]): { repo: string; readOnly: boolean }[] {
  const cur = new Map(env.map((e) => [e.name, e.value]))
  const repo = cur.get('SSH_KEY') ? normalizeRepo(cur.get('REPO_URL')) : null
  const config = normalizeRepo(cur.get('CLAUDE_CONFIG_REPO'))
  return [...(repo ? [{ repo, readOnly: false }] : []), ...(config ? [{ repo: config, readOnly: true }] : [])]
}

// Deletes the stack, then whatever compose down leaves behind: the container if it is still there, the stack's volumes (/home/dev with the workspace) and its deploy keys on GitHub. Only the stack delete throws; after it there is no going back, so each later failure becomes a warning and the rest still runs. homeVolume is the volume the container mounted at /home/dev: when the stack's volume list lacks it, it stays (it may be external) and that is a warning, never silent. Answers how many volumes and keys went.
export async function removeStack(i: { stackId: number; containerId: string; homeVolume: string | null; title: string; keys: { repo: string; readOnly: boolean }[] }, deps: RemoveDeps, step: Step): Promise<{ warnings: string[]; volumes: number; keys: number }> {
  await step('DELETE', `/api/stacks/${i.stackId}`, 204, deps.deleteStack)
  const warnings: string[] = []
  const soft = async (what: string, run: () => Promise<unknown>, hint = '') => {
    try { await run(); return true } catch (e) { warnings.push(`${what}: ${(e as Error).message}.${hint && ' ' + hint}`); return false }
  }
  await soft('Could not remove the container', () => step('DELETE', `/containers/${i.containerId.slice(0, 12)}`, 204, deps.removeContainer))
  let volumes = 0
  let keys = 0
  const listed = await step('GET', '/volumes', 200, deps.listVolumes).catch((e: Error) => { warnings.push(`Could not list the volumes: ${e.message}.`); return null })
  for (const v of listed ?? []) if (await soft(`Could not remove the volume ${v}`, () => step('DELETE', `/volumes/${v}`, 204, () => deps.removeVolume(v)), 'Remove it in Portainer under Volumes.')) volumes++
  if (listed && i.homeVolume && !listed.includes(i.homeVolume)) warnings.push(`The /home/dev volume ${i.homeVolume} is not labeled as this stack's, so it was kept. Remove it in Portainer under Volumes.`)
  for (const k of i.keys) {
    await soft(`Could not remove the ${k.readOnly ? 'read-only ' : ''}deploy key ${i.title} from ${k.repo}`, async () => {
      keys += await deleteKeys(k.repo, () => deps.findKeys(k.repo, k.readOnly), (id) => deps.deleteKey(k.repo, id), step)
    }, "Remove it under the repo's Settings > Deploy keys.")
  }
  return { warnings, volumes, keys }
}
